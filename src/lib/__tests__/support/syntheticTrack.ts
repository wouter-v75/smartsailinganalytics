// Synthetic sailing tracks with KNOWN ground truth, for the wind tests.
//
// The real Atlas files live outside the repo and are 2 and 10 MB, so they cannot
// be fixtures. More importantly, a real track has no ground truth to check
// against — these do: you say what the wind is, what the tack angle is, and what
// compass error and leeway the device has, and the estimator has to recover it.

import type { TrackRow } from '../../wind/segment'

const D = Math.PI / 180
const norm = (a: number) => ((a % 360) + 360) % 360

export interface LegSpec {
  /** True wind angle, signed: positive and negative are opposite tacks. */
  twa: number
  /** Seconds on this leg. */
  seconds: number
  /** Speed over ground, knots. */
  sog?: number
}

export interface TrackSpec {
  /** Degrees the wind comes from. */
  twd: number
  legs: LegSpec[]
  /** Epoch ms of the first sample. */
  startUtc?: number
  /** Samples per second. */
  rateHz?: number
  /** Seconds of turning inserted between legs (excluded by the segmenter). */
  turnSeconds?: number
  /**
   * Compass error, signed the same way the solver reports it: the device reads
   * this much HIGH, so `hdg` is the true heading PLUS this. A device with
   * compassOffsetDeg = -5 reads 5° low, and solveCompassOffset returns -5.
   */
  compassOffsetDeg?: number
  /** Leeway: the boat crabs this far to leeward, so COG differs from HDG. */
  leewayDeg?: number
  /** Heel magnitude; sign follows the tack. */
  heelDeg?: number
}

/**
 * Build a track. `cog` is the true course; `hdg` is what the device's compass
 * would report given the leeway and its own offset.
 */
export function buildTrack(spec: TrackSpec): TrackRow[] {
  const {
    twd, legs, startUtc = Date.UTC(2026, 1, 8, 11, 0), rateHz = 1,
    turnSeconds = 20, compassOffsetDeg = 0, leewayDeg = 0, heelDeg = 20,
  } = spec
  const rows: TrackRow[] = []
  let t = startUtc
  const step = 1000 / rateHz

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    const cog = norm(twd + leg.twa)
    // Leeway pushes the boat to leeward, so the heading points further upwind
    // than the course made good. On +twa the leeward side is −, and vice versa.
    const hdgTrue = norm(cog - Math.sign(leg.twa) * leewayDeg)
    const hdg = norm(hdgTrue + compassOffsetDeg)
    const heel = Math.sign(leg.twa) * heelDeg

    for (let s = 0; s < leg.seconds * rateHz; s++) {
      rows.push({ utc: t, lat: 39.5, lon: 2.57, sog: leg.sog ?? 6, cog, hdg, heel })
      t += step
    }
    // A turn between legs: sweep the course so the segmenter breaks here.
    if (i < legs.length - 1 && turnSeconds > 0) {
      const next = norm(twd + legs[i + 1].twa)
      const delta = ((next - cog + 540) % 360) - 180
      for (let s = 0; s < turnSeconds * rateHz; s++) {
        const f = (s + 1) / (turnSeconds * rateHz)
        rows.push({
          utc: t, lat: 39.5, lon: 2.57,
          sog: (leg.sog ?? 6) * 0.6, cog: norm(cog + delta * f), hdg: norm(cog + delta * f),
          heel: 0,
        })
        t += step
      }
    }
  }
  return rows
}

/** A plain windward-leeward beat: N tacks either side, then a run. */
export function beat(twd: number, opts: Partial<TrackSpec> & { tackAngle?: number; legSeconds?: number; legs?: number } = {}): TrackRow[] {
  const { tackAngle = 42, legSeconds = 120, legs: legCount = 6, ...rest } = opts
  const legs: LegSpec[] = []
  for (let i = 0; i < legCount; i++) legs.push({ twa: i % 2 ? tackAngle : -tackAngle, seconds: legSeconds })
  // `rest` must NOT carry `legs` — the leg COUNT would overwrite the leg ARRAY.
  return buildTrack({ twd, legs, ...rest })
}
