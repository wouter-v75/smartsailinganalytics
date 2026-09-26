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
  // Instrument snapshot + tags are baked into analysis_data at import/mirror
  // time. The photo overlay reads TOP-LEVEL fields (photo.tws, photo.sails…),
  // so hydrate them here — otherwise a cloud-loaded photo shows a blank overlay
  // whenever the live log isn't loaded / doesn't match (videos avoid this by
  // baking twsAvg onto the row). Live enrichment still overrides these when a
  // log row matches.
  const a = (p.analysis_data as {
    inst?: Record<string, number | null>
    sails?: string[]
    raceTags?: string[]
    boat?: string | null
    location?: string | null
    sailTrim?: unknown
  } | null) || {}
  const inst = a.inst || {}
  return {
    id: p.id,
    utc: p.taken_utc ? new Date(p.taken_utc).getTime() : null,
    exif: p.exif_data,
    thumbnailUrl: p.thumbnail_url,
    bunnyPath: p.bunny_storage_path,
    url: p.bunny_storage_path,
    size: p.bytes,
    analysis: p.analysis_data,
    tws: inst.tws ?? null, twa: inst.twa ?? null, awa: inst.awa ?? null,
    bsp: inst.bsp ?? null, heel: inst.heel ?? null, vmg: inst.vmg ?? null,
    sails: a.sails || [], raceTags: a.raceTags || [],
    boat: a.boat ?? null, location: a.location ?? null,
    // Sail geometry, measured once in SailTrim and carried here so that the
    // annotation draws for everyone. PhotosTab reads `sailtrim_data` as a JSON
    // string (the shape SailScan established), so hand it one.
    sailtrim_data: a.sailTrim ? JSON.stringify(a.sailTrim) : null,
    sessionDate: p.sessions?.date || '',
    source: 'supabase',
  }
}

// ── local ⇄ cloud, for a photo this machine also holds ───────────────────────

/**
 * Fold the team's cloud row into the local record for the same photo.
 *
 * The local copy wins for the BYTES — the original is in IndexedDB and needs no
 * round trip — and the photo tab therefore used to drop the cloud row outright
 * whenever a local one existed. That threw away everything only the cloud knows,
 * and the loss fell on the one person who had imported the day: full geometry in
 * the timeline, an instrument card and nothing else in the photo tab.
 *
 * Two different rules, because the fields are two different kinds of thing:
 *
 *   SAIL GEOMETRY is CLOUD-AUTHORITATIVE. It is a few kB, both save paths write
 *   it to the shared row the moment it is measured (PhotosTab through
 *   upsertPhotoCloud, the timeline through savePhotoSailTrim), and it is meant
 *   to be the one copy everybody sees. So the cloud's wins outright, and the
 *   local one is the fallback for when the shared write did not land — which
 *   the photo tab already warns about at the time.
 *
 *   EVERYTHING ELSE is gap-filled: the cloud supplies what the local record has
 *   no value for, and a local value is kept. `photos` carries no `updated_at`,
 *   so there is no way to tell a teammate's newer edit from this machine's
 *   older one; filling gaps is the most that can be claimed honestly. A
 *   teammate CHANGING a field this machine already has will not propagate, and
 *   closing that needs a modified time on the row.
 */
export function mergeCloudIntoLocal<T extends Record<string, unknown>>(
  local: T,
  cloud: Record<string, unknown> | null | undefined,
): T {
  if (!cloud) return local
  const out: Record<string, unknown> = { ...local }

  // Absent means null, undefined, or an empty list — `??` alone would let an
  // empty `sails: []` from an import that read no tags block the cloud's.
  const absent = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0)

  for (const k of ['sails', 'raceTags', 'boat', 'location',
    'tws', 'twa', 'awa', 'bsp', 'heel', 'vmg'] as const) {
    if (absent(out[k]) && !absent(cloud[k])) out[k] = cloud[k]
  }

  // The whole analysis blob, so a key added later survives without this list
  // having to learn about it. Local wins per key; cloud-only keys come through.
  const la = (local.analysis ?? null) as Record<string, unknown> | null
  const ca = (cloud.analysis ?? null) as Record<string, unknown> | null
  if (ca) out.analysis = la ? { ...ca, ...la } : ca

  // …except sail geometry, which the cloud owns outright.
  if (cloud.sailtrim_data != null) {
    out.sailtrim_data = cloud.sailtrim_data
    if (ca && (ca as { sailTrim?: unknown }).sailTrim !== undefined) {
      out.analysis = { ...(out.analysis as Record<string, unknown> || {}), sailTrim: (ca as { sailTrim?: unknown }).sailTrim }
    }
  }
  return out as T
}
