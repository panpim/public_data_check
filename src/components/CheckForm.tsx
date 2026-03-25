"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ResultCard } from "./ResultCard";
import type { ResultStatus } from "@/lib/types";

interface CheckResult {
  runId: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
  driveUrl?: string;
  driveError?: string;
}

export function CheckForm() {
  const [borrowerName, setBorrowerName] = useState("");
  const [idCode, setIdCode] = useState("");
  const [loanReference, setLoanReference] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [providerKey, setProviderKey] = useState("avnt_insolvency");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/checks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          borrowerName,
          idCode: idCode || undefined,
          loanReference: loanReference || undefined,
          driveFolderUrl,
          providerKey,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "An unexpected error occurred");
        return;
      }

      setResult(data);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="borrowerName">Borrower Name *</Label>
          <Input
            id="borrowerName"
            value={borrowerName}
            onChange={(e) => setBorrowerName(e.target.value)}
            placeholder="e.g. UAB Pavyzdys"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="idCode">ID Code (optional)</Label>
          <Input
            id="idCode"
            value={idCode}
            onChange={(e) => setIdCode(e.target.value)}
            placeholder="Company or person code"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="loanReference">Loan Reference (optional)</Label>
          <Input
            id="loanReference"
            value={loanReference}
            onChange={(e) => setLoanReference(e.target.value)}
            placeholder="e.g. LOAN-2025-001"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="registry">Registry</Label>
          <Select value={providerKey} onValueChange={setProviderKey}>
            <SelectTrigger id="registry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="avnt_insolvency">
                AVNT Insolvency Register
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

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
          {loading ? "Running check…" : "Run Check"}
        </Button>
      </form>

      {result && (
        <ResultCard
          status={result.status}
          resultsCount={result.resultsCount}
          summaryText={result.summaryText}
          driveUrl={result.driveUrl}
          driveError={result.driveError}
        />
      )}
    </div>
  );
}
