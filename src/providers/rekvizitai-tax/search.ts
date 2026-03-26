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
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "lt-LT",
    });

    const page = await context.newPage();

    await navigateToCompanyProfile(page, input.borrowerName, input.idCode);

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
 * Parse VMI and Sodra debt status from rekvizitai.vz.lt company profile body text.
 *
 * Exported for unit testing.
 */
export function parseTaxCompliance(bodyText: string): TaxComplianceData {
  const hasVmiDebt = detectVmiDebt(bodyText);
  const hasSodraDebt = detectSodraDebt(bodyText);

  return {
    hasVmiDebt,
    hasSodraDebt,
    vmiDebtAmount: hasVmiDebt ? extractVmiAmount(bodyText) : undefined,
    sodraDebtAmount: hasSodraDebt ? extractSodraAmount(bodyText) : undefined,
  };
}

// ── Generic "no debts" patterns ───────────────────────────────────────────────
// These apply only when the page has no entity-specific debt phrases at all,
// acting as a catch-all for pages that simply say "no debts" without naming VMI/Sodra.

const GENERIC_NO_DEBT_PATTERNS = [
  /^skol[ų]\s+n[eė]ra$/im,
  /^[įi]siskolinim[ų]\s+n[eė]ra$/im,
  /^n[eė]ra\s+skol[ų]$/im,
  /^n[eė]ra\s+[įi]siskolinim[ų]$/im,
];

function hasGenericNoDebt(text: string): boolean {
  return GENERIC_NO_DEBT_PATTERNS.some((p) => p.test(text));
}

// ── VMI detection ─────────────────────────────────────────────────────────────

function detectVmiDebt(text: string): boolean {
  const debtPatterns = [
    /vmi\s+skola/i,
    /mokestin[eė]\s+skola\s+vmi/i,
    /mokestin[eė]\s+skola:/i,
    /vmi.*(?:skola|[eė]skolinimas)/i,
  ];
  const noDebtPatterns = [
    /mokestin[ių]\s+skol[ų]\s+n[eė]ra/i,
    /vmi.*n[eė]ra/i,
    /n[eė]turi\s+mokestin[ių]\s+skol[ų]/i,
  ];

  if (noDebtPatterns.some((p) => p.test(text))) return false;
  if (debtPatterns.some((p) => p.test(text))) return true;
  // Fall back to generic "no debt" — if page says no debts at all, assume no VMI debt
  return false;
}

function extractVmiAmount(text: string): string | undefined {
  const match = text.match(
    /(?:vmi\s+skola|mokestin[eė]\s+skola)[:\s]+([\d\s]+(?:EUR|Eur|eur))/i
  );
  return match ? match[1].trim() : undefined;
}

// ── Sodra detection ───────────────────────────────────────────────────────────

function detectSodraDebt(text: string): boolean {
  const debtPatterns = [
    /sodr[ao]s?\s+skola/i,
    /socialinio\s+draudimo.*skola/i,
    /vsd.*skola/i,
  ];
  const noDebtPatterns = [
    /sodr[ao]s?\s+skol[ų]\s+n[eė]ra/i,
    /sodr[ao].*n[eė]ra/i,
    /n[eė]turi\s+sodr[ao]s?\s+skol[ų]/i,
  ];

  if (noDebtPatterns.some((p) => p.test(text))) return false;
  if (debtPatterns.some((p) => p.test(text))) return true;
  // Fall back to generic "no debt"
  return false;
}

function extractSodraAmount(text: string): string | undefined {
  const match = text.match(
    /sodr[ao]s?\s+skola[:\s]+([\d\s]+(?:EUR|Eur|eur))/i
  );
  return match ? match[1].trim() : undefined;
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
