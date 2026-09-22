'use client'

// Admin: create a squad, and decide which teams may join it.
//
// THE SPLIT OF AUTHORITY, which is the whole point of this screen existing
// separately from the team's own panel:
//
//   ADMIN   creates the squad and says which teams MAY join  (status 'invited')
//   TEAM    decides whether to join, and what it contributes (status 'active')
//
// An admin can put a team on the list and cannot make it share a thing. A team
// can choose freely among the categories and cannot enrol itself in a squad it
// was not invited to. Neither side can do the other's half, which is what makes
// this safe to hand to a national federation running six campaigns.

import { useCallback, useEffect, useState } from 'react'
import { isLive, codeNote } from '@/lib/squadCodes'

interface Team { id: string; name: string }
interface Member {
  id: string
  team_id: string
  status: 'invited' | 'active' | 'left'
  shares: Record<string, unknown> | null
  teams?: { name: string } | null
}
interface Squad {
  id: string
  name: string
  note: string | null
  squad_members: Member[]
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  invited: 'bg-amber-100 text-amber-700',
  left: 'bg-slate-100 text-slate-500',
}

/** What a member actually contributes, for the admin's overview. */
function contributes(m: Member): string {
  if (m.status !== 'active') return '—'
  const s = (m.shares || {}) as Record<string, unknown>
  const on = ['tracks', 'logdata', 'videos', 'photos', 'sailscans', 'comments', 'notes']
    .filter((k) => s[k] === true)
  if (s.tags === 'race') on.push('race tags')
  if (s.tags === 'all') on.push('all tags')
  return on.length ? on.join(', ') : 'nothing yet'
}

