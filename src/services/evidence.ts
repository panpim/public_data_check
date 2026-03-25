/**
 * Evidence PDF generator
 */
import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";
import { v4 as uuidv4 } from "uuid";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

const BRAND_BLUE = rgb(0.07, 0.27, 0.55);
const GREY = rgb(0.4, 0.4, 0.4);
const BLACK = rgb(0, 0, 0);
const RED = rgb(0.75, 0.1, 0.1);
const GREEN = rgb(0.07, 0.52, 0.18);
const ORANGE = rgb(0.85, 0.45, 0.0);

export async function generateEvidencePdf(
  input: RunCheckInput,
  result: NormalizedCheckResult,
  filename: string
): Promise<Buffer> {
  const requestId = uuidv4();
  const doc = await PDFDocument.create();

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const cover = doc.addPage(PageSizes.A4);
  const { width, height } = cover.getSize();
  const margin = 50;
  let y = height - margin;

  cover.drawRectangle({
    x: 0,
    y: height - 70,
    width,
    height: 70,
    color: BRAND_BLUE,
  });
  cover.drawText("Public Registry Check — Evidence Report", {
    x: margin,
    y: height - 45,
    font: bold,
    size: 16,
    color: rgb(1, 1, 1),
  });

  y = height - 110;

  drawSection(cover, bold, "Run Information", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Search type:", getProviderLabel(result.providerKey), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Source name:", "AVNT Insolvency Register", margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Search timestamp:", formatDate(result.searchedAt), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Initiated by:", sanitizeForPdf(input.initiatedByEmail), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Request ID:", requestId, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Evidence filename:", sanitizeForPdf(filename), margin, y);
  y -= 30;

  drawSection(cover, bold, "Search Input", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Borrower name:", sanitizeForPdf(input.borrowerName), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "ID code:", sanitizeForPdf(input.idCode ?? "(not provided)"), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Loan reference:", sanitizeForPdf(input.loanReference ?? "(not provided)"), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Source URL:", result.sourceUrl, margin, y, 9);
  y -= 30;

  drawSection(cover, bold, "Search Result", margin, y, width - margin * 2);
  y -= 20;

  const statusColor =
    result.status === "no_match"
      ? GREEN
      : result.status === "match_found"
      ? RED
      : result.status === "ambiguous"
      ? ORANGE
      : GREY;

  const statusLabel: Record<string, string> = {
    no_match: "NO RECORD FOUND",
    match_found: "RECORD FOUND",
    ambiguous: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    error: "TECHNICAL ERROR",
  };

  cover.drawRectangle({
    x: margin,
    y: y - 28,
    width: width - margin * 2,
    height: 34,
    color: statusColor,
  });
  cover.drawText(statusLabel[result.status] ?? result.status.toUpperCase(), {
    x: margin + 12,
    y: y - 14,
    font: bold,
    size: 14,
    color: rgb(1, 1, 1),
  });
  y -= 48;

  drawRow(cover, regular, bold, "Results count:", String(result.resultsCount), margin, y);
  y -= 18;

  const summaryLines = wrapText(sanitizeForPdf(result.summaryText), 90);
  cover.drawText("Summary:", { x: margin, y, font: bold, size: 9, color: GREY });
  y -= 14;
  for (const line of summaryLines) {
    cover.drawText(line, { x: margin + 10, y, font: regular, size: 9, color: BLACK });
    y -= 13;
  }
  y -= 10;

  if (result.matchedEntities.length > 0) {
    drawSection(cover, bold, "Matched Entities", margin, y, width - margin * 2);
    y -= 20;
    for (const entity of result.matchedEntities.slice(0, 20)) {
      const entityLine = [sanitizeForPdf(entity.name), entity.caseNumber ? `Case: ${entity.caseNumber}` : "", entity.status ?? ""]
        .filter(Boolean)
        .join("  |  ");
      const wrapped = wrapText(entityLine, 90);
      for (const line of wrapped) {
        cover.drawText(`• ${line}`, { x: margin + 8, y, font: regular, size: 8, color: BLACK });
        y -= 12;
      }
      if (y < margin + 50) break;
    }
  }

  cover.drawLine({
    start: { x: margin, y: margin + 20 },
    end: { x: width - margin, y: margin + 20 },
    color: GREY,
    thickness: 0.5,
  });
  cover.drawText(
    `Generated: ${formatDate(new Date().toISOString())}   |   Request ID: ${requestId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
    { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
  );

  if (result.screenshotBuffer) {
    try {
      const screenshotPage = doc.addPage(PageSizes.A4);
      const { width: sw, height: sh } = screenshotPage.getSize();

      screenshotPage.drawText("Search Results Screenshot", {
        x: margin,
        y: sh - margin - 16,
        font: bold,
        size: 12,
        color: BRAND_BLUE,
      });
      screenshotPage.drawText(`Source: ${result.sourceUrl}`, {
        x: margin,
        y: sh - margin - 32,
        font: regular,
        size: 8,
        color: GREY,
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
      // If embedding fails skip — cover page still valid
    }
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

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
    avnt_insolvency: "Insolvency check — AVNT",
  };
  return labels[key] ?? key;
}

/**
 * Transliterate Lithuanian and other non-WinAnsi characters so pdf-lib's
 * standard Helvetica font (which uses WinAnsiEncoding / Latin-1) can render them.
 */
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
