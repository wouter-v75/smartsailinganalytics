'use client'

// Sub-team admin (campaign engine). Two jobs:
//   1) Assign members to sub-teams — a member can be in many. Chips are tap-to-
//      toggle, colour-coded by category (racing / technical / whole-team).
//   2) Manage the vocabulary (add / deactivate / delete) — collapsed by default
//      to keep the panel decluttered.
//
// Rendered for every team — campaign engine is generic.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
// useRouter is used by the ManageVocab sub-component below.

type Category = 'racing' | 'technical' | 'whole-team'

interface Subteam {
  id: string
  category: Category
  key: string
  label: string
  seq: number
  active: boolean
}

type JoinedUser = { id: string; name: string; email: string; status: string }
interface MembershipRow {
  id: string
  user_id: string
  role: string
  users: JoinedUser | JoinedUser[] | null
}
interface Assignment {
  membership_id: string
  subteam_id: string
}

function firstUser(u: MembershipRow['users']): JoinedUser | null {
  if (!u) return null
  return Array.isArray(u) ? u[0] || null : u
}

const CAT_ORDER: Record<Category, number> = {
  racing: 0,
  technical: 1,
  'whole-team': 2,
}
const CAT: Record<
  Category,
  { label: string; dot: string; on: string; off: string }
> = {
  racing: {
    label: 'Racing',
    dot: 'bg-emerald-500',
    on: 'bg-emerald-600 text-white border-emerald-600',
    off: 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50',
  },
  technical: {
    label: 'Technical',
    dot: 'bg-amber-500',
    on: 'bg-amber-500 text-white border-amber-500',
    off: 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50',
  },
  'whole-team': {
    label: 'Whole team',
    dot: 'bg-violet-500',
    on: 'bg-violet-600 text-white border-violet-600',
    off: 'bg-white text-violet-700 border-violet-300 hover:bg-violet-50',
  },
}

