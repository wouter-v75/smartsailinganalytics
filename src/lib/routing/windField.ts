// A gridded, hourly wind field at the polar's reference height, and the lift
// from the reanalysis' own levels to that height.
//
// SAMPLING IS IN u/v FOR DIRECTION. Bilinear in space and linear in time, on the
// components, never on degrees: a blend of 350 deg and 10 deg is 180 deg out if
// done on the numbers. But a component blend UNDERSTATES the wind in the middle
// of a shift (two 10 kn winds 90 deg apart average to 7.1 kn, not 10), so the
// SPEED is blended as a scalar and the components rescaled to it.
//
// THE LIFT TO THE MAST (`liftToHeight`). ERA5 publishes 10 m AND 100 m wind, so
// for a 20-35 m masthead the model's own shear is available and is the default
// ('power': log-linear in height between the two levels, i.e. a power law fitted
// through exactly those two points). That shear already contains the model's
// stability, which is the point: the neutral log law is low-biased by 9 % on
// average and 16 % on a light stable morning (windProfile.ts). The alternatives
// exist to measure against it and as the hook for the next step:
//   'mo'       Monin-Obukhov from the 10 m wind and the air-sea temperature
//              difference (t2m - SST), with Charnock roughness — the
//              surface-layer physics re-done outside the model, which is the
//              first-order version of "a better turbulence scheme".
//   'neutral'  neutral log law from 10 m, the low-biased reference.
//   'none'     use 10 m as is, for a polar defined at 10 m.
// Direction comes from the u/v blend between 10 and 100 m at the same height
// weight, so the veer with height is kept.

import { mastheadWind } from '../windProfile'

const MS_TO_KN = 1.9438445

export interface WindGrid {
  /** First latitude (deg), ascending by dLat. */
  lat0: number; dLat: number; nLat: number
  /** First longitude (deg), ascending by dLon. */
  lon0: number; dLon: number; nLon: number
  /** Epoch ms of the first field, and spacing. */
  t0: number; dtMs: number; nT: number
  /** Knots, at the polar's reference height, index [t][iLat][iLon]. */
  u: Float32Array; v: Float32Array
  heightM: number
}

export interface WindSample { tws: number; twd: number; u: number; v: number }

/**
 * Wind at (lat, lon, t) into `out`. Returns false outside the grid or its time
 * span — the router treats that as "no data", never as calm.
 */
export function sampleWind(g: WindGrid, lat: number, lon: number, t: number, out: WindSample): boolean {
  const y = (lat - g.lat0) / g.dLat, x = (lon - g.lon0) / g.dLon
  const s = (t - g.t0) / g.dtMs
  if (!(y >= 0 && y <= g.nLat - 1 && x >= 0 && x <= g.nLon - 1 && s >= 0 && s <= g.nT - 1)) return false
  const i = Math.min(g.nLat - 2, Math.floor(y)), j = Math.min(g.nLon - 2, Math.floor(x))
  const k = Math.min(g.nT - 2, Math.floor(s))
  const fy = y - i, fx = x - j, fs = s - k
  const plane = g.nLat * g.nLon
  const b0 = k * plane + i * g.nLon + j, b1 = b0 + plane
  const w00 = (1 - fy) * (1 - fx), w01 = (1 - fy) * fx, w10 = fy * (1 - fx), w11 = fy * fx
  const U = g.u, V = g.v, n = g.nLon
  const u0 = w00 * U[b0] + w01 * U[b0 + 1] + w10 * U[b0 + n] + w11 * U[b0 + n + 1]
  const u1 = w00 * U[b1] + w01 * U[b1 + 1] + w10 * U[b1 + n] + w11 * U[b1 + n + 1]
  const v0 = w00 * V[b0] + w01 * V[b0 + 1] + w10 * V[b0 + n] + w11 * V[b0 + n + 1]
  const v1 = w00 * V[b1] + w01 * V[b1 + 1] + w10 * V[b1 + n] + w11 * V[b1 + n + 1]
  let u = u0 + fs * (u1 - u0), v = v0 + fs * (v1 - v0)
  // Direction from the components; SPEED from the speeds. A u/v blend across a
  // shift shrinks the wind (two 10 kn winds 90 deg apart blend to 7.1 kn), which
  // would invent a hole in every front. LuckGrib preserves magnitude the same way.
  const H = Math.hypot
  const sp0 = w00 * H(U[b0], V[b0]) + w01 * H(U[b0 + 1], V[b0 + 1]) + w10 * H(U[b0 + n], V[b0 + n]) + w11 * H(U[b0 + n + 1], V[b0 + n + 1])
  const sp1 = w00 * H(U[b1], V[b1]) + w01 * H(U[b1 + 1], V[b1 + 1]) + w10 * H(U[b1 + n], V[b1 + n]) + w11 * H(U[b1 + n + 1], V[b1 + n + 1])
  const sp = sp0 + fs * (sp1 - sp0)
  const m = H(u, v)
  if (m > 1e-6) { u *= sp / m; v *= sp / m }
  out.u = u; out.v = v
  out.tws = sp
  // Direction the wind blows FROM, degrees true.
  const d = Math.atan2(-u, -v) * 180 / Math.PI
  out.twd = d < 0 ? d + 360 : d
  return true
}

export type LiftMethod = 'power' | 'mo' | 'neutral' | 'none'

