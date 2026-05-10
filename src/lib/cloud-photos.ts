// Cloud-backed photos. Mirror of cloud-videos.ts. Active-membership scope.

import { getActiveMembership } from './active-membership'

export interface CloudPhotoRow {
  id: string
  session_id: string
  taken_utc: string | null
  exif_data: unknown
  thumbnail_url: string | null
  bunny_storage_path: string | null
  bytes: number | null
  analysis_data: unknown
  created_at: string
  created_by_user_id: string | null
  sessions?: { date: string } | null
}

interface ListArgs {
  userId: string
  date?: string
}

export async function listPhotosCloud({
  userId,
  date,
}: ListArgs): Promise<CloudPhotoRow[]> {
  const m = getActiveMembership(userId)
  if (!m || !m.boat_id) return []
  const url = `/api/teams/${m.team_id}/boats/${m.boat_id}/photos${
    date ? `?date=${date}` : ''
  }`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const j = (await res.json()) as { photos?: CloudPhotoRow[] }
    return j.photos || []
  } catch {
    return []
  }
}

interface UpsertArgs {
  userId: string
  sessionDate: string
  takenUtc?: number | string | null
  exif?: unknown
  thumbnailUrl?: string | null
  bunnyStoragePath?: string | null
  bytes?: number | null
  analysis?: unknown
}

export async function upsertPhotoCloud(args: UpsertArgs): Promise<boolean> {
  const m = getActiveMembership(args.userId)
  if (!m || !m.boat_id) return false
  const url = `/api/teams/${m.team_id}/boats/${m.boat_id}/photos`
  const takenUtc =
    args.takenUtc != null
      ? typeof args.takenUtc === 'number'
        ? new Date(args.takenUtc).toISOString()
        : args.takenUtc
      : null
  const body = {
    session_date: args.sessionDate,
    taken_utc: takenUtc,
    exif_data: args.exif ?? null,
    thumbnail_url: args.thumbnailUrl ?? null,
    bunny_storage_path: args.bunnyStoragePath ?? null,
    bytes: args.bytes ?? null,
    analysis_data: args.analysis ?? null,
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

export function toLegacyPhotoShape(p: CloudPhotoRow): Record<string, unknown> {
  return {
    id: p.id,
    utc: p.taken_utc ? new Date(p.taken_utc).getTime() : null,
    exif: p.exif_data,
    thumbnailUrl: p.thumbnail_url,
    bunnyPath: p.bunny_storage_path,
    url: p.bunny_storage_path,
    size: p.bytes,
    analysis: p.analysis_data,
    sessionDate: p.sessions?.date || '',
    source: 'supabase',
  }
}
