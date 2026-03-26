import { runSmeSearch } from "./search";
import type { PublicCheckProvider, RunCheckInput, NormalizedCheckResult } from "@/lib/types";

export class RekvizitaiSmeProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runSmeSearch(input);
  }
}
