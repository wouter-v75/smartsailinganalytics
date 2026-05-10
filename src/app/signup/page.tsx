'use client'

// Signup page. Two flavours:
//   - Plain: lands user as 'pending' with no team, admin approves later.
//   - Invite: ?invite=<token> in URL → shows the team / role they're being
//     invited into, pre-fills email if the invite is targeted, and on signup
//     redeems the invitation right after the auth row exists.

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { getBrowserSupabase } from '../../lib/supabase/browser'

interface InviteSnapshot {
  team_name: string | null
  role: string
  boat_name: string | null
  auto_approve: boolean
  status: 'valid' | 'expired' | 'revoked' | 'exhausted'
  email: string | null
}

function SignupForm() {
  const searchParams = useSearchParams()
  const inviteToken = searchParams.get('invite')

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'pending' | 'invited' | null>(null)

  // Invite preview, fetched on mount when ?invite= is present.
  const [invite, setInvite] = useState<InviteSnapshot | null>(null)
  const [inviteLoading, setInviteLoading] = useState(Boolean(inviteToken))

  useEffect(() => {
    if (!inviteToken) return
    let cancelled = false
    ;(async () => {
      const res = await fetch(`/api/invitations/${inviteToken}`)
      const j = await res.json().catch(() => null)
      if (!cancelled && res.ok) {
        const snap = j as InviteSnapshot
        setInvite(snap)
        // Pre-fill email for targeted invites — auto-approve only fires
        // when the signup email matches the invite, so this gets it right
        // by default while still letting the user override.
        if (snap.email && !email) setEmail(snap.email)
      }
      if (!cancelled) setInviteLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteToken])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      const supabase = getBrowserSupabase()
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { name },
          emailRedirectTo: `${window.location.origin}/auth/callback${
            inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ''
          }`,
        },
      })
      if (signUpError) {
        setError(signUpError.message)
        return
      }
      // Pre-stash the invite's team/role/boat onto the new user row even
      // though they're still pending. This means the admin approval form
      // pre-fills correctly even if the email-confirm OTP expires before
      // the user clicks (runbox/AppleMail link prefetch is a common cause).
      if (inviteToken) {
        try {
          await fetch(`/api/invitations/${inviteToken}/stash`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
        } catch {
          // non-fatal — auth/callback will still try a full redeem later
        }
      }
      // If we have a session right away (rare for email-confirm flows but
      // happens when "Confirm email" is OFF), redeem the invite now too —
      // the stash above is a no-op for active users so this is fine.
      if (inviteToken && data?.session) {
        await fetch(`/api/invitations/${inviteToken}`, { method: 'POST' })
      }
      setDone(inviteToken ? 'invited' : 'pending')
    } finally {
      setBusy(false)
    }
  }

  if (done === 'pending') {
    return (
      <DonePanel>
        <h1 className="text-2xl font-semibold text-slate-900 mb-2">
          Check your inbox
        </h1>
        <p className="text-slate-600 mb-4">
          We&apos;ve sent a confirmation email to <strong>{email}</strong>.
          Click the link inside, then wait for the admin to approve your
          account.
        </p>
        <Link
          href="/login"
          className="inline-block mt-2 text-blue-600 hover:underline"
        >
          Back to sign in
        </Link>
      </DonePanel>
    )
  }

  if (done === 'invited') {
    return (
      <DonePanel>
        <h1 className="text-2xl font-semibold text-slate-900 mb-2">
          Check your inbox
        </h1>
        <p className="text-slate-600 mb-4">
          We&apos;ve sent a confirmation email to <strong>{email}</strong>.
          Click the link inside to finish joining{' '}
          <strong>{invite?.team_name || 'the team'}</strong>.
          {invite?.auto_approve ? null : (
            <>
              {' '}
              The team manager will approve your access once the email is
              confirmed.
            </>
          )}
        </p>
      </DonePanel>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          {invite ? `Join ${invite.team_name || 'this team'}` : 'Request access'}
        </h1>
        {invite ? (
          <p className="text-sm text-slate-600 mb-6">
            You&apos;ve been invited as <strong>{invite.role}</strong>
            {invite.boat_name && (
              <>
                {' '}
                on <strong>{invite.boat_name}</strong>
              </>
            )}
            .
            {invite.auto_approve
              ? ' Your access is granted as soon as you confirm your email.'
              : ' The team manager will approve your access after you sign up.'}
          </p>
        ) : (
          <p className="text-sm text-slate-500 mb-6">
            New accounts are reviewed by the admin before access is granted.
          </p>
        )}

        {inviteLoading && (
          <p className="text-sm text-slate-500 mb-4">Loading invite…</p>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Full name
            </label>
            <input
              type="text"
              required
              autoComplete="name"
              className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Email
            </label>
            <input
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {invite?.email && invite.email.toLowerCase() !== email.trim().toLowerCase() && (
              <p className="mt-1 text-xs text-amber-700">
                Use <strong>{invite.email}</strong> for instant approval. A different
                email still works but the team manager will need to approve manually.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              At least 8 characters.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-900">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 font-medium"
          >
            {busy ? 'Submitting…' : invite ? 'Sign up & join' : 'Request access'}
          </button>
        </form>

        <p className="mt-6 text-sm text-slate-600 text-center">
          Already have an account?{' '}
          <Link
            href={
              inviteToken
                ? `/login?next=${encodeURIComponent(`/join/${inviteToken}`)}`
                : '/login'
            }
            className="text-blue-600 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

function DonePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8 text-center">
        {children}
      </div>
    </div>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <SignupForm />
    </Suspense>
  )
}
