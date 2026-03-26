import { Badge } from "@/components/ui/badge";
import type { ResultStatus } from "@/lib/types";

interface Props {
  providerLabel: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
}

const STATUS_CONFIG: Record<
  ResultStatus,
  {
    label: string;
    variant: "default" | "destructive" | "outline" | "secondary";
    className?: string;
  }
> = {
  no_match: {
    label: "NO RECORD FOUND",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  match_found: { label: "RECORD FOUND", variant: "destructive" },
  ambiguous: {
    label: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    variant: "outline",
    className: "border-amber-500 bg-amber-500 text-white",
  },
  error: { label: "TECHNICAL ERROR", variant: "outline" },
  qualified: {
    label: "QUALIFIED",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  not_qualified: {
    label: "NOT QUALIFIED",
    variant: "destructive",
  },
  compliant: {
    label: "COMPLIANT",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  non_compliant: {
    label: "NON-COMPLIANT",
    variant: "destructive",
  },
};

export function ResultCard({
  providerLabel,
  status,
  resultsCount,
  summaryText,
}: Props) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.error;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {providerLabel}
      </p>
      <div className="flex items-center gap-3">
        <Badge
          variant={config.variant}
          className={`text-xs font-bold tracking-wide px-3 py-1${config.className ? ` ${config.className}` : ""}`}
        >
          {config.label}
        </Badge>
        {resultsCount > 0 && (
          <span className="text-sm text-muted-foreground">
            {resultsCount} {resultsCount === 1 ? "result" : "results"}
          </span>
        )}
      </div>
      <p className="text-sm">{summaryText}</p>
    </div>
  );
}
