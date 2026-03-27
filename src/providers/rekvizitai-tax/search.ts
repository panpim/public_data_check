import { chromium } from "playwright";
import { navigateToCompanyProfile } from "@/providers/rekvizitai/navigate";
import type {
  NormalizedCheckResult,
  RunCheckInput,
  TaxComplianceData,
} from "@/lib/types";

const REKVIZITAI_URL = "https://rekvizitai.vz.lt/";

export async function runTaxSearch(
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
      userAgent:
        "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "lt-LT",
    });

    const page = await context.newPage();

    await navigateToCompanyProfile(page, input.borrowerName, input.idCode);

    // Navigate to the dedicated debt sub-page (/skolos/) which shows current
    // VMI and Sodra debt totals directly rather than requiring regex on prose text.
    const profileUrl = page.url().replace(/\/?$/, "/");
    const skolosUrl = `${profileUrl}skolos/`;
    await page.goto(skolosUrl, { waitUntil: "load" });
    await page.waitForTimeout(1000);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const complianceData = parseTaxCompliance(bodyText);

    const status =
      complianceData.hasVmiDebt || complianceData.hasSodraDebt
        ? "non_compliant"
        : "compliant";

    return {
      providerKey: "rekvizitai_tax",
      sourceUrl: finalUrl || REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount: 0,
      matchedEntities: [],
      summaryText: buildTaxSummary(complianceData, input.borrowerName),
      screenshotBuffer,
      complianceData,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      providerKey: "rekvizitai_tax",
      sourceUrl: REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `Tax compliance check failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse VMI and Sodra debt totals from the rekvizitai.vz.lt /skolos/ sub-page.
 *
 * The page contains two labelled sections:
 *   "Įmonės skola VMI"   → "Pradelsta nepriemoka iš viso  737 304,10 Eur"
 *   "Įmonės skola Sodrai"→ "Skolos suma iš viso  15 730,83 Eur"
 *
 * A non-zero amount in either section means the company currently has that debt.
 *
 * Exported for unit testing.
 */
export function parseTaxCompliance(bodyText: string): TaxComplianceData {
  // VMI total — appears inside the "Įmonės skola VMI" section
  const vmiMatch = bodyText.match(
    /Įmonės\s+skola\s+VMI[\s\S]{0,400}?Pradelsta\s+nepriemoka\s+iš\s+viso\s+([\d\s,.]+)\s*Eur/i
  );

  // Sodra total — appears inside the "Įmonės skola Sodrai" section.
  // Note: "Skolos suma iš viso" also appears earlier for company debts (Juris LT),
  // so we anchor specifically to the Sodrai section header.
  const sodraMatch = bodyText.match(
    /Įmonės\s+skola\s+Sodrai[\s\S]{0,400}?Skolos\s+suma\s+iš\s+viso\s+([\d\s,.]+)\s*Eur/i
  );

  const vmiTotal = vmiMatch ? parseAmountValue(vmiMatch[1]) : 0;
  const sodraTotal = sodraMatch ? parseAmountValue(sodraMatch[1]) : 0;

  return {
    hasVmiDebt: vmiTotal > 0,
    hasSodraDebt: sodraTotal > 0,
    vmiDebtAmount: vmiTotal > 0 ? `${vmiMatch![1].trim()} Eur` : undefined,
    sodraDebtAmount: sodraTotal > 0 ? `${sodraMatch![1].trim()} Eur` : undefined,
  };
}

function parseAmountValue(raw: string): number {
  // "737 304,10" → 737304.10 ; "0" → 0
  return parseFloat(raw.replace(/\s/g, "").replace(",", ".")) || 0;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function buildTaxSummary(
  data: TaxComplianceData,
  borrowerName: string
): string {
  if (!data.hasVmiDebt && !data.hasSodraDebt) {
    return `"${borrowerName}" has no VMI or Sodra debt — tax and social security compliant.`;
  }

  const parts: string[] = [];
  if (data.hasVmiDebt) {
    parts.push(
      data.vmiDebtAmount ? `VMI debt: ${data.vmiDebtAmount}` : "VMI debt present"
    );
  }
  if (data.hasSodraDebt) {
    parts.push(
      data.sodraDebtAmount
        ? `Sodra debt: ${data.sodraDebtAmount}`
        : "Sodra debt present"
    );
  }
  return `"${borrowerName}" has outstanding debts: ${parts.join("; ")}.`;
}
