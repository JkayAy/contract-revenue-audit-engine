"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { DEMO_ACTOR_LABEL, DEMO_ORGANIZATION_ID } from "@/lib/constants";
import type { AnomalyStatus } from "@/types/contract";

export interface AnomalyActionResult {
  success: boolean;
  error?: string;
}

async function updateAnomalyStatus(
  anomalyId: string,
  status: Extract<AnomalyStatus, "resolved" | "dismissed">
): Promise<AnomalyActionResult> {
  const supabase = getSupabaseAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from("audit_anomalies")
    .select("id, status")
    .eq("id", anomalyId)
    .eq("organization_id", DEMO_ORGANIZATION_ID)
    .single();

  if (fetchError || !existing) {
    return { success: false, error: "Anomaly not found for this organization." };
  }

  if (existing.status !== "open") {
    return { success: false, error: `Anomaly is already ${existing.status}.` };
  }

  const nowIso = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("audit_anomalies")
    .update({
      status,
      resolved_by: DEMO_ACTOR_LABEL,
      resolved_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", anomalyId)
    .eq("organization_id", DEMO_ORGANIZATION_ID);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  const { error: logError } = await supabase.from("audit_logs").insert({
    organization_id: DEMO_ORGANIZATION_ID,
    actor: DEMO_ACTOR_LABEL,
    action: status === "resolved" ? "anomaly.resolved" : "anomaly.dismissed",
    target_table: "audit_anomalies",
    target_id: anomalyId,
    detail: { previousStatus: existing.status, newStatus: status },
  });

  if (logError) {
    // Non-fatal: the anomaly update already succeeded. Surfacing this in
    // server logs (and Sentry, in production) rather than silently
    // dropping the audit trail entry.
    console.error("Failed to write audit log entry:", logError.message);
  }

  revalidatePath("/anomalies");
  return { success: true };
}

export async function resolveAnomaly(anomalyId: string): Promise<AnomalyActionResult> {
  return updateAnomalyStatus(anomalyId, "resolved");
}

export async function dismissAnomaly(anomalyId: string): Promise<AnomalyActionResult> {
  return updateAnomalyStatus(anomalyId, "dismissed");
}
