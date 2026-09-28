// src/lib/clipOutbox.ts
// ─────────────────────────────────────────────────────────────────────────────
// The folder the encoder writes to and the watcher uploads from.
//
// ONE folder, not one per day. The Upload tab's watcher is pointed at a folder
// by hand, and a folder that changes name every day is a folder somebody has to
// re-point every day — which is exactly the step that did not happen on the
// evening of 28 September. A fixed outbox is pointed at once and then forgotten.
//
// The cost of a fixed folder is that it fills up, and a clip left lying in it is
// a clip the watcher will happily upload a second time. So the encoder clears
// it first, and the only clips it may clear are the ones the cloud already has.
//
// MATCHING. On the way in, the importer turns a filename into a title by
// dropping the extension and letting the punctuation go: DJI_20260927121745_0001_D.MP4
// is stored as "DJI 20260927121745 0001 D". So both sides are reduced to the
// same shape and compared. Not by timestamp: a clip's start_utc has been through
// the app's video-timezone setting, and a wrong guess there would delete
// footage. A name either matches or it does not.
//
// Pure — no I/O, no React. The deleting is the caller's, and deliberately so.
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO_RE = /\.(mp4|mov|mts|avi|mkv|m4v)$/i

/** Filename or stored title → the one shape both are compared in. */
export function titleKey(name: string): string {
  return String(name || '')
    .replace(VIDEO_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface CloudClip {
  title?: string | null
  /** A row with no object behind it is not an upload. Deleting against one
   *  would throw away the only copy. */
  stored?: boolean
}

export interface OutboxPlan {
  /** Safe to delete: the cloud has them. */
  uploaded: string[]
  /** Keep: not up yet, or up but with nothing behind the row. */
  pending: string[]
}

/**
 * Which files in the outbox the cloud already holds.
 *
 * Anything that is not a video — a manifest, a .DS_Store, an encode still in
 * flight under its dot-prefixed .part name — is ignored entirely rather than
 * reported as pending, because it is not ours to reason about.
 */
export function planOutbox(files: readonly string[], cloud: readonly CloudClip[]): OutboxPlan {
  const have = new Set(
    cloud.filter((c) => c.stored !== false).map((c) => titleKey(c.title || '')).filter(Boolean)
  )
  const uploaded: string[] = []
  const pending: string[] = []
  for (const f of files) {
    if (!f || f.startsWith('.') || !VIDEO_RE.test(f)) continue
    ;(have.has(titleKey(f)) ? uploaded : pending).push(f)
  }
  return { uploaded, pending }
}
