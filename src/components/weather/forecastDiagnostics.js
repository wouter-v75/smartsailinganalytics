// forecastDiagnostics.js
// ----------------------------------------------------------------------------
// Deterministic, physically-grounded diagnostics for the racing-yacht forecast
// brief. Pure functions only (no fetch, no React) so they are node-testable in
// isolation and can be hand-verified against worked meteorological cases. The
// AI exec-summary consumes the OUTPUT of these — it phrases, it does not forecast.
//
// Spec: docs/racing-forecast-diagnostics-spec.md
//
// THIS FILE (build step 1-2): primitives + stability-from-sounding.
//   - angle/circular helpers
//   - coastline normal (auto-derive from a land-sea mask + per-venue override)
//   - cross-shore gradient component, thermal bend, sea-breeze index (SBI)
//   - multi-model spread (σ_TWD circular std, σ_TWS)
//   - stability from the low-level sounding: inversion base/strength, lapse rate,
//     and a 0-1 stability GATE combining inversion + mixed-layer depth (h_mix).
// Sea-breeze score, Quadrant modifier, type-of-day, cloud-trend, confidence and
// funnelling live in later steps (separate functions / files).
// ----------------------------------------------------------------------------

export const D2R = Math.PI / 180
const RD = 287.05        // J/kg/K, gas constant dry air
const G = 9.80665        // m/s^2

// ── basic math ──────────────────────────────────────────────────────────────
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
export const clamp01 = (x) => clamp(x, 0, 1)
export const norm360 = (d) => ((d % 360) + 360) % 360
/** signed smallest difference a-b, in (-180, 180]. +ve = a is clockwise of b. */
export const signedAngle = (a, b) => ((((a - b) % 360) + 540) % 360) - 180
/** absolute angular separation 0..180. */
export const angularDiff = (a, b) => Math.abs(signedAngle(a, b))

/** mean of a numeric array, or null if empty. */
export function mean(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x))
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null
}
/** population standard deviation, or 0 if <2 samples. */
export function std(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x))
  if (v.length < 2) return 0
  const m = v.reduce((a, x) => a + x, 0) / v.length
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length)
}
/** circular mean of directions (deg), or null if empty. */
export function circMean(dirs) {
  const v = dirs.filter((x) => x != null && Number.isFinite(x))
  if (!v.length) return null
  let s = 0; let c = 0
  for (const d of v) { s += Math.sin(d * D2R); c += Math.cos(d * D2R) }
  return norm360((Math.atan2(s, c) / D2R))
}
/** circular standard deviation of directions (deg). R=resultant length → sqrt(-2 ln R). */
export function circStd(dirs) {
  const v = dirs.filter((x) => x != null && Number.isFinite(x))
  if (v.length < 2) return 0
  let s = 0; let c = 0
  for (const d of v) { s += Math.sin(d * D2R); c += Math.cos(d * D2R) }
  const R = Math.hypot(s, c) / v.length
  return R <= 0 ? 180 : Math.sqrt(-2 * Math.log(Math.min(1, R))) / D2R
}

// ── coastline normal θ ───────────────────────────────────────────────────────
// θ = azimuth (deg, 0=N, 90=E) of the outward coast normal, pointing FROM land
// OUT TO SEA. All onshore/offshore/quadrant logic is relative to θ.
//
// Per-venue manual overrides (decision 2026-06-22: auto-derive + override). Keyed
// by the venue key returned by mos.matchVenue(). Fill/adjust as venues are tuned.
export const VENUE_COAST_NORMAL = {
  // la_spezia: Gulf opens to the SSW → sea lies to the ~205-215°. TUNE on site.
  la_spezia: 210,
  // Add Channel/Solent, Scandinavian venues as they come online.
}

