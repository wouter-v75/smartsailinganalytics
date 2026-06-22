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
  // mosModel = the Open-Meteo id the MOS correction was trained on
  // (wind-verification). Exact match for AROME/ARPEGE/ITALIA; mosApprox marks
  // models where the tool's variant differs slightly from the trained one
  // (tool ICON = icon_seamless vs trained icon_eu; tool ECMWF default vs
  // ecmwf_ifs025) — the correction is applied but flagged approximate.
  AROME: {
    key: 'AROME', label: 'AROME', subtitle: 'Météo-France 1.5 km',
    color: '#2e7d32',
    endpoint: 'https://api.open-meteo.com/v1/meteofrance',
    modelParam: 'meteofrance_arome_france_hd',
    metaModel: 'meteofrance_arome_france_hd',
    mosModel: 'meteofrance_arome_france_hd',
    fieldGrid: 16,                 // high-res wind-field sampling (1.5 km model)
    heights: [10, 20, 50, 100, 150, 200],
    tableCols: [10, 20, 50],
    upperHeight: 50,
  },
  ECMWF: {
    key: 'ECMWF', label: 'ECMWF', subtitle: 'IFS 9 km',
    color: '#1565c0',
    endpoint: 'https://api.open-meteo.com/v1/ecmwf',
    modelParam: null,
    metaModel: 'ecmwf_ifs025',
    mosModel: 'ecmwf_ifs025', mosApprox: true,
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
    // 'icon_seamless' is a virtual blend with no single run cycle; report
    // freshness from the ICON-EU member (the one the MOS correction uses).
    metaModel: 'dwd_icon_eu',
    mosModel: 'icon_eu', mosApprox: true,
    fieldGrid: 16,                 // high-res wind-field sampling (ICON-D2 ~2 km)
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
    metaModel: 'dmi_harmonie_arome_europe',
    fieldGrid: 16,                 // high-res wind-field sampling (~2 km model)
    heights: [10, 100],
  },
  ITALIA: {
    key: 'ITALIA', label: 'ItaliaMeteo', subtitle: 'ARPAE ICON-2I 2 km', color: '#ef6c00',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'italia_meteo_arpae_icon_2i',
    metaModel: 'italia_meteo_arpae_icon_2i',
    mosModel: 'italia_meteo_arpae_icon_2i',
    fieldGrid: 16,                 // high-res wind-field sampling (ICON-2I 2 km)
    heights: [10],
    tableCols: [10],
  },
  ARPEGE: {
    key: 'ARPEGE', label: 'ARPEGE', subtitle: 'Météo-France 11 km', color: '#5d4037',
    endpoint: 'https://api.open-meteo.com/v1/meteofrance',
    modelParam: 'meteofrance_arpege_europe',
    metaModel: 'meteofrance_arpege_europe',
    mosModel: 'meteofrance_arpege_europe',
    heights: [10, 20, 50, 80, 100],
    tableCols: [10, 50, 100],
    upperHeight: 100,
  },
  // Self-hosted ICON-LAM 2 km (Regatta project). NOT Open-Meteo — each venue
  // publishes a ~2 km GRID over its racing box to Bunny; fetchBunnyModel snaps
  // a clicked point to the nearest grid cell (so 3 clicks -> 3 resolved points),
  // and greys out for clicks outside every venue box. 30 m is a NATIVE model
  // output here, so its column is exact, not interpolated.
  ICONRACE: {
    key: 'ICONRACE', label: 'SSA-Race 2 km', subtitle: 'self-hosted ICON-LAM 2 km', color: '#e11d48',
    // If NEXT_PUBLIC_ICONRACE_BASE is set (a public pull-zone fronting the
    // smartsailinganalytics storage zone, CORS enabled) we fetch from it
    // directly; otherwise (default) we go through the app's own same-origin
    // storage proxy /api/bunny/storage — no pull zone, no CORS needed.
    bunnyBase: (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_ICONRACE_BASE) || null,
    // Venue boxes (must match each domain's venues.csv: half = half-width in deg).
    // Grid lives at  <bunnyBase>/<domain>/<name>/grid.json .
    // half 0.25° ≈ a 30 nm (N-S) box — must match each domain's venues.csv. The 2 km
    // parent domains are large, so 0.25° sits well inside them, clear of the boundary
    // relaxation zone.
    venues: [
      { name: 'la_ciotat', domain: 'riviera_2km', clon: 5.61, clat: 43.16, half: 0.25 },
      { name: 'st_tropez', domain: 'riviera_2km', clon: 6.678, clat: 43.275, half: 0.25 },
      // La Spezia (early training, 22-26 June) — points grey out until its grid publishes:
      { name: 'la_spezia', domain: 'la_spezia_2km', clon: 9.85, clat: 44.05, half: 0.25 },
      // Porto Cervo (Maxi Worlds, 1-12 Sept) — points grey out until its grid publishes:
      { name: 'porto_cervo', domain: 'porto_cervo_2km', clon: 9.55, clat: 41.13, half: 0.25 },
    ],
    heights: [10, 30, 50, 100, 180],
    tableCols: [10, 30, 50, 100, 180],
    upperHeight: 100,
    // MOS: reuse the ICON-EU verification-based correction as a proxy (flagged
    // approximate) so a MOS 30 m column shows for learning/comparison. Replace
    // with an Icon-Race-specific correction once enough regatta verification
    // (wv_model_score) exists for it.
    mosModel: 'icon_eu', mosApprox: true,
  },
  // SSA-Race 1 km — the nested 1 km inner (La Spezia first). Fetched from its own
  // grid.json under the la_spezia_1km domain path, so it sits next to the 2 km in
  // the picker / comparison and the resolution step is directly visible. Add more
  // venues here as their 1 km nests come online.
  ICONRACE_1KM: {
    key: 'ICONRACE_1KM', label: 'SSA-Race 1 km', subtitle: 'self-hosted nest 1 km', color: '#7c3aed',
    bunnyBase: (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_ICONRACE_BASE) || null,
    // half 0.25° ≈ 30 nm (N-S). The 1 km nest is ±0.45° around the centre with a
    // 12-cell (grf 4 + nudge 8 ≈ 12 km) boundary buffer; a 0.25° box leaves ~0.20°
    // (16-22 cells) to the nest edge, so it stays clear of the boundary instabilities.
    venues: [
      { name: 'la_spezia', domain: 'la_spezia_1km', clon: 9.85, clat: 44.05, half: 0.25 },
    ],
    heights: [10, 30, 50, 100, 180],
    tableCols: [10, 30, 50, 100, 180],
    upperHeight: 100,
    mosModel: 'icon_eu', mosApprox: true,
  },
  // Tidal currents (CMEMS NWS FOAM-AMM15, ~1.5 km, tide-coupled) — a SELECTABLE
  // FIELD in the wind player (default off). Not a wind model: no endpoint / heights
  // / MOS. The overlay reads its own field JSON via fetchCurrentField, gated on
  // point 1 being inside the English Channel coverage.
  CURRENTS: {
    key: 'CURRENTS', label: 'Currents (AMM15)', subtitle: 'tidal current — English Channel', color: '#38BDF8',
    bunnyBase: (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_ICONRACE_BASE) || null,
    isCurrent: true, heights: [],
  },
  // Boundary-layer height (hpbl) — a SELECTABLE SCALAR FIELD in the wind player
  // (default off). Read from the SSA-Race grid.json's per-cell `hpbl` series, so
  // it is available wherever an SSA-Race venue covers point 1. Not a wind model:
  // no endpoint / heights / MOS; renders as a coloured shading overlay (no arrows).
  HPBL: {
    key: 'HPBL', label: 'Boundary layer', subtitle: 'PBL height — SSA-Race', color: '#A855F7',
    isHpbl: true, heights: [],
  },
}

