// Cloud-backed videos. Active-membership scope. Read + write helpers used
// by the SSA UI; falls back gracefully when no membership is set so the
// legacy single-tenant flow keeps working.

import { getActiveMembership } from './active-membership'

export interface CloudVideoRow {
  id: string
  session_id: string
  title: string | null
  start_utc: string | null
  duration_ms: number | null
  tags: string[]
  sync_offset_secs: number
  thumbnail_url: string | null
  bunny_stream_id: string | null
  bunny_storage_path: string | null
  bytes: number | null
  created_at: string
  created_by_user_id: string | null
  // joined
  sessions?: { date: string } | null
}

interface ListArgs {
  userId: string
  date?: string
}

export async function listVideosCloud({
  userId,
  date,
}: ListArgs): Promise<CloudVideoRow[]> {
  const m = getActiveMembership(userId)
  if (!m || !m.boat_id) return []
  const url = `/api/teams/${m.team_id}/boats/${m.boat_id}/videos${
    date ? `?date=${date}` : ''
  }`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const j = (await res.json()) as { videos?: CloudVideoRow[] }
    return j.videos || []
  } catch {
    return []
  }
}

interface UpsertArgs {
  userId: string
  sessionDate: string
  title?: string | null
  startUtc?: number | string | null
  durationSec?: number | null
  tags?: string[]
  syncOffsetSecs?: number
  thumbnailUrl?: string | null
  bunnyStreamId?: string | null
  bunnyStoragePath?: string | null
  bytes?: number | null
  externalId?: string | null
}

export async function upsertVideoCloud(args: UpsertArgs): Promise<boolean> {
  const m = getActiveMembership(args.userId)
  if (!m || !m.boat_id) return false
  const url = `/api/teams/${m.team_id}/boats/${m.boat_id}/videos`
  const startUtc =
    args.startUtc != null
      ? typeof args.startUtc === 'number'
        ? new Date(args.startUtc).toISOString()
        : args.startUtc
      : null
  const body = {
    session_date: args.sessionDate,
    title: args.title ?? null,
    start_utc: startUtc,
    duration_ms:
      typeof args.durationSec === 'number'
        ? Math.round(args.durationSec * 1000)
        : null,
    tags: args.tags ?? [],
    sync_offset_secs: args.syncOffsetSecs ?? 0,
    thumbnail_url: args.thumbnailUrl ?? null,
    bunny_stream_id: args.bunnyStreamId ?? null,
    bunny_storage_path: args.bunnyStoragePath ?? null,
    bytes: args.bytes ?? null,
    external_id: args.externalId ?? null,
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

// Convert Supabase rows into the shape the existing SSA UI expects (so we
// don't have to refactor every consumer). Keeps the legacy field names that
// localStore videos use.
export function toLegacyVideoShape(v: CloudVideoRow): Record<string, unknown> {
  return {
    id: v.id,
    title: v.title,
    name: v.title,
    sessionDate: v.sessions?.date || '',
    startUtc: v.start_utc ? new Date(v.start_utc).getTime() : null,
    duration: v.duration_ms ? v.duration_ms / 1000 : null,
    tags: v.tags || [],
    size: v.bytes,
    streamId: v.bunny_stream_id,
    cloudSynced: true,
    syncOffset: v.sync_offset_secs,
    thumbnailUrl: v.thumbnail_url,
    source: 'supabase',
    hasLocalBlob: false,
  }
}
