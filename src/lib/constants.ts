/**
 * DEMO_ORGANIZATION_ID
 *
 * This codebase implements full multi-tenant isolation at the database
 * layer (see supabase/schema.sql: every table carries organization_id and
 * is protected by Row-Level Security policies keyed off
 * auth.jwt() ->> 'organization_id').
 *
 * This repository does not include a full authentication/session UI
 * (sign-in, org switching, JWT issuance), since that is outside the scope
 * of this audit-engine showcase. Server Components and Server Actions in
 * the dashboard therefore resolve the active tenant from this constant
 * instead of a real session claim. In a production deployment, every
 * usage of DEMO_ORGANIZATION_ID below would be replaced with the
 * organization_id extracted from the authenticated user's session/JWT,
 * and data access would go through the RLS-scoped client rather than
 * the service-role admin client.
 */
export const DEMO_ORGANIZATION_ID =
  process.env.DEMO_ORGANIZATION_ID ?? "00000000-0000-0000-0000-000000000000";

/**
 * DEMO_ACTOR_LABEL
 *
 * Used to populate audit_logs.actor and audit_anomalies.resolved_by when
 * a dashboard action is performed, in the absence of a real signed-in
 * user identity.
 */
export const DEMO_ACTOR_LABEL = "dashboard-operator";
