import type { DefaultSession } from "next-auth";

export type CheckProviderKey = "avnt_insolvency";

export type ResultStatus = "no_match" | "match_found" | "ambiguous" | "error";

export interface RunCheckInput {
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;
  providerKey: CheckProviderKey;
}

export interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
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
}

export interface PublicCheckProvider {
  runSearch(input: RunCheckInput): Promise<NormalizedCheckResult>;
}

// Extend next-auth Session to carry the user's Google access token
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
