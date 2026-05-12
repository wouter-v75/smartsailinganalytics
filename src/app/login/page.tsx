'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBrowserSupabase } from '../../lib/supabase/browser'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get('next') || '/'
  const reason = searchParams.get('reason')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Forgot-password flow lives on the same screen — toggle a sub-state.
  const [mode, setMode] = useState<'signin' | 'forgot' | 'forgot-sent'>('signin')

  useEffect(() => {
    if (reason === 'pending') {
      setInfo(
        'Your account is awaiting admin approval. You will receive an email when it is activated.'
      )
    } else if (reason === 'disabled') {
      setInfo('Your account is disabled. Contact the admin if this is unexpected.')
    } else if (reason === 'missing-profile') {
      setInfo(
        'Your profile row is missing. Please ask the admin to fix this.'
      )
    } else if (reason === 'signed-out') {
      setInfo('You have been signed out.')
    }
  }, [reason])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const supabase = getBrowserSupabase()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (signInError) {
        setError(signInError.message)
        return
      }
      router.push(next)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onForgotSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email.trim()) {
      setError('Enter your email above first.')
      return
    }
    setBusy(true)
    try {
      const supabase = getBrowserSupabase()
      // Route the recovery link through /auth/callback so the code is
      // exchanged for a session before landing on /auth/reset-password.
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent('/auth/reset-password')}`
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo }
      )
      if (resetErr) {
        setError(resetErr.message)
        return
      }
      setMode('forgot-sent')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 sm:p-8">
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          {mode === 'signin' ? 'Sign in to SSA' : 'Reset your password'}
        </h1>
        <p className="text-sm text-slate-500 mb-6">Shared Sailing Analytics</p>

        {info && (
          <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
            {info}
          </div>
        )}

        {mode === 'forgot-sent' ? (
          <>
            <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-900">
              We&apos;ve sent a reset link to <strong>{email}</strong>. Click
              the link in the email to set a new password.
            </div>
            <button
              onClick={() => {
                setMode('signin')
                setError(null)
              }}
              className="mt-4 w-full rounded-lg border border-slate-300 text-slate-700 py-2 font-medium hover:bg-slate-50"
            >
              Back to sign in
            </button>
          </>
        ) : mode === 'forgot' ? (
          <form onSubmit={onForgotSubmit} className="space-y-4">
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
              <p className="mt-1 text-xs text-slate-500">
                We&apos;ll email a link to reset your password.
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
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signin')
                setError(null)
              }}
              className="w-full text-center text-sm text-slate-600 hover:underline"
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
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
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-slate-700">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgot')
                    setError(null)
                  }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <input
                type="password"
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {mode === 'signin' && (
          <p className="mt-6 text-sm text-slate-600 text-center">
            New here?{' '}
            <Link href="/signup" className="text-blue-600 hover:underline">
              Request access
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginForm />
    </Suspense>
  )
}
