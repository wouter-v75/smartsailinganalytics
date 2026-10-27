// Open-Meteo model configs + fetch helpers.
//
// Ported from the v1.3 standalone weather tool (index.html — MODELS block,
// fetchSurfaceModel, fetchGFSPressureLevelData). The constants and the call
// shapes are kept identical so behaviour matches what users have today.
//
// All HTTP requests go straight from the browser to Open-Meteo — no SSA
// backend proxy. The verification feature (Phase 4) will introduce its own
// backend routes for storing scoring results.

import { marineSstUrl, parseMarineSst } from '../../lib/seaTemp'
import { venueAt } from '../../lib/venues'

// Coarse coverage box for the North-American models (USA / Canada / Caribbean).
// Region-gates them (see `coverage` below): fetched + shown only for clicked
// points inside it, hidden in Europe. Deliberately generous — a point inside the
// box but outside a model's true native domain (e.g. HRRR/NAM are CONUS-only, so
// a Caribbean or far-northern point) simply greys out there like any model with
// no data at the click, so the box needn't trace each domain edge exactly.
const NORTH_AMERICA = { latMin: 5, latMax: 75, lonMin: -172, lonMax: -50 }

// REGIONAL EUROPEAN MODELS, boxed 2026-10-27 because they were not boxed at all
// and were therefore offered at EVERY venue. At the San Juan Islands the model
// list showed AROME, which has no data within thousands of miles — the picker
// offered a model that could only ever fail.
//
// Each box is the envelope of a live bisection at lat 45 / lon 10, with the
// venues checked individually. These are rotated or Lambert domains, so the true
// edge is ragged and a rectangle over-claims at the corners; a point inside the
// box but outside the domain still just returns "no data", which is the same
// behaviour as before. What the box buys is that the four venues in the Americas
// never see a European-only model again.
//
//   AROME France HD   west -12 IN / -15 out   east 16 IN / 20 out
//                     north 52 IN / 56 out    south 40 IN / 37 out
//   ARPEGE Europe     west -30 IN / -35 out   east 40 IN
//                     north 72 IN             south 22 IN / 18 out
//   ICON-2I (Italy)   west  2 out (!)         east 20 IN / 30 out
//                     north 48 IN / 50 out    south 34 IN / 30 out
//   DMI HARMONIE      west -25 IN / -30 out   east 20 IN / 30 out
//                     north 66 IN / 72 out    south 40 IN / 37 out
//
// Venue checks, all four models: Porto Cervo, St Tropez and Sorrento IN for all;
// Solent IN for AROME/ARPEGE/DMI and OUT for ICON-2I; Oslofjord IN for
// ARPEGE/DMI only; San Juan and Long Beach OUT for all four.
const AROME_FR = { latMin: 38.5, latMax: 54, lonMin: -13.5, lonMax: 18 }
const ARPEGE_EU = { latMin: 20, latMax: 73, lonMin: -32, lonMax: 42 }
const ICON_2I_IT = { latMin: 33, latMax: 49.5, lonMin: 3, lonMax: 22 }
const DMI_EU = { latMin: 38.5, latMax: 69, lonMin: -27, lonMax: 25 }

// Coarse coverage box for MET Norway's Nordic model (the forecast behind yr.no).
// Probed 2026-09-11 by bisection: data from ~52.7°N to ~73.8°N, and from ~-1°E
// (at 60°N) / ~-7°E (at 68°N) to ~31°E (at 60°N) / ~39°E (at 70°N). The domain
// is a Lambert conformal grid centred on 63°N 15°E, so its true edge is ragged;
// this box traces the outer envelope. Every Norwegian venue is inside, Nordkapp
// included. The Mediterranean and the Solent are outside, so the model is never
// fetched at Porto Cervo / La Ciotat / Cowes.
const NORDIC = { latMin: 52.5, latMax: 74.0, lonMin: -7.0, lonMax: 39.0 }

