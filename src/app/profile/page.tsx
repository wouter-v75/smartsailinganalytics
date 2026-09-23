'use client'

// Your profile: the one place a person changes their own consent.
//
// Small on purpose. The only thing here that matters is the recording toggle,
// and it has to be findable by someone who has just been told "you have not
// agreed to team recording" by a coach standing next to them.
//
// The write goes straight through RLS (users_update_self). Migration 0078 added
// a BEFORE UPDATE trigger that reverts status/global_role/approved_* on a
// self-update, so this path cannot be used to escalate — and it stamps
// recording_consent_at itself, which is why this page never sends a timestamp.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { getBrowserSupabase } from '../../lib/supabase/browser'

// The roles that are actually in a debrief. An owner (team_manager), a
// consultant on a date-boxed window and a guest are not, so their answer
// gates nobody — mirrors team_recording_consent() in migration 0078.
const DEBRIEF_ROLES = new Set(['coach', 'tl1', 'tl2', 'tl3'])

interface Me {
  id: string
  name: string
  email: string
  recording_consent: boolean
  recording_consent_at: string | null
  privacy_accepted_at: string | null
}

export default function ProfilePage() {
  const [me, setMe] = useState<Me | null>(null)
  const [inDebriefRole, setInDebriefRole] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    const supabase = getBrowserSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }

    const [{ data: row, error }, { data: mems }] = await Promise.all([
      supabase
        .from('users')
        .select('id, name, email, recording_consent, recording_consent_at, privacy_accepted_at')
        .eq('id', user.id)
        .maybeSingle(),
      supabase.from('memberships').select('role').eq('user_id', user.id),
    ])

    if (error) setErr(error.message)
    if (row) setMe(row as Me)
    setInDebriefRole(
      Boolean(mems?.some((m: { role: string }) => DEBRIEF_ROLES.has(m.role)))
    )
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function setConsent(next: boolean) {
    if (!me) return
    setSaving(true); setErr(null); setSaved(false)
    const supabase = getBrowserSupabase()
    // recording_consent_at is deliberately NOT sent — the trigger owns it.
    const { error } = await supabase
      .from('users')
      .update({ recording_consent: next })
      .eq('id', me.id)
    if (error) setErr(error.message)
    else { setMe({ ...me, recording_consent: next }); setSaved(true); load() }
    setSaving(false)
  }

  if (loading) {
    return <Frame><p className="text-slate-500">Loading…</p></Frame>
  }
  if (!me) {
    return (
      <Frame>
        <p className="text-slate-600">
          You need to be signed in. <Link href="/login" className="text-blue-600 hover:underline">Sign in</Link>
        </p>
      </Frame>
    )
  }

  return (
    <Frame>
      <h1 className="text-2xl font-semibold text-slate-900">Your profile</h1>
      <p className="mt-1 text-sm text-slate-500">{me.name} · {me.email}</p>

      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Team debrief recordings</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          When your team records a debrief, everyone in the room is captured. The recording is
          transcribed and summarised inside an EU account — no model vendor receives it — and a
          person reviews the draft before anything is saved.{' '}
          <Link href="/privacy" className="text-blue-600 hover:underline">How SSA handles data</Link>.
        </p>

        <label className="mt-5 flex cursor-pointer gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <input
            type="checkbox"
            checked={me.recording_consent}
            disabled={saving}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
          />
          <span className="text-sm leading-relaxed text-slate-800">
            <strong>I agree to be recorded in team debriefs.</strong>
            <span className="mt-1 block text-xs text-slate-600">
              You can withdraw this at any time by unticking it. Doing so stops the team
              recorder for everyone until you agree again, so tell your coach if you turn it off.
            </span>
          </span>
        </label>

        <div className="mt-3 text-xs text-slate-500">
          {me.recording_consent
            ? <>Agreed{me.recording_consent_at ? ` on ${new Date(me.recording_consent_at).toLocaleDateString()}` : ''}.</>
            : <>Not agreed. Your team&rsquo;s debrief recorder will not run until you do.</>}
          {saving && ' · Saving…'}
          {saved && !saving && ' · Saved.'}
        </div>

        {!inDebriefRole && (
          <p className="mt-4 border-l-2 border-slate-300 pl-3 text-xs leading-relaxed text-slate-500">
            Your roles are owner, consultant or guest, which are not counted as being in the
            debrief — your answer here does not block anyone&rsquo;s recorder. It is kept in case
            your role changes.
          </p>
        )}

        {err && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{err}</div>
        )}
      </section>

      <p className="mt-6 text-sm">
        <Link href="/" className="text-blue-600 hover:underline">← Back to SSA</Link>
      </p>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl">{children}</div>
    </div>
  )
}
