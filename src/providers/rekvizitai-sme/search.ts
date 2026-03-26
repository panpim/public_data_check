import { chromium } from "playwright";
import { navigateToCompanyProfile } from "@/providers/rekvizitai/navigate";
import type {
  NormalizedCheckResult,
  RunCheckInput,
  SmeClassification,
} from "@/lib/types";

const REKVIZITAI_URL = "https://rekvizitai.vz.lt/";

export async function runSmeSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    // Stagger browser launch to avoid simultaneous socket contention with
    // the tax provider. SME goes first; tax waits 1 500 ms (see rekvizitai-tax).
    await new Promise((r) => setTimeout(r, 300));

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

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const classification = classifySme(bodyText);

    const status =
      classification.category === "sme" || classification.category === "small_mid_cap"
        ? "qualified"
        : "not_qualified";

    return {
      providerKey: "rekvizitai_sme",
      sourceUrl: finalUrl || REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount: 0,
      matchedEntities: [],
      summaryText: buildSmeSummary(classification, input.borrowerName),
      screenshotBuffer,
      classification,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      providerKey: "rekvizitai_sme",
      sourceUrl: REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `SME classification failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Classify a company as SME, Small Mid-Cap, neither, or unknown based on
 * employee count and annual revenue parsed from the page body text.
 *
 * Exported for unit testing.
 */
export function classifySme(bodyText: string): SmeClassification {
  const employeesCount = parseEmployees(bodyText);
  const annualRevenue = parseRevenue(bodyText);

  // Rule 1: Missing data → unknown (conservative: do not penalise)
  if (employeesCount === undefined || annualRevenue === undefined) {
    return { category: "unknown", employeesCount, annualRevenue };
  }

  // Rule 2: SME — both conditions must be met
  if (employeesCount < 250 && annualRevenue <= 50_000_000) {
    return { category: "sme", employeesCount, annualRevenue };
  }

  // Rule 3: Small Mid-Cap — both conditions must be met
  if (employeesCount < 500 && annualRevenue <= 100_000_000) {
    return { category: "small_mid_cap", employeesCount, annualRevenue };
  }

  // Rule 4: Neither tier satisfied
  return { category: "neither", employeesCount, annualRevenue };
}

function parseEmployees(text: string): number | undefined {
  const patterns = [
    /darbuotoj[uų]\s+skai[cč]ius[:\s]+(\d[\d\s]*)/i,
    /darbuotoj[uų]\s+sk\.[:\s]+(\d[\d\s]*)/i,
    /employees?[:\s]+(\d[\d\s]*)/i,
    /staff[:\s]+(\d[\d\s]*)/i,
    /personnel[:\s]+(\d[\d\s]*)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1].replace(/\s/g, ""), 10);
      if (!isNaN(num)) return num;
    }
  }
  return undefined;
}

function parseRevenue(text: string): number | undefined {
  // Patterns for "X mln. EUR", "X tūkst. EUR", or "X EUR" (with spaces as thousands sep)
  const patterns: Array<{ re: RegExp; multiplier: number }> = [
    {
      re: /apyvarta[:\s]+([\d\s,.]+)\s*mln\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000_000,
    },
    {
      re: /paja?mos[:\s]+([\d\s,.]+)\s*mln\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000_000,
    },
    {
      re: /apyvarta[:\s]+([\d\s,.]+)\s*tūkst\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000,
    },
    {
      re: /paja?mos[:\s]+([\d\s,.]+)\s*tūkst\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000,
    },
    {
      re: /apyvarta[:\s]+([\d\s]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
    {
      re: /paja?mos[:\s]+([\d\s]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
    {
      re: /revenue[:\s]+([\d\s,.]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
    {
      re: /turnover[:\s]+([\d\s,.]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
  ];

  for (const { re, multiplier } of patterns) {
    const match = text.match(re);
    if (match) {
      // Remove spaces (thousands separator) and replace all commas with dot
      const cleaned = match[1].replace(/\s/g, "").replace(/,/g, ".");
      const num = parseFloat(cleaned);
      if (!isNaN(num)) return Math.round(num * multiplier);
    }
  }
  return undefined;
}

function buildSmeSummary(
  classification: SmeClassification,
  borrowerName: string
): string {
  const name = borrowerName;
  switch (classification.category) {
    case "sme":
      return (
        `"${name}" qualifies as an SME ` +
        `(employees: ${classification.employeesCount}, ` +
        `revenue: €${formatRevenue(classification.annualRevenue)}).`
      );
    case "small_mid_cap":
      return (
        `"${name}" qualifies as a Small Mid-Cap ` +
        `(employees: ${classification.employeesCount}, ` +
        `revenue: €${formatRevenue(classification.annualRevenue)}).`
      );
    case "neither":
      return (
        `"${name}" does not qualify as SME or Small Mid-Cap ` +
        `(employees: ${classification.employeesCount}, ` +
        `revenue: €${formatRevenue(classification.annualRevenue)}).`
      );
    case "unknown":
      return (
        `SME classification could not be determined for "${name}" — ` +
        `${classification.employeesCount === undefined ? "employee count" : "revenue"} ` +
        `data not available on rekvizitai.vz.lt.`
      );
  }
}

function formatRevenue(revenue: number | undefined): string {
  if (revenue === undefined) return "N/A";
  if (revenue >= 1_000_000) return `${(revenue / 1_000_000).toFixed(1)}M`;
  if (revenue >= 1_000) return `${(revenue / 1_000).toFixed(0)}K`;
  return String(revenue);
}
