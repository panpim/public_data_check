import { describe, it, expect } from "vitest";
import { classifySme } from "@/providers/rekvizitai-sme/search";

describe("classifySme", () => {
  it("returns unknown when employees data is missing", () => {
    const result = classifySme("Apyvarta: 5 000 000 EUR\nKita informacija");
    expect(result.category).toBe("unknown");
    expect(result.employeesCount).toBeUndefined();
  });

  it("returns unknown when revenue data is missing", () => {
    const result = classifySme("Darbuotojų skaičius: 50\nKita informacija");
    expect(result.category).toBe("unknown");
    expect(result.annualRevenue).toBeUndefined();
  });

  it("returns sme for employees < 250 and revenue <= 50M", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 50\nApyvarta: 5 000 000 EUR"
    );
    expect(result.category).toBe("sme");
    expect(result.employeesCount).toBe(50);
    expect(result.annualRevenue).toBe(5_000_000);
  });

  it("returns small_mid_cap when employees >= 250 but < 500 and revenue <= 100M", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 300\nApyvarta: 60 000 000 EUR"
    );
    expect(result.category).toBe("small_mid_cap");
    expect(result.employeesCount).toBe(300);
  });

  it("returns small_mid_cap when employees < 250 but revenue > 50M and <= 100M", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 200\nApyvarta: 80 000 000 EUR"
    );
    expect(result.category).toBe("small_mid_cap");
  });

  it("returns neither when both tiers are exceeded", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 600\nApyvarta: 150 000 000 EUR"
    );
    expect(result.category).toBe("neither");
  });

  it("parses revenue expressed in millions shorthand (mln.)", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 50\nApyvarta: 5 mln. EUR"
    );
    expect(result.category).toBe("sme");
    expect(result.annualRevenue).toBe(5_000_000);
  });

  it("parses revenue expressed in thousands shorthand (tūkst.)", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 10\nApyvarta: 500 tūkst. EUR"
    );
    expect(result.category).toBe("sme");
    expect(result.annualRevenue).toBe(500_000);
  });

  it("parses 'Darbuotojai\\t19 darbuotojų' key-value table format (actual Rekvizitai layout)", () => {
    // Rekvizitai shows: "\tDarbo laikas\tI-V 08:00-17:00\n\tDarbuotojai\t19 darbuotojų - apdraustųjų"
    // The old generic pattern matched the "0" from "17:00" across the newline to "Darbuotojai"
    const result = classifySme(
      "\tDarbo laikas\tI-V 08:00-17:00\n\tDarbuotojai\t19 darbuotojų - apdraustųjų\nApyvarta: 500 tūkst. EUR"
    );
    expect(result.employeesCount).toBe(19);
    expect(result.category).toBe("sme");
  });

  it("parses 'darbuotojų skaičius yra 19' sentence format (actual Rekvizitai layout)", () => {
    const result = classifySme(
      "įmonės darbuotojų skaičius yra 19. Apyvarta: 500 tūkst. EUR"
    );
    expect(result.employeesCount).toBe(19);
    expect(result.category).toBe("sme");
  });
});