export const MODELS = {
  // mosModel = the Open-Meteo id the MOS correction was trained on
  // (wind-verification). Exact match for AROME/ARPEGE/ITALIA; mosApprox marks
  // models where the tool's variant differs slightly from the trained one
  // (tool ICON = icon_seamless vs trained icon_eu; tool ECMWF = ecmwf_ifs 9 km
  // HRES vs trained ecmwf_ifs025) — the correction is applied but flagged approximate.
  //
  // `coverage` (optional) region-gates a model: it is fetched + shown ONLY for
  // clicked points inside the box, and hidden elsewhere (used for the
  // North-American models so they never appear in Europe). Models without a box
  // are global — fetched everywhere and auto-greyed where they have no data.
  AROME: {
    key: 'AROME', label: 'AROME', subtitle: 'Météo-France 1.5 km',
    color: '#2e7d32',
    endpoint: 'https://api.open-meteo.com/v1/meteofrance',
    modelParam: 'meteofrance_arome_france_hd',
    coverage: AROME_FR,
    metaModel: 'meteofrance_arome_france_hd',
    mosModel: 'meteofrance_arome_france_hd',
    fieldGrid: 16,                 // high-res wind-field sampling (1.5 km model)
    heights: [10, 20, 50, 100, 150, 200],
    tableCols: [10, 20, 50],
    upperHeight: 50,
  },
  ECMWF: {
    key: 'ECMWF', label: 'ECMWF', subtitle: 'IFS HRES 9 km',
    color: '#1565c0',
    endpoint: 'https://api.open-meteo.com/v1/ecmwf',
    // ecmwf_ifs = the native 9 km HRES on the O1280 reduced-Gaussian grid (was the
    // 0.25° default before). Global, so no coverage box. Live probe (2026-07-21):
    // winds at 10/80/100/120/180/200 m all present, but ALL pressure levels null —
    // the 9 km HRES on Open-Meteo carries no pressure data. So SURFACE winds use
    // this 9 km model, while the Skew-T ECMWF sounding pulls pressure levels from
    // the 0.25° ecmwf_ifs025 separately (fetchECMWFPressureLevels -> ecmwfSounding).
    modelParam: 'ecmwf_ifs',
    metaModel: 'ecmwf_ifs',
    mosModel: 'ecmwf_ifs025', mosApprox: true,
    heights: [10, 80, 100, 120, 180, 200],
    tableCols: [10, 100, 200],
    upperHeight: 100,
    // Horizon: 9 km HRES (ecmwf_ifs) for the first 4 days, then stitch the 0.25°
    // open-data IFS (ecmwf_ifs025) out to +10 days — 14 total. fetchSurfaceModel
    // and fetchWindField fetch both and splice by hour at the 4-day seam.
    forecastDays: 4,
    extend: { modelParam: 'ecmwf_ifs025', forecastDays: 14 },
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
    coverage: DMI_EU,
    metaModel: 'dmi_harmonie_arome_europe',
    fieldGrid: 16,                 // high-res wind-field sampling (~2 km model)
    heights: [10, 100],
  },
  ITALIA: {
    key: 'ITALIA', label: 'ItaliaMeteo', subtitle: 'ARPAE ICON-2I 2 km', color: '#ef6c00',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'italia_meteo_arpae_icon_2i',
    coverage: ICON_2I_IT,
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
    coverage: ARPEGE_EU,
    metaModel: 'meteofrance_arpege_europe',
    mosModel: 'meteofrance_arpege_europe',
    heights: [10, 20, 50, 80, 100],
    tableCols: [10, 50, 100],
    upperHeight: 100,
    forecastDays: 4,   // ARPEGE Europe on Open-Meteo runs to 4 days
  },
  // MET Norway "MET Nordic" — the operational forecast behind yr.no. 1 km,
  // post-processed against observations (hence Open-Meteo's `_pp` data store),
  // updated HOURLY, out to about +58 h. For a team racing in Norway this is the
  // local high-res model, the way AROME is in France.
  //
  // REGION-GATED, not "fetched everywhere and greyed out" like DMI: outside its
  // domain Open-Meteo answers HTTP 200 with `"latitude":nan`, which is not JSON,
  // so a stray fetch cannot even be parsed. The NORDIC box keeps it off the
  // Mediterranean venues entirely.
  //
  // 10 m ONLY. Probed: wind_speed_10m / direction / gusts, 2 m temperature,
  // pressure and cloud are served; 80/100/120 m wind, boundary-layer height and
  // every pressure level come back all-null. Asking for them would make the
  // payload look populated while the columns are empty.
  //
  // metaModel differs from modelParam on purpose: `metno_nordic/static/meta.json`
  // is HTTP 500; the run times live under `metno_nordic_pp`.
  //
  // mosModel is an EXACT match — the only one here besides AROME, ARPEGE and
  // ITALIA. ICON and ECMWF both carry mosApprox because the model the tool
  // fetches is not the one the correction was trained on (icon_seamless vs
  // icon_eu, 9 km HRES vs ifs025); here the tool fetches `metno_nordic` and
  // that is the id to train against, so there is nothing approximate.
  //
  // INERT UNTIL A NORWEGIAN VENUE IS FITTED, which is the point of naming it
  // now. Every MOS path is gated on correctionInfo() finding coefficients for
  // (venue, mosModel), and SPECS holds only Sorrento, Porto Cervo and
  // St Tropez — all outside the NORDIC box, so this model is never even
  // fetched there. Naming the id changes no behaviour today; it records what
  // the fit has to be trained on, so the answer is not re-derived later.
  //
  // Its archived forecasts begin about DEC 2022 — probed 2026-10-26 at Færder:
  // 1 Nov 2022 is all-null, 1 Dec 2022 is complete. That is the training
  // window's hard floor, and it is deeper than icon_eu's and ecmwf_ifs025's
  // (which start somewhere in 2022-23 and 2023-24 respectively). The Frost
  // observation backfill is what supplies the other side of the pair.
  METNO: {
    key: 'METNO', label: 'MET Norway', subtitle: 'MET Nordic 1 km · yr.no', color: '#283593',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'metno_nordic',
    metaModel: 'metno_nordic_pp',
    mosModel: 'metno_nordic',
    coverage: NORDIC,
    fieldGrid: 16,                 // high-res wind-field sampling (1 km model)
    heights: [10],
    tableCols: [10],
    forecastDays: 3,               // data runs to ~+58 h; the tail is null, which is fine
  },
  // ── North-American models (region-gated to NORTH_AMERICA) ──────────────────
  // Fetched + shown ONLY when a clicked point is in the Americas box; hidden
  // entirely in Europe (unlike the European regionals, which are global + auto-
  // greyed). ECMWF stays global. Endpoint is the generic /v1/forecast (same as
  // DMI/ITALIA) so the models= id is accepted regardless of family.
  HRRR: {
    key: 'HRRR', label: 'HRRR', subtitle: 'NOAA HRRR 3 km', color: '#d32f2f',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'ncep_hrrr_conus',
    metaModel: 'ncep_hrrr_conus',
    coverage: NORTH_AMERICA,
    fieldGrid: 16,                 // high-res wind-field sampling (3 km rapid-refresh)
    heights: [10, 80],
    tableCols: [10, 80],
    upperHeight: 80,
  },
  // CANADIAN HRDPS, 2.5 km — and at the San Juan Islands it is the best-fitting
  // model available, for a reason worth stating: its level ladder is
  // 10/40/80/120 m. Every other model here jumps 10 -> 80, so a 30 m masthead is
  // EXTRAPOLATED from a two-point fit that does not bracket it; HRDPS brackets it
  // between 10 and 40, which turns wind30()'s power law into an interpolation.
  //
  // Corroboration from the people who model this water: SalishSeaCast (UBC) forces
  // its own NEMO ocean model with HRDPS — see lib/salishSeaCurrents.ts.
  //
  // COVERAGE, probed by bisection 2026-10-27 (the domain is a rotated grid, so its
  // true edge is ragged and this is the outer envelope): IN at 42N, 70N, and at
  // lon -134, -126, -122, -110, -95, -60, -52 on lat 49; OUT at 41N, 71N, -138
  // and -142. So Canada plus the northern US: San Juan and Seattle are in, Long
  // Beach (33.7N) and every European venue are out, and the western edge is some
  // 700 nm clear of the San Juans.
  //
  // NO metaModel: api.open-meteo.com/data/gem_hrdps_continental/static/meta.json
  // is 404, so there is no freshness feed to read. fetchModelMeta() returns null
  // for an absent key, which is the honest outcome — a wrong key would too, but
  // silently.
  HRDPS: {
    key: 'HRDPS', label: 'HRDPS', subtitle: 'ECCC 2.5 km', color: '#4527a0',
    endpoint: 'https://api.open-meteo.com/v1/gem',
    modelParam: 'gem_hrdps_continental',
    coverage: { latMin: 42, latMax: 70, lonMin: -138, lonMax: -52 },
    fieldGrid: 16,                 // high-res wind-field sampling (2.5 km)
    heights: [10, 40, 80, 120],
    tableCols: [10, 40, 80],
    upperHeight: 120,
  },
  NAM: {
    key: 'NAM', label: 'NAM', subtitle: 'NOAA NAM 12 km', color: '#f9a825',
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    modelParam: 'ncep_nam_conus',
    metaModel: 'ncep_nam_conus',
    coverage: NORTH_AMERICA,
    heights: [10, 80],
    tableCols: [10, 80],
    upperHeight: 80,
  },
  // (GEM HRDPS Continental 2.5 km was evaluated but dropped: a live probe showed
  // its domain does not reach San Pedro — HTTP 400 "No data is available for this
  // location" — so it added no value for this venue.)
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
      // Solent / Cowes, Isle of Wight (UK) — own ICON-EU-driven 2 km parent. W lon is
      // negative. Points grey out until solent_2km's grid publishes:
      { name: 'solent', domain: 'solent_2km', clon: -1.30, clat: 50.76, half: 0.30 },
      // San Juan Islands, Washington. Same grid geometry, physics and vertical
      // levels as the Solent pair. NOT yet runnable: the box is driven by ICON-EU,
      // whose western edge is 23.5W, and this is 122.9W — it needs global driving
      // data first (docs/san-juan-islands-domain-2026-10.md).
      // Points grey out until san_juan_islands_2km's grid publishes:
      // half 0.55, widened 2026-10-27 from 0.30. The 2 km GRID spans
      // -124.094..-121.694 / 47.620..49.506, so 0.30 was publishing a box far
      // smaller than what the model already computes: its western edge sat in
      // Haro Strait, cutting off Victoria (-123.37) and the Strait of Juan de
      // Fuca entrance — which is upstream fetch for the prevailing westerly and
      // the first thing you want to see. 0.55 reaches -123.445, with ~0.65 deg
      // still between the box and the grid edge, i.e. far outside the
      // relaxation zone. Payload goes 900 -> 3,025 points, about 8 MB, which is
      // the size solent_1km already ships.
      { name: 'san_juan_islands', domain: 'san_juan_islands_2km', clon: -122.8946, clat: 48.5627, half: 0.55 },
      // La Spezia STOPPED 2026-06-27 (domain box removed; training window closed).
      // Porto Cervo (Maxi Worlds, 1-12 Sept) — points grey out until its grid publishes:
      { name: 'porto_cervo', domain: 'porto_cervo_2km', clon: 9.55, clat: 41.13, half: 0.40 },
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
  // SSA-Race 1 km — the nested 1 km inners off riviera_2km (La Spezia retired
  // 2026-06-27). Each venue has its OWN 1 km domain + grid.json. `half` matches
  // each domain's 1 km venues.csv racing box (la_ciotat 0.15°, st_tropez 0.23°);
  // the published box already sits inside the nest's relaxation buffer.
  // The 1 km nests serve the deep low-level stack (10→300 m) from the upgraded
  // 76-level vertical grid — the rig + sea-breeze band (10/20/30 m) is now native.
  ICONRACE_1KM: {
    key: 'ICONRACE_1KM', label: 'SSA-Race 1 km', subtitle: 'self-hosted nest 1 km', color: '#7c3aed',
    bunnyBase: (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_ICONRACE_BASE) || null,
    venues: [
      { name: 'la_ciotat', domain: 'la_ciotat_1km', clon: 5.61, clat: 43.16, half: 0.15 },
      { name: 'st_tropez', domain: 'st_tropez_1km', clon: 6.678, clat: 43.275, half: 0.23 },
      // Solent / Cowes 1 km nest off solent_2km (full-Solent race box, half 0.30):
      { name: 'solent', domain: 'solent_1km', clon: -1.30, clat: 50.76, half: 0.30 },
      // San Juan Islands 1 km nest off san_juan_islands_2km (solent_1km footprint):
      // half 0.35, widened 2026-10-27 from 0.30 — and this one is GRID-LIMITED,
      // which is the whole point. The 1 km grid spans only -123.350..-122.440,
      // so even at its maximum the box stops at -123.26 once ~10 cells of
      // relaxation zone are kept clear. Victoria sits at -123.37: OUTSIDE the
      // computed grid, not merely outside the box. Reaching it needs a new
      // Zonda grid — see grid/zonda_san_juan_islands_1km_WEST.json on the box,
      // which moves the centre to -123.125 and widens to +-0.625 lon.
      { name: 'san_juan_islands', domain: 'san_juan_islands_1km', clon: -122.8946, clat: 48.5627, half: 0.35 },
      // Porto Cervo 1 km nest off porto_cervo_2km (Costa Smeralda / Bonifacio gap jet):
      { name: 'porto_cervo', domain: 'porto_cervo_1km', clon: 9.45, clat: 41.22, half: 0.31 },
    ],
    // Served wind levels in grid.json: the lean hl stream (10→300 m) PLUS the upper
    // levels 500/750/1000 m that publish (grid_tab_to_json UPPER_FROM_PBL) folds in
    // from the _pbl profile stream. The 3D viewer's level buttons are data-driven
    // from grid.heights so they stay in sync; this mirrors it for the 2D selector.
    heights: [10, 20, 30, 37, 50, 75, 100, 121, 150, 200, 300, 500, 750, 1000],
    // The model's OWN mass levels (z_mc = 10,37,75,121,173,232 on the validated
    // 76-level SLEVE grid). Every other height above is ICON interpolating BETWEEN
    // these, and the 20 m one does not survive it: measured at point 1 over four
    // days, dV(10→20) is −0.03…+0.04 km/h and does NOT scale with wind speed,
    // while dV(10→37) runs +0.05…+2.21 and scales exactly as a surface layer
    // should. The windweight fits its sub-10 m roughness to the two lowest levels
    // it is given, so on the published ladder it was fitting that to noise.
    // Published since the 2026-09-30 cycle (box: _hl h_levels). The 2 km has no
    // entry here — it does not publish its native levels, so it keeps the ladder.
    nativeHeights: [10, 37, 75, 121],
    // Table stays rig-focused (the 1 km's whole value is the resolved low levels);
    // the full stack is available in the 3D view + interpolation.
    tableCols: [10, 20, 30, 50, 100],
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
// HRRR/NAM trail the European set and region-gate themselves off in Europe.
export const MODEL_ORDER = ['AROME', 'METNO', 'ECMWF', 'ICON', 'ICONRACE', 'ICONRACE_1KM', 'ARPEGE', 'ITALIA', 'HRRR', 'NAM']
// All models fetched (Phase 2 Compare consumes the extras).
export const COMPARE_ORDER = ['AROME', 'METNO', 'ECMWF', 'ICON', 'ICONRACE', 'ICONRACE_1KM', 'DMI', 'ITALIA', 'ARPEGE', 'HRRR', 'NAM']

// Region gate. A model with a `coverage` box is only fetched + shown for points
// inside it (hides the North-American models in Europe); models without a box
// — the global OM models and the self-gated SSA-Race venues — always pass.
export function modelCoversPoint(modelKey, latitude, longitude) {
  const box = MODELS[modelKey]?.coverage
  if (!box) return true
  if (latitude == null || longitude == null) return false
  return latitude >= box.latMin && latitude <= box.latMax &&
    longitude >= box.lonMin && longitude <= box.lonMax
}

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

// Per-model forecast horizon in days (default 2 = 48 h). ECMWF/ARPEGE override.
export function forecastDaysFor(m) {
  return (m && m.forecastDays) || 2
}

// Splice a near-term hourly payload (high-res model) onto a longer-range one:
// the first `cutoverHours` samples come from `base`, the rest from `ext`. Both
// share the same local-midnight t0 and hourly step, so indices align. The output
// timeline is the extended (longer) one; columns are the UNION of both, so the
// base model's extra heights survive in the near-term even if `ext` lacks them.
export function stitchHourly(base, ext, cutoverHours) {
  if (!ext || !ext.time) return base
  if (!base || !base.time) return ext
  const time = ext.time.slice()
  const nT = time.length
  const cut = Math.min(cutoverHours, nT)
  const cols = new Set([...Object.keys(base), ...Object.keys(ext)])
  cols.delete('time')
  const out = { time }
  for (const k of cols) {
    const b = base[k], e = ext[k]
    const arr = new Array(nT).fill(null)
    for (let i = 0; i < nT; i++) {
      const src = i < cut ? b : e
      arr[i] = Array.isArray(src) ? (src[i] ?? null) : null
    }
    out[k] = arr
  }
  return out
}

/**
 * CELL SELECTION: `sea`, always, and this is the single most consequential
 * query parameter in this file.
 *
 * Open-Meteo's default is `land` — "prefer a grid cell on land with similar
 * elevation to the requested point" — which for a race area returns a cell
 * ashore. Measured over 1 Jan to 20 Oct 2026 at the venue centres, land cell
 * against sea cell, mean 10 m wind:
 *
 *   Porto Cervo   ecmwf_ifs025   41.00,9.50 (15.0 nm inland)   6.05 kn vs 12.63
 *                 gfs_seamless    8.8 nm off                   6.58    vs 11.94
 *                 arome_hd        0.6 nm off                   7.65    vs  9.97
 *   St Tropez     ecmwf_ifs025   43.25,6.50 (10.9 nm inland)   5.27    vs  8.71
 *   Sorrento      ecmwf, icon_eu, icon_2i: THE SAME CELL — no change at all
 *
 * So at Porto Cervo the ECMWF forecast on screen was a point fifteen miles
 * inland showing less than half the wind, and at Sorrento nothing was wrong.
 * Which cell you get depends on the DEM elevation of the point asked for, so
 * it varies venue by venue and model by model, and there is no symptom beyond
 * the number being too low.
 *
 * The 1 km models barely notice (metno_nordic 32.60 against 32.17 km/h at
 * Svenner fyr) because they have a sea cell at the point already. That is why
 * this hid for so long: the model most looked at was the least affected.
 *
 * A MOS spec belongs to the cell it was fitted against, so this change had to
 * be made together with mos-cell-refit.ts, which re-expresses or voids each
 * stored coefficient set. See CLAUDE.md.
 */
const CELL_SELECTION = 'sea'

// Build an Open-Meteo URL for one surface model at one point.
// Mirrors fetchSurfaceModel() in index.html line 820. `opts` overrides the model
// id and horizon (used to fetch the near-term + extended halves of a blend).
export function surfaceUrl(modelKey, latitude, longitude, timezone, opts = {}) {
  const m = MODELS[modelKey]
  const params = []
  for (const h of m.heights) {
    params.push(`wind_speed_${h}m`, `wind_direction_${h}m`)
  }
  // 2 m air temperature, for the air-sea difference that sets the stability
  // term in lib/windProfile. Free — it rides on the same request — and without
  // it a masthead wind can only be the NEUTRAL profile, which understates it
  // by about 9 % and by 2.1 kn on a light offshore morning. The sea side comes
  // from fetchVenueSst() below, once per venue rather than once per point.
  params.push('temperature_2m')
  if (m.soundingLevels) {
    for (const p of m.soundingLevels) {
      params.push(
        `temperature_${p}hPa`, `relative_humidity_${p}hPa`,
        `geopotential_height_${p}hPa`,
        `wind_speed_${p}hPa`, `wind_direction_${p}hPa`,
      )
    }
  }
  const modelParam = opts.modelParam || m.modelParam
  const days = opts.days || forecastDaysFor(m)
  let url = `${m.endpoint}?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${params.join(',')}` +
    `&wind_speed_unit=kmh&timezone=${encodeURIComponent(timezone)}&forecast_days=${days}` +
    `&cell_selection=${CELL_SELECTION}`
  if (modelParam) url += `&models=${modelParam}`
  return url
}

// ── SSA-Race product freshness ──────────────────────────────────────────────
// The box publishes each venue's grid.json / windweight.json to a FIXED path and
// overwrites it on the next cycle. When a venue's run is skipped — out of season,
// its grid deliberately held back, or the pipeline failed — the previous cycle's
// file simply stays there. Nothing in the payload said "this is old", so the app
// rendered a forecast window that had already elapsed: clicking the three points
// at Porto Cervo pulled up 12 August, the last day its 1 km nest ran.
//
// A published product is only useful while its OWN forecast window still reaches
// the present. Once its last frame is in the past it has nothing to say about
// today, so we treat it as absent rather than as data: the model drops out of
// `modelAvailable`, greys out in the picker, is skipped by the auto-pick, and the
// tables + wind field fall through to a model that does cover today (AROME /
// ECMWF / ICON). Better an honest gap in one model than a confident wrong date.
const SSA_STALE_GRACE_MS = 60 * 60 * 1000   // the just-elapsed hour stays usable

// Parse a published stamp. The box writes '2026-08-12T04:00:00Z'; older products
// and the windweight rows may omit the Z, which Date.parse would read as LOCAL.
function productMs(iso) {
  if (typeof iso !== 'string' || !iso) return NaN
  const hasZone = iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso)
  return Date.parse(hasZone ? iso : `${iso}Z`)
}

// True when a published time axis still extends to (about) now. `times` is the
// product's own frame list — grid.time, or the windweight rows' `t`.
export function productCoversNow(times) {
  if (!Array.isArray(times) || !times.length) return false
  const last = productMs(times[times.length - 1])
  return Number.isFinite(last) && last >= Date.now() - SSA_STALE_GRACE_MS
}

// Module-level cache of fetched venue grids (keyed by URL) so the three
// clicked points don't each re-download the same venue grid.
const _iconRaceGrids = new Map()
function getIconRaceGrid(url) {
  // Cache-bust on a 5-min bucket so a freshly-published grid.json is picked up
  // within ~5 min instead of being pinned to a stale CDN/browser copy (the
  // grid.json URL is otherwise fixed per venue, with no cycle in the path).
  const bust = `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 300000)}`
  if (_iconRaceGrids.has(bust)) return _iconRaceGrids.get(bust)
  const p = (async () => {
    try {
      const res = await fetch(bust, { cache: 'no-store' })
      if (!res.ok) { console.warn(`[weather] ICONRACE grid HTTP ${res.status}`); return null }
      return await res.json()
    } catch (err) {
      console.warn('[weather] ICONRACE grid fetch failed:', err?.message || err); return null
    }
  })()
  _iconRaceGrids.set(bust, p)
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
  // Elapsed cycle → report "no data" so today's tables come from a live model.
  if (!productCoversNow(grid.time)) {
    console.warn(`[weather] ${m.key} ${v.domain}/${v.name}: cycle ${grid.cycle || '?'} has elapsed — treating as unavailable`)
    return null
  }
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
  // Same freshness gate as fetchBunnyModel — an elapsed cycle must not drive the
  // wind field / 3D view either, or the map would animate a past day's weather.
  if (!productCoversNow(grid.time)) return null
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
      return { initSec: init, availableSec: available, intervalSec: interval }
    } catch {
      return null
    }
  })()
  _metaCache.set(metaModel, { at: Date.now(), promise })
  return promise
}

