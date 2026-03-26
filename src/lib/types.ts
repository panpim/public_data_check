import type { DefaultSession } from "next-auth";

export type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax";

export type SearchType = "individual" | "legal_entity";

export type ResultStatus =
  | "no_match"       // AVNT: no insolvency record found (green)
  | "match_found"    // AVNT: insolvency record found (red)
  | "ambiguous"      // AVNT only: multiple records, manual review needed (orange)
  | "error"          // any provider: search failed (grey)
  | "qualified"      // rekvizitai_sme: qualifies as SME or Small Mid-Cap (green)
  | "not_qualified"  // rekvizitai_sme: does not meet either tier (red)
  | "compliant"      // rekvizitai_tax: no VMI or Sodra debt (green)
  | "non_compliant"; // rekvizitai_tax: debt present (red)

export interface RunCheckInput {
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;
  searchType: SearchType;
  providerKeys: CheckProviderKey[];
}

export interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
}

export interface SmeClassification {
  category: "sme" | "small_mid_cap" | "neither" | "unknown";
  employeesCount?: number;
  annualRevenue?: number; // EUR
}

export interface TaxComplianceData {
  hasVmiDebt: boolean;
  hasSodraDebt: boolean;
  // Present only when the flag is true AND the site shows an amount
  vmiDebtAmount?: string;
  sodraDebtAmount?: string;
}

export interface NormalizedCheckResult {
  providerKey: CheckProviderKey;
  sourceUrl: string;
  searchedAt: string;
  borrowerNameInput: string;
  idCodeInput?: string;
  status: ResultStatus;
  resultsCount: number;
  matchedEntities: MatchedEntity[];
  summaryText: string;
  screenshotBuffer?: Buffer;
  classification?: SmeClassification;   // rekvizitai_sme only
  complianceData?: TaxComplianceData;   // rekvizitai_tax only
}

export interface PublicCheckProvider {
  runSearch(input: RunCheckInput): Promise<NormalizedCheckResult>;
}

declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
  }
}
