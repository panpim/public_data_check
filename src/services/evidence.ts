/**
 * Evidence PDF generator — multi-provider combined output
 */
import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";
import type {
  NormalizedCheckResult,
  RunCheckInput,
  ResultStatus,
} from "@/lib/types";

const BRAND_BLUE = rgb(0.07, 0.27, 0.55);
const GREY = rgb(0.4, 0.4, 0.4);
const BLACK = rgb(0, 0, 0);
const RED = rgb(0.75, 0.1, 0.1);
const GREEN = rgb(0.07, 0.52, 0.18);
const ORANGE = rgb(0.85, 0.45, 0.0);
const WHITE = rgb(1, 1, 1);

export async function generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],
  filename: string,
  runGroupId: string
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── Page 1: Cover / Run Summary ────────────────────────────────────────────
  const cover = doc.addPage(PageSizes.A4);
  const { width, height } = cover.getSize();
  const margin = 50;
  let y = height - margin;

  // Header bar
  cover.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: BRAND_BLUE });
  cover.drawText("Public Registry Check — Evidence Report", {
    x: margin, y: height - 45, font: bold, size: 16, color: WHITE,
  });

  y = height - 110;

  // Run Information
  drawSection(cover, bold, "Run Information", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Borrower name:", sanitizeForPdf(input.borrowerName), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "ID code:", sanitizeForPdf(input.idCode ?? "(not provided)"), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Search type:", input.searchType === "legal_entity" ? "Legal entity" : "Individual", margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Initiated by:", sanitizeForPdf(input.initiatedByEmail), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Run group ID:", runGroupId, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Evidence filename:", sanitizeForPdf(filename), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Generated:", formatDate(new Date().toISOString()), margin, y);
  y -= 30;

  // Summary table: one row per provider
  drawSection(cover, bold, "Check Summary", margin, y, width - margin * 2);
  y -= 24;

  // Table header
  const col1 = margin;
  const col2 = margin + 190;
  const col3 = margin + 320;
  cover.drawText("PROVIDER", { x: col1, y, font: bold, size: 8, color: GREY });
  cover.drawText("STATUS", { x: col2, y, font: bold, size: 8, color: GREY });
  cover.drawText("SUMMARY", { x: col3, y, font: bold, size: 8, color: GREY });
  y -= 4;
  cover.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, color: GREY, thickness: 0.5 });
  y -= 14;

  for (const result of results) {
    const statusColor = getStatusColor(result.status);
    const statusLabel = getStatusLabel(result.status);
    const providerLabel = getProviderLabel(result.providerKey);

    // Provider name
    cover.drawText(sanitizeForPdf(providerLabel), { x: col1, y, font: regular, size: 8, color: BLACK });

    // Status badge (colored rectangle)
    const badgeWidth = 110;
    cover.drawRectangle({ x: col2, y: y - 10, width: badgeWidth, height: 16, color: statusColor });
    cover.drawText(statusLabel, { x: col2 + 4, y: y - 4, font: bold, size: 7, color: WHITE });

    // Summary (truncated to fit)
    const summaryLines = wrapText(sanitizeForPdf(result.summaryText), 38);
    cover.drawText(summaryLines[0] ?? "", { x: col3, y, font: regular, size: 7, color: BLACK });
    if (summaryLines[1]) {
      cover.drawText(summaryLines[1], { x: col3, y: y - 10, font: regular, size: 7, color: BLACK });
    }

    y -= 30;
    if (y < margin + 30) break;
  }

  // Footer
  cover.drawLine({
    start: { x: margin, y: margin + 20 },
    end: { x: width - margin, y: margin + 20 },
    color: GREY, thickness: 0.5,
  });
  cover.drawText(
    `Run Group: ${runGroupId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
    { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
  );

  // ── Pages 2+: One detail section per provider (in input order) ─────────────
  for (const result of results) {
    const detailPage = doc.addPage(PageSizes.A4);
    const { width: pw, height: ph } = detailPage.getSize();
    let dy = ph - margin;

    // Page header bar
    detailPage.drawRectangle({ x: 0, y: ph - 50, width: pw, height: 50, color: BRAND_BLUE });
    detailPage.drawText(getProviderLabel(result.providerKey), {
      x: margin, y: ph - 32, font: bold, size: 13, color: WHITE,
    });

    dy = ph - 80;

    // Status badge
    const statusColor = getStatusColor(result.status);
    const statusLabel = getStatusLabel(result.status);
    detailPage.drawRectangle({ x: margin, y: dy - 24, width: pw - margin * 2, height: 30, color: statusColor });
    detailPage.drawText(statusLabel, {
      x: margin + 10, y: dy - 10, font: bold, size: 12, color: WHITE,
    });
    dy -= 44;

    // Summary text
    const summaryLines = wrapText(sanitizeForPdf(result.summaryText), 90);
    for (const line of summaryLines) {
      detailPage.drawText(line, { x: margin, y: dy, font: regular, size: 9, color: BLACK });
      dy -= 14;
    }
    dy -= 10;

    if (result.status === "error") {
      // Error: nothing more to render
    } else if (result.providerKey === "avnt_insolvency" && result.matchedEntities.length > 0) {
      drawSection(detailPage, bold, "Matched Entities", margin, dy, pw - margin * 2);
      dy -= 20;
      for (const entity of result.matchedEntities.slice(0, 20)) {
        const line = [
          sanitizeForPdf(entity.name),
          entity.caseNumber ? `Case: ${entity.caseNumber}` : "",
          entity.status ?? "",
        ].filter(Boolean).join("  |  ");
        const wrapped = wrapText(line, 90);
        for (const wl of wrapped) {
          detailPage.drawText(`• ${wl}`, { x: margin + 8, y: dy, font: regular, size: 8, color: BLACK });
          dy -= 12;
        }
        if (dy < margin + 30) break;
      }
    } else if (result.providerKey === "rekvizitai_sme" && result.classification) {
      drawSection(detailPage, bold, "SME Classification", margin, dy, pw - margin * 2);
      dy -= 20;
      const c = result.classification;
      drawRow(detailPage, regular, bold, "Category:", getCategoryLabel(c.category), margin, dy);
      dy -= 18;
      drawRow(detailPage, regular, bold, "Employees:", c.employeesCount !== undefined ? String(c.employeesCount) : "N/A", margin, dy);
      dy -= 18;
      drawRow(detailPage, regular, bold, "Annual Revenue:", c.annualRevenue !== undefined ? `EUR ${c.annualRevenue.toLocaleString()}` : "N/A", margin, dy);
    } else if (result.providerKey === "rekvizitai_tax" && result.complianceData) {
      drawSection(detailPage, bold, "Tax & Social Security Compliance", margin, dy, pw - margin * 2);
      dy -= 20;
      const td = result.complianceData;
      drawRow(detailPage, regular, bold, "VMI Debt:", td.hasVmiDebt ? `YES${td.vmiDebtAmount ? ` — ${td.vmiDebtAmount}` : ""}` : "None", margin, dy);
      dy -= 18;
      drawRow(detailPage, regular, bold, "Sodra Debt:", td.hasSodraDebt ? `YES${td.sodraDebtAmount ? ` — ${td.sodraDebtAmount}` : ""}` : "None", margin, dy);
    }

    // Footer
    detailPage.drawLine({
      start: { x: margin, y: margin + 20 },
      end: { x: pw - margin, y: margin + 20 },
      color: GREY, thickness: 0.5,
    });
    detailPage.drawText(
      `Run Group: ${runGroupId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
      { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
    );
  }

  // ── Final pages: Screenshots (one per provider, grouped at end) ────────────
  for (const result of results) {
    if (!result.screenshotBuffer) continue;
    try {
      const screenshotPage = doc.addPage(PageSizes.A4);
      const { width: sw, height: sh } = screenshotPage.getSize();

      screenshotPage.drawText(`Screenshot — ${getProviderLabel(result.providerKey)}`, {
        x: margin, y: sh - margin - 16, font: bold, size: 12, color: BRAND_BLUE,
      });
      screenshotPage.drawText(`Source: ${result.sourceUrl}`, {
        x: margin, y: sh - margin - 32, font: regular, size: 8, color: GREY,
      });

      const pngImage = await doc.embedPng(result.screenshotBuffer);
      const imgDims = pngImage.scaleToFit(sw - margin * 2, sh - margin * 2 - 60);
      screenshotPage.drawImage(pngImage, {
        x: margin,
        y: sh - margin - 60 - imgDims.height,
        width: imgDims.width,
        height: imgDims.height,
      });
    } catch {
      // If embedding fails, skip this screenshot — other pages remain valid
    }
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function drawSection(
  page: ReturnType<PDFDocument["addPage"]>,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  title: string,
  x: number,
  y: number,
  sectionWidth: number
) {
  page.drawText(title.toUpperCase(), { x, y, font: bold, size: 9, color: BRAND_BLUE });
  page.drawLine({
    start: { x, y: y - 4 },
    end: { x: x + sectionWidth, y: y - 4 },
    color: BRAND_BLUE,
    thickness: 0.75,
  });
}

function drawRow(
  page: ReturnType<PDFDocument["addPage"]>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  label: string,
  value: string,
  x: number,
  y: number,
  valueFontSize = 9
) {
  page.drawText(label, { x, y, font: bold, size: 9, color: GREY });
  page.drawText(value, { x: x + 130, y, font: regular, size: valueFontSize, color: BLACK });
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC";
  } catch {
    return iso;
  }
}

function getProviderLabel(key: string): string {
  const labels: Record<string, string> = {
    avnt_insolvency: "AVNT Insolvency Register",
    rekvizitai_sme: "SME / Small Mid-Cap Classification",
    rekvizitai_tax: "Tax & Social Security Compliance",
  };
  return labels[key] ?? key;
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    sme: "SME (Small and Medium-sized Enterprise)",
    small_mid_cap: "Small Mid-Cap",
    neither: "Neither SME nor Small Mid-Cap",
    unknown: "Unknown (data not available)",
  };
  return labels[category] ?? category;
}