// When the NEXT run should actually land, and whether the one we hold is late.
//
// A cycle's nominal hour is not its arrival: meta.json gives both the
// INITIALISATION time and when that run became AVAILABLE, and the gap between
// them is the model's publication lag — measured 1 Oct: AROME 2h49m, ICON 3h43m,
// ECMWF 6h21m, ARPEGE 4h05m, MET Norway 42m. Using the nominal hour as the ETA
// put it in the PAST the moment the cycle struck, so the table read
// "03z · 2h 23m ago" — an ETA that had already happened.
//
// Two corrections, and both are needed:
//   lag          03z does not arrive at 03:00Z, it arrives at 03:00Z + lag.
//   roll-forward ICON's 3h43m lag EXCEEDS its 3 h cadence, so more than one cycle
//                is always in flight and "init + interval" can be behind us even
//                with the lag applied. Advance to the first cycle still ahead.
//
// `dueSec` deliberately does NOT roll forward: it is when the cycle after the one
// we hold should have landed, which is the only sound basis for "update due".
// Rolling it would push the deadline away every time the model got later, and the
// row could never go amber.
const _sstCache = new Map() // `${key}|${timezone}` -> { at, promise }

/**
 * Sea-surface temperature for a VENUE, cached for an hour.
 *
 * One call per venue, not per grid point: SST ran 21.8-22.0 C across a whole
 * 48-hour forecast in the Gulf of Naples when this was measured, so it is the
 * slowest-moving field in the system and a venue-wide value loses nothing.
 * Open-Meteo bills per LOCATION, so this is the difference between one call an
 * hour and one per point.
 *
 * `timezone` MUST be the same one the surface model was fetched with. The
 * marine endpoint defaults to GMT and returns naive stamps, so a mismatch
 * silently offsets every air-sea difference by the venue's UTC offset — two
 * hours in the Med, which across a diurnal sea breeze is the difference
 * between stable and unstable. seaTemp.sstAt matches stamps by exact string
 * and returns null rather than guessing, so a mismatch shows up as "no
 * stability data" instead of a wrong correction.
 */
