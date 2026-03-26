import { describe, it, expect } from "vitest";
import { parseTaxCompliance } from "@/providers/rekvizitai-tax/search";

describe("parseTaxCompliance", () => {
  it("returns no debt when page says no tax debts", () => {
    const result = parseTaxCompliance("Mokestinių skolų nėra\nSodros skolų nėra");
    expect(result.hasVmiDebt).toBe(false);
    expect(result.hasSodraDebt).toBe(false);
    expect(result.vmiDebtAmount).toBeUndefined();
    expect(result.sodraDebtAmount).toBeUndefined();
  });

  it("returns no debt when page says no debts (alternative text)", () => {
    const result = parseTaxCompliance("Skolų nėra\nĮsiskolinimų nėra");
    expect(result.hasVmiDebt).toBe(false);
    expect(result.hasSodraDebt).toBe(false);
  });

  it("detects VMI debt with amount", () => {
    const result = parseTaxCompliance(
      "VMI skola: 1 200 EUR\nSodros skolų nėra"
    );
    expect(result.hasVmiDebt).toBe(true);
    expect(result.vmiDebtAmount).toBe("1 200 EUR");
    expect(result.hasSodraDebt).toBe(false);
  });

  it("detects Sodra debt with amount", () => {
    const result = parseTaxCompliance(
      "Mokestinių skolų nėra\nSodros skola: 3 500 EUR"
    );
    expect(result.hasSodraDebt).toBe(true);
    expect(result.sodraDebtAmount).toBe("3 500 EUR");
    expect(result.hasVmiDebt).toBe(false);
  });

  it("detects both VMI and Sodra debt", () => {
    const result = parseTaxCompliance(
      "VMI skola: 5 000 EUR\nSodros skola: 2 100 EUR"
    );
    expect(result.hasVmiDebt).toBe(true);
    expect(result.hasSodraDebt).toBe(true);
    expect(result.vmiDebtAmount).toBe("5 000 EUR");
    expect(result.sodraDebtAmount).toBe("2 100 EUR");
  });

  it("detects VMI debt without amount when debt exists but no figure shown", () => {
    const result = parseTaxCompliance("Mokestinė skola VMI\nSodros skolų nėra");
    expect(result.hasVmiDebt).toBe(true);
    expect(result.vmiDebtAmount).toBeUndefined();
  });
});
