import { Worker, type Job } from 'bullmq';
import Anthropic from '@anthropic-ai/sdk';
import { getWorkerRedisClient } from '../lib/redis';
import { AUDIT_QUEUE_NAME, sendToDeadLetterQueue, type AuditJobPayload } from '../lib/queue';
import { getSupabaseAdminClient } from '../lib/supabase';
import {
    ContractClauseExtractionSchema,
    type ContractTerm,
    type BillingRecord,
    type ReconciliationFinding,
    type AnomalySeverity,
} from '../types/contract';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219';
const EXTRACTION_TOOL_NAME = 'record_contract_clauses';

const extractionTool: Anthropic.Tool = {
    name: EXTRACTION_TOOL_NAME,
    description:
          'Record the structured clauses extracted from a signed contract, including volume discount tiers, SLA penalty terms, unit pricing, and renewal clauses.',
    input_schema: {
          type: 'object',
          properties: {
                  clauses: {
                            type: 'array',
                            items: {
                                        type: 'object',
                                        properties: {
                                                      termType: {
                                                                      type: 'string',
                                                                      enum: ['volume_discount', 'sla_penalty', 'unit_price', 'renewal_clause', 'custom'],
                                                      },
                                                      clauseText: { type: 'string' },
                                                      structuredValue: {
                                                                      type: 'object',
                                                                      description:
                                                                                        'Numeric or boolean facts extracted from the clause, for example threshold and discountPercent for a volume_discount, or penaltyPercent and breachCondition for an sla_penalty.',
                                                      },
                                                      confidence: {
                                                                      type: 'number',
                                                                      description: 'Model confidence in this extraction, from 0 to 1.',
                                                      },
                                        },
                                        required: ['termType', 'clauseText', 'structuredValue', 'confidence'],
                            },
                  },
          },
          required: ['clauses'],
    },
};

/**
 * Ask Claude to extract structured clauses from the contract's plain text.
 *
 * Document text extraction, meaning downloading the signed envelope from
 * DocuSign and converting it to plain text, is handled upstream by the
 * ingestion pipeline and stored on contract.metadata.extractedText; this
 * worker only performs clause-level reasoning over already-extracted text.
 */
async function extractContractClauses(contractText: string) {
    const response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 4096,
          tools: [extractionTool],
          tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
          messages: [
            {
                      role: 'user',
                      content: [
                                  'Extract every volume discount tier, SLA penalty clause, unit price, and renewal clause from the following contract text.',
                                  'Be exhaustive and include every threshold, percentage, price, and condition mentioned. Assign a confidence score between 0 and 1 to each extracted clause.',
                                  '',
                                  contractText,
                                ].join('\n'),
            },
                ],
    });

  const toolUseBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

  if (!toolUseBlock) {
        throw new Error('Claude did not return a tool_use block for contract clause extraction.');
  }

  return ContractClauseExtractionSchema.parse(toolUseBlock.input);
}

// ---------- Row to domain type mapping ----------
// supabase-js returns raw Postgres rows in snake_case, matching
// supabase/schema.sql. The exported TypeScript interfaces in
// src/types/contract.ts use camelCase for application code, so we map
// between the two at the data-access boundary rather than mixing naming
// conventions throughout the business logic below.

function mapContractTermRow(row: Record<string, unknown>): ContractTerm {
    return {
          id: row.id as string,
          organizationId: row.organization_id as string,
          contractId: row.contract_id as string,
          termType: row.term_type as ContractTerm['termType'],
          clauseText: row.clause_text as string,
          structuredValue: (row.structured_value as Record<string, unknown>) ?? {},
          confidence: Number(row.confidence),
          extractedBy: row.extracted_by as string,
          createdAt: row.created_at as string,
    };
}

function mapBillingRecordRow(row: Record<string, unknown>): BillingRecord {
    return {
          id: row.id as string,
          organizationId: row.organization_id as string,
          contractId: (row.contract_id as string | null) ?? null,
          invoiceNumber: row.invoice_number as string,
          lineItem: row.line_item as string,
          billedAmountCents: Number(row.billed_amount_cents),
          expectedAmountCents:
                  row.expected_amount_cents === null ? null : Number(row.expected_amount_cents),
          billingPeriodStart: row.billing_period_start as string,
          billingPeriodEnd: row.billing_period_end as string,
          rawPayload: (row.raw_payload as Record<string, unknown>) ?? {},
          createdAt: row.created_at as string,
    };
}