export async function fetchVenueSst(latitude, longitude, timezone) {
  const venue = venueAt(latitude, longitude)
  // Outside a known venue there is nothing to share a value across, and a
  // per-point marine call is the cost this function exists to avoid.
  if (!venue || !timezone) return null
  const key = `${venue.key}|${timezone}`
  const c = _sstCache.get(key)
  if (c && Date.now() - c.at < 3_600_000) return c.promise

  const promise = (async () => {
    try {
      const res = await fetch(marineSstUrl(venue.lat, venue.lon, timezone))
      if (!res.ok) return null
      return parseMarineSst(await res.json())
    } catch {
      return null   // no SST is a flagged neutral profile, not an outage
    }
  })()
  _sstCache.set(key, { at: Date.now(), promise })
  return promise
}

export function modelCadence(meta, now = Date.now() / 1000) {
  const init = meta?.initSec
  const interval = meta?.intervalSec
  if (init == null || !(interval > 0)) return { lagSec: null, nextSec: null, nextEtaSec: null, dueSec: null }
  const avail = meta?.availableSec
  const lagSec = avail != null && avail > init ? avail - init : 0
  const dueSec = init + interval + lagSec
  let nextSec = init + interval
  // bounded: a stale meta.json must not spin. 64 cycles is >2 days at a 1 h cadence.
  for (let i = 0; i < 64 && nextSec + lagSec <= now; i++) nextSec += interval
  return { lagSec, nextSec, nextEtaSec: nextSec + lagSec, dueSec }
}

