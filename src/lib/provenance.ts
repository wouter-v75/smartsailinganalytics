// src/lib/provenance.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where did this number come from?
//
// Once the app synthesises twd/tws/twa from a bare GPS track, a chart can no
// longer assume every channel is an instrument reading. A derived TWD and a
// measured one look identical in a LogRow and must NOT look identical in a
// debrief — a derived number that does not carry its uncertainty is worse than
// no number, because it gets argued about as though it were measured.
//
// Three rules this encodes, all from the research:
//
//   • RaceAnalyser's principle, worth stealing verbatim: "honest data — marks
//     unmeasured segments rather than inventing numbers". `unavailable` is a
//     first-class state, and a chart must render it as a gap, never as zero.
//   • Provenance is per channel per TIME RANGE, not per row. A wind estimate is
//     good over the beat and refuses to answer during a one-tack speed test,
//     and that varies through the day. Storing it per row would multiply the
//     log's size for data that changes a handful of times.
//   • It lives BESIDE the rows, never inside them. LogRow is
//     `{ utc } & Record<string, number|null>` and everything downstream indexes
//     it by channel name; adding string fields would break that contract. Same
//     lesson as GoldenCheetah's auto-detected intervals living beside the ride
//     file, already cited in the tagger prior-art doc.
//
// Ranges are half-open [from, to) in epoch ms, kept sorted per channel. A gap
// between ranges means nothing is claimed — treat it as unknown, not as good.
// ─────────────────────────────────────────────────────────────────────────────

export type ProvenanceKind = 'measured' | 'derived' | 'modelled' | 'unavailable'

export interface ProvenanceRange {
  kind: ProvenanceKind
  /** Epoch ms, inclusive. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  /** How it was produced: 'vakaros-csv', 'derived-cog', 'open-meteo', … */
  method?: string
  /** 0..1 where the producer can express one. Absent ≠ confident. */
  confidence?: number
  /** Why it is unavailable, or any caveat worth showing. */
  note?: string
}

/** channel name → ranges, sorted by `from`, non-overlapping. */
export type ProvenanceMap = Record<string, ProvenanceRange[]>

export const emptyProvenance = (): ProvenanceMap => ({})

/**
 * Record a range. Overlapping parts of existing ranges are REPLACED, so a later
 * pass can overwrite an earlier claim (a model baseline first, a derived
 * estimate over the part of the day where the geometry supported one).
 */
export function mark(
  map: ProvenanceMap,
  channel: string,
  range: ProvenanceRange
): ProvenanceMap {
  if (!(range.to > range.from)) return map
  const existing = map[channel] || []
  const out: ProvenanceRange[] = []
  for (const r of existing) {
    if (r.to <= range.from || r.from >= range.to) { out.push(r); continue }  // disjoint
    if (r.from < range.from) out.push({ ...r, to: range.from })              // left remnant
    if (r.to > range.to) out.push({ ...r, from: range.to })                  // right remnant
  }
  out.push(range)
  out.sort((a, b) => a.from - b.from)
  map[channel] = out
  return map
}

/** Convenience for the common case: one kind across a whole parsed log. */
export function markAll(
  map: ProvenanceMap,
  channels: string[],
  kind: ProvenanceKind,
  from: number,
  to: number,
  method?: string
): ProvenanceMap {
  for (const c of channels) mark(map, c, { kind, from, to, method })
  return map
}

/** What is claimed for `channel` at `utcMs`, or null when nothing is. */
export function provenanceAt(
  map: ProvenanceMap | null | undefined,
  channel: string,
  utcMs: number
): ProvenanceRange | null {
  const ranges = map?.[channel]
  if (!ranges?.length) return null
  // Ranges are sorted and non-overlapping — binary search.
  let lo = 0, hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (utcMs < r.from) hi = mid - 1
    else if (utcMs >= r.to) lo = mid + 1
    else return r
  }
  return null
}

/**
 * Should a consumer plot this sample at all?
 *
 * `unavailable` and an unclaimed gap both mean no. Everything else is plottable,
 * but `derived` and `modelled` should be rendered so a viewer can tell — that is
 * the whole point, and it is why this returns the kind rather than a boolean.
 */
export function isPlottable(p: ProvenanceRange | null): boolean {
  return p != null && p.kind !== 'unavailable'
}

/** True when the value may be quoted in a debrief without a caveat. */
export function isMeasured(p: ProvenanceRange | null): boolean {
  return p?.kind === 'measured'
}

/** Short human label for a chart legend or tooltip. */
export function describeProvenance(p: ProvenanceRange | null): string {
  if (!p) return 'unknown'
  const base =
    p.kind === 'measured' ? 'measured'
      : p.kind === 'derived' ? 'derived from the track'
        : p.kind === 'modelled' ? 'from the weather model'
          : 'not measurable'
  const how = p.method ? ` (${p.method})` : ''
  const conf = p.confidence != null ? ` · ${Math.round(p.confidence * 100)}%` : ''
  const note = p.note ? ` — ${p.note}` : ''
  return `${base}${how}${conf}${note}`
}

/**
 * Coverage summary for a channel over a window — what a session header shows:
 * "TWD: 62% derived, 38% not measurable".
 */
export function coverage(
  map: ProvenanceMap | null | undefined,
  channel: string,
  from: number,
  to: number
): Record<ProvenanceKind | 'unclaimed', number> {
  const out = { measured: 0, derived: 0, modelled: 0, unavailable: 0, unclaimed: 0 }
  const span = to - from
  if (!(span > 0)) return out
  let claimed = 0
  for (const r of map?.[channel] || []) {
    const a = Math.max(r.from, from), b = Math.min(r.to, to)
    if (b > a) { out[r.kind] += (b - a) / span; claimed += (b - a) / span }
  }
  out.unclaimed = Math.max(0, 1 - claimed)
  return out
}

/**
 * The one-line verdict for a whole channel, for a session card. Deliberately
 * pessimistic: a channel that is derived for part of the day and unmeasurable
 * for the rest is reported as derived-with-gaps, not as derived.
 */
export function summarise(
  map: ProvenanceMap | null | undefined,
  channel: string,
  from: number,
  to: number
): string {
  const c = coverage(map, channel, from, to)
  const missing = c.unavailable + c.unclaimed
  const pct = (v: number) => `${Math.round(v * 100)}%`
  if (c.measured >= 0.999) return 'measured'
  if (missing >= 0.999) return 'not available'
  const parts: string[] = []
  if (c.measured > 0.005) parts.push(`${pct(c.measured)} measured`)
  if (c.derived > 0.005) parts.push(`${pct(c.derived)} derived`)
  if (c.modelled > 0.005) parts.push(`${pct(c.modelled)} modelled`)
  if (missing > 0.005) parts.push(`${pct(missing)} unavailable`)
  return parts.join(', ')
}