/**
 * Derive the outward coast normal from a land-sea mask around a point.
 * @param {number[][]} mask  2-D grid, mask[i][j] = land fraction (1=land, 0=sea).
 * @param {number} i0 row index of the point (i increases toward `northUp` pole)
 * @param {number} j0 col index of the point (j increases toward the east)
 * @param {object} [o]
 * @param {boolean} [o.northUp=true] true if increasing i = increasing latitude (north).
 * @param {number} [o.radius=3] half-window (cells) over which to average the gradient.
 * @returns {number|null} azimuth land→sea (deg), or null if no coastline gradient.
 *
 * The outward normal points toward the sea = direction of the NEGATIVE gradient
 * of land fraction. We average finite differences over a window to smooth a
 * pixelated coastline.
 */
export function coastNormalFromMask(mask, i0, j0, o = {}) {
  const northUp = o.northUp !== false
  const radius = o.radius || 3
  const nI = mask.length; const nJ = mask[0] ? mask[0].length : 0
  if (!nI || !nJ) return null
  let gE = 0; let gN = 0; let n = 0
  for (let di = -radius; di <= radius; di++) {
    for (let dj = -radius; dj <= radius; dj++) {
      const i = i0 + di; const j = j0 + dj
      if (i <= 0 || j <= 0 || i >= nI - 1 || j >= nJ - 1) continue
      const dEast = (mask[i][j + 1] - mask[i][j - 1]) / 2   // ∂land/∂east
      const dNraw = (mask[i + 1][j] - mask[i - 1][j]) / 2   // ∂land/∂(+i)
      const dNorth = northUp ? dNraw : -dNraw               // ∂land/∂north
      gE += dEast; gN += dNorth; n++
    }
  }
  if (!n) return null
  gE /= n; gN /= n
  // outward normal (toward sea) = -∇land
  const eastward = -gE; const northward = -gN
  if (Math.hypot(eastward, northward) < 1e-9) return null   // no coastline locally
  return norm360(Math.atan2(eastward, northward) / D2R)     // atan2(E, N) → azimuth
}

/**
 * Resolve the coast normal: manual override wins; else derive from a mask.
 * @returns {{ deg:number|null, source:'override'|'mask'|'none' }}
 */
export function coastNormal(venueKey, { mask, i0, j0, maskOpts } = {}) {
  if (venueKey && VENUE_COAST_NORMAL[venueKey] != null) {
    return { deg: VENUE_COAST_NORMAL[venueKey], source: 'override' }
  }
  if (mask && i0 != null && j0 != null) {
    const deg = coastNormalFromMask(mask, i0, j0, maskOpts)
    if (deg != null) return { deg, source: 'mask' }
  }
  return { deg: null, source: 'none' }
}

// ── wind vs coast primitives ─────────────────────────────────────────────────
// Wind directions are METEOROLOGICAL "from" bearings. A wind FROM α blows TOWARD
// α+180. Offshore = blowing from land toward sea ≈ toward θ.

/** Cross-shore component of a wind, +ve OFFSHORE, -ve ONSHORE (same speed units). */
export function crossShoreComponent(windFromDeg, windSpd, coastNormalDeg) {
  const toward = windFromDeg + 180
  return windSpd * Math.cos((toward - coastNormalDeg) * D2R)
}

/** Thermal bend = signed turn of the SURFACE wind relative to the GRADIENT wind
 *  (both "from" bearings). +ve = surface veered clockwise of gradient. Friction-only
 *  turn is ~10-15° (ocean) / ~20-30° (enclosed water); larger ⇒ thermal forcing. */
export function thermalBend(surfFromDeg, gradFromDeg) {
  return signedAngle(surfFromDeg, gradFromDeg)
}

/**
 * Sea-breeze index: a closed cell needs the SURFACE flow ONSHORE and the layer
 * ALOFT (BL-top) OFFSHORE, the two opposing through the coast normal. 0..1; >0
 * means a sea-breeze circulation is present (after Hallgren et al. 2023 / GMD 2026,
 * recast in our sign convention and verified in the node test).
 */
export function seaBreezeIndex(surfFromDeg, blTopFromDeg, coastNormalDeg) {
  // onshore-ness of surface = how much its TOWARD vector opposes θ (points to land)
  const onshoreSurf = -Math.cos((surfFromDeg + 180 - coastNormalDeg) * D2R)  // +1 fully onshore
  // offshore-ness of BL-top = how much its TOWARD vector aligns with θ (points to sea)
  const offshoreTop = Math.cos((blTopFromDeg + 180 - coastNormalDeg) * D2R)  // +1 fully offshore
  return clamp01(onshoreSurf) * clamp01(offshoreTop)
}

