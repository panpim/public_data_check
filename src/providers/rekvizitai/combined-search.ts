/**
 * Combined rekvizitai runner — SME + Tax in a single browser session.
 *
 * Navigates to the company profile once, collects SME data, then navigates
 * to the /skolos/ sub-page and collects tax data. Saves one full Chromium
 * launch + navigation sequence compared to running the two providers separately.
 */
import { chromium } from "playwright";
import { navigateToCompanyProfile, screenshotCroppedAtRecommendations } from "@/providers/rekvizitai/navigate";
import { classifySme, buildSmeSummary } from "@/providers/rekvizitai-sme/search";
import { parseTaxCompliance, buildTaxSummary } from "@/providers/rekvizitai-tax/search";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

const REKVIZITAI_URL = "https://rekvizitai.vz.lt/";

export async function runRekvizitaiCombined(
  input: RunCheckInput
): Promise<{ sme: NormalizedCheckResult; tax: NormalizedCheckResult }> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "lt-LT",
    });

    const page = await context.newPage();

    await navigateToCompanyProfile(page, input.borrowerName, input.idCode);

    // ── SME: collect from the company profile page ──────────────────────────
    const smeScreenshot = await screenshotCroppedAtRecommendations(page);
    const smeUrl = page.url();
    const smeBody = await page.evaluate(() => document.body.innerText);

    const classification = classifySme(smeBody);
    const smeStatus =
      classification.category === "sme" || classification.category === "small_mid_cap"
        ? "qualified"
        : "not_qualified";

    const sme: NormalizedCheckResult = {
      providerKey: "rekvizitai_sme",
      sourceUrl: smeUrl || REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: smeStatus,
      resultsCount: 0,
      matchedEntities: [],
      summaryText: buildSmeSummary(classification, input.borrowerName || input.idCode || "unknown"),
      screenshotBuffer: smeScreenshot,
      classification,
    };

    // ── Tax: navigate to /skolos/ sub-page ──────────────────────────────────
    const profileUrl = page.url().replace(/\/?$/, "/");
    await page.goto(`${profileUrl}skolos/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1000);

    const taxScreenshot = await screenshotCroppedAtRecommendations(page);
    const taxUrl = page.url();
    const taxBody = await page.evaluate(() => document.body.innerText);

    const complianceData = parseTaxCompliance(taxBody);
    const taxStatus =
      complianceData.hasVmiDebt || complianceData.hasSodraDebt ? "non_compliant" : "compliant";

    const tax: NormalizedCheckResult = {
      providerKey: "rekvizitai_tax",
      sourceUrl: taxUrl || REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: taxStatus,
      resultsCount: 0,
      matchedEntities: [],
      summaryText: buildTaxSummary(complianceData, input.borrowerName || input.idCode || "unknown"),
      screenshotBuffer: taxScreenshot,
      complianceData,
    };

    return { sme, tax };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorResult = (providerKey: "rekvizitai_sme" | "rekvizitai_tax", label: string): NormalizedCheckResult => ({
      providerKey,
      sourceUrl: REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `${label} check failed: ${message}`,
    });
    return {
      sme: errorResult("rekvizitai_sme", "SME classification"),
      tax: errorResult("rekvizitai_tax", "Tax compliance"),
    };
  } finally {
    if (browser) await browser.close();
  }
}
