// Server-side Supabase client. Use in Server Components, Route Handlers,
// and Server Actions.
//
// Reads / writes the session cookie via next/headers' cookies(). The set /
// remove handlers swallow errors that fire when called from a Server
// Component (which can't write cookies); the middleware compensates by
// refreshing the cookie on every request.

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function getServerSupabase() {
  const cookieStore = cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options })
          } catch {
            // Server Components can't set cookies; middleware handles refresh.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options })
          } catch {
            // see above
          }
        },
      },
    }
  )
}

// Authenticated user id for a route handler. Prefers getClaims(): with the
// project's asymmetric JWT signing key it verifies the token locally against
// the cached JWKS, skipping the ~0.3-0.9s /auth/v1/user round-trip that
// getUser() makes on every API call. Falls back to getUser() when claims can't
// be verified. Returns null for anonymous callers. RLS still gates every row
// read/write, so this is the early-401 + created_by stamp, not the security
// boundary.
export async function authedUserId(
  supabase: ReturnType<typeof getServerSupabase>
): Promise<string | null> {
  const auth = supabase.auth as unknown as {
    getClaims?: () => Promise<{ data: { claims?: { sub?: string; exp?: number } } | null }>
    getUser: () => Promise<{ data: { user: { id: string } | null } }>
  }
  try {
    if (typeof auth.getClaims === 'function') {
      const { data } = await auth.getClaims()
      const claims = data?.claims
      // Only trust a locally-verified token while it is still valid — an expired
      // JWT keeps a good signature (so getClaims returns its sub) but every RLS
      // query with it 401s. Fall through to getUser(), which revalidates and
      // refreshes the session cookie. Mirrors getUidFast() on the client.
      if (
        claims?.sub &&
        typeof claims.exp === 'number' &&
        claims.exp > Math.floor(Date.now() / 1000) + 30
      ) {
        return claims.sub
      }
    }
  } catch {
    /* fall through to getUser */
  }
  try {
    const {
      data: { user },
    } = await auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}

// Service-role client. NEVER use from anywhere that runs in the browser.
// Bypasses RLS — used for admin RPCs (approve user, set role-quota, etc.).
import { createClient } from '@supabase/supabase-js'

export function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
    )
  }
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
