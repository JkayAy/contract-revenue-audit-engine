import { Suspense } from "react";
import { AlertTriangle, TrendingDown } from "lucide-react";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { DEMO_ORGANIZATION_ID } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AnomalyFilterBar } from "./filter-bar";
import { AnomalyRow, type AnomalyRowData } from "./anomaly-row";
import type { AnomalySeverity, AnomalyStatus, AnomalyType } from "@/types/contract";

export const dynamic = "force-dynamic";

interface AnomaliesPageProps {
  searchParams: {
    status?: string;
    severity?: string;
    type?: string;
  };
}

interface AnomalyQueryRow {
  id: string;
  anomaly_type: AnomalyType;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  leaked_amount_cents: number;
  claude_explanation: string | null;
  evidence: Record<string, unknown> | null;
  created_at: string;
  contracts: { customer_name: string } | null;
}

async function getAnomalies(searchParams: AnomaliesPageProps["searchParams"]) {
  const supabase = getSupabaseAdminClient();

  let query = supabase
    .from("audit_anomalies")
    .select(
      "id, anomaly_type, severity, status, leaked_amount_cents, claude_explanation, evidence, created_at, contracts(customer_name)"
    )
    .eq("organization_id", DEMO_ORGANIZATION_ID)
    .order("created_at", { ascending: false });

  if (searchParams.status) {
    query = query.eq("status", searchParams.status);
  }
  if (searchParams.severity) {
    query = query.eq("severity", searchParams.severity);
  }
  if (searchParams.type) {
    query = query.eq("anomaly_type", searchParams.type);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to load anomalies: ${error.message}`);
  }

  return (data ?? []) as unknown as AnomalyQueryRow[];
}

function mapAnomalyRow(row: AnomalyQueryRow): AnomalyRowData {
  return {
    id: row.id,
    contractCustomerName: row.contracts?.customer_name ?? "Unknown customer",
    anomalyType: row.anomaly_type,
    severity: row.severity,
    status: row.status,
    leakedAmountCents: row.leaked_amount_cents,
    claudeExplanation: row.claude_explanation,
    evidence: row.evidence as AnomalyRowData["evidence"],
    createdAt: row.created_at,
  };
}

export default async function AnomaliesPage({ searchParams }: AnomaliesPageProps) {
  const rows = await getAnomalies(searchParams);
  const anomalies = rows.map(mapAnomalyRow);

  const openCount = anomalies.filter((anomaly) => anomaly.status === "open").length;
  const totalLeakedCents = anomalies
    .filter((anomaly) => anomaly.status === "open")
    .reduce((sum, anomaly) => sum + anomaly.leakedAmountCents, 0);

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Revenue Audit Anomalies
        </h1>
        <p className="text-sm text-muted-foreground">
          Contract clauses reconciled against billing records by Claude, flagged for review.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-4">
          <AlertTriangle className="h-8 w-8 text-warning" aria-hidden="true" />
          <div>
            <p className="text-sm text-muted-foreground">Open anomalies</p>
            <p className="text-2xl font-semibold text-foreground">{openCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-4">
          <TrendingDown className="h-8 w-8 text-destructive" aria-hidden="true" />
          <div>
            <p className="text-sm text-muted-foreground">Unresolved revenue leakage</p>
            <p className="text-2xl font-semibold text-foreground">
              {formatCurrency(totalLeakedCents / 100)}
            </p>
          </div>
        </div>
      </div>

      <Suspense>
        <AnomalyFilterBar />
      </Suspense>

      <div className="rounded-lg border border-border">
        <Table>
          <TableCaption>
            {anomalies.length === 0
              ? "No anomalies match the current filters."
              : `Showing ${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"}.`}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Leaked amount</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {anomalies.map((anomaly) => (
              <AnomalyRow key={anomaly.id} anomaly={anomaly} />
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