// Live Icon-Race pipeline status, published once a minute by the box
// (scripts/publish_status.sh -> www/icon-race/status.json). Same delivery path
// as the venue grids: public pull-zone if configured, else the same-origin
// storage proxy. Returns the parsed status object or null.
// The box publishes ONE status file per CHAIN, not per domain: the Med/Cowes 00z
// run writes status.json, and a second chain (San Juan, 12z) writes its own name.
// They cannot share a file -- each would overwrite the other's cycle and leave the
// Admin table confidently describing a run that is not happening.
export const ICONRACE_STATUS_FILES = ['status.json', 'status_usa.json']

export async function fetchIconRaceStatus(name = 'status.json') {
  const base = MODELS.ICONRACE.bunnyBase
  const url = base
    ? `${base}/${name}`
    : `/api/bunny/storage?key=${encodeURIComponent(`icon-race/${name}`)}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Ordered SSA-Race venue candidates for a lat/lon — the 1 km nest FIRST (finer
// profile), then the 2 km parent as fallback. Callers fetch each in turn and use
// the first that has a published windweight.json (so a 2 km-only day still shows).
// Each item: { domain, venue } → icon-race/<domain>/<venue>/windweight.json.
export function windweightVenues(lat, lon) {
  if (lat == null || lon == null) return []
  const out = []
  for (const modelKey of ['ICONRACE_1KM', 'ICONRACE']) {
    const vens = MODELS[modelKey]?.venues || []
    let best = null, bestD = Infinity
    for (const v of vens) {
      if (Math.abs(lat - v.clat) > v.half || Math.abs(lon - v.clon) > v.half) continue
      const d = (lat - v.clat) ** 2 + (lon - v.clon) ** 2
      if (d < bestD) { bestD = d; best = v }
    }
    if (best) out.push({ domain: best.domain, venue: best.name })
  }
  return out
}

// First candidate (1 km if present) — kept for callers that want a single venue.
export function windweightVenueFor(lat, lon) {
  return windweightVenues(lat, lon)[0] || null
}

// Fetch the windweight for the nearest venue that actually has a product
// published (tries 1 km then 2 km). Returns { data, domain, venue } or null.
export async function fetchWindweightNearest(lat, lon) {
  for (const c of windweightVenues(lat, lon)) {
    // eslint-disable-next-line no-await-in-loop
    const data = await fetchWindweight(c.domain, c.venue)
    // Skip an elapsed cycle (see productCoversNow) and try the next resolution —
    // so a stale 1 km doesn't mask a 2 km that DID run today.
    if (data && Array.isArray(data.hours) && data.hours.length
        && productCoversNow(data.hours.map((h) => h && h.t))) {
      return { data, domain: c.domain, venue: c.venue }
    }
  }
  return null
}

// Per-venue windweight time series published by the box
// (scripts/publish_products.sh -> icon-race/<domain>/<venue>/windweight.json).
// Hourly WW% / V_eff / sub-factors / rig profile. Returns parsed object or null.
export async function fetchWindweight(domain, venue) {
  if (!domain || !venue) return null
  const base = MODELS.ICONRACE?.bunnyBase
  const key = `icon-race/${domain}/${venue}/windweight.json`
  const url = base ? `${base}/${domain}/${venue}/windweight.json`
    : `/api/bunny/storage?key=${encodeURIComponent(key)}`
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

// Today's racing window [10:00, 16:00] local — default zoom for the comparison
// charts (pannable to the full forecast either side).
export function localRacingWindow() {
  const a = new Date(); a.setHours(10, 0, 0, 0)
  const b = new Date(); b.setHours(16, 0, 0, 0)
  return [a, b]
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

  // Retry transient failures with exponential backoff. Open-Meteo's free tier
  // rate-limits (HTTP 429) when we sweep several models across points, and a
  // single-shot fetch would drop that model to null — which is exactly how a
  // whole venue's comparison collapsed to just the SSA-Race (Bunny) model. Retry
  // 429 + 5xx + network errors; give up immediately on other 4xx (a real "no
  // data here" is a 400 and won't recover).
  const getJson = async (url, tries = 4) => {
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetch(url)
        if (res.ok) {
          const text = await res.text()
          try { return JSON.parse(text) } catch {
            // A 200 that will not parse is never transient. Outside a regional
            // model's domain Open-Meteo answers 200 with `"latitude":nan`, which is
            // invalid JSON; treating that as a network error retried it four times
            // with backoff — ~4 s and four requests per click past a domain edge —
            // before returning null anyway.
            // eslint-disable-next-line no-console
            console.warn(`[weather] ${modelKey} returned unparseable JSON — outside its domain?`)
            return null
          }
        }
        const retriable = res.status === 429 || res.status >= 500
        if (retriable && attempt < tries - 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
          continue
        }
        // eslint-disable-next-line no-console
        console.warn(`[weather] ${modelKey} HTTP ${res.status}${retriable ? ' (gave up after retries)' : ''}`)
        return null
      } catch (err) {
        if (attempt < tries - 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
          continue
        }
        // eslint-disable-next-line no-console
        console.warn(`[weather] ${modelKey} fetch failed:`, err?.message || err)
        return null
      }
    }
    return null
  }

  // Blended horizon (ECMWF): near-term high-res model spliced onto the longer
  // 0.25° model at the forecastDays seam. Two requests, stitched by hour.
  if (cfg && cfg.extend) {
    const base = await getJson(surfaceUrl(modelKey, latitude, longitude, timezone,
      { modelParam: cfg.modelParam, days: forecastDaysFor(cfg) }))
    await new Promise((r) => setTimeout(r, 200))
    const ext = await getJson(surfaceUrl(modelKey, latitude, longitude, timezone,
      { modelParam: cfg.extend.modelParam, days: cfg.extend.forecastDays }))
    const hourly = stitchHourly(base?.hourly, ext?.hourly, forecastDaysFor(cfg) * 24)
    if (!hasValidSpeed(hourly)) {
      // eslint-disable-next-line no-console
      console.warn(`[weather] ${modelKey} no valid wind data at (${latitude}, ${longitude})`)
      return null
    }
    return { ...(base || ext || {}), hourly }
  }

  const data = await getJson(surfaceUrl(modelKey, latitude, longitude, timezone))
  if (!data) return null
  if (!hasValidSpeed(data.hourly)) {
    // eslint-disable-next-line no-console
    console.warn(`[weather] ${modelKey} no valid wind data at (${latitude}, ${longitude})`)
    return null
  }
  return data
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
    `&wind_speed_unit=kmh&timezone=${encodeURIComponent(timezone)}&forecast_days=2` +
    `&cell_selection=${CELL_SELECTION}`
  try {
    const res = await fetch(url)
    if (!res.ok) return { hourly: { time: [], boundary_layer_height: [] } }
    return await res.json()
  } catch {
    return { hourly: { time: [], boundary_layer_height: [] } }
  }
}

// ECMWF pressure levels for the Skew-T / vertical profile. The 9 km ecmwf_ifs
// surface model carries NO pressure data, so the sounding pulls them from the
// 0.25° ecmwf_ifs025 instead (live probe 2026-07-21: full ladder populated at San
// Pedro). Coarser than GFS (6 levels) but it keeps the ECMWF sounding at every
// venue. Shaped like the GFS payload so SOUNDING_SOURCES.ECMWF reads it directly.
export const ECMWF_SOUNDING_LEVELS = [1000, 925, 850, 700, 600, 500]
export async function fetchECMWFPressureLevels({ latitude, longitude, timezone }) {
  const params = []
  for (const p of ECMWF_SOUNDING_LEVELS) {
    params.push(
      `temperature_${p}hPa`, `relative_humidity_${p}hPa`,
      `geopotential_height_${p}hPa`,
      `wind_speed_${p}hPa`, `wind_direction_${p}hPa`,
    )
  }
  const url = `https://api.open-meteo.com/v1/ecmwf?` +
    `latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${params.join(',')}` +
    `&wind_speed_unit=kmh&timezone=${encodeURIComponent(timezone)}&forecast_days=2&models=ecmwf_ifs025` +
    `&cell_selection=${CELL_SELECTION}`
  try {
    const res = await fetch(url)
    if (!res.ok) return { hourly: { time: [] } }
    return await res.json()
  } catch {
    return { hourly: { time: [] } }
  }
}

