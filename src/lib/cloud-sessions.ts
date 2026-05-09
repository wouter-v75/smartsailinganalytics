// Cloud-backed sessions. Reads/writes log_data + xml_data per
// (active membership, date). Mirrors the localStore.js function shape so
// the existing SSA UI can call these as drop-in replacements.
//
// Falls back to localStorage / IndexedDB when there's no active membership
// (e.g. brand-new user pre-team-assignment) so the legacy single-tenant
// behaviour keeps working.

import { getActiveMembership } from './active-membership'

interface Args { userId: string }

export interface CloudSessionRow {
  id: string
  date: string
  title: string | null
  tz_offset_minutes: number | null
  created_at: string
  updated_at: string
  created_by_user_id: string | null
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

async function upsertSession(
  userId: string,
  date: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const m = getActiveMembership(userId)
  if (!m || !m.boat_id) return false
  const url = endpoint(m.team_id, m.boat_id, date)
  if (!url) return false
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
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
