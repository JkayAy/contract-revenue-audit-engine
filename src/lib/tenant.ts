/**
 * tenant.ts
 *
 * Resolves the active organization_id from the authenticated user's
 * Supabase session JWT rather than from a compile-time constant.
 *
 * Every data-access query in this codebase is already guarded by
 * Row-Level Security policies that enforce `organization_id` isolation at
 * the database layer (see supabase/schema.sql).  This module closes the
 * application-layer gap so the RLS-scoped anon client is used for all
 * dashboard requests, and the admin (service-role) client is used only in
 * the background worker, where no user session exists.
 *
 * Usage in a Server Component or Server Action:
 *
 *   import { getOrganizationId } from '@/lib/tenant';
 *   const orgId = await getOrganizationId();   // throws if unauthenticated
 */

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

/** Extract `organization_id` from the authenticated user's JWT app_metadata. */
export async function getOrganizationId(): Promise<string> {
  const cookieStore = cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session) {
    throw new Error('Unauthenticated: no active session found.');
  }

  // Supabase sets organization_id in app_metadata, which flows through
  // as a top-level claim on the access token JWT.  The RLS policies in
  // schema.sql read this same claim via  auth.jwt() ->> 'organization_id'.
  const orgId =
    (session.user.app_metadata?.organization_id as string | undefined) ??
    (session.user.user_metadata?.organization_id as string | undefined);

  if (!orgId) {
    throw new Error(
      'JWT missing organization_id claim.  ' +
        'Ensure the Supabase auth hook populates app_metadata.organization_id on sign-in.',
    );
  }

  return orgId;
}

/**
 * Returns the actor label for audit log entries.
 * Falls back to the user's email so audit_logs.actor is always a
 * meaningful identity rather than a static string.
 */
export async function getActorLabel(): Promise<string> {
  const cookieStore = cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.user.email ?? session?.user.id ?? 'anonymous';
}
