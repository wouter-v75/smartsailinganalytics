'use client'

// Pending users who redeemed an open-link invite for this team. Two
// actions per row: Approve (one-click; uses the requested role/boat) or
// Decline (clears the request; user stays pending globally).

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface PendingUser {
  id: string
  email: string
  name: string
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

  async function decline(userId: string) {
    if (
      !confirm(
        'Decline this request? They stay registered but no longer appear in this team\'s queue.'
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
                </div>
                <div className="text-sm text-slate-500 truncate">
                  {u.email}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  Joining as {u.requested_role || 'tl1'} ·{' '}
                  {boatName(u.requested_boat_id)}
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
