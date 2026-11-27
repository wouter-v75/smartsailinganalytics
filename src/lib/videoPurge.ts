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

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A SURVIVING ROW STILL NEEDS.
//
// `planPurge` answers "what did these rows name?", which is not the same as
// "what is now unreferenced". It de-duplicates WITHIN the deleted set — two
// deleted rows sharing a proxy purge it once — and has no idea what the rows
// that are still there point at.
//
// That gap is reachable, and the duplicate-row audit of 27 Nov 2026 walks
// straight into it. The three real 29 Sept pairs are two rows for one clip, and
// both carry the SAME `bunny_original_stream_id` — one Stream video, two rows.
// `stream-dedupe.ts` confirms it from the other side: 0 duplicate clip names in
// the library. Deleting the redundant row through the app therefore purges the
// Stream video the row you KEPT depends on, and the clip you were tidying up
// becomes unplayable. No error anywhere: the delete succeeds, the purge
// succeeds, and the survivor's guid now resolves to nothing.
//
// A re-upload that reuses a proxy is the same shape, which is why the fix is
// not specific to duplicates.
//
// The caller deletes the rows FIRST and then asks what is left — so anything
// that matches is genuinely a surviving row, not the row being removed.
// ─────────────────────────────────────────────────────────────────────────────

/** What rows OTHER than the deleted ones still point at. */
export interface StillReferenced {
  streamIds: Iterable<string>
  storageKeys: Iterable<string>
}

export interface PurgeSplit {
  /** Safe to delete from Bunny: nothing else points at these. */
  purge: PurgePlan
  /** Held back because a surviving row needs them. */
  withheld: PurgePlan
}

/**
 * Split a purge plan into what may go and what a surviving row still needs.
 *
 * Storage keys are compared normalised, because the same object is stored with
 * and without a leading slash depending on which uploader wrote the row — and a
 * comparison that misses makes a needed object look unreferenced, which is the
 * one direction that loses data.
 */
export function splitPurge(plan: PurgePlan, kept: StillReferenced): PurgeSplit {
  // Array.from, not for..of: this tsconfig's target cannot iterate a bare
  // Iterable (TS2802), and the signature stays Iterable so a Set passes.
  const keepStream = new Set<string>()
  for (const s of Array.from(kept.streamIds)) { const v = clean(s); if (v) keepStream.add(v) }
  const keepKeys = new Set<string>()
  for (const k of Array.from(kept.storageKeys)) { const v = storageKey(k); if (v) keepKeys.add(v) }

  const purge: PurgePlan = { streamIds: [], storageKeys: [] }
  const withheld: PurgePlan = { streamIds: [], storageKeys: [] }

  for (const id of plan.streamIds) (keepStream.has(id) ? withheld : purge).streamIds.push(id)
  for (const k of plan.storageKeys) (keepKeys.has(storageKey(k)) ? withheld : purge).storageKeys.push(k)

  return { purge, withheld }
}
