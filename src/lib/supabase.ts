import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | undefined;

/**
 * Server-only Supabase client authenticated with the service role key.
 *
 * This bypasses Row-Level Security and must never be imported from
 * client components or exposed to the browser bundle. It is used
 * exclusively by trusted server-side code: API route handlers, server
 * actions, and the standalone BullMQ worker process.
 */
export function getSupabaseAdminClient(): SupabaseClient {
    if (!adminClient) {
          const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!url || !serviceRoleKey) {
              throw new Error(
                        'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set to create the Supabase admin client.'
                      );
      }

      adminClient = createClient(url, serviceRoleKey, {
              auth: {
                        autoRefreshToken: false,
                        persistSession: false,
              },
      });
    }

  return adminClient;
}