// Fetch every enabled surface model + GFS + ECMWF upper air for one point. Returns
// a { surfaceByModel, gfs, ecmwfSounding, elevation, coords } container matching
// the shape the upstream tool's `windData[locKey]` object expects.
export async function fetchAllForPoint({ latitude, longitude, timezone, enabledModels, onProgress }) {
  const surfaceByModel = {}
  // Region gate: a model whose coverage box excludes this point is skipped
  // entirely — not fetched, rendered as absent (null) — exactly like a disabled
  // model. This keeps the North-American models off in Europe (and vice-versa).
  const enabled = COMPARE_ORDER.filter((k) => enabledModels[k] && modelCoversPoint(k, latitude, longitude))
  for (const k of COMPARE_ORDER) if (!enabled.includes(k)) surfaceByModel[k] = null
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
  // ECMWF pressure levels (0.25°) — the 9 km ecmwf_ifs surface model has none, so
  // the Skew-T ECMWF source reads these. Global, so fetched at every point.
  onProgress?.({ modelKey: 'ECMWF-UA', phase: 'start' })
  const ecmwfSounding = await fetchECMWFPressureLevels({ latitude, longitude, timezone })
  onProgress?.({ modelKey: 'ECMWF-UA', phase: 'done' })

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
    ecmwfSounding,
    elevation,
  }
}

