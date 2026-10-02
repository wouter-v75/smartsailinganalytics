// src/lib/clipRowRepair.ts
// ─────────────────────────────────────────────────────────────────────────────
// What a cloud video row SHOULD say, read from the clip's own filename.
//
// A clip's cloud row is written once, when it is uploaded, from the local record
// as it stood at that instant — and the local record is still settling: the
// timestamp probe runs asynchronously, and until it finishes the start time is
// the provisional one from the container's `mvhd`, which for a clip ffmpeg made
// is the ENCODE time. On 2 October six clips reached the cloud mid-probe and sat
// in the timeline at 11:00, the hour they were encoded, while the Videos tab —
// which reads the local record — showed them correctly. The row is never
// rewritten, so the two disagree for ever.
//
// The filename is the one thing that is certainly right. The cutter names every
// segment `<YYYYMMDDHHMMSS>_<tags>_<daytag>_<source>`, where the stamp is the
// moment on the water in VENUE-LOCAL time — the same convention DJI uses, and
// the same one the app's own importer reads.
//
// Pure: the caller fetches the rows and writes them back.
// ─────────────────────────────────────────────────────────────────────────────

/** The 14-digit stamp a clip filename starts with, as venue-LOCAL wall time. */
export function stampInName(name: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(name || ''))
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (h > 23 || mi > 59 || s > 59) return null
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Does this clip's name say it came off a drone?
 *
 * The same test the timeline uses (`lib/mediaDecks.isDroneClip`), kept in step
 * deliberately: the point of the repair is to make the row say what the timeline
 * is about to read. NOT `\b` — underscore is a word character, so `\bDJI\b`
 * matches neither `DJI_20260930…` nor `…_day2_DJI-001`, which are the only two
 * shapes drone clips arrive in.
 */
export const nameSaysDrone = (name: string): boolean =>
  /(?:^|[^a-z0-9])(dji|drone|mavic|osmo|avata|inspire)(?:[^a-z0-9]|$)/i.test(String(name || ''))

export interface ClipRow {
  id: string
  title: string | null
  start_utc: string | null
  tags: string[] | null
}

export interface RowFix {
  id: string
  title: string
  /** Null when the row is already right, or the name carries no stamp. */
  startUtc: string | null
  /** What the row says now, for the report. */
  wasStartUtc: string | null
  /** How far out it was, in ms. Null when there was nothing to compare. */
  driftMs: number | null
  /** Tags to store, when a `drone` tag is missing. Null when nothing to add. */
  tags: string[] | null
}

/**
 * Compare each row against its own filename.
 *
 * `tzOffsetMin` turns the name's local wall clock into the true UTC the column
 * holds — the venue offset, never guessed. A row whose name carries no stamp is
 * reported with `startUtc: null` and left alone: there is nothing better to
 * replace it with, and a guess would be worse than a wrong time somebody can see.
 *
 * `toleranceMs` keeps a row that is merely a second off — a clip whose start was
 * nudged by hand in the Videos tab should not be dragged back by this.
 */
export function planRowFixes(
  rows: readonly ClipRow[],
  tzOffsetMin: number,
  toleranceMs = 2_000
): RowFix[] {
  const out: RowFix[] = []
  for (const r of rows || []) {
    const title = String(r.title || '')
    const local = stampInName(title)
    const want = local == null ? null : local - tzOffsetMin * 60_000
    const has = r.start_utc ? Date.parse(r.start_utc) : null
    const drift = want != null && has != null && Number.isFinite(has) ? want - has : null

    const timeWrong = want != null && (has == null || !Number.isFinite(has) || Math.abs(drift ?? 0) > toleranceMs)
    const tags = r.tags || []
    const tagMissing = nameSaysDrone(title) && !tags.some((t) => String(t).toLowerCase() === 'drone')

    if (!timeWrong && !tagMissing) continue
    out.push({
      id: r.id,
      title,
      startUtc: timeWrong && want != null ? new Date(want).toISOString() : null,
      wasStartUtc: r.start_utc,
      driftMs: drift,
      tags: tagMissing ? [...tags, 'drone'] : null,
    })
  }
  return out
}
