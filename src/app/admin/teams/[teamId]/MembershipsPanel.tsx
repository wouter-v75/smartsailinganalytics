'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Boat {
  id: string
  name: string
}

interface UserStub {
  id: string
  name: string
  email: string
}

// Supabase's PostgREST nested-select returns the joined `users` row as an
// array (since it's modelling a 1:N relation in the schema even though our
// FK is many-to-one). We accept either array, single, or null and normalise
// in the renderer.
type JoinedUser = { id: string; name: string; email: string; status: string }
interface MembershipRow {
  id: string
  user_id: string
  boat_id: string | null
  role: 'team_manager' | 'coach' | 'tl3' | 'tl1' | 'tl2' | 'consultant' | 'guest'
  valid_from: string | null
  valid_to: string | null
  users: JoinedUser | JoinedUser[] | null
}

function firstUser(u: MembershipRow['users']): JoinedUser | null {
  if (!u) return null
  if (Array.isArray(u)) return u[0] || null
  return u
}

// Full membership-role spectrum the admin can grant. Order top-down by
// privilege so the dropdown reads naturally. `consultant` keeps the
// extra valid_from / valid_to date pickers.
const ROLES = ['team_manager', 'coach', 'tl3', 'tl2', 'tl1', 'consultant', 'guest'] as const
type Role = (typeof ROLES)[number]

export default function MembershipsPanel({
  teamId,
  boats,
  memberships,
  activeUsers,
}: {
  teamId: string
  boats: Boat[]
  memberships: MembershipRow[]
  activeUsers: UserStub[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ── Add-membership form ────────────────────────────────────────────
  const [userId, setUserId] = useState('')
  const [boatId, setBoatId] = useState<string>('') // '' = team-wide
  const [role, setRole] = useState<Role>('tl2')
  const [validFrom, setValidFrom] = useState('')
  const [validTo, setValidTo] = useState('')
  const [dataFrom, setDataFrom] = useState('') // session-date range the consultant may VIEW
  const [dataTo, setDataTo] = useState('')

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!userId || !role) return
    if (role === 'consultant' && (!validFrom || !validTo)) {
      setErr('Consultants need valid_from and valid_to.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/memberships`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            boat_id: boatId || null,
            role,
            valid_from: validFrom || null,
            valid_to: validTo || null,
            data_from: dataFrom || null,
            data_to: dataTo || null,
          }),
        }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setUserId('')
      setBoatId('')
      setRole('tl2')
      setValidFrom('')
      setValidTo('')
      setDataFrom('')
      setDataTo('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function destroy(membershipId: string) {
    if (!confirm('Revoke this membership?')) return
    setBusy(true)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/memberships/${membershipId}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  function boatNameOf(id: string | null): string {
    if (!id) return 'all boats'
    return boats.find((b) => b.id === id)?.name || '(boat removed)'
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Memberships ({memberships.length})
      </h2>

      <form
        onSubmit={add}
        className="mb-3 grid grid-cols-1 sm:grid-cols-6 gap-2 items-end bg-white p-3 rounded-xl border border-slate-200"
      >
        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-500 mb-1">User</label>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Pick…</option>
            {activeUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">Boat</label>
          <select
            value={boatId}
            onChange={(e) => setBoatId(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All boats</option>
            {boats.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {role === 'consultant' && (
          <>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Access from</label>
              <input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                title="When the consultant can start logging in"
                className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Access to</label>
              <input
                type="date"
                value={validTo}
                onChange={(e) => setValidTo(e.target.value)}
                title="When the consultant's login access ends"
                className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Data from</label>
              <input
                type="date"
                value={dataFrom}
                onChange={(e) => setDataFrom(e.target.value)}
                title="Earliest SESSION DATE they may view (blank = all)"
                className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Data to</label>
              <input
                type="date"
                value={dataTo}
                onChange={(e) => setDataTo(e.target.value)}
                title="Latest SESSION DATE they may view (blank = all)"
                className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <p className="sm:col-span-6 text-xs text-slate-500 -mt-1">
              <strong>Access</strong> = when they can log in. <strong>Data</strong> = which session dates they can view
              (leave blank for all). E.g. a sailmaker on 1 Jul viewing only 25–27 Jun: Access from today, Data 25 Jun → 27 Jun.
            </p>
          </>
        )}

        <div className="sm:col-span-6">
          <button
            type="submit"
            disabled={busy || !userId}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            Add membership
          </button>
          {err && (
            <span className="ml-3 text-sm text-red-600">{err}</span>
          )}
        </div>
      </form>

      <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
        {memberships.length === 0 ? (
          <div className="p-4 text-slate-500 text-sm text-center">
            No memberships yet.
          </div>
        ) : (
          memberships.map((m) => (
            <MembershipListRow
              key={m.id}
              membership={m}
              boatName={boatNameOf(m.boat_id)}
              teamId={teamId}
              onChanged={() => router.refresh()}
              onRevoke={() => destroy(m.id)}
            />
          ))
        )}
      </div>
    </section>
  )
}

// One row: name + role, with an Edit affordance that swaps the role into a
// dropdown. Saves via PATCH on the existing memberships/[id] route, which
// already enforces requireTeamManager (admin OR team_manager).
function MembershipListRow({
  membership,
  boatName,
  teamId,
  onChanged,
  onRevoke,
}: {
  membership: MembershipRow
  boatName: string
  teamId: string
  onChanged: () => void
  onRevoke: () => void
}) {
  const u = firstUser(membership.users)
  const [editing, setEditing] = useState(false)
  const [role, setRole] = useState<Role>(membership.role as Role)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (role === membership.role) { setEditing(false); return }
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/memberships/${membership.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setEditing(false)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-900 flex items-center gap-2 flex-wrap">
          {u?.name || '(unknown)'}
          {editing ? (
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded border border-slate-300 bg-white text-slate-900 px-2 py-0.5 text-xs"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-slate-500">{membership.role}</span>
          )}
        </div>
        <div className="text-xs text-slate-500">
          {u?.email} · {boatName}
          {membership.valid_from && ` · from ${membership.valid_from.slice(0, 10)}`}
          {membership.valid_to && ` to ${membership.valid_to.slice(0, 10)}`}
        </div>
        {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
      </div>
      <div className="flex gap-2 shrink-0">
        {editing ? (
          <>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setRole(membership.role as Role); setEditing(false); setErr(null) }}
              className="rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              className="text-sm text-blue-600 hover:underline"
            >
              Edit
            </button>
            <button
              onClick={onRevoke}
              className="text-sm text-red-600 hover:underline"
            >
              Revoke
            </button>
          </>
        )}
      </div>
    </div>
  )
}
