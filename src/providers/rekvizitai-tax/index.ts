import type { PublicCheckProvider } from "@/lib/types";
import { runTaxSearch } from "./search";

export class RekvizitaiTaxProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runTaxSearch(input);
  }
}
