'use client'

// People who redeemed an open-link invite for this team. Two actions per row:
// Approve (one-click; uses the requested role/boat) or Decline (clears the
// request; the account itself is untouched).
//
// A row is one of two things, and the badge says which. A NEW account exists
// only as this request. An EXISTING one is already in another team and is
// asking for a second membership — approving adds the team and leaves
// everything else about them alone.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface PendingUser {
  id: string
  email: string
  name: string
  status?: string | null
  created_at: string
  requested_role: string | null
  requested_boat_id: string | null
}

interface Boat {
  id: string
  name: string
}

export default function PendingRequestsPanel({
  teamId,
  pendingUsers,
  boats,
}: {
  teamId: string
  pendingUsers: PendingUser[]
  boats: Boat[]
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const boatName = (id: string | null) =>
    !id ? 'All boats' : boats.find((b) => b.id === id)?.name || '(boat removed)'

  async function approve(userId: string) {
    setBusyId(userId)
    setErr(null)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/approve-user`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        }
      )
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(j.error || `failed (${res.status})`)
        return
      }
      // The membership is made either way — rolling it back because a mail
      // server hiccuped would be the worse answer — but they are waiting for an
      // email that says so, and only you can tell them it did not come.
      if (j.email_sent === false) {
        const theirPassword = j.existing_account
          ? 'they sign in with the password they already use for SSA'
          : 'they sign in with the password they chose when they scanned the code'
        // Two different problems, two different things to do. A missing key is
        // not about this person — NOTHING will send until it is set, so
        // "tell them another way" would be advice for the wrong problem,
        // repeated once per approval.
        setErr(
          j.email_not_configured
            ? `Approved — but this environment cannot send email at all: RESEND_API_KEY and RESEND_FROM ` +
              `are not set, so no invite, approval or password reset will reach anybody from here. ` +
              `On a dev server that is usually expected; in production it needs fixing before anybody ` +
              `is invited. They can still sign in — ${theirPassword}.`
            : `Approved — but the email telling them did not send: ${j.email_error || 'unknown error'}. ` +
              `Let them know another way; ${theirPassword}.`
        )
      }
      router.refresh()
    } finally {
      setBusyId(null)
    }
  }

  async function decline(userId: string) {
    if (
      !confirm(
        'Decline this request? Their account is not touched — it just leaves this team\'s queue.'
      )
    ) {
      return
    }
    setBusyId(userId)
    setErr(null)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/decline-user`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      router.refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Pending requests ({pendingUsers.length})
      </h2>

      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}

      <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
        {pendingUsers.length === 0 ? (
          <div className="p-4 text-slate-500 text-sm text-center">
            No pending requests.
          </div>
        ) : (
          pendingUsers.map((u) => (
            <div
              key={u.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900 truncate">
                  {u.name || '—'}
                  <span className="ml-2 text-xs text-slate-500">
                    {u.requested_role || 'tl1'}
                  </span>
                  {u.status === 'active' && (
                    <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 align-middle">
                      already on SSA
                    </span>
                  )}
                </div>
                <div className="text-sm text-slate-500 truncate">
                  {u.email}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  Joining as {u.requested_role || 'tl1'} ·{' '}
                  {boatName(u.requested_boat_id)}
                  {u.status === 'active' &&
                    ' · in another team already, so this adds a second membership'}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  disabled={busyId === u.id}
                  onClick={() => approve(u.id)}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
                >
                  Approve
                </button>
                <button
                  disabled={busyId === u.id}
                  onClick={() => decline(u.id)}
                  className="rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  Decline
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
