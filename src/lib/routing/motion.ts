// Moving a boat through a time-varying wind: the two operations both routers
// share, so they cannot disagree about how fast the same boat sails.
//
//   advance()   hold a heading for a while, integrated with a midpoint (RK2)
//               step: speed from the wind at the start, a half-step to the
//               midpoint, the wind THERE and THEN, and the full step on that
//               speed. Euler on a 30 min step through a front or a sea-breeze
//               onset is visibly wrong; RK2 costs one more wind sample.
//   approach()  the last few miles to a mark: the exact arrival time from a
//               point near it, which is the answer to the last-isochrone
//               problem (see isochrone.ts for why that is the crux).

import { bearingDeg, destination, distNm, norm180, type LatLon } from './geo'
import type { RoutingPolar } from './polar'
import { sampleWind, type WindGrid, type WindSample } from './windField'
import { stepHitsLand, type LandMask } from './land'

export interface Env {
  polar: RoutingPolar
  wind: WindGrid
  land: LandMask | null
  /**
   * Share of the polar sailed at (lat, lon, t), e.g. 0.95 by day and 0.90 by
   * night (daylight.ts). Absent = the polar as it stands. It scales SPEED only:
   * the VMG angles and the no-go edge are the polar's shape, which a uniform
   * factor does not move.
   */
  perf?: (lat: number, lon: number, tMs: number) => number
}

/** The performance factor at a point, 1 when none is set. */
export const perfAt = (env: Env, lat: number, lon: number, tMs: number) => (env.perf ? env.perf(lat, lon, tMs) : 1)

export interface Leg {
  lat: number; lon: number
  /** Boat speed (kn), signed TWA (deg, + = starboard tack: wind over the starboard side), TWS (kn). */
  bsp: number; twa: number; tws: number
}

const scratch: WindSample = { tws: 0, twd: 0, u: 0, v: 0 }

/** Signed TWA for a heading: positive = wind on the starboard side (starboard tack). */
export const signedTwa = (heading: number, twd: number) => norm180(twd - heading)

/**
 * Hold `heading` for `sec` seconds from (lat, lon) at `t`. Returns null when the
 * wind runs out (off the grid or past its last hour), the heading is no-go, or
 * the step touches land.
 */
export function advance(env: Env, p: LatLon, t: number, heading: number, sec: number): Leg | null {
  if (!sampleWind(env.wind, p.lat, p.lon, t, scratch)) return null
  const twa0 = signedTwa(heading, scratch.twd)
  const s0 = env.polar.speed(scratch.tws, twa0) * perfAt(env, p.lat, p.lon, t)
  if (!(s0 > 0)) return null
  const mid = destination(p.lat, p.lon, heading, (s0 * sec) / 7200)
  if (!sampleWind(env.wind, mid.lat, mid.lon, t + sec * 500, scratch)) return null
  const twa = signedTwa(heading, scratch.twd)
  const s = env.polar.speed(scratch.tws, twa) * perfAt(env, mid.lat, mid.lon, t + sec * 500)
  if (!(s > 0)) return null
  const end = destination(p.lat, p.lon, heading, (s * sec) / 3600)
  if (stepHitsLand(env.land, p, end)) return null
  return { lat: end.lat, lon: end.lon, bsp: s, twa, tws: scratch.tws }
}

export interface ApproachSeg { lat: number; lon: number; t: number; twa: number; tws: number; bsp: number }

export interface Approach {
  /** Seconds (times elsewhere are epoch ms) from the start point to the mark's circle, manoeuvres included. */
  sec: number
  /** Where it reaches the circle. */
  end: LatLon
  /** The points along the way, for the path and the TWA/TWS table. */
  segs: ApproachSeg[]
  manoeuvres: { tacks: number; gybes: number }
  /** Tack side on arrival (+1 starboard, -1 port). */
  side: number
}

/**
 * The fastest way from p (at t, on tack side `side`) into the circle of radius
 * `radiusNm` round `mark`, or null if it takes longer than `maxSec`.
 *
 * In wind that is uniform over the approach the fastest path to a point is
 * either STRAIGHT or TWO LEGS with one manoeuvre between them — the convex hull
 * of the polar. Two legs win exactly when the mark lies inside the VMG angle,
 * upwind (closer to the wind than the beat angle) or downwind (deeper than the
 * run angle), and then the time is d·cos(theta)/VMG whatever the split, so it
 * is closed-form. The wind is read at the approach's midpoint in space and time,
 * and the straight case is then INTEGRATED in sub-steps so a shift during the
 * approach is felt. A no-go straight line with no VMG alternative returns null.
 */
