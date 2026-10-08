// /join/<token> — where the team's QR code lands. Road 2.
//
// Somebody standing on the dock scans the code and arrives here with no
// account. They give a name, an address and a password, and then WAIT: the
// account is created `pending` with no membership, and a team manager has to
// approve it before it can do anything. The approval mail then says "you're
// in" and they sign in with the password they chose here.
//
// It used to send them to /signup?invite=<token> instead. That road went
// through supabase.auth.signUp, whose confirmation email Supabase REFUSES to
// deliver to anybody outside the project's own team unless custom SMTP is
// configured — so the person was told to check an inbox nothing was ever sent
// to. One form here, no confirmation email, nothing to click.
//
// A visitor who is already signed in still gets the old one-button redeem.
//
// AND SO DOES AN ADDRESS THAT ALREADY HAS AN ACCOUNT, through this same form:
// they type the password they already use, the server checks it and files the
// request against the account they have. A user is allowed in several teams at
// once. Before this, the form refused them ("sign in first, then open this
// link again"), which was a loop with no exit for anyone whose team manager
// had only ever sent them a QR code.

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
  // The sign-up form, for the scanner who has no account.
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [requested, setRequested] = useState<string | null>(null)
  // The server says so when the way out of an error is the sign-in page
  // rather than another go at this form.
  const [offerSignIn, setOfferSignIn] = useState(false)
  const [joined, setJoined] = useState(false)
  const [privacyOk, setPrivacyOk] = useState(false)
  const [recordingOk, setRecordingOk] = useState(false)

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
      if (j.auto_approve) {
        router.push('/')
        router.refresh()
        return
      }
      // Otherwise the manager has to approve it. They are signed in already, so
      // sending them to /login would be sending a signed-in person to the
      // sign-in page: say what happens next and leave them where they are.
      setRequested(
        'Your request has gone to the team manager. You will get an email when it is ' +
          'approved, and the team will then appear in the menu behind your name.'
      )
    } finally {
      setBusy(false)
    }
  }

  async function requestAccess(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/join/${params.token}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, email, password, confirm,
          privacy_accepted: privacyOk, recording_consent: recordingOk,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        // The server's words, not ours: it knows whether the code is expired,
        // the password was wrong, the account is switched off or they are in
        // the team already, and each one has a different way out.
        setErr(j.error || `Could not send the request (${res.status}).`)
        setOfferSignIn(Boolean(j.sign_in))
        return
      }
      setJoined(Boolean(j.joined))
      setRequested(j.message || 'Your request has gone to the team manager.')
    } catch {
      setErr('Could not reach SSA. Check your signal and try again.')
    } finally {
      setBusy(false)
    }
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

  if (requested) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            {joined ? `Welcome to ${snap.team_name || 'the team'}` : 'Request sent'}
          </h1>
          <p className="text-slate-600 mb-4">{requested}</p>
          {joined ? (
            <a
              href="/"
              className="inline-block rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 font-medium"
            >
              Open SSA
            </a>
          ) : (
            <p className="text-sm text-slate-500">
              Nothing else to do — no email to confirm.
            </p>
          )}
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
          <form onSubmit={requestAccess} className="text-left">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Your name</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              autoComplete="name" required
              className="w-full rounded-lg border border-slate-300 px-3 py-2 mb-3 text-slate-900"
            />
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Email</label>
            <input
              value={email} onChange={(e) => setEmail(e.target.value)}
              type="email" autoComplete="email" required inputMode="email"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 mb-3 text-slate-900"
            />
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Password</label>
            <input
              value={password} onChange={(e) => setPassword(e.target.value)}
              type="password" autoComplete="new-password" required minLength={8}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 mb-3 text-slate-900"
            />
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Confirm password</label>
            <input
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
              type="password" autoComplete="new-password" required minLength={8}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 mb-2 text-slate-900"
            />
            <p className="text-xs text-slate-500 mb-4">
              At least 8 characters. You will use this to sign in once the manager approves you.
              <strong className="font-semibold"> Already use SSA with another team?</strong> Put in
              that account&rsquo;s email and its existing password — this adds the team to the login
              you have, and nothing about your account changes.
            </p>
            {/* Two boxes, not one. Agreeing to how data is handled is not the
                same as agreeing to be recorded, and a single "I agree to
                everything" would record a consent nobody actually gave. */}
            <label className="mb-3 flex items-start gap-2">
              <input
                type="checkbox" required checked={privacyOk}
                onChange={(e) => setPrivacyOk(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span className="text-xs leading-relaxed text-slate-600">
                I have read{' '}
                <a href="/privacy" target="_blank" rel="noopener" className="text-blue-600 underline">
                  how SSA handles your data
                </a>
                , and agree to it.
              </span>
            </label>
            <label className="mb-4 flex items-start gap-2">
              <input
                type="checkbox" required checked={recordingOk}
                onChange={(e) => setRecordingOk(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span className="text-xs leading-relaxed text-slate-600">
                I agree to debriefs being <strong>voice-recorded</strong> and transcribed for
                the team, and to my voice appearing in them. You can withdraw this later in
                your profile — the team&apos;s recorder stops for everybody if anybody aboard has.
              </span>
            </label>
            {err && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <p>{err}</p>
                {offerSignIn && (
                  <p className="mt-2">
                    <a
                      href={`/login?next=${encodeURIComponent(`/join/${params.token}`)}`}
                      className="font-semibold underline"
                    >
                      Sign in instead
                    </a>{' '}
                    — you come straight back here afterwards.
                  </p>
                )}
              </div>
            )}
            <button
              type="submit" disabled={busy}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 font-medium"
            >
              {busy ? 'Sending…' : 'Ask to join'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
