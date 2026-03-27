/**
 * AVNT Insolvency Register — Playwright automation layer
 */
import { chromium } from "playwright";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

export const AVNT_BASE_URL = "https://nemokumas.avnt.lt/public/case/list";

const NAV_TIMEOUT = 30_000;
const RESULT_TIMEOUT = 15_000;

export async function runAvntSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "lt-LT",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    await page.goto(AVNT_BASE_URL, { waitUntil: "load" });

    const nameFieldSelectors = [
      'input[placeholder="Įveskite paieškos žodį..."]',
      'input[aria-label="Įveskite paieškos žodį..."]',
      'input[placeholder*="paieškos" i]',
      'input[placeholder*="pavadinimas" i]',
      'input[placeholder*="vardas" i]',
      'input[placeholder*="name" i]',
    ];

    let nameFieldFilled = false;
    for (const selector of nameFieldSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3_000 });
        await page.click(selector);
        await page.fill(selector, "");
        // Type character by character so AngularJS detects each keystroke
        await page.locator(selector).pressSequentially(input.borrowerName, { delay: 40 });
        nameFieldFilled = true;
        break;
      } catch {
        // try next selector
      }
    }

    if (!nameFieldFilled) {
      throw new Error(
        "Could not locate the borrower name field on the AVNT page. " +
          "The page structure may have changed — update nameFieldSelectors in search.ts."
      );
    }

    if (input.idCode) {
      // The ID code field lives inside the collapsed "Daugiau parinkčių" (More options)
      // section (#more-content). Expand it first, then fill the field.
      try {
        await page.click("a.c-content-toggle-link", { timeout: 5_000 });
        await page.waitForSelector("#more-content:not(.collapse)", { timeout: 5_000 });
      } catch {
        // toggle not found or already expanded — continue
      }
      try {
        const idSelector = 'input[aria-label="Juridinio asmens kodas"]';
        await page.waitForSelector(idSelector, { state: "visible", timeout: 5_000 });
        await page.click(idSelector);
        await page.fill(idSelector, "");
        await page.locator(idSelector).pressSequentially(input.idCode, { delay: 40 });
      } catch {
        // field not available — proceed with name-only search
      }
    }

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Ieškoti")',
      'button:has-text("Search")',
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        await page.click(selector, { timeout: 3_000 });
        submitted = true;
        break;
      } catch {
        // try next
      }
    }

    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    await page
      .waitForLoadState("load", { timeout: RESULT_TIMEOUT })
      .catch(() => {});
    // Wait for AngularJS to re-render results after filtering
    await page.waitForTimeout(2_500);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const { status, resultsCount, matchedEntities, summaryText } =
      parseAvntResults(bodyText, input.borrowerName);

    return {
      providerKey: "avnt_insolvency",
      sourceUrl: finalUrl || AVNT_BASE_URL,
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
      providerKey: "avnt_insolvency",
      sourceUrl: AVNT_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `Search failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

function parseAvntResults(
  bodyText: string,
  borrowerName: string
): Pick<
  NormalizedCheckResult,
  "status" | "resultsCount" | "matchedEntities" | "summaryText"
> {
  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const matchedEntities = lines
    .filter((l) =>
      l.toLowerCase().includes(borrowerName.toLowerCase().split(" ")[0])
    )
    .slice(0, 10)
    .map((l) => ({ name: l }));

  // Primary signal: "Rodomi X - Y iš Z įrašų" (Showing X-Y of Z records)
  const countMatch = bodyText.match(
    /rodomi\s+\d+\s*[-–]\s*\d+\s+iš\s+(\d+)\s+įrašų/i
  );
  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    if (count === 0) {
      return {
        status: "no_match",
        resultsCount: 0,
        matchedEntities: [],
        summaryText: `No insolvency records found on AVNT for the name "${borrowerName}".`,
      };
    }
    if (count === 1) {
      return {
        status: "match_found",
        resultsCount: 1,
        matchedEntities,
        summaryText: `1 insolvency record found on AVNT matching "${borrowerName}".`,
      };
    }
    return {
      status: "ambiguous",
      resultsCount: count,
      matchedEntities,
      summaryText: `${count} insolvency records found on AVNT for "${borrowerName}". Manual review required.`,
    };
  }

  // Fallback: explicit no-result signals
  const lower = bodyText.toLowerCase();
  const noResultSignals = [
    "nerasta",
    "rezultatų nerasta",
    "nothing found",
    "no results",
    "0 įrašų",
    "0 records",
    "nėra duomenų",
  ];
  if (noResultSignals.some((s) => lower.includes(s))) {
    return {
      status: "no_match",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `No insolvency records found on AVNT for the name "${borrowerName}".`,
    };
  }

  // Fallback: keyword stems (handles Lithuanian inflection)
  const recordSignals = [
    "bankrot",
    "restruktūrizav",
    "nemokum",
    "insolvency",
    "bankruptcy",
  ];
  let recordCount = 0;
  for (const signal of recordSignals) {
    const regex = new RegExp(signal, "gi");
    const matches = bodyText.match(regex);
    if (matches) recordCount = Math.max(recordCount, matches.length);
  }

  if (recordCount === 0) {
    return {
      status: "ambiguous",
      resultsCount: 0,
      matchedEntities: [],
      summaryText:
        "Search page loaded but result could not be clearly parsed. " +
        "Please review the screenshot in the PDF.",
    };
  }

  return {
    status: "match_found",
    resultsCount: recordCount,
    matchedEntities,
    summaryText: `${recordCount} insolvency record(s) found on AVNT matching "${borrowerName}".`,
  };
}
