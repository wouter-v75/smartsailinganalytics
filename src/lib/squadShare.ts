// src/lib/squadShare.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Share this track with the squad", and whether that question is worth asking.
//
// Sharing is decided PER SESSION, not by a standing grant over everything a
// boat will ever do — see migration 0071. A rival will agree to "we trained
// together on these days"; nobody agrees to "watch everything I do for the
// next four years". So the question is asked when a track is uploaded and the
// answer stays changeable afterwards in Analytics.
//
// The question is only worth asking when the boat's team is actually in a
// squad. A team of one boat should never see it.
// ─────────────────────────────────────────────────────────────────────────────

export interface SquadSummary {
  id: string
  name: string
  /** Other teams in it, for "shared with Dragon Squad · 3 other teams". */
  otherTeams: string[]
}

/** The active squads this team belongs to. Empty is the common case. */
export async function squadsForTeam(
  teamId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SquadSummary[]> {
  try {
    const res = await fetchImpl('/api/squads')
    if (!res.ok) return []
    const j = await res.json()
    const squads = Array.isArray(j?.squads) ? j.squads : []
    return squads
      .filter((s: any) => (s.squad_members || []).some(
        (m: any) => m.team_id === teamId && m.status === 'active'))
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        otherTeams: (s.squad_members || [])
          .filter((m: any) => m.team_id !== teamId && m.status === 'active')
          .map((m: any) => m.teams?.name)
          .filter(Boolean),
      }))
  } catch {
    return []
  }
}

/**
 * Turn sharing on or off for one session.
 *
 * Sends ONLY the flag. The session PUT treats an absent field as "leave it
 * alone", so a toggle cannot disturb the log, the event file or the title —
 * and an ordinary save elsewhere cannot silently un-share a session somebody
 * deliberately shared.
 */
export async function setSessionShared(
  teamId: string,
  boatId: string,
  date: string,
  shared: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(`/api/teams/${teamId}/boats/${boatId}/sessions/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shared_with_squad: shared }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      return { ok: false, error: j?.error || `the server answered ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not reach the server' }
  }
}

/** One line for the checkbox or toggle. */
export function shareLabel(squads: SquadSummary[]): string {
  if (!squads.length) return ''
  const names = squads.map((s) => s.name).join(', ')
  const others = squads.reduce((n, s) => n + s.otherTeams.length, 0)
  return others
    ? `Share this track with ${names} — ${others} other ${others === 1 ? 'team' : 'teams'} will see it`
    : `Share this track with ${names}`
}
