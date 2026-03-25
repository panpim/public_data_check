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

interface HistoryRow {
  id: string;
  createdAt: string;
  createdByEmail: string;
  borrowerName: string;
  providerKey: string;
  resultStatus: string;
  resultsCount: number;
  uploadedFileUrl: string | null;
}

const STATUS_BADGE: Record<
  string,
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
};

export function HistoryTable() {
  const [runs, setRuns] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/history?page=${p}&limit=${limit}`);
      const data = await res.json();
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