/**
 * Multi-model spread at a single time/place.
 * @param {number[]} dirs   TWD per model (deg)
 * @param {number[]} speeds TWS per model (kn)
 * @returns {{ sigmaTwd:number, sigmaTws:number, nDir:number, nSpd:number }}
 */
export function modelSpread(dirs, speeds) {
  const d = (dirs || []).filter((x) => x != null && Number.isFinite(x))
  const s = (speeds || []).filter((x) => x != null && Number.isFinite(x))
  return { sigmaTwd: circStd(d), sigmaTws: std(s), nDir: d.length, nSpd: s.length }
}

// ── stability from the low-level sounding ────────────────────────────────────
// Primary control on sea-breeze development/depth (decision 2026-06-22). What
// KILLS a breeze is a LOW, strong capping inversion (the over-land mixed layer
// can't deepen, so the thermal low never forms). A strong inversion sitting WELL
// ABOVE a healthy deep CBL is benign-to-favourable (it sharpens the front).
// NB: CIN is NOT an onset predictor (kept as a separate collapse-risk flag).

/** Specific humidity (kg/kg) from T(°C), RH(%), p(hPa) — for virtual temperature. */
export function specificHumidity(tC, rh, pHpa) {
  if (tC == null || rh == null || pHpa == null) return null
  const es = 6.112 * Math.exp((17.67 * tC) / (tC + 243.5))   // hPa, Bolton
  const e = (clamp(rh, 0, 100) / 100) * es
  return (0.622 * e) / (pHpa - 0.378 * e)
}

/**
 * Ensure geometric heights on a pressure profile. If a level lacks `z`, integrate
 * the hypsometric equation upward from the surface using (virtual) temperature.
 * @param {Array<{press:number, tempC:number, z?:number, rh?:number}>} profile
 *        sorted SURFACE→UP (descending pressure). Returns a copy with `z` (m) filled.
 */
export function ensureHeights(profile) {
  const p = profile.map((o) => ({ ...o }))
  if (p.every((o) => o.z != null && Number.isFinite(o.z))) return p
  let z = p[0].z != null ? p[0].z : 0
  p[0].z = z
  for (let k = 1; k < p.length; k++) {
    const lo = p[k - 1]; const hi = p[k]
    const tvLo = virtualTempK(lo); const tvHi = virtualTempK(hi)
    const tvMean = (tvLo + tvHi) / 2
    const dz = (RD * tvMean / G) * Math.log(lo.press / hi.press)
    z += dz
    if (hi.z == null) hi.z = z
    else z = hi.z   // honour provided heights when present
  }
  return p
}
function virtualTempK(o) {
  const tK = o.tempC + 273.15
  const q = o.rh != null ? specificHumidity(o.tempC, o.rh, o.press) : null
  return q != null ? tK * (1 + 0.61 * q) : tK
}

/**
 * Stability diagnostics from a low-level sounding profile.
 * @param {Array<{press:number, tempC:number, z?:number, rh?:number}>} profileIn
 *        surface→up. (Heights filled hypsometrically if absent.)
 * @param {object} [o]
 * @param {number} [o.maxScanM=2500] only look for the lowest cap below this height.
 * @param {number} [o.minInvC=0.5]   min temp rise (°C) to count an inversion layer.
 * @returns {{
 *   lapseRateCkm:number|null,   // sub-cap environmental lapse rate (°C/km), +ve = T falls with height
 *   nearDryAdiabatic:boolean,   // lapse ≳ 8 °C/km
 *   capBaseM:number|null,       // base height of the lowest inversion (m)
 *   capStrengthC:number|null,   // temp rise across that inversion (°C)
 *   capTopM:number|null,
 *   hasLowCap:boolean,          // low + strong enough to suppress a breeze
 * }}
 */
