"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResultCard } from "./ResultCard";
import type { ResultStatus, SmeClassification, TaxComplianceData } from "@/lib/types";

type Country = "LT" | "PL";
type SearchType =
  | "individual"
  | "legal_entity"
  | "pl_company"
  | "pl_business_ind"
  | "pl_private_ind";

interface ProviderResult {
  providerKey: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
  matchedEntities: Array<{ name: string; caseNumber?: string; status?: string }>;
  classification?: SmeClassification;
  complianceData?: TaxComplianceData;
}

interface ApiResponse {
  runGroupId: string;
  results: ProviderResult[];
  driveUrl?: string;
  driveError?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  avnt_insolvency: "AVNT Insolvency Register",
  rekvizitai_sme: "SME / Small Mid-Cap Classification",
  rekvizitai_tax: "Tax & Social Security Compliance",
  krz_insolvency: "KRZ Insolvency Register",
};

const PL_SEARCH_TYPES: { value: SearchType; label: string }[] = [
  { value: "pl_company", label: "Podmiot (spółka / organizacja)" },
  { value: "pl_business_ind", label: "Osoba fizyczna – działalność gospodarcza" },
  { value: "pl_private_ind", label: "Osoba fizyczna – bez działalności" },
];

interface CheckFormProps {
  country: Country;
}

export function CheckForm({ country }: CheckFormProps) {
  const isLT = country === "LT";

  const [borrowerName, setBorrowerName] = useState("");
  const [idCode, setIdCode] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");

  // LT: individual / legal_entity toggle
  const [ltSearchType, setLtSearchType] = useState<"individual" | "legal_entity">("individual");
  // PL: one of three entity types
  const [plSearchType, setPlSearchType] = useState<SearchType>("pl_company");

  // LT provider checkboxes
  const [avntChecked, setAvntChecked] = useState(true);
  const [smeChecked, setSmeChecked] = useState(false);
  const [taxChecked, setTaxChecked] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  function handleLtSearchTypeChange(type: "individual" | "legal_entity") {
    setLtSearchType(type);
    if (type === "individual") {
      setSmeChecked(false);
      setTaxChecked(false);
    } else {
      setSmeChecked(true);
      setTaxChecked(true);
    }
  }

  function getSearchType(): SearchType {
    return isLT ? ltSearchType : plSearchType;
  }

  function getSelectedProviderKeys(): string[] {
    if (!isLT) return ["krz_insolvency"];
    const keys: string[] = [];
    if (avntChecked) keys.push("avnt_insolvency");
    if (smeChecked) keys.push("rekvizitai_sme");
    if (taxChecked) keys.push("rekvizitai_tax");
    return keys;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const providerKeys = getSelectedProviderKeys();
    if (providerKeys.length === 0) {
      setError("Select at least one check to run.");
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch("/api/checks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          borrowerName: borrowerName || undefined,
          idCode,
          driveFolderUrl,
          searchType: getSearchType(),
          providerKeys,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "An unexpected error occurred");
        return;
      }
      setResponse(data);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const rekvizitaiDisabled = isLT && ltSearchType === "individual";

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">

        {/* Search type — LT: toggle buttons, PL: radio group */}
        <div className="space-y-2">
          <Label>Search Type</Label>
          {isLT ? (
            <div className="flex gap-2">
              <Button
                type="button"
                variant={ltSearchType === "individual" ? "default" : "outline"}
                size="sm"
                onClick={() => handleLtSearchTypeChange("individual")}
              >
                Individual
              </Button>
              <Button
                type="button"
                variant={ltSearchType === "legal_entity" ? "default" : "outline"}
                size="sm"
                onClick={() => handleLtSearchTypeChange("legal_entity")}
              >
                Legal entity
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              {PL_SEARCH_TYPES.map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="plSearchType"
                    value={value}
                    checked={plSearchType === value}
                    onChange={() => setPlSearchType(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* ID Code */}
        <div className="space-y-2">
          <Label htmlFor="idCode">
            {isLT && ltSearchType === "individual"
              ? "ID Code (optional)"
              : isLT
              ? "ID Code *"
              : "KRS / NIP / PESEL *"}
          </Label>
          <Input
            id="idCode"
            value={idCode}
            onChange={(e) => setIdCode(e.target.value)}
            placeholder={isLT ? "Company or person code" : "KRS, NIP or PESEL number"}
            required={!(isLT && ltSearchType === "individual")}
          />
        </div>

        {/* Borrower Name */}
        <div className="space-y-2">
          <Label htmlFor="borrowerName">
            {isLT && ltSearchType === "individual"
              ? "Borrower Name *"
              : "Borrower Name (optional)"}
          </Label>
          <Input
            id="borrowerName"
            value={borrowerName}
            onChange={(e) => setBorrowerName(e.target.value)}
            placeholder={isLT ? "e.g. Jonas Jonaitis" : "e.g. ABC Sp. z o.o."}
            required={isLT && ltSearchType === "individual"}
          />
        </div>

        {/* Checks to run */}
        <div className="space-y-2">
          <Label>Checks to Run</Label>
          {isLT ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={avntChecked}
                  onChange={(e) => setAvntChecked(e.target.checked)}
                  className="rounded"
                />
                AVNT Insolvency Register
              </label>
              <label className={`flex items-center gap-2 text-sm ${rekvizitaiDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  checked={smeChecked}
                  disabled={rekvizitaiDisabled}
                  onChange={(e) => setSmeChecked(e.target.checked)}
                  className="rounded"
                />
                SME / Small Mid-Cap Classification
                {rekvizitaiDisabled && (
                  <span className="text-xs text-muted-foreground">(legal entity only)</span>
                )}
              </label>
              <label className={`flex items-center gap-2 text-sm ${rekvizitaiDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  checked={taxChecked}
                  disabled={rekvizitaiDisabled}
                  onChange={(e) => setTaxChecked(e.target.checked)}
                  className="rounded"
                />
                Tax &amp; Social Security Compliance
                {rekvizitaiDisabled && (
                  <span className="text-xs text-muted-foreground">(legal entity only)</span>
                )}
              </label>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked
                  disabled
                  className="rounded"
                />
                KRZ Insolvency Register
              </label>
            </div>
          )}
        </div>

        {/* Google Drive Folder URL */}
        <div className="space-y-2">
          <Label htmlFor="driveFolderUrl">Google Drive Folder URL *</Label>
          <Input
            id="driveFolderUrl"
            value={driveFolderUrl}
            onChange={(e) => setDriveFolderUrl(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/..."
            required
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Running checks…" : "Run Checks"}
        </Button>
      </form>

      {/* Results */}
      {response && (
        <div className="space-y-4">
          {response.results.map((result) => (
            <ResultCard
              key={result.providerKey}
              providerLabel={PROVIDER_LABELS[result.providerKey] ?? result.providerKey}
              status={result.status}
              resultsCount={result.resultsCount}
              summaryText={result.summaryText}
            />
          ))}
          {response.driveUrl && (
            <a
              href={response.driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-500 hover:underline block"
            >
              View combined PDF in Drive →
            </a>
          )}
          {response.driveError && (
            <p className="text-sm text-destructive">
              Drive upload failed: {response.driveError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
