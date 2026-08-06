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
// Seconds of clock-skew margin: stop trusting a locally-verified token a little
// BEFORE its real expiry so we never fire a query with an about-to-die token.
const CLAIMS_SKEW_SEC = 30
function usableClaims(
  claims: { sub?: string; exp?: number } | undefined
): claims is { sub: string; exp: number } {
  return (
    !!claims?.sub &&
    typeof claims.exp === 'number' &&
    claims.exp > Math.floor(Date.now() / 1000) + CLAIMS_SKEW_SEC
  )
}

export async function getUidFast(): Promise<string | null> {
  const supabase = getBrowserSupabase()
  try {
    const auth = supabase.auth as unknown as { getClaims?: () => Promise<{ data?: { claims?: { sub?: string; exp?: number } } }> }
    if (typeof auth.getClaims === 'function') {
      const { data } = await auth.getClaims()
      const claims = data?.claims
      // getClaims() only checks the SIGNATURE — an expired JWT still yields a
      // valid `sub`, but every RLS query made with that dead access token 401s,
      // which is how infrequent users (e.g. consultants back after weeks) look
      // like they "lost access". Only take the fast local path while the token
      // is still valid; otherwise getUser() revalidates AND refreshes it.
      if (usableClaims(claims)) return claims.sub
    }
  } catch { /* fall through to getUser */ }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}
