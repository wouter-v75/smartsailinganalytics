'use client'

// The team's own squad decisions: join a squad it has been invited to, choose
// what it contributes, and leave.
//
// WHO SEES THIS. The page is reachable by a global admin, a team_manager or a
// coach of this team. Creating a squad and deciding which teams may join it is
// an ADMIN job and lives in /admin/squads; this panel is the other half — the
// team's own consent, taken by the people who run the team.
//
// WHAT AN INVITATION IS. An admin adds the team to a squad with status
// 'invited'. That is not membership and shares nothing; it is permission to
// join. The team becomes a member by pressing Join here, which is also when it
// first chooses its categories. A team can never enrol itself in a squad it
// was not invited to, and an admin can never make a team share anything.
//
// WHY THE CATEGORIES ARE NOT A SINGLE SWITCH. A track is a fact about where a
// boat sailed; a debrief is a crew talking about its own mistakes. Teams in a
// squad are frequently selection rivals, and asking them to share both or
// neither is how a feature goes unused and everyone goes back to WhatsApp.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SQUAD_CATEGORIES, TAG_OPTIONS, NO_SHARES, toShares, inertWithoutTracks,
  type SquadShares, type TagVisibility,
} from '@/lib/squadCategories'

interface MemberRow {
  id: string
  team_id: string
  status: 'invited' | 'active' | 'left'
  shares: unknown
  teams?: { name: string } | null
}
interface SquadRow {
  id: string
  name: string
  note: string | null
  squad_members: MemberRow[]
}

export default function SquadPanel({ teamId }: { teamId: string }) {
  const [squads, setSquads] = useState<SquadRow[] | null>(null)
  const [draft, setDraft] = useState<Record<string, SquadShares>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/squads')
      if (!res.ok) {
        // A 500 here used to be indistinguishable from "you are in no squad",
        // which is how a recursive policy hid the whole feature for a day.
        // Say which it is.
        setErr(`Could not load squads — the server answered ${res.status}.`)
        setSquads([])
        return
      }
      const j = await res.json()
      const rows: SquadRow[] = (j?.squads || []).filter((s: SquadRow) =>
        (s.squad_members || []).some((m) => m.team_id === teamId && m.status !== 'left'))
      setSquads(rows)
      setErr(null)
      const d: Record<string, SquadShares> = {}
      for (const s of rows) {
        const mine = s.squad_members.find((m) => m.team_id === teamId)
        d[s.id] = mine ? toShares(mine.shares) : { ...NO_SHARES }
      }
      setDraft(d)
    } catch {
      setErr('Could not reach the server.')
      setSquads([])
    }
  }, [teamId])

  useEffect(() => { void load() }, [load])

  async function send(squadId: string, body: Record<string, unknown>, label: string) {
    setBusy(squadId); setErr(null); setSaved(null)
    try {
      const res = await fetch(`/api/squads/${squadId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, ...body }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j?.error || `The server answered ${res.status}.`)
        return
      }
      setSaved(label)
      await load()
    } catch {
      setErr('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  async function leave(squadId: string, name: string) {
    // Said plainly rather than softened: revocation is not retroactive, and
    // pretending otherwise would be a lie about what other people already have.
    const ok = window.confirm(
      `Leave ${name}?\n\nFuture days stop being shared immediately. Days that were ` +
      `already shared have been seen, and leaving cannot unsee them.`
    )
    if (!ok) return
    setBusy(squadId)
    try {
      await fetch(`/api/squads/${squadId}/members?team_id=${encodeURIComponent(teamId)}`,
        { method: 'DELETE' })
      await load()
    } finally { setBusy(null) }
  }

  if (squads === null) {
    return (
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">Squad</h2>
        <div className="bg-white rounded-xl shadow border border-slate-200 p-4 text-sm text-slate-400">
          Loading…
        </div>
      </section>
    )
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Squad
      </h2>

      {err && (
        <div className="mb-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {squads.length === 0 ? (
        <div className="bg-white rounded-xl shadow border border-slate-200 p-4 text-sm text-slate-600">
          This team is not in a squad, and has not been invited to one.
          <div className="text-slate-400 text-xs mt-1">
            A squad lets teams that train together see each other&rsquo;s days. An
            administrator sets one up and invites the teams; joining is then this
            team&rsquo;s own decision.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {squads.map((sq) => {
            const mine = sq.squad_members.find((m) => m.team_id === teamId)!
            const joined = mine.status === 'active'
            const others = sq.squad_members
              .filter((m) => m.team_id !== teamId && m.status === 'active')
              .map((m) => m.teams?.name)
              .filter(Boolean) as string[]
            const d = draft[sq.id] || NO_SHARES
            const inert = inertWithoutTracks(d)
            const working = busy === sq.id

            return (
              <div key={sq.id} className="bg-white rounded-xl shadow border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{sq.name}</div>
                    <div className="text-xs text-slate-500">
                      {others.length
                        ? `With ${others.join(', ')}`
                        : 'No other teams have joined yet'}
                    </div>
                    {sq.note && <div className="text-xs text-slate-400 mt-0.5">{sq.note}</div>}
                  </div>
                  {joined ? (
                    <button
                      onClick={() => leave(sq.id, sq.name)}
                      disabled={working}
                      className="shrink-0 text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Leave squad
                    </button>
                  ) : (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                      Invited
                    </span>
                  )}
                </div>

                {!joined && (
                  <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <div className="text-sm text-slate-700">
                      This team has been invited to join. Joining shares{' '}
                      <strong>nothing</strong> on its own — you choose what to
                      contribute below, and each day still carries its own
                      &ldquo;share with the squad&rdquo; tick.
                    </div>
                  </div>
                )}

                {/* Categories */}
                <div className="mt-3 space-y-1.5">
                  {SQUAD_CATEGORIES.map((c) => (
                    <label key={c.key} className="flex gap-2 items-start cursor-pointer group">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={d[c.key]}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, [sq.id]: { ...d, [c.key]: e.target.checked } }))
                        }
                      />
                      <span className="min-w-0">
                        <span className="text-sm text-slate-800">{c.label}</span>
                        <span className="block text-xs text-slate-500">{c.detail}</span>
                      </span>
                    </label>
                  ))}

                  {/* Tags: the one category with a middle setting. */}
                  <div className="pt-1">
                    <div className="text-sm text-slate-800">Tags</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {TAG_OPTIONS.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          title={o.detail}
                          onClick={() =>
                            setDraft((p) => ({ ...p, [sq.id]: { ...d, tags: o.value as TagVisibility } }))
                          }
                          className={
                            'text-xs px-2 py-1 rounded border ' +
                            (d.tags === o.value
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50')
                          }
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {TAG_OPTIONS.find((o) => o.value === d.tags)?.detail}
                    </div>
                  </div>
                </div>

                {/* A box that silently does nothing is worse than one that says so. */}
                {inert.length > 0 && (
                  <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                    {inert.join(', ')} {inert.length === 1 ? 'needs' : 'need'} <strong>Tracks</strong> to
                    be shared as well — they hang off a shared day, so on their own they show nothing.
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() =>
                      send(sq.id,
                        { status: 'active', shares: d },
                        joined ? 'Saved.' : `Joined ${sq.name}.`)
                    }
                    disabled={working}
                    className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {working ? 'Saving…' : joined ? 'Save what we share' : 'Join squad'}
                  </button>
                  {saved && !working && (
                    <span className="text-xs text-green-700">{saved}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
