// Tidal currents in the Salish Sea, from SalishSeaCast (UBC EOAS).
//
// WHY A SECOND CURRENT SOURCE EXISTS AT ALL, measured 27 Oct 2026. Open-Meteo's
// marine currents — what lib/oceanCurrent.ts fetches everywhere else — come from
// a 1/12 degree global ocean model, and at the San Juan Islands they return
// **0.8 to 1.2 km/h**, under 0.6 kn, in channels that run 3 to 6. It is the same
// failure as the global SST: a 9 km model does not resolve a 2-5 km channel, so
// it reports the mean of a strait and a mountain. Those numbers are not slightly
// low, they are the wrong quantity, and a current arrow drawn from them would
// point a crew at the wrong side of a gate.
//
// SalishSeaCast is a NEMO configuration built for this water: 898 x 398 cells at
// about 500 m, hourly, served over ERDDAP with no key and no quota. The dataset
// used here is `ubcSSfDepthAvgdCurrents1h` — "Near-surface Depth Averaged
// Currents" — and of its four variables this takes **VelEast5 / VelNorth5**, the
// average over the top 5 m, because that is the water a hull sits in. (The 10 m
// pair exists for deeper draught.) Its window is rolling and covers about three
// days back and three forward.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT.
//
// 1. THE GRID HAS NO LAT/LON AXES. It is curvilinear and indexed by gridY/gridX,
//    so a position cannot be looked up directly. An affine fit gets close — on
//    the 1,106 sampled points within about 40 nm of the San Juans it has an rms
//    residual of 0.35 cells (~176 m) — but its worst case over that set is 4.8
//    cells, about 2.4 km, which at this coast is the difference between one
//    channel and the next. So the fit is a FIRST GUESS and nothing more: the
//    cell is then chosen by looking at what is actually there.
//
// 2. THE BATHYMETRY MASK AND THE CURRENT MASK DISAGREE. In a 13x13 window at the
//    venue centre, 96 cells have water in the bathymetry file and only 58 carry a
//    velocity; at Cattle Pass it is 148 against 126. So a cell picked for having
//    water can still have no current, and the venue centre is exactly that case —
//    41 m of bathymetry and a masked velocity. The cell is therefore chosen
//    against the CURRENT field, which makes the choice self-validating.
//
// 3. AT 500 M IN A TIDAL GATE, ONE CELL IS NOT THE ANSWER. The same 13x13 window
//    at Cattle Pass spans **0.04 to 4.03 kn**. Picking the nearest cell with data
//    gave 2.30 kn where the gate is known to run 4 to 6. That spread is not noise
//    to be smoothed away, it is the structure a sailor is trying to use, so
//    `localMaxKn` carries it out of here and the UI can say "0.9 kn here, 4.0 kn
//    within half a mile" rather than quietly picking one.

import { distanceKm, type CurrentSeries } from './oceanCurrent'

export const ERDDAP = 'https://salishsea.eos.ubc.ca/erddap/griddap'
export const CURRENTS_DS = 'ubcSSfDepthAvgdCurrents1h'
export const GRID_DS = 'ubcSSnBathymetryV21-08'

/** Grid shape, from the dataset's own dimensions. */
export const NY = 898
export const NX = 398

/**
 * The model domain's bounding box, read off the grid file (lat 46.860..51.093,
 * lon -126.397..-121.345). It is the box around a ROTATED grid, so the corners
 * of this rectangle are outside the model — which is harmless here, because a
 * position that passes this gate and then finds no current cell simply returns
 * null and the caller falls back.
 */
export const SALISH_SEA = { latMin: 46.86, latMax: 51.09, lonMin: -126.4, lonMax: -121.34 }

export function inSalishSea(lat: number | null | undefined, lon: number | null | undefined): boolean {
  if (!Number.isFinite(lat as number) || !Number.isFinite(lon as number)) return false
  const la = lat as number; const lo = lon as number
  return la >= SALISH_SEA.latMin && la <= SALISH_SEA.latMax
    && lo >= SALISH_SEA.lonMin && lo <= SALISH_SEA.lonMax
}

