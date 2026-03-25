import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
};

export function getProvider(key: string): PublicCheckProvider | null {
  return providers[key as CheckProviderKey] ?? null;
}
