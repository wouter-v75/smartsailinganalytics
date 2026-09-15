// src/lib/tagging/detectLegs.ts
// ─────────────────────────────────────────────────────────────────────────────
// Legs and mark roundings from the log alone.
//
// SSA gets roundings from the event file's <markrounding> today, which means a
// day without an event file — a training session, a regatta where the onboard
// assistant was not running — has none at all. That is the gap this fills, and
// it matters more than it sounds: starts and mark roundings are the moments a
// debrief is ALWAYS built from, so a day missing them is a day the tagger cannot
// do its main job on.
//
// The insight that makes it cheap: a leg boundary and a mark rounding are the
// same event. A rounding is where the boat stops going upwind and starts going
// downwind, or the reverse. So one pass finds both.
//
//   1. classify every sample's point of sail from |TWA| (the bands
//      computeAutoTags already uses: <60 up, <110 reach, else down);
//   2. run-length encode, then MERGE AWAY runs too short to be a leg. Without
//      this a boat oscillating around 60° TWA produces a dozen phantom legs a
//      minute — the classic failure of threshold classification on real data;
//   3. a rounding is where the last committed UPWIND-or-DOWNWIND mode flips.
//      Reaching is treated as transitional, so upwind → reach → downwind is one
//      bear-away at the top mark, not two events.
//
// Tack comes from the sign of mean TWA, matching phaseStats.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { modeOfTwa, type PhaseMode, type PhaseTack, type PhaseLogRow } from './autoPhases'

export interface Leg {
  t0: number
  t1: number
  mode: PhaseMode
  tack: PhaseTack | null
  nSamples: number
  /** Mean TWA over the leg, degrees (signed). */
  twa: number | null
  /** Mean boat speed over the leg, kn. */
  bsp: number | null
}

export interface Rounding {
  utc: number
  /** true = top mark (bore away, upwind → downwind). */
  isTop: boolean
  /** 0–1. How clean the transition was: a crisp bear-away with long legs either
   *  side scores high; a scrappy one between two short legs scores low. */
  confidence: number
  /** Seconds spent transitioning between the two committed modes. */
  transitionSec: number
  beforeMode: PhaseMode
  afterMode: PhaseMode
}

export interface LegOptions {
  /** A stretch shorter than this is not a leg; it is merged into its neighbour. */
  minLegSec?: number
  /** Samples below this boat speed are ignored — a drifting boat has no leg. */
  minBsp?: number
}

