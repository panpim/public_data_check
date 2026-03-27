import { runKrzSearch } from "./search";
import type {
  PublicCheckProvider,
  RunCheckInput,
  NormalizedCheckResult,
} from "@/lib/types";

export class KrzInsolvencyProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runKrzSearch(input);
  }
}
