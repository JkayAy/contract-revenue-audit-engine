import { z } from 'zod';

// ---------- Enums ----------

export const CONTRACT_STATUSES = ['pending_review', 'active', 'expired', 'terminated'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_TERM_TYPES = [
    'volume_discount',
    'sla_penalty',
    'unit_price',
    'renewal_clause',
    'custom',
  ] as const;
export type ContractTermType = (typeof CONTRACT_TERM_TYPES)[number];

export const ANOMALY_TYPES = [
    'unapplied_volume_discount',
    'sla_penalty_missing',
    'overbilling',
    'underbilling',
    'other',
  ] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

export const ANOMALY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

export const ANOMALY_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

  // ---------- Core domain types (mirror supabase/schema.sql) ----------

export interface Organization {
    id: string;
    name: string;
    slug: string;
    docusignAccountId: string | null;
    hubspotPortalId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface Contract {
    id: string;
    organizationId: string;
    externalEnvelopeId: string;
    customerName: string;
    status: ContractStatus;
    effectiveDate: string | null;
    expirationDate: string | null;
    rawDocumentUrl: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface ContractTerm {
    id: string;
    organizationId: string;
    contractId: string;
    termType: ContractTermType;
    clauseText: string;
    structuredValue: Record<string, unknown>;
    confidence: number;
    extractedBy: string;
    createdAt: string;
}

  export interface BillingRecord {
      id: string;
      organizationId: string;
      contractId: string | null;
      invoiceNumber: string;
      lineItem: string;
      billedAmountCents: number;
      expectedAmountCents: number | null;
      billingPeriodStart: string;
      billingPeriodEnd: string;
      rawPayload: Record<string, unknown>;
      createdAt: string;
  }

export interface AuditAnomaly {
    id: string;
    organizationId: string;
    contractId: string;
    billingRecordId: string | null;
    anomalyType: AnomalyType;
    severity: AnomalySeverity;
    status: AnomalyStatus;
    leakedAmountCents: number;
    evidence: Record<string, unknown>;
    claudeExplanation: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface AuditLog {
    id: string;
    organizationId: string;
    actor: string;
    action: string;
    targetTable: string;
    targetId: string | null;
    detail: Record<string, unknown>;
    createdAt: string;
}

  // ---------- Zod schemas for runtime validation ----------

export const jsonRecordSchema = z.record(z.string(), z.unknown());

export const organizationSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
    docusignAccountId: z.string().nullable(),
    hubspotPortalId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

export const contractSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    externalEnvelopeId: z.string().min(1),
    customerName: z.string().min(1),
    status: z.enum(CONTRACT_STATUSES),
    effectiveDate: z.string().nullable(),
    expirationDate: z.string().nullable(),
    rawDocumentUrl: z.string().url().nullable(),
    metadata: jsonRecordSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
});

  export const contractTermSchema = z.object({
      id: z.string().uuid(),
      organizationId: z.string().uuid(),
      contractId: z.string().uuid(),
      termType: z.enum(CONTRACT_TERM_TYPES),
      clauseText: z.string().min(1),
      structuredValue: jsonRecordSchema,
      confidence: z.number().min(0).max(1),
      extractedBy: z.string().min(1),
      createdAt: z.string(),
  });

export const billingRecordSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    contractId: z.string().uuid().nullable(),
    invoiceNumber: z.string().min(1),
    lineItem: z.string().min(1),
    billedAmountCents: z.number().int(),
    expectedAmountCents: z.number().int().nullable(),
    billingPeriodStart: z.string(),
    billingPeriodEnd: z.string(),
    rawPayload: jsonRecordSchema,
    createdAt: z.string(),
});

export const auditAnomalySchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    contractId: z.string().uuid(),
    billingRecordId: z.string().uuid().nullable(),
    anomalyType: z.enum(ANOMALY_TYPES),
    severity: z.enum(ANOMALY_SEVERITIES),
    status: z.enum(ANOMALY_STATUSES),
    leakedAmountCents: z.number().int().nonnegative(),
    evidence: jsonRecordSchema,
    claudeExplanation: z.string().nullable(),
    resolvedBy: z.string().uuid().nullable(),
    resolvedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

export const auditLogSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    actor: z.string().min(1),
    action: z.string().min(1),
    targetTable: z.string().min(1),
    targetId: z.string().uuid().nullable(),
    detail: jsonRecordSchema,
    createdAt: z.string(),
});

// ---------- Claude extraction schema ----------
// This is what we ask Claude to return when extracting clauses from a
// freshly-ingested contract. It intentionally mirrors ContractTerm but
// omits server-generated fields (id, organizationId, contractId, createdAt).

export const ContractClauseSchema = z.object({
    termType: z.enum(CONTRACT_TERM_TYPES),
    clauseText: z.string().min(1),
    structuredValue: jsonRecordSchema,
    confidence: z.number().min(0).max(1),
});

export type ContractClause = z.infer<typeof ContractClauseSchema>;

export const ContractClauseExtractionSchema = z.object({
    clauses: z.array(ContractClauseSchema),
});

export type ContractClauseExtraction = z.infer<typeof ContractClauseExtractionSchema>;

// ---------- Reconciliation finding shape (worker output) ----------

export const ReconciliationFindingSchema = z.object({
    anomalyType: z.enum(ANOMALY_TYPES),
    severity: z.enum(ANOMALY_SEVERITIES),
    leakedAmountCents: z.number().int().nonnegative(),
    explanation: z.string().min(1),
    evidence: jsonRecordSchema,
});

export type ReconciliationFinding = z.infer<typeof ReconciliationFindingSchema>;
