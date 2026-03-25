import { Badge } from "@/components/ui/badge";
import type { ResultStatus } from "@/lib/types";

interface Props {
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
  driveUrl?: string;
  driveError?: string;
}

const STATUS_CONFIG: Record<
  ResultStatus,
  {
    label: string;
    variant: "default" | "destructive" | "outline" | "secondary";
  }
> = {
  no_match: { label: "NO RECORD FOUND", variant: "default" },
  match_found: { label: "RECORD FOUND", variant: "destructive" },
  ambiguous: {
    label: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    variant: "secondary",
  },
  error: { label: "TECHNICAL ERROR", variant: "outline" },
};

export function ResultCard({
  status,
  resultsCount,
  summaryText,
  driveUrl,
  driveError,
}: Props) {
  const { label, variant } = STATUS_CONFIG[status] ?? STATUS_CONFIG.error;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Badge
          variant={variant}
          className="text-xs font-bold tracking-wide px-3 py-1"
        >
          {label}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {resultsCount} result(s)
        </span>
      </div>
      <p className="text-sm">{summaryText}</p>
      {driveUrl && (
        <a
          href={driveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-500 hover:underline"
        >
          View PDF in Drive →
        </a>
      )}
      {driveError && (
        <p className="text-sm text-destructive">
          Drive upload failed: {driveError}
        </p>
      )}
    </div>
  );
}
