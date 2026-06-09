// Open-Meteo model configs + fetch helpers.
//
// Ported from the v1.3 standalone weather tool (index.html — MODELS block,
// fetchSurfaceModel, fetchGFSPressureLevelData). The constants and the call
// shapes are kept identical so behaviour matches what users have today.
//
// All HTTP requests go straight from the browser to Open-Meteo — no SSA
// backend proxy. The verification feature (Phase 4) will introduce its own
// backend routes for storing scoring results.

export const MODELS = {
  AROME: {
    key: 'AROME', label: 'AROME', subtitle: 'Météo-France 1.5 km',
    color: '#2e7d32',
    endpoint: 'https://api.open-meteo.com/v1/meteofrance',
    modelParam: 'meteofrance_arome_france_hd',
    heights: [10, 20, 50, 100, 150, 200],
    tableCols: [10, 20, 50],
    upperHeight: 50,
  },
  ECMWF: {
    key: 'ECMWF', label: 'ECMWF', subtitle: 'IFS 9 km',
    color: '#1565c0',
    endpoint: 'https://api.open-meteo.com/v1/ecmwf',
    modelParam: null,
    heights: [10, 100, 200],
    tableCols: [10, 100, 200],
    upperHeight: 100,
    soundingLevels: [1000, 925, 850, 700, 600, 500],
  },
  ICON: {
    key: 'ICON', label: 'ICON', subtitle: 'DWD seamless',
    color: '#ad1457',
    endpoint: 'https://api.open-meteo.com/v1/dwd-icon',
    modelParam: 'icon_seamless',
    heights: [10, 80, 120, 180],
    tableCols: [10, 80, 180],
    upperHeight: 120,
    soundingLevels: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500],
  },
  // Comparison-only high-res / regional models (Phase 2 — fetched but
  // currently rendered only in the Model Comparison sub-tab).
  DMI: {
    key: 'DMI', label: 'DMI Harmonie', color: '#00838f',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'dmi_harmonie_arome_europe',
    heights: [10, 100],
  },
  ITALIA: {
    key: 'ITALIA', label: 'ItaliaMeteo', color: '#ef6c00',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'italia_meteo_arpae_icon_2i',
    heights: [10],
  },
  ARPEGE: {
    key: 'ARPEGE', label: 'ARPEGE', color: '#5d4037',
    endpoint: 'https://api.open-meteo.com/v1/meteofrance',
    modelParam: 'meteofrance_arpege_europe',
    heights: [10],
  },
}

// Models shown in the Forecast surface toggle (Phase 1).
export const MODEL_ORDER = ['AROME', 'ECMWF', 'ICON']
// All models fetched (Phase 2 Compare consumes the extras).
export const COMPARE_ORDER = ['AROME', 'ECMWF', 'ICON', 'DMI', 'ITALIA', 'ARPEGE']

// Quick sanity check: does this model's hourly payload have any wind_speed
// data at all? Open-Meteo returns the structure even when a model has no
// coverage at the requested point — every value is null. We use this to grey
// out unavailable models in the checkbox row.
export function hasValidSpeed(hourly) {
  if (!hourly || !hourly.time || !hourly.time.length) return false
  // Walk every wind_speed_* column; any single non-null sample = valid.
  for (const k of Object.keys(hourly)) {
    if (!k.startsWith('wind_speed_')) continue
    const arr = hourly[k]
    if (Array.isArray(arr) && arr.some((v) => v != null)) return true
  }
  return false
}

// Build an Open-Meteo URL for one surface model at one point.
// Mirrors fetchSurfaceModel() in index.html line 820.
function surfaceUrl(modelKey, latitude, longitude, timezone) {
  const m = MODELS[modelKey]
  const params = []
  for (const h of m.heights) {
    params.push(`wind_speed_${h}m`, `wind_direction_${h}m`)
  }
  if (m.soundingLevels) {
    for (const p of m.soundingLevels) {
      params.push(
        `temperature_${p}hPa`, `relative_humidity_${p}hPa`,
        `geopotential_height_${p}hPa`,
        `wind_speed_${p}hPa`, `wind_direction_${p}hPa`,
      )
    }
  }
  let url = `${m.endpoint}?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${params.join(',')}` +
    `&wind_speed_unit=kmh&timezone=${encodeURIComponent(timezone)}&forecast_days=2`
  if (m.modelParam) url += `&models=${m.modelParam}`
  return url
}

// Fetch one surface model at one point. Returns the Open-Meteo JSON envelope,
// or null if the response is missing / empty for this point. Never throws —
// network errors are logged + swallowed (matches the upstream tool).
export async function fetchSurfaceModel({ modelKey, latitude, longitude, timezone }) {
  try {
    const res = await fetch(surfaceUrl(modelKey, latitude, longitude, timezone))
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[weather] ${modelKey} HTTP ${res.status}`)
      return null
    }
    const data = await res.json()
    if (!hasValidSpeed(data.hourly)) {
      // eslint-disable-next-line no-console
      console.warn(`[weather] ${modelKey} no valid wind data at (${latitude}, ${longitude})`)
      return null
    }
    return data
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[weather] ${modelKey} fetch failed:`, err?.message || err)
    return null
  }
}

