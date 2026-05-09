// OAuth / email-confirmation callback.
//
// Supabase redirects here after the user clicks the confirm link in their
// email. We exchange the code for a session, then redeem an invite if one
// is attached (so a freshly-confirmed user lands fully active with the
// right team membership in one round-trip).

import { NextResponse, type NextRequest } from 'next/server'
import { getServerSupabase } from '../../../lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const inviteToken = searchParams.get('invite')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const supabase = getServerSupabase()
    await supabase.auth.exchangeCodeForSession(code)
  }

  if (inviteToken) {
    // Best-effort redeem. If it fails, the user can still try /join/<token>
    // manually after they sign in.
    try {
      await fetch(`${origin}/api/invitations/${inviteToken}`, {
        method: 'POST',
        headers: { cookie: request.headers.get('cookie') || '' },
      })
    } catch {
      // swallow — middleware will handle their state on next request
    }
  }

  return NextResponse.redirect(`${origin}${next}`)
}
