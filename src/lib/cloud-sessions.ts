// Cloud-backed sessions. Reads/writes log_data + xml_data per
// (active membership, date). Mirrors the localStore.js function shape so
// the existing SSA UI can call these as drop-in replacements.
//
// Falls back to localStorage / IndexedDB when there's no active membership
// (e.g. brand-new user pre-team-assignment) so the legacy single-tenant
// behaviour keeps working.

import { getActiveMembership } from './active-membership'
import { withUplink } from './uplinkPriority'

interface Args { userId: string }

export interface CloudSessionRow {
  id: string
  date: string
  title: string | null
  tz_offset_minutes: number | null
  created_at: string
  updated_at: string
  created_by_user_id: string | null
  /** Number of videos in this session (from the API's aggregate embed). */
  video_count?: number
  photo_count?: number
  /** Whether the row holds a log / event file — see the sessions route. */
  has_log?: boolean
  has_xml?: boolean
}

function endpoint(teamId: string, boatId: string | null, date?: string): string | null {
  if (!boatId) return null // we only support boat-scoped sessions for now
  const base = `/api/teams/${teamId}/boats/${boatId}/sessions`
  return date ? `${base}/${date}` : base
}

export async function listSessionsCloud({
  userId,
}: Args): Promise<CloudSessionRow[]> {
  const m = getActiveMembership(userId)
  if (!m || !m.boat_id) return []
  const url = endpoint(m.team_id, m.boat_id)
  if (!url) return []
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const j = (await res.json()) as { sessions?: CloudSessionRow[] }
    return j.sessions || []
  } catch {
    return []
  }
}

export async function getSessionCloud({
  userId,
  date,
}: Args & { date: string }): Promise<{
  log_data: unknown
  xml_data: unknown
  tz_offset_minutes: number | null
  title: string | null
} | null> {
  const m = getActiveMembership(userId)
  if (!m || !m.boat_id) return null
  const url = endpoint(m.team_id, m.boat_id, date)
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const j = (await res.json()) as { session: any | null }
    if (!j.session) return null
    return {
      log_data: j.session.log_data ?? null,
      xml_data: j.session.xml_data ?? null,
      tz_offset_minutes: j.session.tz_offset_minutes ?? null,
      title: j.session.title ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Why a cloud write cannot work, in a sentence, or null when it can.
 *
 * This exists because of how 10 October went. The log imported, the track drew
 * locally, and the cloud row got nothing — so the phone, which has no other
 * source, showed a day with no track, no detections and no starts, while the
 * desktop that imported it looked perfect. The upload tab's own message said
 * "saved on this device only · check the console for the HTTP status", and the
 * console was EMPTY: there had been no HTTP status, because the write never
 * reached the network. `if (!m || !m.boat_id) return false` is three different
 * answers — not signed into a workspace, signed into a TEAM-level one with no
 * boat, or a boat the device cannot resolve — and it gave all three as a bare
 * `false` with nothing written anywhere.
 *
 * A failure whose only symptom is on somebody else's device has to say what it
 * was, where the person who caused it is looking.
 */
export function sessionSyncBlocker(userId: string): string | null {
  const m = getActiveMembership(userId)
  if (!m) {
    return 'no active workspace on this device — pick one from the menu behind your name, '
         + 'then import again'
  }
  if (!m.boat_id) {
    return 'the active workspace is the TEAM, not a boat. A session belongs to a boat, so '
         + 'nothing can be written for it — switch to a boat workspace and import again'
  }
  if (!endpoint(m.team_id, m.boat_id, '1970-01-01')) {
    return `the active workspace (team ${m.team_id}) resolves to no session URL`
  }
  return null
}

async function upsertSession(
  userId: string,
  date: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const blocked = sessionSyncBlocker(userId)
  if (blocked) {
    // eslint-disable-next-line no-console
    console.error(`[cloud-sessions] session PUT not attempted: ${blocked}`)
    return false
  }
  const m = getActiveMembership(userId)!
  const url = endpoint(m.team_id, m.boat_id, date)
  if (!url) return false
  try {
    const payload = JSON.stringify(body)
    // The log takes the uplink: see uplinkPriority.ts. Four MB that every other
    // device needs before it can show anything, against gigabytes of video that
    // people watch one at a time afterwards.
    const res = await withUplink(() => fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }))
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // eslint-disable-next-line no-console
      console.error(
        `[cloud-sessions] session PUT failed: HTTP ${res.status} · ` +
          `payload ${(payload.length / 1024 / 1024).toFixed(2)} MB · ` +
          `${detail.slice(0, 200)}`
      )
    }
    return res.ok
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[cloud-sessions] session PUT failed (network/exception)', e)
    return false
  }
}

export async function saveLogDataCloud({
  userId,
  date,
  logData,
  tzOffsetMinutes,
}: Args & {
  date: string
  logData: unknown
  tzOffsetMinutes?: number | null
}): Promise<boolean> {
  const body: Record<string, unknown> = { log_data: logData }
  if (tzOffsetMinutes !== undefined) body.tz_offset_minutes = tzOffsetMinutes
  return upsertSession(userId, date, body)
}

export async function saveXmlDataCloud({
  userId,
  date,
  xmlData,
}: Args & { date: string; xmlData: unknown }): Promise<boolean> {
  return upsertSession(userId, date, { xml_data: xmlData })
}