export interface RawFields {
  lat0: number; dLat: number; nLat: number
  lon0: number; dLon: number; nLon: number
  t0: number; dtMs: number; nT: number
  /** m/s, [t][iLat][iLon]. */
  u10: Float32Array; v10: Float32Array
  u100?: Float32Array; v100?: Float32Array
  /** Kelvin. SST is NaN over land. */
  t2m?: Float32Array; sst?: Float32Array
}

export interface LiftStats {
  method: LiftMethod
  /** Mean of (speed at height / speed at 10 m), over the cells that had wind. */
  meanRatio: number
  /** Share of cell-hours the 'mo' path found stable. */
  stableShare: number | null
  fallbacks: number
}

/**
 * Lift a reanalysis' 10 m (+100 m) wind to the polar's height, in knots.
 * A method that needs a field the file does not carry falls back to the
 * neutral log law and COUNTS the fallbacks, so a run says what it really did.
 */
export function liftToHeight(f: RawFields, heightM: number, method: LiftMethod): { grid: WindGrid; stats: LiftStats } {
  const N = f.u10.length
  const u = new Float32Array(N), v = new Float32Array(N)
  const z = heightM
  const w = Math.log(z / 10) / Math.log(10)   // 0 at 10 m, 1 at 100 m
  let ratioSum = 0, ratioN = 0, stable = 0, moN = 0, fallbacks = 0
  // The neutral and MO ratios depend only on (speed, dT); cache them on a coarse
  // key so twenty years of cells do not each run the iteration.
  const cache = new Map<number, number>()
  const ratioFor = (s10kn: number, dT: number | null) => {
    const key = Math.round(s10kn * 4) * 100000 + (dT == null ? 99999 : Math.round((dT + 30) * 20))
    let r = cache.get(key)
    if (r == null) { r = mastheadWind(Math.max(0.25, s10kn), 10, z, dT).ratio; cache.set(key, r) }
    return r
  }

  for (let n = 0; n < N; n++) {
    const a = f.u10[n], b = f.v10[n]
    const s10 = Math.hypot(a, b)
    if (!Number.isFinite(s10)) { u[n] = NaN; v[n] = NaN; continue }
    let ux = a, vy = b, speed = s10
    const has100 = f.u100 && f.v100 && Number.isFinite(f.u100[n]) && Number.isFinite(f.v100[n])
    if (method !== 'none' && has100) {
      // Direction: the 10/100 m blend at this height.
      ux = a + w * (f.u100![n] - a); vy = b + w * (f.v100![n] - b)
    }
    if (method === 'none' || z === 10) speed = s10
    else if (method === 'power' && has100) {
      const s100 = Math.hypot(f.u100![n], f.v100![n])
      speed = s10 > 0.05 && s100 > 0.05 ? s10 * Math.pow(s100 / s10, w) : s10 + w * (s100 - s10)
    } else if (method === 'mo') {
      const sst = f.sst?.[n], t2 = f.t2m?.[n]
      const dT = Number.isFinite(sst as number) && Number.isFinite(t2 as number) ? (t2 as number) - (sst as number) : null
      if (dT == null) fallbacks++
      else { moN++; if (dT > 0) stable++ }
      speed = s10 * ratioFor(s10 * MS_TO_KN, dT)
    } else {
      if (method === 'power') fallbacks++
      speed = s10 * ratioFor(s10 * MS_TO_KN, null)
    }
    const m = Math.hypot(ux, vy)
    const k = m > 1e-6 ? (speed / m) * MS_TO_KN : 0
    u[n] = ux * k; v[n] = vy * k
    if (s10 > 1) { ratioSum += speed / s10; ratioN++ }
  }
  return {
    grid: {
      lat0: f.lat0, dLat: f.dLat, nLat: f.nLat, lon0: f.lon0, dLon: f.dLon, nLon: f.nLon,
      t0: f.t0, dtMs: f.dtMs, nT: f.nT, u, v, heightM: z,
    },
    stats: {
      method,
      meanRatio: ratioN ? ratioSum / ratioN : 1,
      stableShare: method === 'mo' && moN ? stable / moN : null,
      fallbacks,
    },
  }
}

/** A uniform or analytic field, for tests and synthetic studies. */
export function syntheticGrid(
  box: { latMin: number; latMax: number; lonMin: number; lonMax: number },
  t0: number, hours: number, step: number,
  wind: (lat: number, lon: number, tMs: number) => { tws: number; twd: number },
): WindGrid {
  const nLat = Math.round((box.latMax - box.latMin) / step) + 1
  const nLon = Math.round((box.lonMax - box.lonMin) / step) + 1
  const nT = hours + 1
  const u = new Float32Array(nT * nLat * nLon), v = new Float32Array(nT * nLat * nLon)
  for (let k = 0; k < nT; k++) for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
    const w = wind(box.latMin + i * step, box.lonMin + j * step, t0 + k * 3600e3)
    const r = w.twd * Math.PI / 180, n = (k * nLat + i) * nLon + j
    u[n] = -w.tws * Math.sin(r); v[n] = -w.tws * Math.cos(r)
  }
  return { lat0: box.latMin, dLat: step, nLat, lon0: box.lonMin, dLon: step, nLon, t0, dtMs: 3600e3, nT, u, v, heightM: 10 }
}
