import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
};

function isCheckProviderKey(key: string): key is CheckProviderKey {
  return key in providers;
}

export function getProvider(key: string): PublicCheckProvider | null {
  if (!isCheckProviderKey(key)) return null;
  return providers[key];
}