export function approach(
  env: Env, p: LatLon, t: number, side: number,
  mark: LatLon, radiusNm: number, maxSec: number,
): Approach | null {
  const d0 = distNm(p.lat, p.lon, mark.lat, mark.lon)
  if (d0 <= radiusNm) return { sec: 0, end: p, segs: [], manoeuvres: { tacks: 0, gybes: 0 }, side }
  const brg = bearingDeg(p.lat, p.lon, mark.lat, mark.lon)
  const run = d0 - radiusNm
  const endPt = destination(p.lat, p.lon, brg, run)

  // Mid-approach wind, for the choice between straight and two legs.
  const midP = destination(p.lat, p.lon, brg, run / 2)
  if (!sampleWind(env.wind, p.lat, p.lon, t, scratch)) return null
  const twsA = scratch.tws
  // When the midpoint is reached: a rough duration from the start wind, the
  // better of straight and VMG.
  const a0 = Math.abs(signedTwa(brg, scratch.twd))
  const v0 = env.polar.vmg(twsA)
  const est = Math.max(env.polar.speed(twsA, a0), v0.upVmg, v0.dnVmg, 0.5) * perfAt(env, p.lat, p.lon, t)
  const tMid = t + 0.5 * (run / Math.max(est, 0.25)) * 3600e3
  if (!sampleWind(env.wind, midP.lat, midP.lon, tMid, scratch)) return null
  const tws = 0.5 * (twsA + scratch.tws), twd = scratch.twd
  const twa = signedTwa(brg, twd)
  const a = Math.abs(twa)
  const polar = env.polar
  // The closed forms below use ONE wind and ONE performance factor for the
  // whole approach, both read at its midpoint in space and time.
  const fMid = perfAt(env, midP.lat, midP.lon, tMid)
  const vm = polar.vmg(tws)
  const upVmg = vm.upVmg * fMid, dnVmg = vm.dnVmg * fMid
  const straight = polar.speed(tws, a) * fMid
  const thetaUp = a, thetaDn = 180 - a
  const twoUp = a < vm.upTwa && upVmg > 0 ? (run * Math.cos(thetaUp * Math.PI / 180)) / upVmg * 3600 + polar.tackSec : Infinity
  const twoDn = a > vm.dnTwa && dnVmg > 0 ? (run * Math.cos(thetaDn * Math.PI / 180)) / dnVmg * 3600 + polar.gybeSec : Infinity
  const straightSec = straight > 0 ? (run / straight) * 3600 : Infinity
  const best = Math.min(straightSec, twoUp, twoDn)
  if (!Number.isFinite(best) || best > maxSec * 1.5) return null

  const newSide = twa >= 0 ? 1 : -1
  if (best === straightSec) {
    // Integrate it: sub-steps of at most 5 minutes, re-aiming at the mark each time.
    const segs: ApproachSeg[] = []
    let q: LatLon = p, tt = t, left = run, guard = 0
    let pen = 0
    if (side !== 0 && side !== newSide) pen = a < 90 ? polar.tackSec : polar.gybeSec
    while (left > 1e-4 && guard++ < 400) {
      if (!sampleWind(env.wind, q.lat, q.lon, tt, scratch)) return null
      const h = bearingDeg(q.lat, q.lon, mark.lat, mark.lon)
      const ta = signedTwa(h, scratch.twd)
      const s = polar.speed(scratch.tws, ta) * perfAt(env, q.lat, q.lon, tt)
      if (!(s > 0)) return null
      const sub = Math.min(300, (left / s) * 3600)
      const nm = (s * sub) / 3600
      const nq = destination(q.lat, q.lon, h, nm)
      if (stepHitsLand(env.land, q, nq)) return null
      segs.push({ lat: q.lat, lon: q.lon, t: tt, twa: ta, tws: scratch.tws, bsp: s })
      q = nq; tt += sub * 1000; left -= nm
      if (tt - t > maxSec * 1500) return null
    }
    const sec = (tt - t) / 1000 + pen
    const man = pen === 0 ? { tacks: 0, gybes: 0 } : a < 90 ? { tacks: 1, gybes: 0 } : { tacks: 0, gybes: 1 }
    return { sec, end: q, segs, manoeuvres: man, side: newSide }
  }

  // Two legs: the closed form. The path is drawn through the corner so it is
  // honest on a chart, and the first leg is on whichever tack the boat is
  // already on, so the only manoeuvre is the one in the middle.
  const up = best === twoUp
  const ang = up ? vm.upTwa : vm.dnTwa
  const first = side !== 0 ? side : newSide
  // Heading for TWA `ang` on side `s`: TWA = twd - heading.
  const h1 = twd - first * ang
  const h2 = twd + first * ang
  // Split: solve corner = p + L1·e1, mark = corner + L2·e2 in a local plane.
  const k = Math.cos(p.lat * Math.PI / 180)
  const dx = (endPt.lon - p.lon) * 60 * k, dy = (endPt.lat - p.lat) * 60
  const e1 = { x: Math.sin(h1 * Math.PI / 180), y: Math.cos(h1 * Math.PI / 180) }
  const e2 = { x: Math.sin(h2 * Math.PI / 180), y: Math.cos(h2 * Math.PI / 180) }
  const det = e1.x * e2.y - e1.y * e2.x
  const L1 = Math.abs(det) > 1e-9 ? (dx * e2.y - dy * e2.x) / det : run / 2
  const L2 = Math.abs(det) > 1e-9 ? (e1.x * dy - e1.y * dx) / det : run / 2
  if (!(L1 >= -1e-6 && L2 >= -1e-6)) return null
  const corner = destination(p.lat, p.lon, h1, Math.max(0, L1))
  if (stepHitsLand(env.land, p, corner) || stepHitsLand(env.land, corner, endPt)) return null
  const s = polar.speed(tws, ang) * fMid
  const t1 = (Math.max(0, L1) / s) * 3600
  const segs: ApproachSeg[] = [
    { lat: p.lat, lon: p.lon, t, twa: first * ang, tws, bsp: s },
    { lat: corner.lat, lon: corner.lon, t: t + (t1 + (up ? polar.tackSec : polar.gybeSec)) * 1000, twa: -first * ang, tws, bsp: s },
  ]
  return {
    sec: best, end: endPt, segs,
    manoeuvres: up ? { tacks: 1, gybes: 0 } : { tacks: 0, gybes: 1 },
    side: -first,
  }
}
