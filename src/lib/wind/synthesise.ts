// src/lib/wind/synthesise.ts
// ─────────────────────────────────────────────────────────────────────────────
// Manufacture the channels a dinghy track does not have, so that everything
// downstream runs unchanged.
//
// This is the whole architectural bet of the dinghy work (plan §0): rather than
// fork phaseStats / manoeuvres / startAnalysis for boats without instruments,
// synthesise `twd`, `tws` and `twa` into the existing LogRow shape and let the
// existing pipeline consume them. The boat's profile decides WHICH method is
// used; this module applies it and records provenance for every channel it
// writes, so a chart can tell a derived number from a measured one.
//
// TWA SIGN — the one thing that must not be got wrong here, because every
// downstream tack test depends on it:
//
//     twa = angleDiff(twd, bearing)
//
// Wind from 000°, boat on 045°: the wind is 45° to PORT of the bow, so TWA is
// −45 and the boat is on PORT tack. angleDiff(0, 45) = −45. ✓ That matches
// phaseStats' rule that a POSITIVE mean TWA means STARBOARD tack. Writing it
// the other way round — angleDiff(bearing, twd) — silently swaps every tack
// label in the app, which is exactly the mistake made in the scratchpad
// prototype that produced this module.
//
// `bsp` is written from `sog` and marked DERIVED. A dinghy has no paddlewheel,
// so speed over ground is not speed through water; they differ by the current.
// Downstream code wants a `bsp`, so it gets one — but the provenance says what
// it really is, which is the entire reason provenance exists.
// ─────────────────────────────────────────────────────────────────────────────

import { angleDiff } from './circular'
import { findSegments, type Segment, type TrackRow } from './segment'
import { rollingTwd, type RollingPoint, type GateOpts } from './estimate'
import {
  emptyProvenance, mark, markAll, type ProvenanceMap,
} from '../provenance'
import { effectiveMethods, type BoatLogProfile, type BoatMethods } from '../logProfile'

/** A model or measured wind series to fall back on. */
export interface WindSeries {
  times: number[]
  twd?: (number | null)[]
  tws?: (number | null)[]
}

export interface SynthesiseInput {
  rows: TrackRow[]
  /** Which parser produced the rows; picks the default methods. */
  format?: string | null
  profile?: BoatLogProfile | null
  /** Open-Meteo or a coach-boat sensor. Supplies TWS and the TWD prior. */
  model?: WindSeries | null
  /**
   * Segments from EVERY boat in the session. Pooling is what makes the estimate
   * work (§18) — pass the squad's, not just this boat's.
   */
  pooledSegments?: Segment[] | null
  gate?: GateOpts
}

export interface SynthesiseResult {
  rows: Array<TrackRow & { twd?: number | null; tws?: number | null; twa?: number | null; bsp?: number | null }>
  provenance: ProvenanceMap
  segments: Segment[]
  estimates: RollingPoint[]
  methods: BoatMethods
  /** Fraction of the session for which a TWD could be derived, 0..1. */
  twdCoverage: number
}

const lerpAt = (series: WindSeries | null | undefined, key: 'twd' | 'tws', utc: number): number | null => {
  const vals = series?.[key]
  if (!series?.times?.length || !vals) return null
  const { times } = series
  if (utc < times[0] || utc > times[times.length - 1]) return null
  let hi = times.findIndex((t) => t >= utc)
  if (hi < 0) return null
  if (hi === 0) hi = 1
  const lo = hi - 1
  const a = vals[lo], b = vals[hi]
  if (a == null && b == null) return null
  if (a == null || b == null) return (a ?? b) as number
  const span = times[hi] - times[lo]
  const f = span > 0 ? (utc - times[lo]) / span : 0
  if (key === 'twd') {
    // Interpolate the vector, never the bearing — 350°→10° must give 0°, not 180°.
    const D = Math.PI / 180
    const u = Math.sin(a * D) + (Math.sin(b * D) - Math.sin(a * D)) * f
    const v = Math.cos(a * D) + (Math.cos(b * D) - Math.cos(a * D)) * f
    return (Math.atan2(u, v) / D + 360) % 360
  }
  return a + (b - a) * f
}

/** Nearest derived TWD at a time, from the rolling estimates. */
function derivedTwdAt(points: RollingPoint[], utc: number): number | null {
  let best: RollingPoint | null = null
  for (const p of points) {
    if (!p.estimate) continue
    if (!best || Math.abs(p.t - utc) < Math.abs(best.t - utc)) best = p
  }
  // Do not stretch an estimate more than half a window either side of itself.
  if (!best || Math.abs(best.t - utc) > 20 * 60_000) return null
  return best.estimate!.twd
}

