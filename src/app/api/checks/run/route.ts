import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getProvider } from "@/providers/registry";
import { generateEvidencePdf } from "@/services/evidence";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";
import type {
  RunCheckInput,
  NormalizedCheckResult,
  CheckProviderKey,
  SearchType,
} from "@/lib/types";

const REKVIZITAI_KEYS: CheckProviderKey[] = ["rekvizitai_sme", "rekvizitai_tax"];

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    borrowerName,
    idCode,
    loanReference,
    driveFolderUrl,
    searchType = "individual" as SearchType,
    providerKeys,
  } = body;

  if (!borrowerName?.trim()) {
    return NextResponse.json(
      { error: "borrowerName is required" },
      { status: 400 }
    );
  }

  const folderId = extractFolderIdFromUrl(driveFolderUrl ?? "");
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

  for (const key of providerKeys as string[]) {
    if (!getProvider(key)) {
      return NextResponse.json(
        { error: `Unknown provider: ${key}` },
        { status: 400 }
      );
    }
    if (
      searchType === "individual" &&
      REKVIZITAI_KEYS.includes(key as CheckProviderKey)
    ) {
      return NextResponse.json(
        {
          error: `Provider "${key}" is only available for legal entity searches`,
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
    initiatedByEmail: session.user.email,
    searchType: searchType as SearchType,
    providerKeys: providerKeys as CheckProviderKey[],
  };

  try {
    const results: NormalizedCheckResult[] = await Promise.all(
      (providerKeys as string[]).map(async (key) => {
        const provider = getProvider(key)!;
        try {
          return await provider.runSearch(input);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            providerKey: key as CheckProviderKey,
            sourceUrl: "",
            searchedAt: new Date().toISOString(),
            borrowerNameInput: input.borrowerName,
            status: "error",
            resultsCount: 0,
            matchedEntities: [],
            summaryText: `Search failed: ${message}`,
          } satisfies NormalizedCheckResult;
        }
      })
    );

    const safeName = input.borrowerName
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
            createdByEmail: session.user.email!,
            borrowerName: input.borrowerName,
            borrowerIdCode: input.idCode,
            loanReference: input.loanReference,
            providerKey: result.providerKey,
            driveFolderUrl,
            runGroupId,
            searchType: input.searchType,
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