function getNumberField(source: Record<string, unknown>, key: string): number | null {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getBooleanField(source: Record<string, unknown>, key: string): boolean {
    return source[key] === true;
}

function severityForLeakedCents(leakedCents: number): AnomalySeverity {
    if (leakedCents >= 100_000) return 'critical';
    if (leakedCents >= 25_000) return 'high';
    if (leakedCents >= 1_000) return 'medium';
    return 'low';
}

/**
 * Compare extracted contract terms against historical billing records to
 * detect revenue leakage: volume discounts that were never applied to an
 * invoice, and SLA penalty credits that were owed but not issued.
 *
 * Usage quantities and SLA breach flags are read defensively from each
 * billing record's rawPayload, since that payload's shape is defined by
 * whichever upstream billing system produced the invoice, not by this
 * application.
 */
function reconcileBillingAgainstTerms(
    terms: ContractTerm[],
    billingRecords: BillingRecord[]
  ): ReconciliationFinding[] {
    const findings: ReconciliationFinding[] = [];

  const volumeDiscountTerms = terms.filter((term) => term.termType === 'volume_discount');
    const slaPenaltyTerms = terms.filter((term) => term.termType === 'sla_penalty');

  for (const record of billingRecords) {
        const grossAmountCents = getNumberField(record.rawPayload, 'grossAmountCents');
        const usageQuantity = getNumberField(record.rawPayload, 'usageQuantity');
        const slaBreach = getBooleanField(record.rawPayload, 'slaBreach');

      if (grossAmountCents === null) {
              continue;
      }

      for (const term of volumeDiscountTerms) {
              const threshold = getNumberField(term.structuredValue, 'threshold');
              const discountPercent = getNumberField(term.structuredValue, 'discountPercent');

          if (
                    threshold !== null &&
                    discountPercent !== null &&
                    usageQuantity !== null &&
                    usageQuantity >= threshold
                  ) {
                    const expectedCents = Math.round(grossAmountCents * (1 - discountPercent / 100));
                    const leakedCents = record.billedAmountCents - expectedCents;

                if (leakedCents > 0) {
                            findings.push({
                                          anomalyType: 'unapplied_volume_discount',
                                          severity: severityForLeakedCents(leakedCents),
                                          leakedAmountCents: leakedCents,
                                          explanation: `Usage of ${usageQuantity} met the ${threshold}-unit threshold for a ${discountPercent}% volume discount on invoice ${record.invoiceNumber}, but the billed amount does not reflect it.`,
                                          evidence: {
                                                          billingRecordId: record.id,
                                                          contractTermId: term.id,
                                                          invoiceNumber: record.invoiceNumber,
                                                          grossAmountCents,
                                                          expectedCents,
                                                          billedAmountCents: record.billedAmountCents,
                                                          usageQuantity,
                                                          threshold,
                                                          discountPercent,
                                          },
                            });
                }
          }
      }

      for (const term of slaPenaltyTerms) {
              const penaltyPercent = getNumberField(term.structuredValue, 'penaltyPercent');

          if (penaltyPercent !== null && slaBreach) {
                    const expectedCents = Math.round(grossAmountCents * (1 - penaltyPercent / 100));
                    const leakedCents = record.billedAmountCents - expectedCents;

                if (leakedCents > 0) {
                            findings.push({
                                          anomalyType: 'sla_penalty_missing',
                                          severity: severityForLeakedCents(leakedCents),
                                          leakedAmountCents: leakedCents,
                                          explanation: `An SLA breach was recorded on invoice ${record.invoiceNumber}, but the ${penaltyPercent}% penalty credit was not applied to the billed amount.`,
                                          evidence: {
                                                          billingRecordId: record.id,
                                                          contractTermId: term.id,
                                                          invoiceNumber: record.invoiceNumber,
                                                          grossAmountCents,
                                                          expectedCents,
                                                          billedAmountCents: record.billedAmountCents,
                                                          penaltyPercent,
                                          },
                            });
                }
          }
      }
  }

  return findings;
}

async function persistFindings(
    organizationId: string,
    contractId: string,
    findings: ReconciliationFinding[]
  ): Promise<void> {
    if (findings.length === 0) {
          return;
    }

  const supabase = getSupabaseAdminClient();

  const rows = findings.map((finding) => ({
        organization_id: organizationId,
        contract_id: contractId,
        billing_record_id: (finding.evidence.billingRecordId as string) ?? null,
        anomaly_type: finding.anomalyType,
        severity: finding.severity,
        status: 'open',
        leaked_amount_cents: finding.leakedAmountCents,
        evidence: finding.evidence,
        claude_explanation: finding.explanation,
  }));

  const { error } = await supabase.from('audit_anomalies').insert(rows);

  if (error) {
        throw new Error(`Failed to persist audit anomalies: ${error.message}`);
  }
}

async function processAuditJob(job: Job<AuditJobPayload>): Promise<void> {
    const { organizationId, contractId, envelopeId } = job.data;
    const supabase = getSupabaseAdminClient();

  const { data: contractRow, error: contractError } = await supabase
      .from('contracts')
      .select('id, metadata')
      .eq('id', contractId)
      .eq('organization_id', organizationId)
      .single();

  if (contractError || !contractRow) {
        throw new Error(
                `Unable to load contract ${contractId} for organization ${organizationId}: ${
                          contractError?.message ?? 'not found'
                }`
              );
  }

  const metadata = (contractRow.metadata as Record<string, unknown>) ?? {};
    const contractText = typeof metadata.extractedText === 'string' ? metadata.extractedText : '';

  if (!contractText) {
        throw new Error(
                `Contract ${contractId} has no extractedText in metadata; the ingestion pipeline must populate this before auditing can run.`
              );
  }

  const extraction = await extractContractClauses(contractText);

  if (extraction.clauses.length > 0) {
        const termRows = extraction.clauses.map((clause) => ({
                organization_id: organizationId,
                contract_id: contractId,
                term_type: clause.termType,
                clause_text: clause.clauseText,
                structured_value: clause.structuredValue,
                confidence: clause.confidence,
                extracted_by: `claude:${CLAUDE_MODEL}`,
        }));

      const { error: insertTermsError } = await supabase.from('contract_terms').insert(termRows);

      if (insertTermsError) {
              throw new Error(`Failed to persist extracted contract terms: ${insertTermsError.message}`);
      }
  }

  const { data: termRowsRaw, error: termsError } = await supabase
      .from('contract_terms')
      .select('*')
      .eq('contract_id', contractId);

  if (termsError) {
        throw new Error(`Failed to load contract terms: ${termsError.message}`);
  }

  const { data: billingRowsRaw, error: billingError } = await supabase
      .from('billing_records')
      .select('*')
      .eq('contract_id', contractId);

  if (billingError) {
        throw new Error(`Failed to load billing records: ${billingError.message}`);
  }

  const terms = (termRowsRaw ?? []).map(mapContractTermRow);
    const billingRecords = (billingRowsRaw ?? []).map(mapBillingRecordRow);

  const findings = reconcileBillingAgainstTerms(terms, billingRecords);

  await persistFindings(organizationId, contractId, findings);

  await supabase.from('audit_logs').insert({
        organization_id: organizationId,
        actor: 'audit-worker',
        action: 'audit_completed',
        target_table: 'contracts',
        target_id: contractId,
        detail: {
                envelopeId,
                clausesExtracted: extraction.clauses.length,
                findingsCount: findings.length,
        },
  });
}

/**
 * Entry point for the standalone worker process. This module is executed
 * as its own Node.js process, see the "worker" script in package.json and
 * Dockerfile.worker, and never shares memory, an event loop, or a Redis
 * connection with the Next.js web server.
 */
function startWorker(): Worker<AuditJobPayload> {
    const worker = new Worker<AuditJobPayload>(
          AUDIT_QUEUE_NAME,
          async (job) => {
                  await processAuditJob(job);
          },
      {
              connection: getWorkerRedisClient(),
              concurrency: 5,
      }
        );

  worker.on('completed', (job) => {
        // eslint-disable-next-line no-console
                console.info(`[auditWorker] completed job ${job.id} for contract ${job.data.contractId}`);
  });

  worker.on('failed', async (job, error) => {
        // eslint-disable-next-line no-console
                console.error(`[auditWorker] job ${job?.id} failed:`, error.message);

                if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
                        await sendToDeadLetterQueue(job.data, error.message, job.attemptsMade);
                }
  });

  worker.on('error', (error) => {
        // eslint-disable-next-line no-console
                console.error('[auditWorker] worker-level error:', error);
  });

  // eslint-disable-next-line no-console
  console.info(`[auditWorker] listening on queue "${AUDIT_QUEUE_NAME}"`);

  return worker;
}

startWorker();
