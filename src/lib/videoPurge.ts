// src/lib/videoPurge.ts
// ─────────────────────────────────────────────────────────────────────────────
// What a deleted `videos` row leaves behind in Bunny.
//
// A clip is not one object. Over Phase A and B it grew to six places it can
// live: the legacy Stream video, a proxy Stream video and an original Stream
// video, plus three Storage objects (the upload, the proxy, the original). The
// delete path only ever removed `bunny_stream_id`, so every other one survived
// its row — paid storage for a file nothing points at any more.
//
// Worse than the cost: `backfill-from-bunny` builds `videos` rows FROM the
// objects still in Storage. A deleted clip whose object survives is a clip an
// admin backfill puts back. Deleting the row without the objects is not a
// delete, it is a delay.
//
// Pure — the route does the deleting. Keeping the list-building here is what
// makes it testable without a Bunny account.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeletedVideoRow {
  id?: string | null
  bunny_stream_id?: string | null
  bunny_proxy_stream_id?: string | null
  bunny_original_stream_id?: string | null
  bunny_storage_path?: string | null
  bunny_proxy_path?: string | null
  bunny_original_path?: string | null
}

/** Every column of `videos` that names something in Bunny. The DELETE must
 *  select all of them: what is not returned cannot be purged, and the row is
 *  gone by then, so there is no second chance to look. */
export const PURGE_COLUMNS = [
  'id',
  'bunny_stream_id',
  'bunny_proxy_stream_id',
  'bunny_original_stream_id',
  'bunny_storage_path',
  'bunny_proxy_path',
  'bunny_original_path',
].join(',')

export interface PurgePlan {
  /** Bunny Stream GUIDs to delete from the library. */
  streamIds: string[]
  /** Bunny Storage object keys, relative to the zone root. */
  storageKeys: string[]
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** A storage key is stored with or without a leading slash depending on which
 *  uploader wrote it. Bunny wants it without, and `a/b` and `/a/b` are the same
 *  object — so normalise before de-duplicating or the same file is deleted
 *  twice and the second attempt reports a 404 the caller then calls a failure. */
export function storageKey(path: unknown): string {
  return clean(path).replace(/^\/+/, '')
}

/**
 * The Bunny objects a set of deleted rows leaves behind.
 *
 * Order is the order the columns are listed in, de-duplicated: two rows sharing
 * a proxy (a re-upload that reused it) purge it once.
 */
export function planPurge(rows: readonly DeletedVideoRow[]): PurgePlan {
  const streamIds = new Set<string>()
  const storageKeys = new Set<string>()
  for (const r of rows || []) {
    for (const id of [r?.bunny_stream_id, r?.bunny_proxy_stream_id, r?.bunny_original_stream_id]) {
      const v = clean(id)
      if (v) streamIds.add(v)
    }
    for (const p of [r?.bunny_storage_path, r?.bunny_proxy_path, r?.bunny_original_path]) {
      const v = storageKey(p)
      if (v) storageKeys.add(v)
    }
  }
  return { streamIds: Array.from(streamIds), storageKeys: Array.from(storageKeys) }
}
