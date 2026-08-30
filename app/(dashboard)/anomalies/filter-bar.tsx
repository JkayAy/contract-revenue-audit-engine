"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ANOMALY_SEVERITIES,
  ANOMALY_STATUSES,
  ANOMALY_TYPES,
} from "@/types/contract";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ANOMALY_TYPE_LABELS: Record<string, string> = {
  unapplied_volume_discount: "Unapplied volume discount",
  sla_penalty_missing: "Missing SLA penalty",
  overbilling: "Overbilling",
  underbilling: "Underbilling",
  other: "Other",
};

const selectClassName =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AnomalyFilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentStatus = searchParams.get("status") ?? "";
  const currentSeverity = searchParams.get("severity") ?? "";
  const currentType = searchParams.get("type") ?? "";

  const navigate = useCallback(
    (params: URLSearchParams) => {
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [pathname, router]
  );

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      navigate(params);
    },
    [navigate, searchParams]
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("status");
    params.delete("severity");
    params.delete("type");
    navigate(params);
  }, [navigate, searchParams]);

  const hasActiveFilters = Boolean(currentStatus || currentSeverity || currentType);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background p-3",
        isPending && "opacity-70"
      )}
    >
      <div className="flex items-center gap-2">
        <label htmlFor="status-filter" className="text-sm font-medium text-muted-foreground">
          Status
        </label>
        <select
          id="status-filter"
          className={selectClassName}
          value={currentStatus}
          onChange={(event) => setParam("status", event.target.value)}
        >
          <option value="">All</option>
          {ANOMALY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="severity-filter" className="text-sm font-medium text-muted-foreground">
          Severity
        </label>
        <select
          id="severity-filter"
          className={selectClassName}
          value={currentSeverity}
          onChange={(event) => setParam("severity", event.target.value)}
        >
          <option value="">All</option>
          {ANOMALY_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severity.charAt(0).toUpperCase() + severity.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="type-filter" className="text-sm font-medium text-muted-foreground">
          Type
        </label>
        <select
          id="type-filter"
          className={selectClassName}
          value={currentType}
          onChange={(event) => setParam("type", event.target.value)}
        >
          <option value="">All</option>
          {ANOMALY_TYPES.map((type) => (
            <option key={type} value={type}>
              {ANOMALY_TYPE_LABELS[type] ?? type}
            </option>
          ))}
        </select>
      </div>

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
