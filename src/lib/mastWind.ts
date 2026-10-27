// Model wind AT THE MAST, from a grid of points and a ladder of heights.
//
// This is the arithmetic the Mediterranean MOS specs were fitted through, and
// it has to be reproducible outside the browser: the fit pairs a boat's logged
// 30 m TWS against the model interpolated to WHERE THE BOAT WAS, not to a
// venue centre, which means a horizontal step (bilinear over the fetched
// points, in u/v) and a vertical one (a power law fitted to the model's own
// levels). `wind30()` in components/weather/mos.js does the vertical half for
// the app at one point; this module does both, purely, so a script and a test
// can drive it.
//
// TWO THINGS WORTH NOT REDISCOVERING.
//
// 1. INTERPOLATE IN u/v, NOT IN SPEED AND DEGREES. A mean of 350° and 10° is
//    180° out if taken as a mean of numbers, and the same error appears in a
//    bilinear weighting of four corners straddling north. Every horizontal and
//    vertical blend here goes through components.
//
// 2. THE VERTICAL STEP IS A FITTED POWER LAW, not a fixed exponent, whenever
//    the model publishes two or more levels — the model's own shear is better
//    information than a climatological alpha. With ONE level (ICON-2I and
//    MET Nordic publish 10 m only) there is nothing to fit, and what fills the
//    gap MATTERS and is not obvious. The app solves the neutral marine log law
//    self-consistently (Charnock roughness from the speed's own friction
//    velocity), worth a 10->30 m ratio of about 1.088 at 9 kn. The original
//    Mediterranean pipeline assumed a 0.11 power law instead, worth 1.128 —
//    3.6 % more wind, every hour, on every single-level model.
//
//    `mode` therefore defaults to 'log', which is what the app APPLIES, and a
//    fit must use the same thing it will be applied to or the coefficients
//    absorb the difference. 'alpha' exists to reproduce the old numbers.

import { solveSurfaceLayer, profileRatio } from './windProfile'

export interface UV { u: number; v: number }

/** Meteorological convention: the direction the wind comes FROM. */
export function toUV(speed: number, dirFromDeg: number): UV {
  const r = (dirFromDeg * Math.PI) / 180
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) }
}

export function fromUV(u: number, v: number): { speed: number; dir: number } {
  return {
    speed: Math.hypot(u, v),
    dir: (((Math.atan2(-u, -v) * 180) / Math.PI) % 360 + 360) % 360,
  }
}

/**
 * Least-squares alpha for U(z) = exp(alpha·ln z + c), on two or more levels.
 *
 * Returns null when fewer than two positive speeds survive, which is the
 * caller's signal to fall back rather than to invent a shear.
 */
export function fitPowerLaw(
  heights: readonly number[], speeds: readonly number[],
): { alpha: number; lnIntercept: number } | null {
  const h: number[] = []; const s: number[] = []
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] > 0 && speeds[i] > 0 && Number.isFinite(speeds[i])) { h.push(heights[i]); s.push(speeds[i]) }
  }
  if (h.length < 2) return null
  const x = h.map(Math.log); const y = s.map(Math.log)
  const mx = x.reduce((a, b) => a + b, 0) / x.length
  const my = y.reduce((a, b) => a + b, 0) / y.length
  let num = 0; let den = 0
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2 }
  if (!(den > 0)) return null
  const alpha = num / den
  return { alpha, lnIntercept: my - alpha * mx }
}

/**
 * The model's wind at height `z`, from whatever levels it published.
 *
 * `levels` maps height in metres to { speed, dir }. Direction comes from a
 * linear u/v interpolation between the two bracketing levels, clamped at the
 * ends — a mast at 30 m sits between 10 m and 80 m on most ladders, and that
 * is where the rig's backing or veering comes from.
 */
