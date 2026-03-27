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

    // Navigate to the search page
    await page.goto(KRZ_SEARCH_URL, { waitUntil: "load" });
    await page.waitForTimeout(2000); // Allow Angular to bootstrap

    // Select entity type tab/radio
    const entityLabel = ENTITY_TYPE_LABELS[input.searchType];
    if (entityLabel) {
      const tabSelectors = [
        `li:has-text("${entityLabel}")`,
        `label:has-text("${entityLabel}")`,
        `button:has-text("${entityLabel}")`,
        `[title="${entityLabel}"]`,
      ];
      for (const sel of tabSelectors) {
        try {
          await page.click(sel, { timeout: 5_000 });
          await page.waitForTimeout(500);
          break;
        } catch {
          // try next selector
        }
      }
    }

    // Fill name field
    const nameSelectors = [
      'input[placeholder*="Nazwa" i]',
      'input[placeholder*="nazwa" i]',
      'input[ng-model*="name" i]',
      'input[ng-model*="nazwa" i]',
      'input[type="text"]:first-of-type',
    ];
    let nameFilled = false;
    for (const sel of nameSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5_000 });
        await page.fill(sel, input.borrowerName.trim());
        nameFilled = true;
        break;
      } catch {
        // try next
      }
    }
    if (!nameFilled) {
      throw new Error(
        "Could not locate the name field on KRZ. The page structure may have changed."
      );
    }

    // Fill ID field if provided
    if (input.idCode) {
      const idSelectors = [
        'input[placeholder*="KRS" i]',
        'input[placeholder*="NIP" i]',
        'input[placeholder*="numer" i]',
        'input[ng-model*="krs" i]',
        'input[ng-model*="nip" i]',
      ];
      for (const sel of idSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 3_000 });
          await page.fill(sel, input.idCode.trim());
          break;
        } catch {
          // field not found — proceed without it
        }
      }
    }

    // Submit
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Szukaj")',
      'button:has-text("Wyszukaj")',
      'input[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        await page.click(sel, { timeout: 3_000 });
        submitted = true;
        break;
      } catch {
        // try next
      }
    }
    if (!submitted) {
      await page.keyboard.press("Enter");
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