/**
 * Affine first guess at (gridY, gridX), fitted by least squares on the grid's
 * own geo-location arrays restricted to +-0.6 lat / 0.9 lon around the San Juans
 * (1,106 points, rms 0.35 cells). Deliberately a LOCAL fit: the same fit over
 * the whole domain has an rms of 1.85 cells, because the grid is rotated and a
 * plane cannot follow it end to end.
 */
export function gridGuess(lat: number, lon: number): { gy: number; gx: number } {
  return {
    gy: 192.8547 * lat - 70.5863 * lon - 17746.314,
    gx: 123.8294 * lat + 146.4056 * lon + 12263.888,
  }
}

const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(v)))

/** An ERDDAP index selector for a square window, clamped to the grid. */
export function windowSel(gy: number, gx: number, half: number): string {
  const y0 = clamp(gy - half, NY); const y1 = clamp(gy + half, NY)
  const x0 = clamp(gx - half, NX); const x1 = clamp(gx + half, NX)
  return `[${y0}:${y1}][${x0}:${x1}]`
}

/** ERDDAP wants the brackets percent-encoded; everything else is literal. */
const enc = (sel: string) => sel.replace(/\[/g, '%5B').replace(/\]/g, '%5D')

export function geoWindowUrl(sel: string): string {
  return `${ERDDAP}/${GRID_DS}.json?latitude${enc(sel)},longitude${enc(sel)},bathymetry${enc(sel)}`
}

/** One timestep of the current field, which is what proves a cell is usable. */
export function currentWindowUrl(sel: string): string {
  return `${ERDDAP}/${CURRENTS_DS}.json?VelEast5%5B0:0%5D${enc(sel)},VelNorth5%5B0:0%5D${enc(sel)}`
}

export function seriesUrl(gy: number, gx: number): string {
  const sel = enc(`[${gy}:${gy}][${gx}:${gx}]`)
  return `${ERDDAP}/${CURRENTS_DS}.json?VelEast5%5B0:last%5D${sel},VelNorth5%5B0:last%5D${sel}`
}

const MS_TO_KN = 1.94384
const speedKnOf = (ve: number, vn: number) => Math.hypot(ve, vn) * MS_TO_KN
/** Degrees the water flows TOWARD, from east/north components. */
const setDegOf = (ve: number, vn: number) => ((Math.atan2(ve, vn) * 180) / Math.PI + 360) % 360

export interface SalishCell {
  gy: number
  gx: number
  lat: number
  lon: number
  depthM: number | null
  offsetKm: number
  /** Fastest speed anywhere in the search window at the sampled hour. */
  localMaxKn: number
  /** How many cells in the window carried a velocity, and how many were asked. */
  withData: number
  inWindow: number
}

type Row = Array<number | null>

/**
 * Choose the cell: nearest to the point among those that carry a velocity.
 *
 * Both windows are indexed the same way, so they are joined on (gridY, gridX).
 * A cell missing from either side is not a candidate — that is the mask
 * disagreement in note 2, and joining is what makes it harmless.
 */