// GFS pressure-level fetch — drives the Skew-T (Phase 3) and the PBL chart
// (Phase 2). Always fetched alongside the surface models so we don't have a
// second round-trip when the user opens the Sounding sub-tab.
export const GFS_SOUNDING_LEVELS = [
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650,
  625, 600, 575, 550, 525, 500,
]
export async function fetchGFSPressureLevels({ latitude, longitude, timezone }) {
  const params = ['boundary_layer_height']
  for (const p of GFS_SOUNDING_LEVELS) {
    params.push(
      `temperature_${p}hPa`, `relative_humidity_${p}hPa`,
      `geopotential_height_${p}hPa`,
      `wind_speed_${p}hPa`, `wind_direction_${p}hPa`,
    )
  }
  const url = `https://api.open-meteo.com/v1/gfs?` +
    `latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${params.join(',')}` +
    `&wind_speed_unit=kmh&timezone=${encodeURIComponent(timezone)}&forecast_days=2`
  try {
    const res = await fetch(url)
    if (!res.ok) return { hourly: { time: [], boundary_layer_height: [] } }
    return await res.json()
  } catch {
    return { hourly: { time: [], boundary_layer_height: [] } }
  }
}

// Fetch every enabled surface model + GFS for one point. Returns a
// { surfaceByModel, gfs, elevation, coords } container matching the shape
// the upstream tool's `windData[locKey]` object expects.
export async function fetchAllForPoint({ latitude, longitude, timezone, enabledModels, onProgress }) {
  const surfaceByModel = {}
  for (const modelKey of COMPARE_ORDER) {
    if (!enabledModels[modelKey]) { surfaceByModel[modelKey] = null; continue }
    onProgress?.({ modelKey, phase: 'start' })
    // eslint-disable-next-line no-await-in-loop
    surfaceByModel[modelKey] = await fetchSurfaceModel({ modelKey, latitude, longitude, timezone })
    onProgress?.({ modelKey, phase: 'done' })
    // Be gentle on Open-Meteo's rate limit (matches the 300ms spacing in v1.3).
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300))
  }
  onProgress?.({ modelKey: 'GFS', phase: 'start' })
  const gfs = await fetchGFSPressureLevels({ latitude, longitude, timezone })
  onProgress?.({ modelKey: 'GFS', phase: 'done' })

  // Elevation: first model that returned it, else GFS's.
  let elevation = 0
  for (const k of COMPARE_ORDER) {
    if (surfaceByModel[k] && surfaceByModel[k].elevation != null) {
      elevation = surfaceByModel[k].elevation
      break
    }
  }
  if (!elevation && gfs && gfs.elevation != null) elevation = gfs.elevation

  return {
    coords: { latitude, longitude },
    surfaceByModel,
    gfs,
    elevation,
  }
}

// Pick the default active model for the surface toggle: first model in
// MODEL_ORDER that has data at any of the points we fetched.
export function pickDefaultActiveModel(allPoints) {
  for (const k of MODEL_ORDER) {
    if (allPoints.some((p) => p.surfaceByModel[k] && hasValidSpeed(p.surfaceByModel[k].hourly))) return k
  }
  return 'AROME'
}

// kmh → knots
export const kmhToKnots = (v) => (v == null ? null : v * 0.539957)

// Decimal degrees → DMS string. Used in the location cards.
export function decimalToDMS(decimal, isLongitude) {
  const abs = Math.abs(decimal)
  const deg = Math.floor(abs)
  const min = (abs - deg) * 60
  const hemi = isLongitude ? (decimal >= 0 ? 'E' : 'W') : (decimal >= 0 ? 'N' : 'S')
  const degStr = isLongitude ? String(deg).padStart(3, '0') : String(deg).padStart(2, '0')
  return `${degStr} ${min.toFixed(1)}${hemi}`
}

// Theoretical neutral marine log-wind profile. Roughness z₀=0.0002 m, von
// Kármán k=0.41. Returns altitude-speed pairs (1m–100m). Matches the
// formula in index.html line 591 (calculateTheoreticalSeaProfile).
export function calculateTheoreticalSeaProfile(windSpeed10mKmh) {
  const z0 = 0.0002, k = 0.41
  const uStar = (windSpeed10mKmh * k) / Math.log(10 / z0)
  const out = []
  for (let z = 10; z <= 100; z++) {
    const spd = (uStar / k) * Math.log(z / z0)
    out.push({ height: z, speed: spd > 0 ? spd : 0 })
  }
  return out
}

// Pressure → approximate altitude (m). Used to place pressure-level samples
// on the vertical profile chart's altitude axis. International Standard
// Atmosphere troposphere.
export function pressureToAltitude(pressureHpa) {
  const seaLevel = 1013.25
  const T0 = 288.15
  const L = 0.0065
  const Rd = 287.053
  const g = 9.80665
  return (T0 / L) * (1 - Math.pow(pressureHpa / seaLevel, (Rd * L) / g))
}

