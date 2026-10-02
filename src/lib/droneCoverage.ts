// src/lib/droneCoverage.ts
// ─────────────────────────────────────────────────────────────────────────────
// When the drone was ACTUALLY FILMING, and which of it was cut into clips.
//
// The card is on a desk, the track is in a browser, and nothing in the app has
// ever known the difference between "the drone was not up" and "nobody cut that
// bit yet". On 30 September both the top mark and the gate were tagged and
// neither produced a clip — the drone was on the deck for one and had landed
// before the other — and the only way to find that out was to read the cutter's
// clip table line by line.
//
// So the card's own coverage is measured once, when the drive is plugged in,
// and stored with the day. Two bands on the track:
//
//   light green   the drone was recording here. Footage exists.
//   dark green    and this part is already a clip.
//
// Dark is always inside light: a clip is cut FROM footage. The renderer draws
// light first and dark over it, so the two never fight.
//
// CLOCKS. The card is in venue-local wall time — the drone's filenames and its
// SRT sidecars both — and everything stored in SSA is true UTC. The conversion
// happens ONCE, in the script, before anything is written, and this module
// deals only in true UTC. That is CLAUDE.md's first trap and it is worth the
// repetition: read the card as UTC and every band sits two hours off the track
// it is meant to annotate.
//
// Pure: no I/O, no React.
// ─────────────────────────────────────────────────────────────────────────────

export interface Span {
  /** Epoch ms, true UTC. */
  from: number
  to: number
}

export interface DroneCoverage {
  /** Where footage exists at all. */
  footage: Span[]
  /** The parts already cut into clips. Always within `footage`. */
  clips: Span[]
  /** When the card was read, so a stale answer is visible as one. */
  scannedAt?: string
  /** Which offset turned the card's wall clock into UTC, so a wrong one can be
   *  recognised rather than merely suspected. */
  tzOffsetMin?: number
  /** How many files the scan saw — a coverage of nothing is different from a
   *  card nobody has scanned. */
  fileCount?: number
}

export const EMPTY_COVERAGE: DroneCoverage = { footage: [], clips: [] }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Merge overlapping and nearly-touching spans.
 *
 * `joinMs` closes the seam between consecutive recordings. A drone splitting a
 * file writes the next one a second or two later, and drawing that as a gap
 * would pepper the track with holes that were never holes — 30 September had
 * three files inside six seconds. It must NOT be generous enough to swallow a
 * real gap: the 14-minute one that day is the whole point of the picture.
 */
export function mergeSpans(spans: readonly Span[], joinMs = 5_000): Span[] {
  const clean = (spans || [])
    .filter((s) => s && finite(s.from) && finite(s.to) && s.to > s.from)
    .sort((a, b) => a.from - b.from)
  const out: Span[] = []
  for (const s of clean) {
    const last = out[out.length - 1]
    if (last && s.from - last.to <= joinMs) last.to = Math.max(last.to, s.to)
    else out.push({ from: s.from, to: s.to })
  }
  return out
}

/** Total milliseconds covered. */
export function spanTotal(spans: readonly Span[]): number {
  return mergeSpans(spans, 0).reduce((n, s) => n + (s.to - s.from), 0)
}

/** Is this instant inside any span? What the track asks per tag. */
export function covers(spans: readonly Span[], utc: number): boolean {
  return spans.some((s) => utc >= s.from && utc <= s.to)
}

/**
 * The gaps BETWEEN the spans, bounded by the day.
 *
 * Which is what answers "why did my top mark not produce a clip" — the moment
 * is in one of these.
 */
export function gapsBetween(spans: readonly Span[], from?: number, to?: number): Span[] {
  const m = mergeSpans(spans)
  if (!m.length) return finite(from) && finite(to) && to > from ? [{ from, to }] : []
  const out: Span[] = []
  if (finite(from) && m[0].from > from) out.push({ from, to: m[0].from })
  for (let i = 1; i < m.length; i++) out.push({ from: m[i - 1].to, to: m[i].from })
  if (finite(to) && to > m[m.length - 1].to) out.push({ from: m[m.length - 1].to, to })
  return out
}

/** Anything at all → a coverage. Never throws: this parses a JSONB column that
 *  an older version, or a hand-edit, may have left in any shape. */
export function normaliseCoverage(raw: unknown): DroneCoverage {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const spans = (x: unknown): Span[] => mergeSpans(
    (Array.isArray(x) ? x : [])
      .map((s) => {
        const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
        return { from: Number(o.from), to: Number(o.to) }
      })
      .filter((s) => finite(s.from) && finite(s.to) && s.to > s.from),
    0
  )
  const out: DroneCoverage = { footage: spans(v.footage), clips: spans(v.clips) }
  if (typeof v.scannedAt === 'string') out.scannedAt = v.scannedAt
  if (finite(Number(v.tzOffsetMin))) out.tzOffsetMin = Number(v.tzOffsetMin)
  if (finite(Number(v.fileCount))) out.fileCount = Number(v.fileCount)
  return out
}

export function isEmptyCoverage(c: DroneCoverage): boolean {
  return !c.footage.length && !c.clips.length
}

/**
 * Clip spans clamped to the footage.
 *
 * A clip's window is padded — 30 s before a gybe, 90 s after a top mark — and
 * the padding can reach past where the drone was recording. Drawing the dark
 * band outside the light one would say the impossible: a clip of footage that
 * does not exist.
 */
export function clampToFootage(clips: readonly Span[], footage: readonly Span[]): Span[] {
  const f = mergeSpans(footage)
  const out: Span[] = []
  for (const c of clips) {
    for (const s of f) {
      const from = Math.max(c.from, s.from)
      const to = Math.min(c.to, s.to)
      if (to > from) out.push({ from, to })
    }
  }
  return mergeSpans(out, 0)
}

/**
 * The part of a scan that falls on ONE calendar day.
 *
 * A card someone has filed by day holds only that day. A card straight out of
 * the drone — `/Volumes/<card>/DCIM/DJI001` — holds every day it has ever
 * recorded, and storing that whole scan against one session paints bands over a
 * track that was sailed a week earlier. The cutter is safe against this because
 * a clip only becomes a segment if it overlaps a window from the day being cut;
 * the coverage scan has no windows at all, so the day has to be applied here.
 *
 * The bounds are read in the SAME clock as the spans, which is the only way to
 * use this without thinking about it: pass the card's wall-clock spans and you
 * get wall-clock spans back, pass UTC and you get UTC. A recording that crosses
 * midnight is cut at it rather than dropped — it is footage of both days.
 */
export function spansOnDay(spans: readonly Span[], date: string): Span[] {
  const from = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(from)) return []
  const to = from + 86_400_000
  const out: Span[] = []
  for (const s of spans || []) {
    if (!s || !finite(s.from) || !finite(s.to) || s.to <= s.from) continue
    if (s.to <= from || s.from >= to) continue
    out.push({ from: Math.max(s.from, from), to: Math.min(s.to, to) })
  }
  return out
}
