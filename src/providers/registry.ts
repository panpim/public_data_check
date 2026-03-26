import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";
import { RekvizitaiSmeProvider } from "./rekvizitai-sme";
import { RekvizitaiTaxProvider } from "./rekvizitai-tax";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
  rekvizitai_sme: new RekvizitaiSmeProvider(),
  rekvizitai_tax: new RekvizitaiTaxProvider(),
};

function isCheckProviderKey(key: string): key is CheckProviderKey {
  return key in providers;
}

export function getProvider(key: string): PublicCheckProvider | null {
  if (!isCheckProviderKey(key)) return null;
  return providers[key];
}
