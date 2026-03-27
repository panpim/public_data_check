import { chromium } from "playwright";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

export const KRZ_BASE_URL = "https://krz.ms.gov.pl";
// Direct hash URL for the subject search page
const KRZ_SEARCH_URL =
  "https://krz.ms.gov.pl/#!/application/KRZPortalPUB/1.9/KrzRejPubGui.WyszukiwaniePodmiotow?params=JTdCJTdE&itemId=item-2&seq=0";

const NAV_TIMEOUT = 30_000;
const RESULT_TIMEOUT = 15_000;

// Maps our searchType values to the Polish label text on KRZ tabs/radios
const ENTITY_TYPE_LABELS: Record<string, string> = {
  pl_company: "Podmiot niebędący osobą fizyczną",
  pl_business_ind: "Osoba fizyczna prowadząca działalność gospodarczą",
  pl_private_ind: "Osoba fizyczna nieprowadząca działalności gospodarczej",
};

export async function runKrzSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "pl-PL",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // Step 1: Load the base URL first so Angular can establish its session.
    await page.goto(KRZ_BASE_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(3_000);

    // Dismiss cookie consent banner if present (common on Polish government portals).
    // Try the most common accept-button patterns; silently skip if not found.
    const cookieSelectors = [
      'button:has-text("Akceptuję")',
      'button:has-text("Akceptuj")',
      'button:has-text("Zgadzam się")',
      'button:has-text("Zaakceptuj")',
      'button:has-text("Accept")',
      'button:has-text("OK")',
      '[class*="cookie"] button',
      '[id*="cookie"] button',
      '[class*="consent"] button',
      '[id*="consent"] button',
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 2_000 });
          await page.waitForTimeout(500);
          break;
        }
      } catch { /* not found, try next */ }
    }

    // Step 2: Navigate to the search page.
    await page.goto(KRZ_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    // Step 3: Wait for any post-authorize redirect to resolve (Angular hash routing).
    await page.waitForFunction(
      () => !window.location.href.includes("post-authorize"),
      { timeout: 20_000 }
    ).catch(() => {}); // ignore — if no redirect, continue

    // Step 4: Wait for the form to render.
    // KRZ uses Angular and inputs may not have type="text" in the attribute.
    // Try multiple selectors in order of specificity.
    const formReadySelectors = [
      'input[type="text"]',
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])',
      'input',
    ];
    let firstInput = page.locator('input').first();
    for (const sel of formReadySelectors) {
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: "visible", timeout: 8_000 });
        firstInput = loc;
        break;
      } catch {
        // try next selector
      }
    }

    // Select entity type tab/radio — use locator with text matching (faster, no long timeouts)
    const entityLabel = ENTITY_TYPE_LABELS[input.searchType];
    if (entityLabel) {
      const tab = page.locator(`li, label, button, a`).filter({ hasText: entityLabel }).first();
      try {
        await tab.click({ timeout: 3_000 });
        await page.waitForTimeout(500);
      } catch {
        // entity type selector not found — proceed with default tab
      }
    }

    // Fill name field — try specific selectors first, fall back to firstInput already found
    const nameInputCandidates = [
      page.locator('input[placeholder*="Nazwa" i]').first(),
      page.locator('input[ng-model*="nazwa" i]').first(),
      page.locator('input[ng-model*="name" i]').first(),
      firstInput,
    ];
    let nameInput = firstInput;
    for (const candidate of nameInputCandidates) {
      if ((await candidate.count()) > 0) {
        nameInput = candidate;
        break;
      }
    }
    await nameInput.fill(input.borrowerName.trim());

    // Fill ID field if provided — use the second visible text input, or a labelled ID field
    if (input.idCode) {
      try {
        const idInput = page
          .locator('input[placeholder*="KRS" i], input[placeholder*="NIP" i], input[placeholder*="numer" i], input[ng-model*="krs" i], input[ng-model*="nip" i]')
          .first();
        const idCount = await idInput.count();
        if (idCount > 0) {
          await idInput.fill(input.idCode.trim());
        } else {
          // Fall back to second text input (first is name, second is often ID)
          const secondInput = page.locator('input[type="text"]').nth(1);
          if ((await secondInput.count()) > 0) {
            await secondInput.fill(input.idCode.trim());
          }
        }
      } catch {
        // ID field not found — proceed without it
      }
    }

    // Submit — try button with text, then submit button type, then Enter
    const submitBtn = page.locator('button:has-text("Szukaj"), button:has-text("Wyszukaj"), button[type="submit"]').first();
    if ((await submitBtn.count()) > 0) {
      await submitBtn.click({ timeout: 3_000 });
    } else {
      await nameInput.press("Enter");
    }

    // Wait for results to render
    await page.waitForLoadState("load", { timeout: RESULT_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2_500);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const { status, resultsCount, matchedEntities, summaryText } =
      parseKrzResults(bodyText, input.borrowerName);

    return {
      providerKey: "krz_insolvency",
      sourceUrl: finalUrl || KRZ_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount,
      matchedEntities,
      summaryText,
      screenshotBuffer,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Capture a diagnostic screenshot if the browser/page is still open
    let diagScreenshot: Buffer | undefined;
    try {
      if (browser) {
        const pages = browser.contexts()[0]?.pages();
        const activePage = pages?.[pages.length - 1];
        if (activePage) {
          diagScreenshot = await activePage.screenshot({ fullPage: true });
        }
      }
    } catch { /* ignore screenshot errors */ }
    return {
      providerKey: "krz_insolvency",
      sourceUrl: KRZ_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `KRZ search failed: ${message}`,
      screenshotBuffer: diagScreenshot,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse KRZ search results from the page body text.
 * Exported for unit testing.
 */
export function parseKrzResults(
  bodyText: string,
  borrowerName: string
): Pick<
  NormalizedCheckResult,
  "status" | "resultsCount" | "matchedEntities" | "summaryText"
> {
  const lower = bodyText.toLowerCase();

  // Primary signal: count string "Wyświetlanie X - Y z Z wyników"
  const countMatch = bodyText.match(
    /wyświetlanie\s+\d+\s*[-–]\s*\d+\s+z\s+(\d+)\s+wyników/i
  );
  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    const matchedEntities = extractEntities(bodyText, borrowerName);
    if (count === 0) {
      return {
        status: "no_match",
        resultsCount: 0,
        matchedEntities: [],
        summaryText: `No insolvency records found on KRZ for "${borrowerName}".`,
      };
    }
    if (count === 1) {
      return {
        status: "match_found",
        resultsCount: 1,
        matchedEntities,
        summaryText: `1 insolvency record found on KRZ matching "${borrowerName}".`,
      };
    }
    return {
      status: "ambiguous",
      resultsCount: count,
      matchedEntities,
      summaryText: `${count} insolvency records found on KRZ for "${borrowerName}". Manual review required.`,
    };
  }

  // Explicit no-result signal
  if (lower.includes("brak wyników") || lower.includes("nie znaleziono")) {
    return {
      status: "no_match",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `No insolvency records found on KRZ for "${borrowerName}".`,
    };
  }

  // Fallback: ambiguous — could not parse
  return {
    status: "ambiguous",
    resultsCount: 0,
    matchedEntities: [],
    summaryText:
      "KRZ search page loaded but results could not be parsed. Please review the screenshot in the PDF.",
  };
}

function extractEntities(
  bodyText: string,
  borrowerName: string
): Array<{ name: string; caseNumber?: string }> {
  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const firstWord = borrowerName.toLowerCase().split(" ")[0];
  return lines
    .filter((l) => l.toLowerCase().includes(firstWord))
    .slice(0, 10)
    .map((l) => ({ name: l }));
}