export function interpToMast(
  levels: ReadonlyMap<number, { speed: number; dir: number }>,
  z: number,
  opts: { mode?: 'log' | 'alpha'; defaultAlpha?: number; deltaK?: number | null } = {},
): { speed: number; dir: number; alpha: number; nLevels: number } | null {
  const mode = opts.mode ?? 'log'
  const defaultAlpha = opts.defaultAlpha ?? 0.11
  const hs = Array.from(levels.keys())
    .filter((h) => h > 0 && Number.isFinite(levels.get(h)!.speed) && levels.get(h)!.speed > 0)
    .sort((a, b) => a - b)
  if (!hs.length || !(z > 0)) return null

  let speed: number
  let alpha: number
  if (hs.length >= 2) {
    const fit = fitPowerLaw(hs, hs.map((h) => levels.get(h)!.speed))
    if (!fit) return null
    alpha = fit.alpha
    speed = Math.exp(alpha * Math.log(z) + fit.lnIntercept)
  } else if (mode === 'alpha') {
    alpha = defaultAlpha
    speed = levels.get(hs[0])!.speed * (z / hs[0]) ** defaultAlpha
  } else {
    // The app's path, term for term: solve the surface layer from this speed
    // and lift through it. deltaK is air minus sea, positive = stable; a
    // missing value is passed as 0, which is the honest no-information case
    // rather than a claim of neutrality.
    const sp = levels.get(hs[0])!.speed
    const dK = Number.isFinite(opts.deltaK as number) ? (opts.deltaK as number) : 0
    const layer = solveSurfaceLayer(sp * 0.514444, dK, { refZ: hs[0] })
    const r = profileRatio(z, hs[0], layer.z0, layer.lengthM)
    speed = sp * (r > 0 ? r : (z / hs[0]) ** defaultAlpha)
    alpha = Math.log(speed / sp) / Math.log(z / hs[0])
  }

  const uv = hs.map((h) => ({ h, ...toUV(levels.get(h)!.speed, levels.get(h)!.dir) }))
  let dir: number
  if (z <= uv[0].h) dir = fromUV(uv[0].u, uv[0].v).dir
  else if (z >= uv[uv.length - 1].h) dir = fromUV(uv[uv.length - 1].u, uv[uv.length - 1].v).dir
  else {
    let lo = uv[0]; let hi = uv[uv.length - 1]
    for (const p of uv) { if (p.h <= z) lo = p; }
    for (let i = uv.length - 1; i >= 0; i--) { if (uv[i].h >= z) hi = uv[i]; }
    const f = hi.h === lo.h ? 0 : (z - lo.h) / (hi.h - lo.h)
    dir = fromUV(lo.u + f * (hi.u - lo.u), lo.v + f * (hi.v - lo.v)).dir
  }
  return { speed, dir, alpha, nLevels: hs.length }
}

/** One fetched point's wind at one level. */
export interface GridPoint { lat: number; lon: number; speed: number; dir: number }

/**
 * Bilinear interpolation to (lat, lon) over the fetched lattice, in u/v.
 *
 * Falls back to the NEAREST point whenever a bracketing corner is missing —
 * which happens at the edge of a model's domain, where some of a venue's nine
 * points come back empty. Returning the nearest point is the behaviour the
 * original fit had; silently dropping the row would quietly shrink a regatta.
 */
export function bilinearUV(points: readonly GridPoint[], lat: number, lon: number): UV | null {
  const usable = points.filter((p) => Number.isFinite(p.speed) && Number.isFinite(p.dir))
  if (!usable.length) return null
  const nearest = () => {
    let best = usable[0]; let bd = Infinity
    for (const p of usable) {
      const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2
      if (d < bd) { bd = d; best = p }
    }
    return toUV(best.speed, best.dir)
  }
  const lats = Array.from(new Set(usable.map((p) => p.lat))).sort((a, b) => a - b)
  const lons = Array.from(new Set(usable.map((p) => p.lon))).sort((a, b) => a - b)
  const below = (xs: number[], x: number) => {
    const c = xs.filter((v) => v <= x)
    return c.length ? Math.max(...c) : Math.min(...xs)
  }
  const above = (xs: number[], x: number) => {
    const c = xs.filter((v) => v >= x)
    return c.length ? Math.min(...c) : Math.max(...xs)
  }
  const la0 = below(lats, lat); const la1 = above(lats, lat)
  const lo0 = below(lons, lon); const lo1 = above(lons, lon)
  const at = (a: number, o: number) => usable.find((p) => p.lat === a && p.lon === o)
  const c00 = at(la0, lo0); const c01 = at(la0, lo1)
  const c10 = at(la1, lo0); const c11 = at(la1, lo1)
  if (!c00 || !c01 || !c10 || !c11) return nearest()
  const fy = la1 === la0 ? 0 : (lat - la0) / (la1 - la0)
  const fx = lo1 === lo0 ? 0 : (lon - lo0) / (lo1 - lo0)
  const q = [c00, c01, c10, c11].map((c) => toUV(c.speed, c.dir))
  const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
  return {
    u: q.reduce((s, p, i) => s + p.u * w[i], 0),
    v: q.reduce((s, p, i) => s + p.v * w[i], 0),
  }
}
