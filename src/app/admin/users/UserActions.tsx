'use client'

// Per-user action panel.
//
// For pending users we render an expand-on-click form that captures the
// initial team / boat / role so the user lands in a real workspace on
// approval. Disable is a single-click button.
//
// For active users, only Disable is offered. For disabled users, Reactivate.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type Status = 'pending' | 'active' | 'disabled'
type Action = 'approve' | 'disable' | 'reactivate'
type Role = 'team_manager' | 'coach' | 'tl2' | 'tl1' | 'consultant' | 'guest'

interface TeamWithBoats {
  id: string
  name: string
  boats: { id: string; name: string }[]
}

const ROLES: Role[] = ['team_manager', 'coach', 'tl2', 'tl1', 'consultant', 'guest']

export default function UserActions({
  userId,
  status,
  teams,
  requestedTeamId,
  requestedRole,
  requestedBoatId,
}: {
  userId: string
  status: Status
  teams: TeamWithBoats[]
  requestedTeamId?: string | null
  requestedRole?: Role | null
  requestedBoatId?: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Approve form state. Default to whatever the redeemed invitation
  // recorded; otherwise fall back to the first team + tl2.
  const initialTeamId = (() => {
    if (requestedTeamId && teams.some((t) => t.id === requestedTeamId)) {
      return requestedTeamId
    }
    return teams[0]?.id || ''
  })()
  const initialBoatId = (() => {
    if (
      requestedBoatId &&
      teams
        .find((t) => t.id === initialTeamId)
        ?.boats.some((b) => b.id === requestedBoatId)
    ) {
      return requestedBoatId
    }
    return ''
  })()
  const initialRole: Role = requestedRole || 'tl2'

  const [teamId, setTeamId] = useState<string>(initialTeamId)
  const [boatId, setBoatId] = useState<string>(initialBoatId)
  const [role, setRole] = useState<Role>(initialRole)
  const [validFrom, setValidFrom] = useState('')
  const [validTo, setValidTo] = useState('')
  const [skipMembership, setSkipMembership] = useState(false)

  const boatsForTeam = useMemo(
    () => teams.find((t) => t.id === teamId)?.boats || [],
    [teams, teamId]
  )

  async function run(action: Action, membership?: object) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, membership }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setExpanded(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  function approve(e: React.FormEvent) {
    e.preventDefault()
    if (skipMembership) {
      run('approve')
      return
    }
    if (!teamId) {
      setErr('Pick a team or tick "approve without membership".')
      return
    }
    if (role === 'consultant' && (!validFrom || !validTo)) {
      setErr('Consultant role needs valid_from and valid_to.')
      return
    }
    run('approve', {
      team_id: teamId,
      boat_id: boatId || null,
      role,
      valid_from: validFrom || null,
      valid_to: validTo || null,
    })
  }

  // ── Pending: Approve (expandable) + Reject ─────────────────────────
  if (status === 'pending') {
    if (!expanded) {
      return (
        <div className="flex items-center gap-2 shrink-0">
          {err && <span className="text-xs text-red-600">{err}</span>}
          <button
            disabled={busy}
            onClick={() => setExpanded(true)}
            className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          >
            Approve…
          </button>
          <button
            disabled={busy}
            onClick={() => run('disable')}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )
    }
    return (
      <form
        onSubmit={approve}
        className="bg-slate-50 border border-slate-200 rounded-xl p-3 grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md"
      >
        {teams.length === 0 ? (
          <p className="sm:col-span-2 text-xs text-slate-500">
            No teams exist yet.{' '}
            <Link
              href="/admin/teams"
              className="text-blue-600 hover:underline"
            >
              Create one first
            </Link>
            , or approve without a membership for now.
          </p>
        ) : (
          <>
            <label className="text-xs text-slate-600">
              Team
              <select
                value={teamId}
                onChange={(e) => {
                  setTeamId(e.target.value)
                  setBoatId('')
                }}
                className="block w-full mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                disabled={skipMembership}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Boat
              <select
                value={boatId}
                onChange={(e) => setBoatId(e.target.value)}
                className="block w-full mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                disabled={skipMembership}
              >
                <option value="">All boats</option>
                {boatsForTeam.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="block w-full mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                disabled={skipMembership}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            {role === 'consultant' && !skipMembership && (
              <>
                <label className="text-xs text-slate-600">
                  Valid from
                  <input
                    type="date"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                    className="block w-full mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-slate-600">
                  Valid to
                  <input
                    type="date"
                    value={validTo}
                    onChange={(e) => setValidTo(e.target.value)}
                    className="block w-full mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                  />
                </label>
              </>
            )}
            <label className="sm:col-span-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={skipMembership}
                onChange={(e) => setSkipMembership(e.target.checked)}
              />
              Approve without a membership (assign later from team page)
            </label>
          </>
        )}

        {err && (
          <p className="sm:col-span-2 text-xs text-red-600">{err}</p>
        )}

        <div className="sm:col-span-2 flex gap-2 mt-1">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
          >
            {busy ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setExpanded(false)
              setErr(null)
            }}
            className="rounded-lg border border-slate-300 text-slate-700 px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    )
  }

  // ── Active: Disable ────────────────────────────────────────────────
  if (status === 'active') {
    return (
      <div className="flex items-center gap-2 shrink-0">
        {err && <span className="text-xs text-red-600">{err}</span>}
        <button
          disabled={busy}
          onClick={() => run('disable')}
          className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Disable
        </button>
      </div>
    )
  }

  // ── Disabled: Reactivate ───────────────────────────────────────────
  return (
    <div className="flex items-center gap-2 shrink-0">
      {err && <span className="text-xs text-red-600">{err}</span>}
      <button
        disabled={busy}
        onClick={() => run('reactivate')}
        className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
      >
        Reactivate
      </button>
    </div>
  )
}
