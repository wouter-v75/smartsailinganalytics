// Browser-side Supabase client. Use in client components and effects.
//
// Holds the session in cookies (not localStorage) so the server middleware
// and Route Handlers can see the same auth state. createBrowserClient from
// @supabase/ssr handles the cookie wiring under the hood.

import { createBrowserClient } from '@supabase/ssr'

export function getBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// Verified user id with NO network round-trip. getClaims() checks the JWT
// signature locally against the cached JWKS (asymmetric key), so it is both fast
// AND cryptographically verified — strictly better than getSession() (fast but
// unverified) and getUser() (verified but a ~0.3-0.9s round-trip to GoTrue).
// Falls back to getUser() only when claims can't be read (e.g. project not on
// asymmetric keys). Mirrors the admin-gate pattern in SmartSailingAnalytics_UI.
// Data access stays safe regardless because RLS re-verifies server-side.
export async function getUidFast(): Promise<string | null> {
  const supabase = getBrowserSupabase()
  try {
    const auth = supabase.auth as unknown as { getClaims?: () => Promise<{ data?: { claims?: { sub?: string } } }> }
    if (typeof auth.getClaims === 'function') {
      const { data } = await auth.getClaims()
      const sub = data?.claims?.sub
      if (sub) return sub
    }
  } catch { /* fall through to getUser */ }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}
