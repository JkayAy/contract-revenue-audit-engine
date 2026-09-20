-- Migration 002: pgvector semantic search for contract clauses
--
-- Adds vector embeddings to contract_terms so related clauses can be
-- retrieved by semantic similarity rather than exact keyword match.
-- The application generates embeddings via Anthropic's voyage-3 model
-- (or any OpenAI-compatible embeddings endpoint) and stores them here.
--
-- recall@k is measured offline in evals/clause-extraction.eval.ts by
-- comparing the top-k cosine-similarity results against the ground-truth
-- clause set.  Run `npm run eval:retrieval` to reproduce.
--
-- Depends on: 001_schema.sql (contract_terms table must exist)
-- Enabled in Supabase: Dashboard -> Database -> Extensions -> vector

-- Enable the pgvector extension (safe to run multiple times)
create extension if not exists vector with schema extensions;

-- Add an embedding column to contract_terms.
-- text-embedding-3-small produces 1536-dimensional vectors;
-- voyage-3 produces 1024-dimensional vectors.
-- We default to 1536 to be compatible with both.
alter table contract_terms
  add column if not exists embedding extensions.vector(1536);

-- IVFFlat index for approximate nearest-neighbour search.
-- lists = sqrt(row_count) is a sensible starting point; tune once
-- the table exceeds ~100k rows.  The index is on cosine distance
-- because voyage-3 and OpenAI embeddings are normalised.
create index if not exists idx_contract_terms_embedding
  on contract_terms
  using ivfflat (embedding extensions.vector_cosine_ops)
  with (lists = 50);

-- ---------------------------------------------------------------------------
-- RPC: match_clauses
--
-- Returns the k most semantically similar contract_terms rows for a query
-- embedding, scoped to the calling user's organization (RLS applies).
--
-- Parameters
--   query_embedding  The query vector (same dimension as the column).
--   match_count      Maximum rows to return (top-k).
--   match_threshold  Minimum cosine similarity (0-1); 0.7 is a sensible
--                    default for contract text.
--   p_contract_id    Optional: restrict search to a single contract.
--
-- Returns rows of (id, contract_id, term_type, clause_text,
--                  structured_value, confidence, similarity)
--
-- Example (TypeScript):
--   const { data } = await supabase.rpc('match_clauses', {
--     query_embedding: embeddingVector,
--     match_count: 5,
--     match_threshold: 0.72,
--     p_contract_id: contractId,
--   });
-- ---------------------------------------------------------------------------
create or replace function match_clauses(
  query_embedding extensions.vector(1536),
  match_count      int     default 5,
  match_threshold  float   default 0.70,
  p_contract_id   uuid    default null
)
returns table (
  id               uuid,
  contract_id      uuid,
  term_type        text,
  clause_text      text,
  structured_value jsonb,
  confidence       numeric,
  similarity       float
)
language sql stable security invoker
as $$
  select
    ct.id,
    ct.contract_id,
    ct.term_type,
    ct.clause_text,
    ct.structured_value,
    ct.confidence,
    1 - (ct.embedding <=> query_embedding) as similarity
  from contract_terms ct
  where
    -- RLS on contract_terms already filters to the caller's org;
    -- this check is belt-and-suspenders for service-role callers.
    ct.embedding is not null
    and (p_contract_id is null or ct.contract_id = p_contract_id)
    and 1 - (ct.embedding <=> query_embedding) >= match_threshold
  order by ct.embedding <=> query_embedding
  limit match_count;
$$;
