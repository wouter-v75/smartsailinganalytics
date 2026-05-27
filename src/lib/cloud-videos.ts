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
  /** Bunny Stream auto-poster URL, attached inline by the videos GET route
   *  (derived from bunny_original_stream_id) so cards can paint without a
   *  per-clip signed-URL call. */
  thumbnail?: string | null
  bunny_stream_id: string | null
  bunny_storage_path: string | null
  // Phase B rendition columns. Either present + bool true, or null + false.
  bunny_proxy_path?: string | null
  bunny_original_path?: string | null
  /** Phase 2 — GUID of the Bunny Stream video holding the original. */
  bunny_original_stream_id?: string | null
  has_proxy?: boolean
  has_original?: boolean
  proxy_uploaded_at?: string | null
  original_uploaded_at?: string | null
  proxy_bytes?: number | null
  bytes: number | null
  created_at: string
  created_by_user_id: string | null
  /** Links a cloud row back to the local IDB video it was mirrored from. */
  external_id?: string | null
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

// Recognise a Supabase UUID. We use this to decide whether a video's
// id is already a cloud row id, or whether it's still the local IDB key
// (e.g. `v_1779206586594_uavaqvgpr7s`) — in which case we need to
// upsert first to get a real UUID before any rendition PATCH can target
// the row.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isCloudVideoId(id: string | null | undefined): boolean {
  return !!id && UUID_RE.test(id)
}

interface EnsureArgs {
  userId: string
  /** The local video record from IDB or already-cloud row. */
  video: {
    id: string
    title?: string | null
    name?: string | null
    sessionDate?: string | null
    startUtc?: number | string | null
    duration?: number | null
    tags?: string[]
    size?: number | null
    streamId?: string | null
  }
  /** Fallback session date if video.sessionDate isn't set. */
  sessionDate: string
  /** Optional sync offset map keyed by local id. */
  syncOffsets?: Record<string, number>
}

/**
 * Ensure a Supabase videos row exists for this local clip and return its
 * UUID. Idempotent — if a row already exists (matched by external_id or
 * stream id), the existing UUID is returned without creating a duplicate.
 *
 * Returns null when no active membership is set (e.g. solo / pre-onboarding
 * users); callers should treat that as "skip the cloud step".
 */
export async function ensureCloudVideoId({
  userId,
  video,
  sessionDate,
  syncOffsets,
}: EnsureArgs): Promise<string | null> {
  // Already a cloud row id — nothing to do.
  if (isCloudVideoId(video.id)) return video.id

  const m = getActiveMembership(userId)
  if (!m || !m.boat_id) return null

  const startUtcIso =
    video.startUtc != null
      ? typeof video.startUtc === 'number'
        ? new Date(video.startUtc).toISOString()
        : video.startUtc
      : null

  const body = {
    session_date: sessionDate,
    title: video.title || video.name || null,
    start_utc: startUtcIso,
    duration_ms:
      typeof video.duration === 'number'
        ? Math.round(video.duration * 1000)
        : null,
    tags: video.tags ?? [],
    sync_offset_secs: syncOffsets?.[video.id] || 0,
    bunny_stream_id: video.streamId ?? null,
    bytes: video.size ?? null,
    external_id: video.id, // ← the linking key
  }

  try {
    const res = await fetch(
      `/api/teams/${m.team_id}/boats/${m.boat_id}/videos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    if (!res.ok) return null
    const j = (await res.json()) as { video?: { id: string } }
    return j.video?.id || null
  } catch {
    return null
  }
}

// Build a per-video callback for syncSessionToCloud's onVideoSynced hook.
// Mirrors each clip into Supabase the moment its Bunny upload finishes, so
// teammates can see clips appear one-by-one rather than after the whole
// batch. Safe to invoke without an authed user — returns a no-op in that case.
interface MirrorArgs {
  userId: string | null
  sessionDate: string
  syncOffsets?: Record<string, number>
  onMirrored?: (label: string) => void
}
export function makeVideoMirrorCallback({
  userId,
  sessionDate,
  syncOffsets,
  onMirrored,
}: MirrorArgs) {
  return async ({
    video,
    streamId,
  }: {
    video: {
      id: string
      name?: string | null
      title?: string | null
      startUtc?: number | string | null
      duration?: number | null
      tags?: string[]
      size?: number | null
    }
    streamId: string | null
  }) => {
    if (!userId || !streamId) return
    try {
      await upsertVideoCloud({
        userId,
        sessionDate,
        title: video.title || video.name || null,
        startUtc: video.startUtc ?? null,
        durationSec: video.duration ?? null,
        tags: video.tags ?? [],
        syncOffsetSecs: syncOffsets?.[video.id] || 0,
        bunnyStreamId: streamId,
        bunnyStoragePath: `sessions/${sessionDate}/videos/${video.id}/original`,
        bytes: video.size ?? null,
        externalId: video.id,
      })
      onMirrored?.(video.title || video.name || video.id)
    } catch {
      /* non-fatal — Bunny still has the file */
    }
  }
}

// Convert Supabase rows into the shape the existing SSA UI expects (so we
// don't have to refactor every consumer). Keeps the legacy field names that
// localStore videos use.
export function toLegacyVideoShape(v: CloudVideoRow): Record<string, unknown> {
  return {
    id: v.id,
    /** Local IDB id this cloud row was mirrored from — used to de-dupe a
     *  clip that exists both on this device and in Supabase. */
    externalId: v.external_id || null,
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
    thumbnailUrl: v.thumbnail || v.thumbnail_url || null,
    source: 'supabase',
    hasLocalBlob: false,
    // Phase B — propagate rendition state to the UI shape so the per-clip
    // sync panel can know what's already uploaded.
    hasProxy: Boolean(v.has_proxy),
    hasOriginal: Boolean(v.has_original),
    proxyPath: v.bunny_proxy_path || null,
    originalPath: v.bunny_original_path || null,
    originalStreamId: v.bunny_original_stream_id || null,
    proxyUploadedAt: v.proxy_uploaded_at || null,
    // Exposed for the local/cloud freshness comparison in loadDate: a clip
    // can have an original uploaded without ever having a proxy (and on
    // desktop we skip the proxy step entirely), so we need both timestamps
    // to decide whether the cloud row's bytes are newer than a local edit.
    originalUploadedAt: v.original_uploaded_at || null,
  }
}