export function stabilityFromSounding(profileIn, o = {}) {
  const maxScanM = o.maxScanM ?? 2500
  const minInvC = o.minInvC ?? 0.5
  const empty = {
    lapseRateCkm: null, nearDryAdiabatic: false,
    capBaseM: null, capStrengthC: null, capTopM: null, hasLowCap: false,
  }
  if (!Array.isArray(profileIn) || profileIn.length < 2) return empty
  // sort surface→up (descending pressure) and fill heights
  const p = ensureHeights(
    profileIn.filter((x) => x && x.press != null && x.tempC != null)
      .sort((a, b) => b.press - a.press),
  )
  if (p.length < 2) return empty

  // lowest inversion: first level where T rises with height by ≥ minInvC over a layer
  let capBaseM = null; let capTopM = null; let capStrengthC = null
  for (let k = 0; k < p.length - 1 && p[k].z <= maxScanM; k++) {
    if (p[k + 1].tempC > p[k].tempC + 1e-6) {
      // start of a temperature increase → inversion base at p[k]
      const baseT = p[k].tempC; const baseZ = p[k].z
      let topIdx = k + 1
      while (topIdx + 1 < p.length && p[topIdx + 1].tempC >= p[topIdx].tempC - 1e-6) topIdx++
      const rise = p[topIdx].tempC - baseT
      if (rise >= minInvC) {
        capBaseM = baseZ; capTopM = p[topIdx].z; capStrengthC = rise
        break
      }
      k = topIdx - 1   // skip past a too-weak bump and keep scanning
    }
  }

  // sub-cap lapse rate: surface up to the cap base (or top of profile / maxScanM)
  const topZ = capBaseM != null ? capBaseM : Math.min(maxScanM, p[p.length - 1].z)
  const sfc = p[0]
  let topPt = p[0]
  for (const pt of p) { if (pt.z <= topZ + 1e-6) topPt = pt }
  let lapseRateCkm = null
  if (topPt.z - sfc.z > 50) {
    lapseRateCkm = -((topPt.tempC - sfc.tempC) / (topPt.z - sfc.z)) * 1000
  }
  const nearDryAdiabatic = lapseRateCkm != null && lapseRateCkm >= 8

  // "low cap" = a capping inversion low enough AND strong enough to stop the CBL
  // deepening. Thresholds are engineering defaults — TUNE against verification.
  const hasLowCap = capBaseM != null && capBaseM < 800 && (capStrengthC ?? 0) >= 1

  return { lapseRateCkm, nearDryAdiabatic, capBaseM, capStrengthC, capTopM, hasLowCap }
}

/**
 * Stability GATE 0..1 — the PRIMARY (multiplicative) term of the sea-breeze score.
 * Combines mixed-layer depth (h_mix from HPBL) with the sounding cap. → 0 for a
 * shallow CBL under a low strong cap; → 1 for a deep, near-adiabatic, uncapped CBL.
 * @param {object} a
 * @param {number} [a.hMix]            boundary-layer height (m) at the venue/hour
 * @param {number} [a.capBaseM]        from stabilityFromSounding
 * @param {number} [a.capStrengthC]
 * @param {boolean}[a.nearDryAdiabatic]
 * @param {object} [t] threshold overrides
 * @returns {number} 0..1
 */
export function stabilityGate(a, t = {}) {
  const hMin = t.hMin ?? 300      // m — below this the CBL is too shallow for a breeze
  const hFull = t.hFull ?? 1300   // m — at/above this depth is fully favourable
  // depth term from h_mix
  let depth = a.hMix != null ? clamp01((a.hMix - hMin) / (hFull - hMin)) : 0.5
  // cap penalty: a low strong cap drags the gate toward 0
  let capFactor = 1
  if (a.capBaseM != null && a.capStrengthC != null) {
    const lowness = clamp01((hFull - a.capBaseM) / hFull)      // 1 if cap at surface, 0 if ≥hFull
    const strength = clamp01(a.capStrengthC / 4)               // saturates at 4 °C
    capFactor = clamp01(1 - lowness * strength)
  }
  // small bonus for a well-mixed near-adiabatic layer
  const mixBonus = a.nearDryAdiabatic ? 1.0 : 0.85
  return clamp01(depth * capFactor * mixBonus)
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10)
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100)

