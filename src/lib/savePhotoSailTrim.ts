// src/lib/savePhotoSailTrim.ts
// ─────────────────────────────────────────────────────────────────────────────
// Write a sail-geometry measurement onto a photo's shared row, from anywhere
// that has the team, the boat and the row — the timeline, in practice, where
// PhotosTab's local state does not exist.
//
// The route dedupes on `bunny_storage_path` and UPDATEs when it matches, so this
// is an upsert of the row we were given. Every other column has to be sent back
// unchanged: the handler writes the whole row, so anything omitted is nulled.
// That is the trap here, and the reason this takes the ROW rather than an id.
// ─────────────────────────────────────────────────────────────────────────────

import type { SailTrimAnnotation } from './sailTrimOverlay'

/** The photo row as the photos route hands it back. */
export interface PhotoRow {
  id: string
  taken_utc?: string | null
  exif_data?: unknown
  thumbnail_url?: string | null
  bunny_storage_path?: string | null
  bytes?: number | null
  analysis_data?: Record<string, unknown> | null
  sessions?: { date: string } | null
}

export interface SailTrimPayload {
  annotation: SailTrimAnnotation
  overlay: boolean
  headline?: string
  result?: unknown
}

export async function savePhotoSailTrim({
  teamId, boatId, row, payload, sessionDate,
}: {
  teamId: string
  boatId: string
  row: PhotoRow
  payload: SailTrimPayload
  /** The day the photo belongs to; the route needs it to find the session. */
  sessionDate?: string | null
}): Promise<void> {
  const date = sessionDate || row.sessions?.date
  if (!date) throw new Error('This photo has no session date, so there is no day to attach it to.')
  if (!row.bunny_storage_path) {
    throw new Error('This photo is not in the cloud yet, so there is no shared row to write to.')
  }

  // `thumbnail_url` deserves a word: the GET route REWRITES it to a fast CDN URL
  // before handing the row over, so sending back what we were given would
  // persist a derived URL over the stored one. The CDN form is recomputed on
  // every read, so this is cosmetic rather than harmful — but it is the kind of
  // thing that turns into a puzzle later, so it is left alone here instead.
  const body = {
    session_date: date,
    taken_utc: row.taken_utc ?? null,
    exif_data: row.exif_data ?? null,
    thumbnail_url: row.thumbnail_url ?? null,
    bunny_storage_path: row.bunny_storage_path,
    bytes: row.bytes ?? null,
    analysis_data: { ...(row.analysis_data || {}), sailTrim: payload },
  }

  const res = await fetch(`/api/teams/${teamId}/boats/${boatId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const j = await res.json().catch(() => null)
    throw new Error(j?.error || `the server refused it (HTTP ${res.status})`)
  }
}
