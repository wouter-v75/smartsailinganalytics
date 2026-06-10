// MOS (Model Output Statistics) runtime correction for mast-height (30 m) TWS.
//
// Turns each model's raw 30 m forecast into a venue-tuned, bias-corrected
// 30 m TWS, using coefficients fitted offline against 3 years of NORTHSTAR
// logfile wind (see Smart Sailing Analytics/wind-verification). Corrections are
// only applied when the selected point is near one of the calibrated venues and
// the model has a fitted correction for that venue; otherwise the raw value is
// returned untouched.
//
// Self-contained — mirrors apply_mos.py / apply_mos.js. No external deps.

import sorrento from './mos/mos_sorrento.json'
import porto_cervo from './mos/mos_porto_cervo.json'
import st_tropez from './mos/mos_st_tropez.json'

const SPECS = { sorrento, porto_cervo, st_tropez }

// Venue race-area centres + match radius (deg). Generous enough to catch a
// marker dropped anywhere on the course.
const VENUE_CENTERS = {
  sorrento: [40.60, 14.42],
  porto_cervo: [41.13, 9.54],
  st_tropez: [43.27, 6.62],
}
const MATCH_RADIUS_DEG = 0.35

export function matchVenue(lat, lon) {
  let best = null
  let bd = Infinity
  for (const [v, [la, lo]] of Object.entries(VENUE_CENTERS)) {
    const d = Math.hypot(lat - la, lon - lo)
    if (d < bd) { bd = d; best = v }
  }
  return bd <= MATCH_RADIUS_DEG ? best : null
}

export function specFor(venue) {
  return SPECS[venue] || null
}

// ── wind vectors (meteorological FROM convention) ──────────────────────
function toUV(spd, dir) {
  const r = (dir * Math.PI) / 180
  return [-spd * Math.sin(r), -spd * Math.cos(r)]
}
function dirFromUV(u, v) {
  return (((Math.atan2(-u, -v) * 180) / Math.PI) % 360 + 360) % 360
}
const KMH_TO_KN = 0.539957

// Raw model wind at the target height (default 30 m), interpolated from the
// model's available levels. Speed via fitted-α power-law (or a climatological
// α when only one level exists, e.g. ICON-2I @10 m); direction via u/v interp.
// `heights` is MODELS[key].heights; `hourly` the Open-Meteo payload; speeds in
// the payload are km/h. Returns { ws30 (kn), twd (deg), nLevels } or null.
export function wind30(hourly, heights, idx, targetZ = 30, defaultAlpha = 0.11) {
  if (!hourly) return null
  const lv = []
  for (const h of heights) {
    const s = hourly[`wind_speed_${h}m`]?.[idx]
    const d = hourly[`wind_direction_${h}m`]?.[idx]
    if (s != null && s > 0) lv.push({ z: h, sp: s * KMH_TO_KN, di: d })
  }
  if (lv.length === 0) return null

  let sp30
  if (lv.length >= 2) {
    const xs = lv.map((p) => Math.log(p.z))
    const ys = lv.map((p) => Math.log(p.sp))
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let num = 0; let den = 0
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2 }
    const alpha = den ? num / den : defaultAlpha
    sp30 = Math.exp(alpha * Math.log(targetZ) + (my - alpha * mx))
  } else {
    sp30 = lv[0].sp * Math.pow(targetZ / lv[0].z, defaultAlpha)
  }

  // direction: linear u/v interpolation between bracketing levels
  const s = lv.slice().sort((a, b) => a.z - b.z)
  let dir
  if (targetZ <= s[0].z) dir = s[0].di
  else if (targetZ >= s[s.length - 1].z) dir = s[s.length - 1].di
  else {
    let lo = s[0]; let hi = s[s.length - 1]
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i].z <= targetZ && s[i + 1].z >= targetZ) { lo = s[i]; hi = s[i + 1]; break }
    }
    const f = (targetZ - lo.z) / (hi.z - lo.z)
    const [ul, vl] = toUV(lo.sp, lo.di)
    const [uh, vh] = toUV(hi.sp, hi.di)
    dir = dirFromUV(ul + f * (uh - ul), vl + f * (vh - vl))
  }
  return { ws30: sp30, twd: dir, nLevels: lv.length }
}

function assignSector(twd, bands) {
  const t = ((twd % 360) + 360) % 360
  for (const [name, lo, hi] of bands) {
    if (lo <= hi) { if (t >= lo && t <= hi) return name } else if (t >= lo || t <= hi) return name
  }
  return 'other'
}

// Apply the fitted correction. `mosModelId` is the Open-Meteo id the MOS was
// trained on (MODELS[key].mosModel). Returns { ws (kn), type } or null when no
// correction exists for this model/venue.
export function applyMOS(spec, mosModelId, ws30, twd, localHour) {
  const m = spec?.models?.[mosModelId]
  if (!m) return null
  const t = m.type || 'raw'
  if (t === 'raw') return { ws: ws30, type: 'raw' }
  const base = m.a * ws30 + m.b
  if (t === 'bias_scale') return { ws: base, type: t }
  if (t === 'diurnal') {
    if (localHour == null) return { ws: base, type: t }
    const ang = (2 * Math.PI * localHour) / 24
    return { ws: base + m.c0 + m.c1 * Math.sin(ang) + m.c2 * Math.cos(ang), type: t }
  }
  if (t === 'sector') {
    if (twd == null) return { ws: base, type: t }
    const sec = assignSector(twd, spec.bands || [])
    return { ws: base + (sec in m.delta ? m.delta[sec] : m.global), type: t, sector: sec }
  }
  return { ws: ws30, type: 'raw' }
}

// Local clock hour in a timezone (mirrors the table's hour calc).
export function hourInTz(timeStr, tz) {
  try {
    return parseInt(new Date(timeStr).toLocaleString('en-GB',
      { timeZone: tz, hour: '2-digit', hour12: false }), 10)
  } catch {
    return new Date(timeStr).getHours()
  }
}

// Whole MOS-corrected 30 m series (kn) for a model's hourly payload, or null.
export function mosSeries(hourly, heights, spec, mosModelId, tz) {
  if (!hourly?.time || !spec?.models?.[mosModelId]) return null
  if ((spec.models[mosModelId].type || 'raw') === 'raw') return null
  return hourly.time.map((t, i) => {
    const w = wind30(hourly, heights, i)
    if (!w) return null
    const r = applyMOS(spec, mosModelId, w.ws30, w.twd, hourInTz(t, tz))
    return r ? r.ws : null
  })
}

// Convenience: does a usable (non-raw) correction exist for this model+venue?
export function correctionInfo(venue, mosModelId) {
  const spec = SPECS[venue]
  const m = spec?.models?.[mosModelId]
  if (!m || (m.type || 'raw') === 'raw') return null
  return { type: m.type, cv_rmse: m.cv_rmse, reduction_pct: m.reduction_pct,
           sector_agreement: m.sector_agreement }
}
