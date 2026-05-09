// /join/<token> — invite-redemption landing page.
//
// Renders details about the invite (team, role, boat). If the visitor isn't
// logged in, sends them to /signup?invite=<token>. If they are, the
// "Join team" button POSTs to the redeem endpoint and routes them to /.

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBrowserSupabase } from '../../../lib/supabase/browser'

interface InviteSnapshot {
  team_name: string | null
  role: string
  boat_name: string | null
  auto_approve: boolean
  expires_at: string
  remaining_uses: number
  status: 'valid' | 'expired' | 'revoked' | 'exhausted'
}

export default function JoinPage({
  params,
}: {
  params: { token: string }
}) {
  const router = useRouter()
  const [snap, setSnap] = useState<InviteSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Fetch invite snapshot.
      const res = await fetch(`/api/invitations/${params.token}`)
      const j = await res.json().catch(() => null)
      if (!cancelled && res.ok) setSnap(j as InviteSnapshot)
      else if (!cancelled) setErr(j?.error || `failed (${res.status})`)

      // Check session.
      const supabase = getBrowserSupabase()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!cancelled) setSignedIn(Boolean(user))
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [params.token])

  async function redeem() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/invitations/${params.token}`, {
        method: 'POST',
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(j.error || `failed (${res.status})`)
        return
      }
      // Auto-approve invites land them in the app immediately.
      // Open links land them as pending; show a "thanks, we'll approve you" page.
      if (j.auto_approve) {
        router.push('/')
        router.refresh()
      } else {
        router.push('/login?reason=pending')
      }
    } finally {
      setBusy(false)
    }
  }

  function goSignup() {
    router.push(`/signup?invite=${encodeURIComponent(params.token)}`)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 text-sm">Loading invite…</div>
      </div>
    )
  }

  if (err || !snap) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            Invite unavailable
          </h1>
          <p className="text-slate-600">{err || 'Not found.'}</p>
        </div>
      </div>
    )
  }

  if (snap.status !== 'valid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            This invite is {snap.status}
          </h1>
          <p className="text-slate-600">
            Ask the team for a new invite link.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8 text-center">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          Join {snap.team_name || 'this team'}
        </h1>
        <p className="text-sm text-slate-600 mb-5">
          You&apos;ve been invited as <strong>{snap.role}</strong>
          {snap.boat_name && (
            <>
              {' '}
              on <strong>{snap.boat_name}</strong>
            </>
          )}
          .
        </p>

        {snap.auto_approve ? (
          <p className="text-xs text-slate-500 mb-5">
            You&apos;ll be added to the team as soon as you accept.
          </p>
        ) : (
          <p className="text-xs text-slate-500 mb-5">
            After you accept, the team manager will review and confirm your
            access. You&apos;ll get an email once approved.
          </p>
        )}

        {signedIn ? (
          <button
            disabled={busy}
            onClick={redeem}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 font-medium"
          >
            {busy ? 'Joining…' : 'Accept invite'}
          </button>
        ) : (
          <button
            onClick={goSignup}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 font-medium"
          >
            Sign up to accept
          </button>
        )}
      </div>
    </div>
  )
}
