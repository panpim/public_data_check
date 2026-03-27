import { describe, it, expect } from "vitest";
import { parseKrzResults } from "@/providers/krz-insolvency/search";

// Simulated body text when KRZ returns no results
const NO_RESULTS_PAGE = `
Wyszukiwanie podmiotów
Podmiot niebędący osobą fizyczną
Nazwa podmiotu
KRS
Szukaj
Brak wyników wyszukiwania
`;

// Simulated body text with a single match
const ONE_RESULT_PAGE = `
Wyszukiwanie podmiotów
Podmiot niebędący osobą fizyczną
ABC SP. Z O.O.
KRS: 0000123456
Status: postępowanie restrukturyzacyjne
Rodz. postęp.: Przyspieszone postępowanie układowe
Wyświetlanie 1 - 1 z 1 wyników
`;

// Simulated body text with multiple matches
const MULTI_RESULT_PAGE = `
Wyszukiwanie podmiotów
ABC SP. Z O.O.
KRS: 0000123456
ABC HOLDING SP. Z O.O.
KRS: 0000654321
Wyświetlanie 1 - 2 z 2 wyników
`;

describe("parseKrzResults", () => {
  it("returns no_match when page shows no results", () => {
    const result = parseKrzResults(NO_RESULTS_PAGE, "ABC");
    expect(result.status).toBe("no_match");
    expect(result.resultsCount).toBe(0);
    expect(result.matchedEntities).toHaveLength(0);
  });

  it("returns match_found for single result", () => {
    const result = parseKrzResults(ONE_RESULT_PAGE, "ABC");
    expect(result.status).toBe("match_found");
    expect(result.resultsCount).toBe(1);
  });

  it("returns ambiguous for multiple results", () => {
    const result = parseKrzResults(MULTI_RESULT_PAGE, "ABC");
    expect(result.status).toBe("ambiguous");
    expect(result.resultsCount).toBe(2);
  });

  it("includes summary text mentioning the borrower name", () => {
    const result = parseKrzResults(ONE_RESULT_PAGE, "ABC SP. Z O.O.");
    expect(result.summaryText).toContain("ABC SP. Z O.O.");
  });
});