// ── Quadrant Theory modifier (gradient-wind direction vs coast) ──────────────
// Houghton's four-box scheme; the defensible physics (Steele et al. 2015) is the
// OFFSHORE-COMPONENT magnitude (light offshore favourable, strong offshore
// suppresses, onshore reinforces) and the shore-parallel "land-on-left" (NH)
// maximum. The left/right side term is a teaching simplification (medium
// confidence) — kept small and TUNABLE; the speed term dominates.
/**
 * @param {number} coastNormalDeg θ, land→sea azimuth
 * @param {number} gradFromDeg    gradient wind "from" bearing
 * @param {number} gradSpeedKt
 * @param {'N'|'S'} [hemisphere='N']
 */
export function quadrantModifier(coastNormalDeg, gradFromDeg, gradSpeedKt, hemisphere = 'N') {
  const toward = gradFromDeg + 180
  const rel = signedAngle(toward, coastNormalDeg)      // 0 = blowing straight offshore
  const a = Math.abs(rel)
  const offshoreComp = gradSpeedKt * Math.cos(rel * D2R)  // +offshore
  // +ve = favourable side (land on the LEFT looking out to sea, NH). 0 at pure offshore.
  const sideFav = hemisphere === 'N' ? -Math.sin(rel * D2R) : Math.sin(rel * D2R)

  let quad; let family
  if (a <= 60) { family = 'offshore'; quad = sideFav < -0.15 ? 'Q3' : 'Q1' }
  else if (a >= 120) { family = 'onshore'; quad = 'Q2' }
  else { family = 'along'; quad = sideFav >= 0 ? 'Q4' : 'Q3' }

  const base = family === 'onshore' ? 0.5 : family === 'along' ? 1.5 * sideFav : 1.2 * sideFav
  let spd
  if (offshoreComp > 0) spd = offshoreComp <= 8 ? 0.8 : offshoreComp <= 15 ? 0 : offshoreComp <= 25 ? -1.5 : -3
  else spd = gradSpeedKt < 18 ? 0.4 : 0   // onshore reinforcement
  const scoreMod = clamp(base + spd, -3, 2.5)

  const veer = hemisphere === 'N' ? 35 : -35
  const timing = quad === 'Q1' ? 'classic: fills late morning, peaks early-mid afternoon'
    : quad === 'Q4' ? 'early/all-day build (hybrid, not a pure thermal breeze)'
      : quad === 'Q2' ? 'no discrete onset; reinforced onshore'
        : 'late/fluky or fails; dies in the afternoon'
  return {
    quadrant: quad, family, scoreMod: round1(scoreMod), offshoreCompKt: round1(offshoreComp),
    favourableSide: sideFav >= 0, dirOnsetFrom: Math.round(norm360(coastNormalDeg)),
    dirPeakFrom: Math.round(norm360(coastNormalDeg + veer)), timing,
  }
}

// ── Sea-breeze potential score (0-10) ────────────────────────────────────────
// Stability-gated (multiplicative) + additive [gradient, thermal, mixed-layer],
// then the Quadrant modifier. See spec §4.
function fGrad(offKt) {            // cross-shore gradient term, + = offshore
  if (offKt >= 0) return clamp01(offKt <= 6 ? 1 : 1 - (offKt - 6) / 6)  // 1 to 12 kt, 0 beyond
  return clamp01(1 - (-offKt) / 14)                                     // onshore → 0 at 14 kt
}
function fThermal(dT) {            // air-SST / land-sea ΔT term
  if (dT == null) return 0.3
  if (dT <= 0) return 0
  if (dT < 3) return (dT / 3) * 0.5
  if (dT < 5) return 0.5 + ((dT - 3) / 2) * 0.5
  return 1
}
function fStab2(a) {               // mixed-layer "quality" beyond the gate
  const lap = a.lapseRateCkm == null ? 0.5 : clamp01((a.lapseRateCkm - 5) / 4)  // 0@5 →1@9 °C/km
  const dep = a.hMix == null ? 0.5 : clamp01((a.hMix - 500) / 1000)              // 0@500 →1@1500 m
  return 0.5 * lap + 0.5 * dep
}
/**
 * @param {object} a
 * @param {number} a.gStab    stability gate 0..1 (from stabilityGate)
 * @param {number} [a.gSolar] insolation gate 0..1 (default 1)
 * @param {number} a.offshoreKt cross-shore gradient component (+offshore)
 * @param {number} [a.deltaT]  air-SST / land-sea ΔT (°C)
 * @param {number} [a.lapseRateCkm]
 * @param {number} [a.hMix]
 * @param {number} [a.quadMod] Quadrant modifier (from quadrantModifier.scoreMod)
 * @returns {{score:number, fGrad:number, fThermal:number, fStab2:number, gate:number}}
 */
