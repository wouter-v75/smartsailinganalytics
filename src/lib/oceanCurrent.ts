// src/lib/oceanCurrent.ts
// ─────────────────────────────────────────────────────────────────────────────
// Ocean + tidal current from Open-Meteo's Marine API — the free global baseline.
//
// It plays the same role Open-Meteo already plays for wind: a prior, an
// independent validation check, and a FLAG. It is explicitly NOT a correction
// term. The model is 0.08° ≈ 8 km, and Open-Meteo say so themselves: "Accuracy
// at coastal areas is limited. This is not suitable for coastal navigation."
// An 8 km cell cannot represent a tidal gate or a back-eddy, which is what
// actually decides an inshore race. See docs/current-data-sources-2026-09.md.
//
// The useful output is not the vector, it is `twdBiasDeg()` — how far a naive
// tack-bisector TWD is rotated by this current. "0.9 kn across the course ≈ 5°
// of TWD bias if uncorrected" is actionable; "0.9 kn at 124°" is not.
//
// Three traps, all found by calling the real API rather than reading the docs:
//
//   • `current_velocity_unit=kn` IS IGNORED. The response comes back in km/h
//     whatever you ask for, so the unit is read from `hourly_units` and
//     converted here. Trusting the request parameter would have made every
//     current 1.85× too big.
//   • ALWAYS REQUEST `timezone=UTC`. Asking for `Europe/Madrid` on a February
//     date returned `utc_offset_seconds: 7200` — September's DST offset, not
//     the offset in force on the requested day — which would slide the whole
//     series an hour. Same family as the clock traps in CLAUDE.md.
//   • The model snaps hard. A request for Palma came back from a cell 8.3 km
//     away. The response reports the cell it used, so the distance is measured
//     and returned; a caller can refuse a cell that is too far to be relevant.
//
// Direction convention, which is the opposite of wind's: `ocean_current_direction`
// is where the water flows TO (a "set"; 0° = northward, 90° = eastward), while
// TWD is where the wind comes FROM. Mixing them up flips the bias sign.
// ─────────────────────────────────────────────────────────────────────────────

export const MARINE_ENDPOINT = 'https://marine-api.open-meteo.com/v1/marine'

const KMH_TO_KN = 1 / 1.852
const D = Math.PI / 180
const R_KM = 6371

export interface CurrentSample {
  speedKn: number
  /** Degrees the water flows TOWARD (a set), 0 = north, 90 = east. */
  setDeg: number
}

export interface CurrentSeries {
  /** Epoch ms, ascending. */
  times: number[]
  speedKn: (number | null)[]
  setDeg: (number | null)[]
  /** The grid cell the model actually used — not what was requested. */
  cell: { lat: number; lon: number }
  /** How far that cell is from the requested point, km. */
  cellOffsetKm: number
}

/** Great-circle-ish distance, fine at these scales. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * D
  const dLon = (bLon - aLon) * D * Math.cos(((aLat + bLat) / 2) * D)
  return Math.hypot(dLat, dLon) * R_KM
}

/**
 * Snap to a coarse grid before requesting. Open-Meteo bills PER LOCATION, and a
 * current track along a boat's path is a sequence of locations — so collapse a
 * whole session to one venue cell. 0.05° (~5.5 km) is finer than the model's
 * own 8 km, so snapping loses nothing the model could have told us.
 */
export function snapToGrid(lat: number, lon: number, step = 0.05): { lat: number; lon: number } {
  const r = (v: number) => Math.round(v / step) * step
  return { lat: +r(lat).toFixed(4), lon: +r(lon).toFixed(4) }
}

/** Median position of a track — one representative point per session. */
export function medianPosition(
  rows: Array<{ lat?: number | null; lon?: number | null }>
): { lat: number; lon: number } | null {
  const lats = rows.map((r) => r.lat).filter((v): v is number => Number.isFinite(v as number))
  const lons = rows.map((r) => r.lon).filter((v): v is number => Number.isFinite(v as number))
  if (!lats.length || !lons.length) return null
  lats.sort((a, b) => a - b); lons.sort((a, b) => a - b)
  return { lat: lats[lats.length >> 1], lon: lons[lons.length >> 1] }
}

export interface CurrentQuery {
  lat: number
  lon: number
  /** YYYY-MM-DD, both inclusive. */
  startDate: string
  endDate?: string
}

export function currentUrl(q: CurrentQuery): string {
  const { lat, lon } = snapToGrid(q.lat, q.lon)
  const end = q.endDate || q.startDate
  // timezone=UTC deliberately — see the header. We convert ourselves.
  return `${MARINE_ENDPOINT}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${q.startDate}&end_date=${end}` +
    `&hourly=ocean_current_velocity,ocean_current_direction&timezone=UTC`
}