// Models shown in the Forecast surface toggle. ARPEGE/ITALIA included so their
// venue MOS corrections (e.g. ARPEGE sector at Porto Cervo) surface here too.
export const MODEL_ORDER = ['AROME', 'ECMWF', 'ICON', 'ICONRACE', 'ICONRACE_1KM', 'ARPEGE', 'ITALIA']
// All models fetched (Phase 2 Compare consumes the extras).
export const COMPARE_ORDER = ['AROME', 'ECMWF', 'ICON', 'ICONRACE', 'ICONRACE_1KM', 'DMI', 'ITALIA', 'ARPEGE']

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

// Module-level cache of fetched venue grids (keyed by URL) so the three
// clicked points don't each re-download the same venue grid.
const _iconRaceGrids = new Map()
function getIconRaceGrid(url) {
  if (_iconRaceGrids.has(url)) return _iconRaceGrids.get(url)
  const p = (async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) { console.warn(`[weather] ICONRACE grid HTTP ${res.status}`); return null }
      return await res.json()
    } catch (err) {
      console.warn('[weather] ICONRACE grid fetch failed:', err?.message || err); return null
    }
  })()
  _iconRaceGrids.set(url, p)
  return p
}

// Self-hosted Icon-Race fetch. Finds the venue whose racing box contains the
// clicked point, fetches that venue's ~2 km grid (cached), snaps to the nearest
// cell, and returns it as an Open-Meteo-shaped envelope. Null when the click is
// outside every venue box (model greys out, like an OM model with no coverage).
async function fetchBunnyModel(m, latitude, longitude) {
  const v = (m.venues || []).find(
    (ven) => Math.abs(latitude - ven.clat) <= ven.half && Math.abs(longitude - ven.clon) <= ven.half
  )
  if (!v) return null
  const gf = m.gridFile || 'grid.json'                    // per-model grid file (default grid.json)
  const path = `icon-race/${v.domain}/${v.name}/${gf}`
  const url = m.bunnyBase
    ? `${m.bunnyBase}/${v.domain}/${v.name}/${gf}`         // public CDN pull-zone
    : `/api/bunny/storage?key=${encodeURIComponent(path)}` // same-origin proxy (default)
  const grid = await getIconRaceGrid(url)
  if (!grid || !Array.isArray(grid.cells) || !grid.cells.length) return null
  // nearest cell (equirectangular distance is plenty over a ~30 km box)
  const cosLat = Math.cos((latitude * Math.PI) / 180)
  let best = null
  for (const c of grid.cells) {
    const dLat = latitude - c.lat, dLon = (longitude - c.lon) * cosLat
    const d2 = dLat * dLat + dLon * dLon
    if (!best || d2 < best.d2) best = { c, d2 }
  }
  const c = best.c
  const hourly = { time: grid.time }
  for (const h of grid.heights) {
    hourly[`wind_speed_${h}m`] = c.spd?.[String(h)] ?? null
    hourly[`wind_direction_${h}m`] = c.dir?.[String(h)] ?? null
  }
  // Convective boundary-layer height (m), if this cycle carries it. Flows through
  // the SAME `boundary_layer_height` column the GFS PBL chart already reads, so it
  // surfaces in the forecast + comparison views with no further plumbing.
  if (Array.isArray(c.hpbl)) hourly.boundary_layer_height = c.hpbl
  return hasValidSpeed(hourly) ? { latitude: c.lat, longitude: c.lon, elevation: 0, hourly } : null
}