export function seaBreezeScore(a) {
  const gS = a.gStab ?? 0.5
  const gSol = a.gSolar ?? 1
  const fg = fGrad(a.offshoreKt ?? 0)
  const ft = fThermal(a.deltaT)
  const fs2 = fStab2(a)
  const additive = 0.45 * fg + 0.35 * ft + 0.20 * fs2
  const score = clamp(10 * gS * gSol * additive + (a.quadMod ?? 0), 0, 10)
  return { score: round1(score), fGrad: round2(fg), fThermal: round2(ft), fStab2: round2(fs2), gate: round2(gS * gSol) }
}

/** Is a day "favourable" for a sea breeze? (gate healthy + cell present/quadrant ok) */
export function isFavourable({ gStab, gSolar = 1, sbi, quadMod }) {
  return (gStab ?? 0) * gSolar >= 0.35 && ((sbi ?? 0) > 0.05 || (quadMod ?? 0) > 0)
}

// ── Type-of-day classifier (4 classes) ───────────────────────────────────────
// Decision: 10 kn (100-900 m wind) is the class boundary; 12 kt is the score
// roll-off (lives in fGrad). See spec §5.
/**
 * @param {object} a
 * @param {number} a.lowLevelKt  100-900 m AGL wind speed (kt)
 * @param {boolean} a.favourable from isFavourable()
 * @param {number} [a.thermalBendDeg] signed surface-vs-gradient turn
 * @param {number} [a.sbi]        sea-breeze index 0..1
 * @param {boolean}[a.funnelFlag] funnelling detected in race box
 * @param {number} [a.frictionBandDeg=15]
 */
export function typeOfDay(a) {
  const friction = a.frictionBandDeg ?? 15
  if (a.funnelFlag) {
    return { cls: 'funnelled', label: 'Funnelled gradient wind' }
  }
  const thermalActive = (a.sbi != null && a.sbi > 0.05) ||
    (a.thermalBendDeg != null && Math.abs(a.thermalBendDeg) > friction + 10)
  if (a.lowLevelKt != null && a.lowLevelKt < 10) {
    return a.favourable
      ? { cls: 'pure_seabreeze', label: 'Pure sea breeze' }
      : { cls: 'gradient_light', label: 'Gradient / light residual + trend' }
  }
  if (a.favourable && thermalActive) {
    return { cls: 'thermally_enhanced', label: 'Thermally-enhanced gradient' }
  }
  return { cls: 'gradient', label: 'Gradient wind day + trend' }
}

// ── Cloud-cover trend (insolation) ───────────────────────────────────────────
// Land-minus-sea low-cloud trend over the 09-13 heating window. See spec §7.
/**
 * @param {object} a  oktas (0-8)
 * @param {number} a.landCloudAm   mean low cloud over upwind land 09-11
 * @param {number} [a.landCloudMid] mean 11-13
 * @param {boolean}[a.precipLandPM] convective precip over land in the afternoon
 * @param {boolean}[a.cloudOverWaterLandClear] cloud over sea but land clear (enhancing)
 * @returns {{signal:number, verdict:string, note:string}}  signal ∈ [-1,1]
 */