export default function SquadsAdmin({ teams, isAdmin = false }: { teams: Team[]; isAdmin?: boolean }) {
  const [squads, setSquads] = useState<Squad[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [foundingTeam, setFoundingTeam] = useState('')
  const [invitePick, setInvitePick] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/squads')
      if (!res.ok) {
        setErr(`Could not load squads — the server answered ${res.status}.`)
        setSquads([])
        return
      }
      const j = await res.json()
      setSquads(j?.squads || [])
      setErr(null)
    } catch {
      setErr('Could not reach the server.')
      setSquads([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function create() {
    if (!name.trim() || !foundingTeam) return
    setBusy(true); setErr(null)
    try {
      // A squad with no team in it is a squad nobody can see — the policy keys
      // visibility off membership — so the founding team is required.
      const res = await fetch('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), note: note.trim() || null, team_id: foundingTeam }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j?.error || `The server answered ${res.status}.`)
        return
      }
      setName(''); setNote(''); setFoundingTeam('')
      await load()
    } finally { setBusy(false) }
  }

  async function invite(squadId: string) {
    const teamId = invitePick[squadId]
    if (!teamId) return
    setBusy(true); setErr(null)
    try {
      // 'invited', never 'active': an admin offers the place, the team takes
      // it. Writing 'active' here would enrol a team without its consent.
      const res = await fetch(`/api/squads/${squadId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, status: 'invited' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j?.error || `The server answered ${res.status}.`)
        return
      }
      setInvitePick((p) => ({ ...p, [squadId]: '' }))
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-8">
      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
          New squad
        </h2>
        <div className="bg-white rounded-xl shadow border border-slate-200 p-4 space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name — e.g. NED 49er squad, Palma winter block"
            className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5"
          />
          <select
            value={foundingTeam}
            onChange={(e) => setFoundingTeam(e.target.value)}
            className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white"
          >
            <option value="">Founding team…</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <button
              onClick={create}
              disabled={busy || !name.trim() || !foundingTeam}
              className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Create squad
            </button>
            <span className="text-xs text-slate-500">
              The founding team joins as a member. It still chooses what it shares.
            </span>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
          Squads {squads ? `(${squads.length})` : ''}
        </h2>
        {squads === null ? (
          <div className="bg-white rounded-xl shadow border border-slate-200 p-4 text-sm text-slate-400">
            Loading…
          </div>
        ) : squads.length === 0 ? (
          <div className="bg-white rounded-xl shadow border border-slate-200 p-4 text-sm text-slate-600">
            No squads yet.
          </div>
        ) : (
          <div className="space-y-3">
            {squads.map((sq) => {
              const inIt = new Set(sq.squad_members.map((m) => m.team_id))
              const eligible = teams.filter((t) => !inIt.has(t.id))
              return (
                <div key={sq.id} className="bg-white rounded-xl shadow border border-slate-200 p-4">
                  <div className="font-medium text-slate-900">{sq.name}</div>
                  {sq.note && <div className="text-xs text-slate-400">{sq.note}</div>}

                  <table className="w-full text-sm mt-2">
                    <tbody className="divide-y divide-slate-100">
                      {sq.squad_members.map((m) => (
                        <tr key={m.id}>
                          <td className="py-1.5 pr-2 text-slate-800">{m.teams?.name || m.team_id}</td>
                          <td className="py-1.5 pr-2 w-20">
                            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_STYLE[m.status]}`}>
                              {m.status}
                            </span>
                          </td>
                          <td className="py-1.5 text-xs text-slate-500">{contributes(m)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <JoinCodes squadId={sq.id} onChanged={load} />

                  {/* Admins can still add a team they can see directly; a team
                      manager cannot, because there is no picker that does not
                      leak the team directory. Codes work for both. */}
                  {isAdmin && eligible.length > 0 && (
                    <div className="mt-3 flex items-center gap-2">
                      <select
                        value={invitePick[sq.id] || ''}
                        onChange={(e) => setInvitePick((p) => ({ ...p, [sq.id]: e.target.value }))}
                        className="text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white"
                      >
                        <option value="">Or add a team directly (admin)…</option>
                        {eligible.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <button
                        onClick={() => invite(sq.id)}
                        disabled={busy || !invitePick[sq.id]}
                        className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Invite
                      </button>
                    </div>
                  )}
                  <div className="text-xs text-slate-400 mt-2">
                    An invited team appears here as <strong>invited</strong> until its own
                    coach or manager joins it, on that team&rsquo;s page. Neither a code
                    nor an invitation shares anything.
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}


// The codes for one squad. A code is how a squad manager reaches a team they
// do not run: they send it, the other team's coach or manager redeems it on
// their own team page, and an INVITED row appears. Consent never moves.
function JoinCodes({ squadId, onChanged }: { squadId: string; onChanged: () => void }) {
  const [codes, setCodes] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/squads/${squadId}/codes`)
      if (!res.ok) { setCodes([]); return }
      const j = await res.json()
      setCodes(j?.codes || [])
    } catch { setCodes([]) }
  }, [squadId])
  useEffect(() => { void load() }, [load])

  async function mint() {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/squads/${squadId}/codes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_uses: 10, expires_in_days: 30 }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j?.error || `the server answered ${res.status}`); return }
      await load(); onChanged()
    } finally { setBusy(false) }
  }

  async function withdraw(id: string) {
    setBusy(true)
    try {
      await fetch(`/api/squads/${squadId}/codes?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
    } finally { setBusy(false) }
  }


  return (
    <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Join codes</div>
        <button
          onClick={mint}
          disabled={busy}
          className="text-xs px-2 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          New code
        </button>
      </div>
      {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
      {codes === null ? (
        <div className="text-xs text-slate-400 mt-1">Loading…</div>
      ) : codes.length === 0 ? (
        <div className="text-xs text-slate-500 mt-1">
          None yet. A code lets another team&rsquo;s coach or manager put their team
          in front of this squad — send it however you like.
        </div>
      ) : (
        <ul className="mt-1 space-y-1">
          {codes.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs">
              <code className={isLive(c) ? 'font-mono text-slate-800' : 'font-mono text-slate-400 line-through'}>
                {c.token}
              </code>
              <span className="text-slate-400">
                {c.used_count}/{c.max_uses}
                {codeNote(c) && ` · ${codeNote(c)}`}
              </span>
              {isLive(c) && (
                <>
                  <button
                    onClick={() => { navigator.clipboard?.writeText(c.token); setCopied(c.id) }}
                    className="text-blue-600 hover:underline"
                  >
                    {copied === c.id ? 'copied' : 'copy'}
                  </button>
                  <button onClick={() => withdraw(c.id)} disabled={busy} className="text-red-600 hover:underline">
                    withdraw
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