// 100 m wind-speed series for a given model. ICON publishes 80 m and 120 m
// natively; we interpolate at 100 m. Other models expose 100 m directly.
// Returns knots (or null if the model doesn't carry the needed levels).
export function speed100mSeries(hourly, modelKey) {
  if (!hourly) return null
  if (modelKey === 'ICON') {
    const a = hourly.wind_speed_80m
    const b = hourly.wind_speed_120m
    if (!a || !b) return null
    return a.map((v, i) => (v != null && b[i] != null) ? kmhToKnots((v + b[i]) / 2) : null)
  }
  return hourly.wind_speed_100m
    ? hourly.wind_speed_100m.map((v) => v != null ? kmhToKnots(v) : null)
    : null
}

// Wind speed at an arbitrary height (e.g. masthead), interpolated from a
// model's own height levels. Fits a curve through the 3 nearest available
// levels (Lagrange, in log-height space — wind shear is ~logarithmic near the
// surface, so this tracks the profile better than a straight line and is exact
// at the data points). Falls back to a 2-point log fit, or the single value,
// when fewer levels carry data. Returns km/h (same unit as the inputs) or null.
export function interpolateSpeedAtHeight(hourly, heights, targetH, idx) {
  if (!hourly || !heights || !heights.length || targetH == null) return null
  const pts = []
  for (const hgt of heights) {
    const v = hourly[`wind_speed_${hgt}m`]?.[idx]
    if (v != null && isFinite(v)) pts.push({ h: hgt, v })
  }
  if (!pts.length) return null
  if (pts.length === 1) return pts[0].v
  const lt = Math.log(Math.max(targetH, 1))
  // 3 nearest levels by distance in log-height
  pts.sort((a, b) => Math.abs(Math.log(a.h) - lt) - Math.abs(Math.log(b.h) - lt))
  const use = pts.slice(0, Math.min(3, pts.length)).sort((a, b) => a.h - b.h)
  const xs = use.map((p) => Math.log(p.h))
  const ys = use.map((p) => p.v)
  let result = 0
  for (let i = 0; i < xs.length; i++) {
    let term = ys[i]
    for (let j = 0; j < xs.length; j++) {
      if (j !== i) term *= (lt - xs[j]) / (xs[i] - xs[j])
    }
    result += term
  }
  return result > 0 ? result : 0
}


// ── Skew-T sounding sources (Phase 3) ────────────────────────────────────────
// Pressure levels each source publishes. GFS uses the dense 25 hPa ladder above;
// ICON / ECMWF expose the coarser sets Open-Meteo carries for those models.
export const ICON_SOUNDING_LEVELS  = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500]
export const ECMWF_SOUNDING_LEVELS = [1000, 925, 850, 700, 600, 500]

// Sounding source registry — mirrors SOUNDING_SOURCES in index.html. Each
// `hourly(point)` resolves the Open-Meteo payload that carries that source's
// pressure-level columns for a windData point.
export const SOUNDING_SOURCES = {
  GFS:   { label: 'GFS · 25 hPa', levels: GFS_SOUNDING_LEVELS,   hourly: (d) => d && d.gfs && d.gfs.hourly },
  ICON:  { label: 'ICON',         levels: ICON_SOUNDING_LEVELS,  hourly: (d) => d && d.surfaceByModel && d.surfaceByModel.ICON  && d.surfaceByModel.ICON.hourly },
  ECMWF: { label: 'ECMWF',        levels: ECMWF_SOUNDING_LEVELS, hourly: (d) => d && d.surfaceByModel && d.surfaceByModel.ECMWF && d.surfaceByModel.ECMWF.hourly },
}
export const SOUNDING_ORDER = ['GFS', 'ICON', 'ECMWF']

// Fetch a single user-picked sounding point. Lighter than fetchAllForPoint —
// only the sources the Skew-T can use (ICON + ECMWF surface upper-air, GFS
// pressure levels). Returns the same { coords, surfaceByModel, gfs, elevation }
// container shape so it slots straight into windData under the 'S' key.
// Mirrors fetchSoundingPoint() in index.html.
export async function fetchSoundingPoint({ latitude, longitude, timezone }) {
  const surfaceByModel = {}
  surfaceByModel.ICON  = await fetchSurfaceModel({ modelKey: 'ICON',  latitude, longitude, timezone })
  await new Promise((r) => setTimeout(r, 250))
  surfaceByModel.ECMWF = await fetchSurfaceModel({ modelKey: 'ECMWF', latitude, longitude, timezone })
  await new Promise((r) => setTimeout(r, 250))
  const gfs = await fetchGFSPressureLevels({ latitude, longitude, timezone })

  let elevation = 0
  for (const k of ['ICON', 'ECMWF']) {
    if (surfaceByModel[k] && surfaceByModel[k].elevation != null) { elevation = surfaceByModel[k].elevation; break }
  }
  if (!elevation && gfs && gfs.elevation != null) elevation = gfs.elevation

  return { coords: { latitude, longitude }, surfaceByModel, gfs, elevation }
}
