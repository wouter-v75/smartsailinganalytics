// ─────────────────────────────────────────────────────────────────────────────
// Finance database client. Talks ONLY to the separate finance Supabase project —
// which is physically separate from the SSA database. Server-only; the browser
// never sees a finance key and never connects to finance directly.
//
// Tier 1 (now): a service-role client to the finance project. Authorization is
//   enforced in the finance API routes using the FinanceCaller from identity.ts.
// Tier 2 (later, defence-in-depth): swap the internals here for a pooled Postgres
//   connection that injects financeClaims() as request.jwt.claims per transaction,
//   so the finance DB's OWN RLS enforces access even if a route has a bug. That
//   change is isolated to THIS file — nothing that imports it needs to change.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function financeConfigured(): boolean {
  return !!(process.env.FINANCE_SUPABASE_URL && process.env.FINANCE_SERVICE_ROLE_KEY)
}

// Service-role finance client. Bypasses finance RLS — callers MUST authorize
// using the FinanceCaller before reading/writing. Never import from client code.
export function getFinanceDb(): SupabaseClient {
  if (!financeConfigured()) {
    throw new Error(
      'Finance DB not configured — set FINANCE_SUPABASE_URL and FINANCE_SERVICE_ROLE_KEY',
    )
  }
  if (_client) return _client
  _client = createClient(
    process.env.FINANCE_SUPABASE_URL!,
    process.env.FINANCE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  return _client
}
