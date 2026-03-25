import { runAvntSearch } from "./search";
import type {
  PublicCheckProvider,
  RunCheckInput,
  NormalizedCheckResult,
} from "@/lib/types";

export class AvntInsolvencyProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runAvntSearch(input);
  }
}