export function cloudTrend(a) {
  if (a.landCloudAm == null) return { signal: 0, verdict: 'unknown', note: 'no land-cloud data' }
  const am = a.landCloudAm
  const mid = a.landCloudMid ?? am
  const trend = mid - am
  let signal = clamp((4 - am) / 4 - 0.5 * Math.max(trend, 0) / 2, -1, 1)
  if (a.cloudOverWaterLandClear) signal = clamp(signal + 0.2, -1, 1)
  if (a.precipLandPM) signal = -1
  let verdict; let note
  if (a.precipLandPM) { verdict = 'collapse'; note = 'convective precip over land → sea-breeze switch-off risk' }
  else if (am <= 2 && trend <= 0) { verdict = 'favourable'; note = 'clear/clearing over land → full build' }
  else if (am >= 6) { verdict = 'suppressed'; note = 'persistent overcast over land → insolation cut' }
  else if (trend > 1) { verdict = 'at-risk'; note = 'cloud building through midday → overdevelopment risk' }
  else { verdict = 'neutral'; note = 'partial cloud → delayed / weaker breeze' }
  return { signal: round2(signal), verdict, note }
}

// ── Confidence (High/Moderate/Low) ───────────────────────────────────────────
// Multi-model agreement weighted highest; light air (<7 kn) both lowers skill
// (σ_dir ∝ 1/V) AND caps the label. See spec §9.
/**
 * @param {object} a
 * @param {number} [a.seaBreezeMarginality] 0..1 (1 = clean, confident regime)
 * @param {number} a.sigmaTwd  circular std of TWD across models (deg)
 * @param {number} [a.sigmaTws] std of TWS across models (kn)
 * @param {number} a.twsKn     ensemble-mean forecast speed (kn)
 * @returns {{label:'HIGH'|'MODERATE'|'LOW', score10:number, sigmaTwd:number|null, components:object}}
 */
export function confidence(a) {
  const S = clamp01(a.seaBreezeMarginality ?? 0.5)
  const Mdir = clamp01(1 - (a.sigmaTwd ?? 20) / 40)
  const Mspd = clamp01(1 - (a.sigmaTws ?? 2) / 4)
  const M = 0.6 * Mdir + 0.4 * Mspd
  const w = a.twsKn ?? 10
  let L
  if (w >= 9) L = 1
  else if (w >= 7) L = 0.4 + ((w - 7) / 2) * 0.6
  else if (w >= 5) L = 0.4
  else L = 0.2
  const core = 0.35 * S + 0.40 * M + 0.25 * L
  const Lcap = Math.min(1, 0.5 + 0.5 * L)
  const score10 = clamp(10 * core * Lcap, 0, 10)
  const label = score10 >= 7 ? 'HIGH' : score10 >= 4 ? 'MODERATE' : 'LOW'
  return { label, score10: round1(score10), sigmaTwd: a.sigmaTwd != null ? Math.round(a.sigmaTwd) : null, components: { S: round2(S), M: round2(M), L: round2(L) } }
}

// ── Funnelling / channelled gradient wind (from the wind-field grid) ──────────
// Spec §8. Detects topographic wind acceleration on the ~1 km field. NB the
// VENTURI / "funnel" analogy is physically WRONG for straits/headlands — the max
// wind sits at the gap EXIT / just downwind of a headland, NOT at the narrowest
// throat. So funnel CORES are marked where the flow is fast AND STILL accelerating
// (along-flow ∂S/∂s > 0), which biases them downstream as the physics requires.
//
// Grid convention (matches windField.js): u eastward m/s, v northward m/s, flat
// arrays indexed p = j*nx + i; i = W→E (lon = lo1 + i*dx), j = N→S (lat = la1 - j*dy).
const MPERDEG = 111320

/** wind vector components (m/s) from speed + met "from" bearing — mirrors toUV. */
export function windUV(speedMs, dirFromDeg) {
  if (speedMs == null || dirFromDeg == null) return [0, 0]
  const th = dirFromDeg * D2R
  return [-speedMs * Math.sin(th), -speedMs * Math.cos(th)]
}