/** Parse a marine response. Returns null when the cell has no current data (land). */
export function parseCurrentResponse(json: any, reqLat: number, reqLon: number): CurrentSeries | null {
  const h = json?.hourly
  if (!h || !Array.isArray(h.time) || !h.time.length) return null

  // The unit is whatever the API felt like returning — read it, do not assume.
  const unit = String(json?.hourly_units?.ocean_current_velocity || '').toLowerCase()
  const toKn = unit.includes('km') ? KMH_TO_KN
    : unit.includes('kn') ? 1
      : unit.includes('m/s') ? 1.94384
        : unit.includes('mph') ? 0.868976
          : KMH_TO_KN   // the observed default

  const times = h.time.map((t: string) => Date.parse(t.endsWith('Z') ? t : `${t}Z`))
  const speedKn = (h.ocean_current_velocity || []).map(
    (v: number | null) => (Number.isFinite(v as number) ? (v as number) * toKn : null))
  const setDeg = (h.ocean_current_direction || []).map(
    (v: number | null) => (Number.isFinite(v as number) ? ((v as number) % 360 + 360) % 360 : null))

  if (!speedKn.some((v: number | null) => v != null)) return null

  const cell = { lat: json.latitude, lon: json.longitude }
  return {
    times, speedKn, setDeg, cell,
    cellOffsetKm: distanceKm(reqLat, reqLon, cell.lat, cell.lon),
  }
}

export async function fetchOceanCurrent(
  q: CurrentQuery,
  fetchImpl: typeof fetch = fetch
): Promise<CurrentSeries | null> {
  try {
    const res = await fetchImpl(currentUrl(q))
    if (!res.ok) return null
    return parseCurrentResponse(await res.json(), q.lat, q.lon)
  } catch {
    return null
  }
}

/**
 * Current at an instant. Interpolates the VECTOR, not speed and direction
 * separately — interpolating a bearing across the 0/360 wrap gives nonsense.
 */
export function currentAt(series: CurrentSeries | null, utcMs: number): CurrentSample | null {
  if (!series || !series.times.length) return null
  const { times } = series
  if (utcMs < times[0] || utcMs > times[times.length - 1]) return null

  let hi = times.findIndex((t) => t >= utcMs)
  if (hi < 0) return null
  if (hi === 0) hi = 1
  const lo = hi - 1

  const vec = (i: number) => {
    const s = series.speedKn[i], d = series.setDeg[i]
    if (s == null || d == null) return null
    return { u: s * Math.sin(d * D), v: s * Math.cos(d * D) }   // u east, v north
  }
  const a = vec(lo), b = vec(hi)
  if (!a && !b) return null
  if (!a || !b) {
    const only = (a || b)!
    return { speedKn: Math.hypot(only.u, only.v), setDeg: (Math.atan2(only.u, only.v) / D + 360) % 360 }
  }
  const span = times[hi] - times[lo]
  const f = span > 0 ? (utcMs - times[lo]) / span : 0
  const u = a.u + (b.u - a.u) * f
  const v = a.v + (b.v - a.v) * f
  return { speedKn: Math.hypot(u, v), setDeg: (Math.atan2(u, v) / D + 360) % 360 }
}

/**
 * Component of the current ACROSS the wind axis, in knots.
 *
 *   c⊥ = c · sin(set − TWD)
 *
 * Positive means the water sets clockwise of the direction the wind comes from.
 * Only this component rotates a tack bisector; the along-wind component changes
 * the apparent tack angle instead, corrupting TWS rather than TWD (TWD doc §7).
 */
export function crossWindKn(speedKn: number, setDeg: number, twdDeg: number): number {
  return speedKn * Math.sin((setDeg - twdDeg) * D)
}

export interface BiasInput {
  speedKn: number
  setDeg: number
  twdDeg: number
  /** Boat speed through the water, knots. */
  boatSpeedKn: number
  /** Upwind true wind angle, degrees. */
  twaDeg: number
}

/**
 * How far a naive tack-bisector TWD is rotated CLOCKWISE by this current:
 *
 *   bias(deg) ≈ 57.3 · c⊥ · cos(TWA) / V
 *
 * Subtract it to correct. Derived and tabulated in TWD doc §7; the linearisation
 * is within 0.2° of exact out to 1 kn of cross-current.
 */
export function twdBiasDeg(i: BiasInput): number {
  if (!(i.boatSpeedKn > 0)) return 0
  const cPerp = crossWindKn(i.speedKn, i.setDeg, i.twdDeg)
  return (180 / Math.PI) * cPerp * Math.cos(i.twaDeg * D) / i.boatSpeedKn
}

export type BiasVerdict = 'negligible' | 'notable' | 'significant'

/**
 * Whether the current is worth mentioning. The thresholds come from what the
 * wind estimate can otherwise achieve: a pooled fleet reaches ~1°, so below
 * that the current is lost in the noise, and beyond ~3° it is the dominant
 * error and the TWD should be labelled ground-wind-only until L4 runs.
 */
export function biasVerdict(biasDeg: number): BiasVerdict {
  const a = Math.abs(biasDeg)
  if (a < 1) return 'negligible'
  if (a < 3) return 'notable'
  return 'significant'
}

/** One sentence a coach can act on, or null when there is nothing to say. */
export function describeCurrentBias(i: BiasInput): string | null {
  const bias = twdBiasDeg(i)
  const v = biasVerdict(bias)
  if (v === 'negligible') return null
  const dir = bias > 0 ? 'clockwise' : 'anticlockwise'
  return `${i.speedKn.toFixed(1)} kn setting ${Math.round(i.setDeg)}° ` +
    `rotates an uncorrected TWD ${Math.abs(bias).toFixed(1)}° ${dir}` +
    (v === 'significant' ? ' — treat TWD as ground wind until current is solved.' : '.')
}
