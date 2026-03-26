"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResultStatus } from "@/lib/types";

interface HistoryRow {
  id: string;
  createdAt: string;
  createdByEmail: string;
  borrowerName: string;
  providerKey: string;
  resultStatus: ResultStatus;
  resultsCount: number;
  uploadedFileUrl: string | null;
}

const STATUS_BADGE: Record<
  ResultStatus,
  {
    label: string;
    variant: "default" | "destructive" | "outline" | "secondary";
    className?: string;
  }
> = {
  no_match: {
    label: "No match",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  match_found: { label: "Match", variant: "destructive" },
  ambiguous: {
    label: "Ambiguous",
    variant: "outline",
    className: "border-amber-500 bg-amber-500 text-white",
  },
  error: { label: "Error", variant: "outline" },
  qualified: {
    label: "Qualified",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  not_qualified: { label: "Not qualified", variant: "destructive" },
  compliant: {
    label: "Compliant",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  non_compliant: { label: "Non-compliant", variant: "destructive" },
};

export function HistoryTable() {
  const [runs, setRuns] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const limit = 20;

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/history?page=${p}&limit=${limit}`);
      const data = await res.json();
      if (!res.ok) {
        setFetchError(data.error ?? "Failed to load history");
        return;
      }
      setRuns(data.runs ?? []);
      setTotal(data.total ?? 0);
      setPage(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage(1);
  }, [fetchPage]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} run{total !== 1 ? "s" : ""} total
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchPage(page - 1)}
            disabled={page <= 1 || loading}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchPage(page + 1)}
            disabled={page >= totalPages || loading}
          >
            Next
          </Button>
        </div>
      </div>

      {fetchError && (
        <p className="text-sm text-destructive text-center py-4">{fetchError}</p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Borrower</TableHead>
              <TableHead>Registry</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>By</TableHead>
              <TableHead>PDF</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  {loading ? "Loading…" : "No checks run yet"}
                </TableCell>
              </TableRow>
            )}
            {runs.map((run) => {
              const badge =
                STATUS_BADGE[run.resultStatus] ?? {
                  label: run.resultStatus,
                  variant: "outline" as const,
                };
              return (
                <TableRow key={run.id}>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {new Date(run.createdAt).toLocaleDateString("en-GB")}
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    {run.borrowerName}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground uppercase">
                    {run.providerKey.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant} className={`text-xs${badge.className ? ` ${badge.className}` : ""}`}>
                      {badge.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {run.createdByEmail.split("@")[0]}
                  </TableCell>
                  <TableCell>
                    {run.uploadedFileUrl ? (
                      <a
                        href={run.uploadedFileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open PDF for ${run.borrowerName}`}
                        className="text-blue-500 hover:underline text-sm"
                      >
                        ↗
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
