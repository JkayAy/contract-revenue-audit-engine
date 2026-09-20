/**
 * retrieval.ts
 *
 * Semantic retrieval layer for contract clauses using pgvector.
 *
 * The audit worker uses `findSimilarClauses` to surface contract terms that
 * are semantically related to a billing-record description, enabling the
 * reconciliation step to compare billing line items against relevant clauses
 * even when the exact clause text doesn't appear in the invoice.
 *
 * Embedding model: text-embedding-3-small (1536-dim, OpenAI-compatible).
 * Swap EMBEDDING_MODEL to "voyage-3" (1024-dim) by also updating the
 * vector column dimension in migration 002_pgvector.sql.
 */

import OpenAI from 'openai';
import { getSupabaseAdminClient } from './supabase';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL =
  (process.env.EMBEDDING_MODEL as string | undefined) ?? 'text-embedding-3-small';

/** Generate a 1536-dim embedding for `text`. */
export async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: 1536,
  });
  return response.data[0].embedding;
}

export interface SimilarClause {
  id: string;
  contractId: string;
  termType: string;
  clauseText: string;
  structuredValue: Record<string, unknown>;
  confidence: number;
  similarity: number;
}

/**
 * Find the `topK` contract_terms most semantically similar to `query`.
 *
 * Calls the `match_clauses` RPC defined in migration 002_pgvector.sql.
 * Results are ordered by cosine similarity (highest first).
 *
 * @param query        Natural-language query, e.g. a billing line item.
 * @param topK         Maximum results to return (default 5).
 * @param threshold    Minimum similarity (0-1, default 0.70).
 * @param contractId   Optional: restrict to a single contract.
 */
export async function findSimilarClauses(
  query: string,
  topK = 5,
  threshold = 0.70,
  contractId?: string,
): Promise<SimilarClause[]> {
  const queryEmbedding = await embed(query);
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase.rpc('match_clauses', {
    query_embedding: queryEmbedding,
    match_count: topK,
    match_threshold: threshold,
    p_contract_id: contractId ?? null,
  });

  if (error) {
    throw new Error(`match_clauses RPC failed: ${error.message}`);
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    contractId: row.contract_id as string,
    termType: row.term_type as string,
    clauseText: row.clause_text as string,
    structuredValue: (row.structured_value as Record<string, unknown>) ?? {},
    confidence: Number(row.confidence),
    similarity: Number(row.similarity),
  }));
}

/**
 * Store the embedding for a freshly-extracted contract term.
 *
 * Called by the audit worker immediately after inserting a new row in
 * contract_terms, so the vector is available for subsequent retrieval.
 */
export async function indexClauseEmbedding(
  clauseId: string,
  clauseText: string,
): Promise<void> {
  const embedding = await embed(clauseText);
  const supabase = getSupabaseAdminClient();

  const { error } = await supabase
    .from('contract_terms')
    .update({ embedding })
    .eq('id', clauseId);

  if (error) {
    throw new Error(`Failed to store clause embedding for ${clauseId}: ${error.message}`);
  }
}
