-- Extensions required for UUID generation
create extension if not exists "pgcrypto";

-- ORGANIZATIONS: tenant root
create table if not exists organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text not null unique,
    docusign_account_id text,
    hubspot_portal_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

-- CONTRACTS
create table if not exists contracts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references organizations(id) on delete cascade,
    external_envelope_id text not null,
    customer_name text not null,
    status text not null default 'pending_review'
      check (status in ('pending_review', 'active', 'expired', 'terminated')),
    effective_date date,
    expiration_date date,
    raw_document_url text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, external_envelope_id)
  );

-- CONTRACT_TERMS: extracted clauses (one row per clause)
create table if not exists contract_terms (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references organizations(id) on delete cascade,
    contract_id uuid not null references contracts(id) on delete cascade,
    term_type text not null
      check (term_type in ('volume_discount', 'sla_penalty', 'unit_price', 'renewal_clause', 'custom')),
    clause_text text not null,
    structured_value jsonb not null default '{}'::jsonb,
    confidence numeric(4,3) not null default 0 check (confidence >= 0 and confidence <= 1),
    extracted_by text not null default 'claude-3-7-sonnet',
    created_at timestamptz not null default now()
  );

-- BILLING_RECORDS: historical invoice line items used for reconciliation
create table if not exists billing_records (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references organizations(id) on delete cascade,
    contract_id uuid references contracts(id) on delete set null,
    invoice_number text not null,
    line_item text not null,
    billed_amount_cents bigint not null,
    expected_amount_cents bigint,
    billing_period_start date not null,
    billing_period_end date not null,
    raw_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (organization_id, invoice_number, line_item)
  );

-- AUDIT_ANOMALIES: flagged revenue leakage findings
create table if not exists audit_anomalies (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references organizations(id) on delete cascade,
    contract_id uuid not null references contracts(id) on delete cascade,
    billing_record_id uuid references billing_records(id) on delete set null,
    anomaly_type text not null
      check (anomaly_type in ('unapplied_volume_discount', 'sla_penalty_missing', 'overbilling', 'underbilling', 'other')),
    severity text not null default 'medium'
      check (severity in ('low', 'medium', 'high', 'critical')),
    status text not null default 'open'
      check (status in ('open', 'resolved', 'dismissed')),
    leaked_amount_cents bigint not null default 0,
    evidence jsonb not null default '{}'::jsonb,
    claude_explanation text,
    resolved_by uuid,
    resolved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

-- AUDIT_LOGS: append-only activity trail
create table if not exists audit_logs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references organizations(id) on delete cascade,
    actor text not null,
    action text not null,
    target_table text not null,
    target_id uuid,
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

-- INDEXES
create index if not exists idx_contracts_org_status on contracts (organization_id, status);
create index if not exists idx_contract_terms_org_contract on contract_terms (organization_id, contract_id);
create index if not exists idx_billing_records_org_period on billing_records (organization_id, billing_period_start, billing_period_end);
create index if not exists idx_audit_anomalies_org_status on audit_anomalies (organization_id, status);
create index if not exists idx_audit_anomalies_org_severity on audit_anomalies (organization_id, severity);
create index if not exists idx_audit_logs_org_created on audit_logs (organization_id, created_at desc);

-- ROW LEVEL SECURITY
alter table organizations enable row level security;
alter table contracts enable row level security;
alter table contract_terms enable row level security;
alter table billing_records enable row level security;
alter table audit_anomalies enable row level security;
alter table audit_logs enable row level security;

-- Organizations: a user may only see/update their own org row
create policy "organizations_isolation_select" on organizations
  for select using (id::text = auth.jwt() ->> 'organization_id');
create policy "organizations_isolation_update" on organizations
  for update using (id::text = auth.jwt() ->> 'organization_id');

-- Contracts
create policy "contracts_isolation_select" on contracts
  for select using (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "contracts_isolation_insert" on contracts
  for insert with check (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "contracts_isolation_update" on contracts
  for update using (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "contracts_isolation_delete" on contracts
  for delete using (organization_id::text = auth.jwt() ->> 'organization_id');

-- Contract terms
create policy "contract_terms_isolation_select" on contract_terms
  for select using (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "contract_terms_isolation_insert" on contract_terms
  for insert with check (organization_id::text = auth.jwt() ->> 'organization_id');

-- Billing records
create policy "billing_records_isolation_select" on billing_records
  for select using (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "billing_records_isolation_insert" on billing_records
  for insert with check (organization_id::text = auth.jwt() ->> 'organization_id');

-- Audit anomalies
create policy "audit_anomalies_isolation_select" on audit_anomalies
  for select using (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "audit_anomalies_isolation_insert" on audit_anomalies
  for insert with check (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "audit_anomalies_isolation_update" on audit_anomalies
  for update using (organization_id::text = auth.jwt() ->> 'organization_id');

-- Audit logs: append-only, no update/delete policy is defined intentionally
create policy "audit_logs_isolation_select" on audit_logs
  for select using (organization_id::text = auth.jwt() ->> 'organization_id');
create policy "audit_logs_isolation_insert" on audit_logs
  for insert with check (organization_id::text = auth.jwt() ->> 'organization_id');