export function synthesise(input: SynthesiseInput): SynthesiseResult {
  const { rows, model } = input
  const methods = effectiveMethods(input.profile, input.format)
  const provenance = emptyProvenance()

  const segments = findSegments(rows)
  const pooled = input.pooledSegments?.length ? input.pooledSegments : segments

  if (!rows.length) {
    return { rows: [], provenance, segments, estimates: [], methods, twdCoverage: 0 }
  }
  const t0 = rows[0].utc
  const t1 = rows[rows.length - 1].utc + 1

  // What the parser measured.
  const measured = (['lat', 'lon', 'sog', 'cog', 'hdg', 'heel'] as const)
    .filter((c) => rows.some((r) => (r as any)[c] != null))
  markAll(provenance, measured as unknown as string[], 'measured', t0, t1, input.format || 'log')

  // ── TWD ────────────────────────────────────────────────────────────────────
  let estimates: RollingPoint[] = []
  if (methods.windDirection === 'derived-cog' || methods.windDirection === 'derived-fleet') {
    // The model is the prior that resolves the 180° mirror and confines the
    // search. Without it a beat-only session cannot be resolved at all.
    const priorTwd = lerpAt(model, 'twd', (t0 + t1) / 2)
    estimates = rollingTwd(pooled, { ...input.gate, priorTwd })
  }

  // ── write the rows ─────────────────────────────────────────────────────────
  let derivedRows = 0
  const out = rows.map((r) => {
    const row: any = { ...r }

    if (r.sog != null) row.bsp = r.sog          // derived — see the header

    let twd: number | null = null
    let twdKind: 'derived' | 'modelled' | null = null

    if (methods.windDirection === 'measured') {
      twd = (r as any).twd ?? null
      twdKind = twd != null ? null : null       // already measured; provenance set below
    } else {
      const d = estimates.length ? derivedTwdAt(estimates, r.utc) : null
      if (d != null) { twd = d; twdKind = 'derived'; derivedRows++ }
      else if (methods.windDirection !== 'manual') {
        const m = lerpAt(model, 'twd', r.utc)
        if (m != null) { twd = m; twdKind = 'modelled' }
      }
    }

    const tws = methods.windSpeed === 'measured'
      ? ((r as any).tws ?? null)
      : lerpAt(model, 'tws', r.utc)

    row.twd = twd
    row.tws = tws
    // TWA sign: see the header. Positive = starboard tack, matching phaseStats.
    row.twa = twd != null && r.cog != null ? angleDiff(twd, r.cog) : null
    row._twdKind = twdKind
    return row
  })

  // ── provenance for the synthesised channels ────────────────────────────────
  if (rows.some((r) => r.sog != null)) {
    mark(provenance, 'bsp', {
      kind: 'derived', from: t0, to: t1, method: 'sog',
      note: 'speed over ground — a dinghy has no paddlewheel, so this is not speed through water',
    })
  }

  if (methods.windDirection === 'measured') {
    markAll(provenance, ['twd', 'twa'], 'measured', t0, t1, input.format || 'log')
  } else {
    // One range per contiguous run of the same kind, so a chart can render the
    // unmeasured stretches as gaps rather than as a flat line.
    let runStart = t0
    let runKind: 'derived' | 'modelled' | 'unavailable' =
      (out[0]._twdKind as any) || 'unavailable'
    for (let i = 1; i <= out.length; i++) {
      const kind = (i < out.length ? (out[i]._twdKind as any) : null) || 'unavailable'
      const end = i < out.length ? out[i].utc : t1
      if (kind !== runKind || i === out.length) {
        for (const ch of ['twd', 'twa']) {
          mark(provenance, ch, {
            kind: runKind, from: runStart, to: end,
            method: runKind === 'derived' ? 'derived-cog'
              : runKind === 'modelled' ? 'model' : undefined,
            note: runKind === 'unavailable'
              ? 'no opposite tack in this window — wind direction not measurable'
              : runKind === 'derived' ? 'ground wind, not true wind' : undefined,
          })
        }
        runStart = end
        runKind = kind
      }
    }
  }

  mark(provenance, 'tws', {
    kind: methods.windSpeed === 'measured' ? 'measured' : 'modelled',
    from: t0, to: t1,
    method: methods.windSpeed === 'measured' ? (input.format || 'log') : 'model',
  })

  for (const r of out) delete r._twdKind

  return {
    rows: out,
    provenance,
    segments,
    estimates,
    methods,
    twdCoverage: out.length ? derivedRows / out.length : 0,
  }
}