// Full Icon-Race grid for the venue box containing (lat,lon) — used by the
// animated wind-field overlay (which needs every cell, not just the nearest).
// Returns { grid:{time,heights,cells:[{lat,lon,spd,dir}]}, venue } or null.
export async function iconRaceGridForPoint(latitude, longitude, modelKey = 'ICONRACE') {
  const m = MODELS[modelKey] || MODELS.ICONRACE
  const v = (m.venues || []).find(
    (ven) => Math.abs(latitude - ven.clat) <= ven.half && Math.abs(longitude - ven.clon) <= ven.half
  )
  if (!v) return null
  const gf = m.gridFile || 'grid.json'
  const path = `icon-race/${v.domain}/${v.name}/${gf}`
  const url = m.bunnyBase
    ? `${m.bunnyBase}/${v.domain}/${v.name}/${gf}`
    : `/api/bunny/storage?key=${encodeURIComponent(path)}`
  const grid = await getIconRaceGrid(url)
  if (!grid || !Array.isArray(grid.cells) || !grid.cells.length) return null
  return { grid, venue: v }
}

// ── Model freshness (Weather ▸ Admin "Model updates" table) ─────────────────
// Open-Meteo publishes a tiny per-model meta.json with the latest run's
// initialisation time, when it became available, and the run cadence. We read
// it client-side (same origin policy as the forecast calls) to show, per model:
// which cycle (00/06/12/18…), when it landed, and the next run + ETA.
const META_BASE = 'https://api.open-meteo.com/data'
const _metaCache = new Map() // metaModel -> { at, promise }