export function pickCell(
  geoJson: { table?: { rows?: Row[] } },
  curJson: { table?: { rows?: Row[] } },
  lat: number,
  lon: number,
): SalishCell | null {
  const geo = new Map<string, { lat: number; lon: number; depth: number | null }>()
  for (const r of geoJson?.table?.rows ?? []) {
    const [y, x, plat, plon, bath] = r
    if (y == null || x == null || plat == null || plon == null) continue
    geo.set(`${y},${x}`, { lat: plat, lon: plon, depth: bath ?? null })
  }
  let best: SalishCell | null = null
  let localMax = 0
  let withData = 0
  let inWindow = 0
  for (const r of curJson?.table?.rows ?? []) {
    // rows are [time, gridY, gridX, VelEast5, VelNorth5]
    const [, y, x, ve, vn] = r
    if (y == null || x == null) continue
    inWindow++
    if (ve == null || vn == null) continue
    withData++
    const kn = speedKnOf(ve, vn)
    if (kn > localMax) localMax = kn
    const g = geo.get(`${y},${x}`)
    if (!g) continue
    const offsetKm = distanceKm(lat, lon, g.lat, g.lon)
    if (!best || offsetKm < best.offsetKm) {
      best = { gy: y, gx: x, lat: g.lat, lon: g.lon, depthM: g.depth, offsetKm, localMaxKn: 0, withData: 0, inWindow: 0 }
    }
  }
  if (!best) return null
  return { ...best, localMaxKn: localMax, withData, inWindow }
}

/** The hourly series at one cell, in the shape every other current source uses. */
export function parseSeries(
  json: { table?: { rows?: Row[] } },
  cell: SalishCell,
  reqLat: number,
  reqLon: number,
): CurrentSeries | null {
  const times: number[] = []
  const speedKn: (number | null)[] = []
  const setDeg: (number | null)[] = []
  for (const r of json?.table?.rows ?? []) {
    const [t, , , ve, vn] = r as [string | number | null, ...Row]
    const ms = typeof t === 'string' ? Date.parse(t) : Number(t)
    if (!Number.isFinite(ms)) continue
    times.push(ms)
    if (ve == null || vn == null) { speedKn.push(null); setDeg.push(null); continue }
    speedKn.push(speedKnOf(ve as number, vn as number))
    setDeg.push(setDegOf(ve as number, vn as number))
  }
  if (!times.length) return null
  return {
    times,
    speedKn,
    setDeg,
    cell: { lat: cell.lat, lon: cell.lon },
    cellOffsetKm: distanceKm(reqLat, reqLon, cell.lat, cell.lon),
  }
}

/**
 * Resolve the cell for a position. Two small window requests, and the answer is
 * static for a given position, so a caller may cache it indefinitely.
 *
 * `half` is in cells: 12 covers about 6 km each way, which at this coast reaches
 * the next channel. Widening it does not help a point in a lake.
 */
export async function resolveCell(
  lat: number, lon: number, fetchImpl: typeof fetch = fetch, half = 12,
): Promise<SalishCell | null> {
  if (!inSalishSea(lat, lon)) return null
  const { gy, gx } = gridGuess(lat, lon)
  const sel = windowSel(gy, gx, half)
  try {
    const [geoRes, curRes] = await Promise.all([
      fetchImpl(geoWindowUrl(sel)),
      fetchImpl(currentWindowUrl(sel)),
    ])
    if (!geoRes.ok || !curRes.ok) return null
    return pickCell(await geoRes.json(), await curRes.json(), lat, lon)
  } catch {
    return null
  }
}

/**
 * The current series at a position, or null when this source cannot serve it —
 * outside the domain, or inside it with no current cell within the window. Null
 * is a real answer here: the caller keeps whatever it already had rather than
 * being handed a global model's 0.5 kn.
 */
export async function fetchSalishSeaCurrent(
  q: { lat: number; lon: number },
  fetchImpl: typeof fetch = fetch,
): Promise<(CurrentSeries & { source: 'salishseacast'; localMaxKn: number; depthM: number | null }) | null> {
  const cell = await resolveCell(q.lat, q.lon, fetchImpl)
  if (!cell) return null
  try {
    const res = await fetchImpl(seriesUrl(cell.gy, cell.gx))
    if (!res.ok) return null
    const series = parseSeries(await res.json(), cell, q.lat, q.lon)
    if (!series) return null
    return { ...series, source: 'salishseacast', localMaxKn: cell.localMaxKn, depthM: cell.depthM }
  } catch {
    return null
  }
}
