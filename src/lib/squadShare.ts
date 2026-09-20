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

// ── Media ───────────────────────────────────────────────────────────────────
// The same decision on videos and photos, because the usual case is ONE drone
// operator or coach filming the whole squad from the RIB: that footage is of
// everybody and was taken by somebody working for everybody. Onboard footage
// with crew audio simply stays unticked — a judgement the person who shot it
// can make and the schema cannot.

export type MediaKind = 'videos' | 'photos'

/**
 * Share or un-share one clip or photo.
 *
 * `squad-share`, not `share`: /api/videos/<id>/share already exists and does
 * something else — it mints an external capability token. These are different
 * decisions with different audiences and they must not share a URL.
 */
export async function setMediaShared(
  kind: MediaKind,
  id: string,
  shared: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(`/api/${kind}/${id}/squad-share`, {
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

/**
 * Share every clip or photo in a session at once.
 *
 * A drone operator comes back with dozens of clips of six boats; asking them to
 * tick each one is asking them not to bother. Returns what actually happened
 * rather than a bare boolean, because a partial failure here is worth seeing —
 * half-shared media is the kind of thing somebody discovers much later.
 */
export async function setSessionMediaShared(
  kind: MediaKind,
  ids: string[],
  shared: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; changed: number; failed: number; error?: string }> {
  if (!ids.length) return { ok: true, changed: 0, failed: 0 }
  const results = await Promise.all(ids.map((id) => setMediaShared(kind, id, shared, fetchImpl)))
  const failed = results.filter((r) => !r.ok).length
  return {
    ok: failed === 0,
    changed: results.length - failed,
    failed,
    error: failed ? results.find((r) => !r.ok)?.error : undefined,
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

// ── "Am I in a squad, and what is it seeing?" ───────────────────────────────
// A team must never be in a squad without knowing it — design doc §7, "no
// silent sharing". Being in a squad shares NOTHING by itself, so the honest
// answer has two halves: the standing relationship, and the count of items
// actually shared under it. Showing only the first invites the reasonable fear
// that joining handed everything over; showing only the second hides the
// relationship from a team that has not uploaded yet.

export interface SquadStanding {
  squads: SquadSummary[]
  /** Items of this team's OWN data currently visible to the squad. */
  shared: { sessions: number; videos: number; photos: number }
}

/**
 * Counts what this team is exposing. Reads through the caller's own session,
 * so RLS applies and a team can only ever count its own.
 *
 * Counting failures return 0 rather than throwing: this is a reassurance
 * panel, and it must not be the thing that breaks the user menu.
 */
export async function squadStanding(
  teamId: string,
  countImpl: (table: MediaKind | 'sessions') => Promise<number>,
  fetchImpl: typeof fetch = fetch
): Promise<SquadStanding> {
  const squads = await squadsForTeam(teamId, fetchImpl)
  if (!squads.length) {
    return { squads, shared: { sessions: 0, videos: 0, photos: 0 } }
  }
  const [sessions, videos, photos] = await Promise.all(
    (['sessions', 'videos', 'photos'] as const).map((t) =>
      countImpl(t).catch(() => 0))
  )
  return { squads, shared: { sessions, videos, photos } }
}

/** Plain English for the panel: what the squad can actually see today. */
export function sharedSummary(shared: SquadStanding['shared']): string {
  const parts: string[] = []
  if (shared.sessions) parts.push(`${shared.sessions} track${shared.sessions === 1 ? '' : 's'}`)
  if (shared.videos) parts.push(`${shared.videos} clip${shared.videos === 1 ? '' : 's'}`)
  if (shared.photos) parts.push(`${shared.photos} photo${shared.photos === 1 ? '' : 's'}`)
  if (!parts.length) return 'Nothing shared yet — you choose per track.'
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    : parts[0]
  return `Sharing ${list}.`
}
