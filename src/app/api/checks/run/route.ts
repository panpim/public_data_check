import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getProvider } from "@/providers/registry";
import { runRekvizitaiCombined } from "@/providers/rekvizitai/combined-search";
import { generateEvidencePdf } from "@/services/evidence";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";
import type {
  RunCheckInput,
  NormalizedCheckResult,
  CheckProviderKey,
  SearchType,
} from "@/lib/types";

const VALID_SEARCH_TYPES: SearchType[] = [
  "individual",
  "legal_entity",
  "pl_company",
  "pl_business_ind",
  "pl_private_ind",
];

const LT_PROVIDERS = new Set<CheckProviderKey>([
  "avnt_insolvency",
  "rekvizitai_sme",
  "rekvizitai_tax",
]);
const PL_PROVIDERS = new Set<CheckProviderKey>(["krz_insolvency"]);

function deriveCountry(st: SearchType): "LT" | "PL" {
  return st === "pl_company" || st === "pl_business_ind" || st === "pl_private_ind"
    ? "PL"
    : "LT";
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const borrowerName = typeof body.borrowerName === "string" ? body.borrowerName : "";
  const idCode = typeof body.idCode === "string" ? body.idCode : undefined;
  const loanReference = typeof body.loanReference === "string" ? body.loanReference : undefined;
  const driveFolderUrl = typeof body.driveFolderUrl === "string" ? body.driveFolderUrl : "";
  const rawSearchType = body.searchType as string;
  if (!VALID_SEARCH_TYPES.includes(rawSearchType as SearchType)) {
    return NextResponse.json(
      { error: `Invalid searchType. Must be one of: ${VALID_SEARCH_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  const searchType = rawSearchType as SearchType;
  const country = deriveCountry(searchType);
  const allowedProviders = country === "PL" ? PL_PROVIDERS : LT_PROVIDERS;
  const providerKeys = body.providerKeys;

  if (searchType === "individual") {
    if (!borrowerName.trim()) {
      return NextResponse.json(
        { error: "borrowerName is required for individual searches" },
        { status: 400 }
      );
    }
  } else {
    if (!idCode?.trim()) {
      return NextResponse.json(
        { error: "idCode is required" },
        { status: 400 }
      );
    }
  }

  const folderId = extractFolderIdFromUrl(driveFolderUrl);
  if (!folderId) {
    return NextResponse.json(
      { error: "Invalid Google Drive folder URL" },
      { status: 400 }
    );
  }

  if (!Array.isArray(providerKeys) || providerKeys.length === 0) {
    return NextResponse.json(
      { error: "providerKeys must be a non-empty array" },
      { status: 400 }
    );
  }

  // Pass 1: all keys must be recognised
  for (const key of providerKeys as string[]) {
    if (!getProvider(key)) {
      return NextResponse.json(
        { error: `Unknown provider: ${key}` },
        { status: 400 }
      );
    }
  }

  // Pass 2: Provider must belong to the derived country
  for (const key of providerKeys as string[]) {
    if (!allowedProviders.has(key as CheckProviderKey)) {
      return NextResponse.json(
        {
          error: `Provider "${key}" is not available for ${country} searches`,
        },
        { status: 400 }
      );
    }
  }

  const runGroupId = crypto.randomUUID();

  const input: RunCheckInput = {
    borrowerName: borrowerName.trim(),
    idCode: idCode?.trim() || undefined,
    loanReference: loanReference?.trim() || undefined,
    driveFolderUrl,
    initiatedByEmail: session.user.email!,
    searchType: searchType as SearchType,
    providerKeys: providerKeys as CheckProviderKey[],
  };

  try {
    // Run providers sequentially to avoid launching multiple Chromium browsers
    // simultaneously, which causes socket exhaustion and navigation timeouts.
    // When both rekvizitai providers are requested, run them in a single shared
    // browser session to avoid navigating to the same company twice.
    const keys = providerKeys as string[];
    const hasSme = keys.includes("rekvizitai_sme");
    const hasTax = keys.includes("rekvizitai_tax");
    const useCombined = hasSme && hasTax;

    const results: NormalizedCheckResult[] = [];

    // Pre-fill rekvizitai results via the combined runner (one browser session).
    let combinedSme: NormalizedCheckResult | undefined;
    let combinedTax: NormalizedCheckResult | undefined;
    if (useCombined) {
      const combined = await runRekvizitaiCombined(input);
      combinedSme = combined.sme;
      combinedTax = combined.tax;
    }

    for (const key of keys) {
      if (key === "rekvizitai_sme" && combinedSme) {
        results.push(combinedSme);
        continue;
      }
      if (key === "rekvizitai_tax" && combinedTax) {
        results.push(combinedTax);
        continue;
      }
      const provider = getProvider(key)!;
      try {
        results.push(await provider.runSearch(input));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          providerKey: key as CheckProviderKey,
          sourceUrl: "",
          searchedAt: new Date().toISOString(),
          borrowerNameInput: input.borrowerName,
          status: "error",
          resultsCount: 0,
          matchedEntities: [],
          summaryText: `Search failed: ${message}`,
        } satisfies NormalizedCheckResult);
      }
    }

    const safeName = (input.borrowerName || input.idCode || "search")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-]/g, "-")
      .toLowerCase();
    const dateStr = new Date().toISOString().slice(0, 10);
    const shortId = runGroupId.replace(/-/g, "").slice(0, 8);
    const filename = `${safeName}-${dateStr}-${shortId}.pdf`;

    let pdfBuffer: Buffer | undefined;
    let pdfError: string | undefined;
    try {
      pdfBuffer = await generateEvidencePdf(input, results, filename, runGroupId);
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
    }

    let uploadedFileId: string | undefined;
    let uploadedFileUrl: string | undefined;
    let driveError: string | undefined;

    if (pdfBuffer) {
      try {
        const uploaded = await uploadFileToDrive(
          session.accessToken,
          folderId,
          filename,
          pdfBuffer
        );
        uploadedFileId = uploaded.fileId;
        uploadedFileUrl = uploaded.webViewLink;
      } catch (err) {
        driveError = err instanceof Error ? err.message : String(err);
      }
    }

    await Promise.all(
      results.map((result) =>
        db.searchRun.create({
          data: {
            createdByEmail: session.user!.email!,
            borrowerName: input.borrowerName,
            borrowerIdCode: input.idCode,
            loanReference: input.loanReference,
            providerKey: result.providerKey,
            driveFolderUrl,
            runGroupId,
            searchType: input.searchType,
            country,
            resultStatus: result.status,
            resultsCount: result.resultsCount,
            matchedSummary: result.summaryText,
            uploadedFileId,
            uploadedFileUrl,
            requestPayloadJson: JSON.stringify(input),
            normalizedResultJson: JSON.stringify({
              ...result,
              screenshotBuffer: undefined,
            }),
          },
        })
      )
    );

    return NextResponse.json({
      runGroupId,
      results: results.map((r) => ({
        providerKey: r.providerKey,
        status: r.status,
        resultsCount: r.resultsCount,
        summaryText: r.summaryText,
        matchedEntities: r.matchedEntities,
        classification: r.classification,
        complianceData: r.complianceData,
      })),
      driveUrl: uploadedFileUrl,
      ...(driveError
        ? { driveError }
        : pdfError
        ? { driveError: `PDF generation failed: ${pdfError}` }
        : {}),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
