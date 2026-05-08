// OAuth / email-confirmation callback. Supabase redirects here after the
// user clicks the confirm link in the email; we exchange the code for a
// session and bounce them to /login (where the middleware will then read
// users.status and route them appropriately).

import { NextResponse, type NextRequest } from 'next/server'
import { getServerSupabase } from '../../../lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const supabase = getServerSupabase()
    await supabase.auth.exchangeCodeForSession(code)
  }
  return NextResponse.redirect(`${origin}${next}`)
}
