import { describe, it, expect } from "vitest";
import { parseTaxCompliance } from "@/providers/rekvizitai-tax/search";

// Minimal /skolos/ page fixtures that mirror the real page structure.
const NO_DEBT_PAGE = `
Įmonės skola VMI
Pradelsta nepriemoka iš viso
0 Eur
Pradelsta atidėta nepriemoka
0 Eur
Įmonės skola Sodrai
Skolos suma iš viso
0 Eur
Atidėta suma
0 Eur
`;

const VMI_DEBT_PAGE = `
Įmonės skola VMI
Pradelsta nepriemoka iš viso
737 304,10 Eur
Pradelsta atidėta nepriemoka
0 Eur
Įmonės skola Sodrai
Skolos suma iš viso
0 Eur
Atidėta suma
0 Eur
`;

const SODRA_DEBT_PAGE = `
Įmonės skola VMI
Pradelsta nepriemoka iš viso
0 Eur
Pradelsta atidėta nepriemoka
0 Eur
Įmonės skola Sodrai
Skolos suma iš viso
15 730,83 Eur
Atidėta suma
0 Eur
`;

const BOTH_DEBTS_PAGE = `
Įmonės skola VMI
Pradelsta nepriemoka iš viso
737 304,10 Eur
Pradelsta atidėta nepriemoka
0 Eur
Įmonės skola Sodrai
Skolos suma iš viso
15 730,83 Eur
Atidėta suma
0 Eur
`;

// The page also has a "Kitų įmonių paskelbtos skolos" section with its own
// "Skolos suma iš viso" line (which should NOT be mistaken for Sodra debt).
const OTHER_COMPANIES_DEBT_ONLY = `
Nauja Kitų įmonių paskelbtos skolos
Skolos suma iš viso
5 000 Eur
Įmonės skola VMI
Pradelsta nepriemoka iš viso
0 Eur
Įmonės skola Sodrai
Skolos suma iš viso
0 Eur
`;

describe("parseTaxCompliance (/skolos/ page format)", () => {
  it("returns no debt when both totals are 0", () => {
    const result = parseTaxCompliance(NO_DEBT_PAGE);
    expect(result.hasVmiDebt).toBe(false);
    expect(result.hasSodraDebt).toBe(false);
    expect(result.vmiDebtAmount).toBeUndefined();
    expect(result.sodraDebtAmount).toBeUndefined();
  });

  it("detects VMI debt and extracts amount", () => {
    const result = parseTaxCompliance(VMI_DEBT_PAGE);
    expect(result.hasVmiDebt).toBe(true);
    expect(result.vmiDebtAmount).toBe("737 304,10 Eur");
    expect(result.hasSodraDebt).toBe(false);
    expect(result.sodraDebtAmount).toBeUndefined();
  });

  it("detects Sodra debt and extracts amount", () => {
    const result = parseTaxCompliance(SODRA_DEBT_PAGE);
    expect(result.hasSodraDebt).toBe(true);
    expect(result.sodraDebtAmount).toBe("15 730,83 Eur");
    expect(result.hasVmiDebt).toBe(false);
    expect(result.vmiDebtAmount).toBeUndefined();
  });

  it("detects both VMI and Sodra debt simultaneously", () => {
    const result = parseTaxCompliance(BOTH_DEBTS_PAGE);
    expect(result.hasVmiDebt).toBe(true);
    expect(result.hasSodraDebt).toBe(true);
    expect(result.vmiDebtAmount).toBe("737 304,10 Eur");
    expect(result.sodraDebtAmount).toBe("15 730,83 Eur");
  });

  it("does not treat third-party company debts as Sodra debt", () => {
    // The page has a 'Kitų įmonių paskelbtos skolos' section with its own
    // 'Skolos suma iš viso' — it must not be confused with Sodra totals.
    const result = parseTaxCompliance(OTHER_COMPANIES_DEBT_ONLY);
    expect(result.hasSodraDebt).toBe(false);
    expect(result.hasVmiDebt).toBe(false);
  });

  it("returns no debt when page has no recognised sections", () => {
    const result = parseTaxCompliance("No relevant content here.");
    expect(result.hasVmiDebt).toBe(false);
    expect(result.hasSodraDebt).toBe(false);
  });
});