function median(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Funnelling diagnostics over one wind-field frame.
 * @param {object} g {nx,ny,lo1,la1,dx,dy, u:number[], v:number[]}  (dx,dy in degrees)
 * @param {object} [o]
 * @param {number} [o.rFunnel=1.3]  speed-up ratio to flag an acceleration zone
 * @param {number} [o.rShadow=0.8]  ratio below which = lee/bay shadow
 * @param {number} [o.dConv=-1e-4]  divergence (s⁻¹) at/below which = convergence line
 * @returns {{ nx,ny, lat:number[], lon:number[], S,R,div,alongAccel:Float64Array,
 *            funnel,shadow,conv:Uint8Array, sRef:number, sMax:number,
 *            cores:Array<{lat,lon,R}>, convLine:Array<{lat,lon}> }}
 */
export function funnelDiagnostics(g, o = {}) {
  const rFunnel = o.rFunnel ?? 1.3
  const rShadow = o.rShadow ?? 0.8
  const dConv = o.dConv ?? -1e-4
  const { nx, ny, lo1, la1, dx, dy, u, v } = g
  const n = nx * ny
  const S = new Float64Array(n)
  for (let p = 0; p < n; p++) S[p] = Math.hypot(u[p] || 0, v[p] || 0)
  const lat = Array.from({ length: ny }, (_, j) => la1 - j * dy)
  const lon = Array.from({ length: nx }, (_, i) => lo1 + i * dx)
  const sRef = median(Array.from(S).filter((s) => s > 0.1)) || 1
  const sMax = S.reduce((m, s) => (s > m ? s : m), 0)

  const R = new Float64Array(n)
  const div = new Float64Array(n)
  const alongAccel = new Float64Array(n)
  const funnel = new Uint8Array(n)
  const shadow = new Uint8Array(n)
  const conv = new Uint8Array(n)
  const dyM = dy * MPERDEG

  for (let j = 1; j < ny - 1; j++) {
    const dxM = dx * MPERDEG * Math.cos(lat[j] * D2R)
    for (let i = 1; i < nx - 1; i++) {
      const p = j * nx + i
      R[p] = S[p] / sRef
      const pe = p + 1; const pw = p - 1        // east / west neighbours (i±1)
      const pn = p - nx; const ps = p + nx      // north (j-1) / south (j+1)
      // ∂/∂x eastward, ∂/∂north (north = decreasing j)
      const dudx = (u[pe] - u[pw]) / (2 * dxM)
      const dvdy = -(v[ps] - v[pn]) / (2 * dyM)
      div[p] = dudx + dvdy
      const dSdx = (S[pe] - S[pw]) / (2 * dxM)
      const dSdN = -(S[ps] - S[pn]) / (2 * dyM)
      alongAccel[p] = S[p] > 0.1 ? (u[p] * dSdx + v[p] * dSdN) / S[p] : 0
      // flags
      if (R[p] >= rFunnel && alongAccel[p] > 0) funnel[p] = 1     // fast AND accelerating
      if (R[p] <= rShadow && div[p] > 0) shadow[p] = 1            // slow + diverging = lee/bay
      if (div[p] <= dConv) conv[p] = 1                            // convergence line
    }
  }
  const cores = []
  const convLine = []
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const p = j * nx + i
      if (funnel[p]) cores.push({ lat: lat[j], lon: lon[i], R: round2(R[p]) })
      if (conv[p]) convLine.push({ lat: lat[j], lon: lon[i] })
    }
  }
  return { nx, ny, lat, lon, S, R, div, alongAccel, funnel, shadow, conv, sRef: round2(sRef), sMax: round2(sMax), cores, convLine }
}

/** Is a funnel core present within `radiusNm` of (lat,lon)? Feeds type-of-day class (iv). */
export function funnelFlag(diag, lat, lon, radiusNm = 5) {
  if (!diag || !diag.cores || !diag.cores.length) return false
  const cosLat = Math.cos(lat * D2R)
  const r2 = (radiusNm / 60) ** 2   // deg² (1 nm = 1/60°)
  return diag.cores.some((c) => {
    const dLat = lat - c.lat; const dLon = (lon - c.lon) * cosLat
    return dLat * dLat + dLon * dLon <= r2
  })
}
