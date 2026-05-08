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
