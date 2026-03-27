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

    // Step 1: Load base URL so Angular can bootstrap and set up its session.
    await page.goto(KRZ_BASE_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2_500);

    // Step 2: Dismiss cookie consent banner if present.
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

    // Step 3: Navigate to the search page via JS hash navigation.
    await page.evaluate((url: string) => { window.location.href = url; }, KRZ_SEARCH_URL);

    // Step 4: Wait for BOTH conditions simultaneously:
    //   - URL contains "WyszukiwaniePodmiotow" (Angular finished routing, including post-authorize)
    //   - At least one visible input exists (form is rendered)
    // waitForURL alone resolves immediately before Angular redirects away for post-authorize.
    await page.waitForFunction(
      () => {
        const onSearchPage = window.location.href.includes("WyszukiwaniePodmiotow");
        const hasInput = document.querySelector("input:not([type=hidden])") !== null;
        return onSearchPage && hasInput;
      },
      { timeout: 30_000 }
    );
    await page.waitForTimeout(300);

    // Step 5: Select entity type tab.
    const entityLabel = ENTITY_TYPE_LABELS[input.searchType];
    if (entityLabel) {
      try {
        await page.locator(`text="${entityLabel}"`).first().click({ timeout: 3_000 });
        await page.waitForTimeout(800);
      } catch { /* proceed with the default (first) tab */ }
    }

    // Step 6: Fill inputs by position.
    //   nth(0) = "Nazwa podmiotu"
    //   nth(1) = "Identyfikator (KRS, NIP lub inny identyfikator)"
    const nameInput = page.locator("input").nth(0);
    await nameInput.waitFor({ state: "visible", timeout: 5_000 });
    await nameInput.fill(input.borrowerName.trim());

    if (input.idCode) {
      try {
        const idInput = page.locator("input").nth(1);
        if ((await idInput.count()) > 0) {
          await idInput.fill(input.idCode.trim());
        }
      } catch { /* ID field not available — proceed without it */ }
    }

    // Step 7: Click the "Wyszukaj" submit button.
    await page.locator('button:has-text("Wyszukaj")').first().click({ timeout: 5_000 });

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
