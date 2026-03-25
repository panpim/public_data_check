import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getProvider } from "@/providers/registry";
import { generateEvidencePdf } from "@/services/evidence";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";
import type { RunCheckInput, NormalizedCheckResult } from "@/lib/types";

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
    providerKey = "avnt_insolvency",
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

  const provider = getProvider(providerKey);
  if (!provider) {
    return NextResponse.json(
      { error: `Unknown provider: ${providerKey}` },
      { status: 400 }
    );
  }

  const input: RunCheckInput = {
    borrowerName: borrowerName.trim(),
    idCode: idCode?.trim() || undefined,
    loanReference: loanReference?.trim() || undefined,
    driveFolderUrl,
    initiatedByEmail: session.user.email,
    providerKey,
  };

  try {
    let result: NormalizedCheckResult;
    try {
      result = await provider.runSearch(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        providerKey,
        sourceUrl: "",
        searchedAt: new Date().toISOString(),
        borrowerNameInput: input.borrowerName,
        status: "error",
        resultsCount: 0,
        matchedEntities: [],
        summaryText: `Search failed: ${message}`,
      };
    }

    const safeName = input.borrowerName
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_\-.]/g, "_");
    const filename = `${providerKey}_${safeName}_${Date.now()}.pdf`;

    let pdfBuffer: Buffer | undefined;
    let pdfError: string | undefined;
    try {
      pdfBuffer = await generateEvidencePdf(input, result, filename);
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

    const run = await db.searchRun.create({
      data: {
        createdByEmail: session.user.email!,
        borrowerName: input.borrowerName,
        borrowerIdCode: input.idCode,
        loanReference: input.loanReference,
        providerKey,
        driveFolderUrl,
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
    });

    return NextResponse.json({
      runId: run.id,
      status: result.status,
      resultsCount: result.resultsCount,
      summaryText: result.summaryText,
      driveUrl: uploadedFileUrl,
      ...(driveError ? { driveError } : {}),
      ...(pdfError ? { driveError: `PDF generation failed: ${pdfError}` } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
