"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/utils";
import { dismissAnomaly, resolveAnomaly, type AnomalyActionResult } from "./actions";
import type { AnomalySeverity, AnomalyStatus, AnomalyType } from "@/types/contract";

export interface EvidenceClause {
  text: string;
  confidence: number;
}

export interface AnomalyRowData {
  id: string;
  contractCustomerName: string;
  anomalyType: AnomalyType;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  leakedAmountCents: number;
  claudeExplanation: string | null;
  evidence: { clauses?: EvidenceClause[] } | null;
  createdAt: string;
}

const SEVERITY_BADGE_VARIANT: Record<AnomalySeverity, "secondary" | "warning" | "destructive"> = {
  low: "secondary",
  medium: "secondary",
  high: "warning",
  critical: "destructive",
};

const STATUS_BADGE_VARIANT: Record<AnomalyStatus, "warning" | "success" | "outline"> = {
  open: "warning",
  resolved: "success",
  dismissed: "outline",
};

const ANOMALY_TYPE_LABELS: Record<AnomalyType, string> = {
  unapplied_volume_discount: "Unapplied volume discount",
  sla_penalty_missing: "Missing SLA penalty",
  overbilling: "Overbilling",
  underbilling: "Underbilling",
  other: "Other",
};

function confidenceToBackground(confidence: number): string {
  const alpha = Math.min(Math.max(confidence, 0), 1) * 0.5;
  return `rgba(239, 68, 68, ${alpha.toFixed(2)})`;
}

export function AnomalyRow({ anomaly }: { anomaly: AnomalyRowData }) {
  const [expanded, setExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const isOpen = anomaly.status === "open";
  const clauses = anomaly.evidence?.clauses ?? [];

  function handleAction(action: (id: string) => Promise<AnomalyActionResult>) {
    setActionError(null);
    startTransition(async () => {
      const result = await action(anomaly.id);
      if (!result.success) {
        setActionError(result.error ?? "Something went wrong.");
      }
    });
  }

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{anomaly.contractCustomerName}</TableCell>
        <TableCell>{ANOMALY_TYPE_LABELS[anomaly.anomalyType]}</TableCell>
        <TableCell>
          <Badge variant={SEVERITY_BADGE_VARIANT[anomaly.severity]}>{anomaly.severity}</Badge>
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_BADGE_VARIANT[anomaly.status]}>{anomaly.status}</Badge>
        </TableCell>
        <TableCell className="text-right">
          {formatCurrency(anomaly.leakedAmountCents / 100)}
        </TableCell>
        <TableCell>{formatDate(anomaly.createdAt)}</TableCell>
        <TableCell className="text-right">
          <div className="flex flex-col items-end gap-1">
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)}>
                {expanded ? "Hide evidence" : "View evidence"}
              </Button>
              {isOpen && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    onClick={() => handleAction(resolveAnomaly)}
                  >
                    Resolve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isPending}
                    onClick={() => handleAction(dismissAnomaly)}
                  >
                    Dismiss
                  </Button>
                </>
              )}
            </div>
            {actionError && <span className="text-xs text-destructive">{actionError}</span>}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30">
            <div className="space-y-2 py-2">
              {anomaly.claudeExplanation && (
                <p className="text-sm text-foreground">{anomaly.claudeExplanation}</p>
              )}
              {clauses.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">
                    Evidence confidence heatmap
                  </p>
                  {clauses.map((clause, index) => (
                    <div
                      key={index}
                      className="rounded-md border border-border p-2 text-sm"
                      style={{ backgroundColor: confidenceToBackground(clause.confidence) }}
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {Math.round(clause.confidence * 100)}% confidence
                      </span>
                      <p>{clause.text}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No structured evidence recorded.</p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