export const DEFAULT_LEG_OPTIONS: Required<LegOptions> = {
  minLegSec: 90,
  minBsp: 2,
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const round2 = (v: number) => Math.round(v * 100) / 100
const clamp01 = (v: number) => Math.max(0.05, Math.min(1, v))

interface Run { mode: PhaseMode; from: number; to: number; rows: PhaseLogRow[] }

/** Run-length encode the samples by point of sail. */
function encode(rows: PhaseLogRow[], minBsp: number): Run[] {
  const runs: Run[] = []
  for (const r of rows) {
    const twa = isNum(r.twa) ? r.twa : null
    if (twa == null) continue
    const speed = isNum(r.bsp) ? r.bsp : isNum(r.sog) ? r.sog : null
    if (speed == null || speed < minBsp) continue
    const mode = modeOfTwa(twa)
    const last = runs[runs.length - 1]
    if (last && last.mode === mode) {
      last.to = r.utc
      last.rows.push(r)
    } else {
      runs.push({ mode, from: r.utc, to: r.utc, rows: [r] })
    }
  }
  return runs
}

/**
 * Absorb runs shorter than `minLegMs` into their neighbours, repeatedly, until
 * every remaining run is long enough to be a leg.
 *
 * A short run is given to whichever neighbour is longer — which is what you want
 * at a mark, where a brief reach between a beat and a run belongs to neither in
 * particular and should not become a leg of its own.
 */
function mergeShortRuns(runs: Run[], minLegMs: number): Run[] {
  let work = runs
  for (let pass = 0; pass < 20; pass++) {
    if (work.length <= 1) break
    // The shortest offender first, so merging cannot cascade in a silly order.
    let idx = -1
    let shortest = Infinity
    for (let i = 0; i < work.length; i++) {
      const dur = work[i].to - work[i].from
      if (dur < minLegMs && dur < shortest) { shortest = dur; idx = i }
    }
    if (idx < 0) break

    const prev = work[idx - 1]
    const next = work[idx + 1]
    const prevLen = prev ? prev.to - prev.from : -1
    const nextLen = next ? next.to - next.from : -1
    const target = prevLen >= nextLen ? prev : next
    if (!target) break

    target.rows = prev === target
      ? [...target.rows, ...work[idx].rows]
      : [...work[idx].rows, ...target.rows]
    target.from = Math.min(target.from, work[idx].from)
    target.to = Math.max(target.to, work[idx].to)
    work = work.filter((_, i) => i !== idx)

    // Merging may have made two same-mode runs adjacent; coalesce them.
    const coalesced: Run[] = []
    for (const r of work) {
      const last = coalesced[coalesced.length - 1]
      if (last && last.mode === r.mode) {
        last.to = Math.max(last.to, r.to)
        last.rows = [...last.rows, ...r.rows]
      } else coalesced.push(r)
    }
    work = coalesced
  }
  return work
}

/** The day's legs, from the log alone. */
export function detectLegs(
  rows: PhaseLogRow[] | null | undefined,
  options: LegOptions = {}
): Leg[] {
  const o = { ...DEFAULT_LEG_OPTIONS, ...options }
  const sorted = (rows || []).filter((r) => isNum(r?.utc)).slice().sort((a, b) => a.utc - b.utc)
  if (sorted.length < 2) return []

  const runs = mergeShortRuns(encode(sorted, o.minBsp), o.minLegSec * 1000)

  return runs
    .filter((r) => r.to > r.from)
    .map((r) => {
      // Statistics come only from samples that actually sailed this leg's point
      // of sail. A merged-in bear-away SPANS the leg — the leg runs from one
      // mark to the next — but averaging its 95-degree TWA into a beat would
      // report the beat as 48 degrees, which is a number nobody should read.
      const own = r.rows.filter((x) => isNum(x.twa) && modeOfTwa(x.twa) === r.mode)
      const statRows = own.length ? own : r.rows
      const twas = statRows.map((x) => (isNum(x.twa) ? x.twa : null)).filter((v): v is number => v != null)
      const bsps = statRows
        .map((x) => (isNum(x.bsp) ? x.bsp : isNum(x.sog) ? x.sog : null))
        .filter((v): v is number => v != null)
      const mTwa = mean(twas)
      return {
        t0: r.from,
        t1: r.to,
        mode: r.mode,
        tack: mTwa == null ? null : mTwa >= 0 ? 'stbd' : 'port',
        nSamples: statRows.length,
        twa: mTwa,
        bsp: mean(bsps),
      } as Leg
    })
}

/**
 * Mark roundings, as the points where the boat crosses between going upwind and
 * going downwind. Reaching is transitional: upwind → reach → downwind is ONE
 * bear-away at the top mark.
 *
 * The rounding is timed at the START of the leg that committed the new mode —
 * that is when the boat had finished turning, which is what "rounded the mark"
 * means and what a clip should be anchored to.
 */
export function roundingsFromLegs(legs: Leg[]): Rounding[] {
  const out: Rounding[] = []
  let lastCommitted: Leg | null = null

  for (const leg of legs) {
    if (leg.mode === 'reach') continue        // transitional — never commits
    if (lastCommitted && lastCommitted.mode !== leg.mode) {
      const isTop = lastCommitted.mode === 'up'   // up → down is a bear-away
      const transitionMs = Math.max(0, leg.t0 - lastCommitted.t1)
      const beforeLen = lastCommitted.t1 - lastCommitted.t0
      const afterLen = leg.t1 - leg.t0

      // A rounding is believable in proportion to the legs either side of it and
      // how briskly the boat got from one to the other. Ten minutes of "reach"
      // between a beat and a run is not a rounding, it is a delivery.
      let c = 0.75
      if (transitionMs > 180_000) c *= 0.4
      else if (transitionMs > 90_000) c *= 0.7
      else if (transitionMs < 45_000) c *= 1.15
      const shorter = Math.min(beforeLen, afterLen)
      if (shorter < 120_000) c *= 0.6
      else if (shorter > 300_000) c *= 1.1

      out.push({
        utc: leg.t0,
        isTop,
        confidence: round2(clamp01(c)),
        transitionSec: Math.round(transitionMs / 1000),
        beforeMode: lastCommitted.mode,
        afterMode: leg.mode,
      })
    }
    lastCommitted = leg
  }
  return out
}

/** Legs and the roundings between them, in one call. */
export function detectLegsAndRoundings(
  rows: PhaseLogRow[] | null | undefined,
  options: LegOptions = {}
): { legs: Leg[]; roundings: Rounding[] } {
  const legs = detectLegs(rows, options)
  return { legs, roundings: roundingsFromLegs(legs) }
}