export async function fetchModelMeta(metaModel) {
  if (!metaModel) return null
  const c = _metaCache.get(metaModel)
  // cache for 60 s so a 1-min table refresh doesn't hammer the endpoint
  if (c && Date.now() - c.at < 60_000) return c.promise
  const promise = (async () => {
    try {
      const res = await fetch(`${META_BASE}/${metaModel}/static/meta.json`, { cache: 'no-store' })
      if (!res.ok) return null
      const j = await res.json()
      const init = j.last_run_initialisation_time ?? null // unix seconds, UTC
      const available = j.last_run_availability_time ?? j.last_run_modification_time ?? null
      const interval = j.update_interval_seconds ?? null   // seconds between runs
      return {
        initSec: init,
        availableSec: available,
        intervalSec: interval,
        nextSec: (init != null && interval != null) ? init + interval : null,
      }
    } catch {
      return null
    }
  })()
  _metaCache.set(metaModel, { at: Date.now(), promise })
  return promise
}

// Live Icon-Race pipeline status, published once a minute by the box
// (scripts/publish_status.sh -> www/icon-race/status.json). Same delivery path
// as the venue grids: public pull-zone if configured, else the same-origin
// storage proxy. Returns the parsed status object or null.
export async function fetchIconRaceStatus() {
  const base = MODELS.ICONRACE.bunnyBase
  const url = base
    ? `${base}/status.json`
    : `/api/bunny/storage?key=${encodeURIComponent('icon-race/status.json')}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// [start, end] Dates for a fixed local-time forecast window: today 00:00 local
// to +`days` 00:00. Used to PIN the comparison-chart x-axes so a stray earlier
// cycle (e.g. an old Icon-Race grid spanning yesterday) can't widen the view —
// the window is always "00 today → 00 +N days" regardless of the data extent.
export function localForecastWindow(days = 2) {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + days)
  return [start, end]
}

// Init-cycle tag like "00z" / "06z" from a unix-seconds run-initialisation time.
export function cycleTagFromSec(sec) {
  if (sec == null) return ''
  return `${String(new Date(sec * 1000).getUTCHours()).padStart(2, '0')}z`
}

// Latest run cycle (UTC init hour) for every downloaded model + the self-hosted
// Icon-Race. Returns e.g. { AROME:'00z', ICON:'06z', ICONRACE:'00z' }. Models
// whose meta is unavailable are simply omitted (their label stays plain).
export async function loadAllModelCycles() {
  const out = {}
  const omKeys = COMPARE_ORDER.filter((k) => !k.startsWith('ICONRACE'))
  await Promise.all(omKeys.map(async (k) => {
    const meta = await fetchModelMeta(MODELS[k]?.metaModel)
    if (meta && meta.initSec != null) out[k] = cycleTagFromSec(meta.initSec)
  }))
  try {
    const s = await fetchIconRaceStatus()
    if (s) {
      const init = (s.init != null && String(s.init) !== '')
        ? `${String(s.init).padStart(2, '0')}z`
        : (typeof s.cycle === 'string' && s.cycle.length >= 10 ? `${s.cycle.slice(8, 10)}z` : '')
      if (init) { out.ICONRACE = init; out.ICONRACE_1KM = init }  // self-hosted models share the 00z cycle
    }
  } catch { /* leave label plain */ }
  return out
}

// "AROME" + cycles.AROME -> "AROME 00z" (plain label when no cycle is known).
export function labelWithCycle(modelKey, cycles) {
  const base = MODELS[modelKey]?.label || modelKey
  const tag = cycles && cycles[modelKey]
  return tag ? `${base} ${tag}` : base
}

// Shallow-clone a MODELS entry with the cycle folded into its `label`, so child
// components that render `model.label` show the cycle with no further changes.
export function withCycleLabel(model, tag) {
  if (!model) return model
  return tag ? { ...model, label: `${model.label} ${tag}` } : model
}

// Fetch one surface model at one point -> the Open-Meteo hourly envelope (or
// null if missing/empty). Icon-Race delegates to fetchBunnyModel above.

export async function fetchSurfaceModel({ modelKey, latitude, longitude, timezone }) {
  const cfg = MODELS[modelKey]
  if (cfg && cfg.bunnyBase) return fetchBunnyModel(cfg, latitude, longitude)
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
  for (const k of COMPARE_ORDER) if (!enabledModels[k]) surfaceByModel[k] = null
  const enabled = COMPARE_ORDER.filter((k) => enabledModels[k])
  // SSA-Race / self-hosted (Bunny) models are NOT Open-Meteo — load them FIRST and
  // in parallel so the ICON data is always there even when Open-Meteo is throttled.
  const ssaKeys = enabled.filter((k) => MODELS[k]?.bunnyBase)
  const omKeys = enabled.filter((k) => !MODELS[k]?.bunnyBase)
  await Promise.all(ssaKeys.map(async (modelKey) => {
    onProgress?.({ modelKey, phase: 'start' })
    surfaceByModel[modelKey] = await fetchSurfaceModel({ modelKey, latitude, longitude, timezone })
    onProgress?.({ modelKey, phase: 'done' })
  }))
  // Then the Open-Meteo models, sequential + spaced to be gentle on the rate limit.
  for (const modelKey of omKeys) {
    onProgress?.({ modelKey, phase: 'start' })
    // eslint-disable-next-line no-await-in-loop
    surfaceByModel[modelKey] = await fetchSurfaceModel({ modelKey, latitude, longitude, timezone })
    onProgress?.({ modelKey, phase: 'done' })
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
// SSA-Race low-level sounding: standard pressure levels 1000-700 hPa (within ~3 km),
// computed on the box from the _pbl height profile and read from the point's
// `ssaSounding` field (attached on demand in SoundingView via fetchIconRaceSounding).
// Dense below 900 hPa (~12 hPa) to use the maximum low-level detail of the SSA-Race
// _pbl ladder; 25 hPa from 900 to 700. MUST match LEVELS in scripts/sounding_from_tab.py.
export const SSARACE_SOUNDING_LEVELS = [1010, 998, 986, 974, 962, 950, 938, 925, 912, 900,
  875, 850, 825, 800, 775, 750, 725, 700]

export const SOUNDING_SOURCES = {
  SSARACE: { label: 'SSA-Race 2 km', levels: SSARACE_SOUNDING_LEVELS, lowLevel: true, hourly: (d) => d && d.ssaSounding },
  GFS:   { label: 'GFS · 25 hPa', levels: GFS_SOUNDING_LEVELS,   hourly: (d) => d && d.gfs && d.gfs.hourly },
  ICON:  { label: 'ICON',         levels: ICON_SOUNDING_LEVELS,  hourly: (d) => d && d.surfaceByModel && d.surfaceByModel.ICON  && d.surfaceByModel.ICON.hourly },
  ECMWF: { label: 'ECMWF',        levels: ECMWF_SOUNDING_LEVELS, hourly: (d) => d && d.surfaceByModel && d.surfaceByModel.ECMWF && d.surfaceByModel.ECMWF.hourly },
}
export const SOUNDING_ORDER = ['SSARACE', 'GFS', 'ICON', 'ECMWF']

// SSA-Race per-venue sounding.json (published next to grid.json). Snaps the point
// to the nearest sounding cell and returns its Open-Meteo-shaped `hourly` (pressure
// levels), so the Skew-T treats SSA-Race exactly like ICON/ECMWF. Cached per venue.
const _iconRaceSoundings = new Map()
function getIconRaceSounding(url) {
  if (_iconRaceSoundings.has(url)) return _iconRaceSoundings.get(url)
  const p = (async () => {
    try { const r = await fetch(url); if (!r.ok) return null; return await r.json() } catch { return null }
  })()
  _iconRaceSoundings.set(url, p)
  return p
}
export async function fetchIconRaceSounding({ latitude, longitude, modelKey = 'ICONRACE' }) {
  const m = MODELS[modelKey] || MODELS.ICONRACE
  const v = (m.venues || []).find(
    (ven) => Math.abs(latitude - ven.clat) <= ven.half && Math.abs(longitude - ven.clon) <= ven.half
  )
  if (!v) return null
  const path = `icon-race/${v.domain}/${v.name}/sounding.json`
  const url = m.bunnyBase
    ? `${m.bunnyBase}/${v.domain}/${v.name}/sounding.json`
    : `/api/bunny/storage?key=${encodeURIComponent(path)}`
  const snd = await getIconRaceSounding(url)
  if (!snd || !Array.isArray(snd.cells) || !snd.cells.length) return null
  const cosLat = Math.cos((latitude * Math.PI) / 180)
  let best = null
  for (const c of snd.cells) {
    const dLat = latitude - c.lat; const dLon = (longitude - c.lon) * cosLat
    const d2 = dLat * dLat + dLon * dLon
    if (!best || d2 < best.d2) best = { c, d2 }
  }
  return best.c.hourly
}

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