function getStatusColor(status: ResultStatus) {
  switch (status) {
    case "no_match":
    case "qualified":
    case "compliant":
      return GREEN;
    case "match_found":
    case "not_qualified":
    case "non_compliant":
      return RED;
    case "ambiguous":
      return ORANGE;
    default:
      return GREY;
  }
}

function getStatusLabel(status: ResultStatus): string {
  const labels: Record<ResultStatus, string> = {
    no_match: "NO RECORD FOUND",
    match_found: "RECORD FOUND",
    ambiguous: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    error: "TECHNICAL ERROR",
    qualified: "QUALIFIED",
    not_qualified: "NOT QUALIFIED",
    compliant: "COMPLIANT",
    non_compliant: "NON-COMPLIANT",
  };
  return labels[status] ?? status.toUpperCase();
}

function sanitizeForPdf(text: string): string {
  return text
    .replace(/[Ąą]/g, (c) => (c === c.toUpperCase() ? "A" : "a"))
    .replace(/[Čč]/g, (c) => (c === c.toUpperCase() ? "C" : "c"))
    .replace(/[Ęę]/g, (c) => (c === c.toUpperCase() ? "E" : "e"))
    .replace(/[Ėė]/g, (c) => (c === c.toUpperCase() ? "E" : "e"))
    .replace(/[Įį]/g, (c) => (c === c.toUpperCase() ? "I" : "i"))
    .replace(/[Šš]/g, (c) => (c === c.toUpperCase() ? "S" : "s"))
    .replace(/[Ųų]/g, (c) => (c === c.toUpperCase() ? "U" : "u"))
    .replace(/[Ūū]/g, (c) => (c === c.toUpperCase() ? "U" : "u"))
    .replace(/[Žž]/g, (c) => (c === c.toUpperCase() ? "Z" : "z"))
    .replace(/[^\x00-\xFF]/g, "?");
}