export default function SubteamsPanel({
  teamId,
  subteams,
  memberships,
  assignments,
}: {
  teamId: string
  subteams: Subteam[]
  memberships: MembershipRow[]
  assignments: Assignment[]
}) {
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [manage, setManage] = useState(false)

  // membershipId → Set(subteamId), seeded from props, mutated optimistically.
  const [links, setLinks] = useState<Record<string, Set<string>>>(() => {
    const m: Record<string, Set<string>> = {}
    for (const a of assignments) {
      ;(m[a.membership_id] ||= new Set()).add(a.subteam_id)
    }
    return m
  })

  const activeSubteams = useMemo(
    () =>
      [...subteams]
        .filter((s) => s.active)
        .sort(
          (a, b) =>
            CAT_ORDER[a.category] - CAT_ORDER[b.category] || a.seq - b.seq
        ),
    [subteams]
  )

  async function toggle(membershipId: string, subteam: Subteam) {
    const key = `${membershipId}:${subteam.id}`
    if (pending.has(key)) return
    const has = links[membershipId]?.has(subteam.id)
    setErr(null)
    setPending((p) => new Set(p).add(key))
    // optimistic
    setLinks((prev) => {
      const next = { ...prev }
      const set = new Set(next[membershipId] || [])
      if (has) set.delete(subteam.id)
      else set.add(subteam.id)
      next[membershipId] = set
      return next
    })
    try {
      const res = await fetch(`/api/admin/teams/${teamId}/membership-subteams`, {
        method: has ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          membership_id: membershipId,
          subteam_id: subteam.id,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        // revert
        setLinks((prev) => {
          const next = { ...prev }
          const set = new Set(next[membershipId] || [])
          if (has) set.add(subteam.id)
          else set.delete(subteam.id)
          next[membershipId] = set
          return next
        })
      }
    } finally {
      setPending((p) => {
        const n = new Set(p)
        n.delete(key)
        return n
      })
    }
  }

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Sub-teams
        </h2>
        <button
          onClick={() => setManage((v) => !v)}
          className="text-xs text-blue-600 hover:underline"
        >
          {manage ? 'Done' : 'Manage sub-teams'}
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3 text-xs text-slate-500">
        {(Object.keys(CAT) as Category[]).map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${CAT[c].dot}`} />
            {CAT[c].label}
          </span>
        ))}
      </div>

      {err && <div className="mb-2 text-sm text-red-600">{err}</div>}

      {manage && (
        <ManageVocab teamId={teamId} subteams={subteams} />
      )}

      {/* Member ↔ sub-team matrix */}
      <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
        {memberships.length === 0 ? (
          <div className="p-4 text-slate-500 text-sm text-center">
            No memberships yet — add members above first.
          </div>
        ) : (
          memberships.map((m) => {
            const u = firstUser(m.users)
            const set = links[m.id] || new Set<string>()
            return (
              <div key={m.id} className="px-4 py-3">
                <div className="mb-2">
                  <span className="font-medium text-slate-900">
                    {u?.name || '(unknown)'}
                  </span>
                  <span className="text-xs text-slate-500 ml-2">{m.role}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {activeSubteams.map((s) => {
                    const on = set.has(s.id)
                    const key = `${m.id}:${s.id}`
                    const busy = pending.has(key)
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggle(m.id, s)}
                        disabled={busy}
                        className={`text-xs rounded-full border px-2.5 py-1 transition ${
                          on ? CAT[s.category].on : CAT[s.category].off
                        } ${busy ? 'opacity-50' : ''}`}
                        title={CAT[s.category].label}
                      >
                        {on ? '✓ ' : ''}
                        {s.label}
                      </button>
                    )
                  })}
                  {activeSubteams.length === 0 && (
                    <span className="text-xs text-slate-400">
                      No sub-teams defined.
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

// ── Vocabulary manager (collapsible) ─────────────────────────────────────────
function ManageVocab({
  teamId,
  subteams,
}: {
  teamId: string
  subteams: Subteam[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [category, setCategory] = useState<Category>('racing')
  const [label, setLabel] = useState('')

  const sorted = [...subteams].sort(
    (a, b) => CAT_ORDER[a.category] - CAT_ORDER[b.category] || a.seq - b.seq
  )

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/admin/teams/${teamId}/subteams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, label, seq: 500 }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setLabel('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(true)
    try {
      await fetch(`/api/admin/teams/${teamId}/subteams/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this sub-team? Members are unlinked; backlog items keep their row.'))
      return
    setBusy(true)
    try {
      await fetch(`/api/admin/teams/${teamId}/subteams/${id}`, {
        method: 'DELETE',
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
      <form onSubmit={add} className="flex flex-wrap gap-2 items-end mb-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            className="rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 text-sm"
          >
            <option value="racing">Racing</option>
            <option value="technical">Technical</option>
            <option value="whole-team">Whole team</option>
          </select>
        </div>
        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-slate-500 mb-1">Name</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Hydraulics"
            className="w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-2 text-sm font-medium"
        >
          Add
        </button>
        {err && <span className="text-sm text-red-600 w-full">{err}</span>}
      </form>

      <div className="flex flex-wrap gap-1.5">
        {sorted.map((s) => (
          <span
            key={s.id}
            className={`inline-flex items-center gap-1.5 text-xs rounded-full border px-2 py-1 ${
              s.active ? CAT[s.category].off : 'bg-slate-100 text-slate-400 border-slate-200'
            }`}
          >
            <span className={`inline-block w-2 h-2 rounded-full ${CAT[s.category].dot}`} />
            {s.label}
            <button
              onClick={() => patch(s.id, { active: !s.active })}
              disabled={busy}
              title={s.active ? 'Deactivate' : 'Reactivate'}
              className="ml-1 text-slate-500 hover:text-slate-800"
            >
              {s.active ? '⦻' : '↺'}
            </button>
            <button
              onClick={() => remove(s.id)}
              disabled={busy}
              title="Delete"
              className="text-red-500 hover:text-red-700"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}