// Pick the default active model for the surface toggle: first model in
// MODEL_ORDER that has data at any of the points we fetched.
// Default active model after a fetch. Prefer the self-hosted SSA-Race models
// (1 km, then 2 km) so the active model matches the wind-field viewer's own
// auto-selection — otherwise the table/active model flips to AROME on a late
// fetch completion while the field stays on SSA-Race. Falls through to the
// standard MODEL_ORDER (AROME first) when no SSA-Race data is present.
// Then the local regional models (region-gated, so only one ever has data) ahead
// of the globals: HRRR at a North-American venue, not ECMWF.
const LOCAL_FIRST = ['AROME', 'METNO', 'HRRR', 'NAM']
const DEFAULT_ACTIVE_ORDER = ['ICONRACE_1KM', 'ICONRACE', ...LOCAL_FIRST, ...MODEL_ORDER.filter((k) => !k.startsWith('ICONRACE') && !LOCAL_FIRST.includes(k))]
export function pickDefaultActiveModel(allPoints) {
  for (const k of DEFAULT_ACTIVE_ORDER) {
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

// Wind DIRECTION at an arbitrary height. Directions must be interpolated as unit
// VECTORS, never as plain numbers: the arithmetic mean of 350° and 010° is 180°,
// which is the exact opposite of the answer. Linear in log-height between the two
// bracketing levels (2 points, not the 3-point Lagrange used for speed — an
// overshoot in an angle wraps rather than just being a bit wrong).
export function interpolateDirectionAtHeight(hourly, heights, targetH, idx) {
  if (!hourly || !heights?.length || targetH == null) return null
  const pts = []
  for (const hgt of heights) {
    const d = hourly[`wind_direction_${hgt}m`]?.[idx]
    if (d != null && isFinite(d)) pts.push({ h: hgt, d })
  }
  if (!pts.length) return null
  pts.sort((a, b) => a.h - b.h)
  if (pts.length === 1) return ((pts[0].d % 360) + 360) % 360
  const t = Math.max(targetH, 1)
  let lo = pts[0]; let hi = pts[pts.length - 1]
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].h <= t && pts[i + 1].h >= t) { lo = pts[i]; hi = pts[i + 1]; break }
  }
  const span = Math.log(hi.h) - Math.log(lo.h)
  const f = span === 0 ? 0 : Math.max(0, Math.min(1, (Math.log(t) - Math.log(lo.h)) / span))
  const r = Math.PI / 180
  const su = (1 - f) * Math.sin(lo.d * r) + f * Math.sin(hi.d * r)
  const cu = (1 - f) * Math.cos(lo.d * r) + f * Math.cos(hi.d * r)
  if (su === 0 && cu === 0) return null
  return ((Math.atan2(su, cu) / r) % 360 + 360) % 360
}

