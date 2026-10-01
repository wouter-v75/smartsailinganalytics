'use client'

// /auth/reset-password — landing page after the user clicks the password
// reset link in their email. Supabase's resetPasswordForEmail flow goes:
//
//   /login → "Forgot password?" → user enters email →
//   email sent with link to /auth/callback?code=…&next=/auth/reset-password →
//   /auth/callback exchanges code for session →
//   redirect here with the user now signed in via "recovery" session.
//
// We just collect a new password and call supabase.auth.updateUser.

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '../../../lib/supabase/browser'

// useSearchParams() forces this subtree to render on the client, and Next
// refuses to BUILD a page that uses it without a Suspense boundary. Nothing but
// `next build` catches that — tsc, vitest and lint are all green either way, the
// same lesson as the route tree in CLAUDE.md.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  )
}

function ResetPasswordForm() {
  const router = useRouter()
  // Why the sign-in failed, carried here by /auth/callback. Without it this
  // page could only guess, and it guessed "expired" at a link that was a minute
  // old — see the note in the callback.
  const authError = useSearchParams().get('authError')
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getBrowserSupabase()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!cancelled) setSignedIn(Boolean(user))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    try {
      const supabase = getBrowserSupabase()
      const { error: updErr } = await supabase.auth.updateUser({ password })
      if (updErr) {
        setError(updErr.message)
        return
      }
      setDone(true)
      setTimeout(() => {
        router.push('/')
        router.refresh()
      }, 1500)
    } finally {
      setBusy(false)
    }
  }

  if (signedIn === false) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            That link didn&apos;t sign you in
          </h1>
          <p className="text-slate-600 mb-4">
            Password links can only be used once, and they expire. Ask for a
            fresh one with <strong>Forgot password?</strong> on the sign-in page
            — it works whether or not you have set a password before.
          </p>
          {authError && (
            // The actual reason, not a guess. Small, but it is the difference
            // between "try again" and a support thread.
            <p className="text-xs text-slate-400 mb-4">Reason: {authError}</p>
          )}
          <Link
            href="/login"
            className="text-blue-600 hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            Password updated
          </h1>
          <p className="text-slate-600">
            Redirecting you to the app…
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          Set a new password
        </h1>
        <p className="text-sm text-slate-500 mb-6">
          Pick something you haven&apos;t used before.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              New password
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
            <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Confirm new password
            </label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
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
            {busy ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}
