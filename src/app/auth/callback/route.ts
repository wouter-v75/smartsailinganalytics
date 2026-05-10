// OAuth / email-confirmation callback.
//
// Supabase redirects here after the user clicks the confirm link. We:
//   1. Exchange the code for a session (this writes auth cookies).
//   2. If an invite token rode along, redeem it INLINE — calling our shared
//      helper rather than fetching our own /api/invitations/[token].
//      Internal fetch can't see the cookies we just set (Next.js gotcha),
//      which is what was preventing auto-approve from working.
//   3. Redirect to next or /.

import { NextResponse, type NextRequest } from 'next/server'
import { getServerSupabase } from '../../../lib/supabase/server'
import { redeemInvitation } from '../../../lib/invitation-redeem'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const inviteToken = searchParams.get('invite')
  const next = searchParams.get('next') ?? '/'

  let user: { id: string; email?: string | null } | null = null
  if (code) {
    const supabase = getServerSupabase()
    const { data } = await supabase.auth.exchangeCodeForSession(code)
    if (data?.user) {
      user = { id: data.user.id, email: data.user.email ?? null }
    }
  }

  if (inviteToken && user) {
    try {
      await redeemInvitation({ token: inviteToken, user })
    } catch {
      // Non-fatal — the user can manually go to /join/<token> later.
    }
  }

  return NextResponse.redirect(`${origin}${next}`)
}