// Signed directional shear through the rig band: TWD at masthead minus TWD at the
// lowest published level, wrapped to (−180, 180].
//   POSITIVE = veering  (rotates RIGHT / clockwise with height)
//   NEGATIVE = backing  (rotates LEFT with height)
//
// Deliberately kept OUT of the windweight/V_eff integral. Directional shear is not
// a load term — the local force at each height is set by the local wind SPEED, and
// the sail is twisted to the local direction. What it is instead is a TACK
// asymmetry: veer frees the top on starboard and heads it on port, backing does the
// reverse. A single scalar cannot carry that, so it is reported on its own and left
// for the crew to read against the tack they are on.
export function rigDirectionShearDeg(hourly, heights, mastH, idx) {
  if (!hourly || !heights?.length) return null
  const lows = heights.filter((h) => hourly[`wind_direction_${h}m`]?.[idx] != null)
  if (!lows.length) return null
  const base = Math.min(...lows)
  const dBase = interpolateDirectionAtHeight(hourly, heights, base, idx)
  const dMast = interpolateDirectionAtHeight(hourly, heights, mastH, idx)
  if (dBase == null || dMast == null) return null
  return ((dMast - dBase + 540) % 360) - 180
}

// ── Skew-T sounding sources (Phase 3) ────────────────────────────────────────
// Pressure levels each source publishes. GFS uses the dense 25 hPa ladder above;
// ICON exposes the coarser set Open-Meteo carries for it. ECMWF's levels
// (ECMWF_SOUNDING_LEVELS) come from the dedicated 0.25° ecmwf_ifs025 fetch
// (ecmwfSounding) — the 9 km ecmwf_ifs surface model carries no pressure data.
export const ICON_SOUNDING_LEVELS  = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500]

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
  ECMWF: { label: 'ECMWF',        levels: ECMWF_SOUNDING_LEVELS, hourly: (d) => d && d.ecmwfSounding && d.ecmwfSounding.hourly },
}
export const SOUNDING_ORDER = ['SSARACE', 'ECMWF', 'GFS', 'ICON']

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
  // sounding.json is overwritten in place like grid.json, so an elapsed cycle
  // would put a past day's Skew-T under today's date. Same gate as the grid.
  if (!productCoversNow(snd.cells[0]?.hourly?.time)) return null
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
// only the sources the Skew-T can use (ICON surface upper-air, ECMWF 0.25°
// pressure levels, GFS pressure levels). Returns the same
// { coords, surfaceByModel, gfs, ecmwfSounding, elevation } container shape so it
// slots straight into windData under the 'S' key.
export async function fetchSoundingPoint({ latitude, longitude, timezone }) {
  const surfaceByModel = {}
  surfaceByModel.ICON  = await fetchSurfaceModel({ modelKey: 'ICON',  latitude, longitude, timezone })
  await new Promise((r) => setTimeout(r, 250))
  // ECMWF sounding from the 0.25° model (the 9 km ecmwf_ifs has no pressure data).
  const ecmwfSounding = await fetchECMWFPressureLevels({ latitude, longitude, timezone })
  await new Promise((r) => setTimeout(r, 250))
  const gfs = await fetchGFSPressureLevels({ latitude, longitude, timezone })

  let elevation = 0
  if (surfaceByModel.ICON && surfaceByModel.ICON.elevation != null) elevation = surfaceByModel.ICON.elevation
  if (!elevation && gfs && gfs.elevation != null) elevation = gfs.elevation

  return { coords: { latitude, longitude }, surfaceByModel, gfs, ecmwfSounding, elevation }
}
