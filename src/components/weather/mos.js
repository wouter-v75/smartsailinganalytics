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
import oslofjord from './mos/mos_oslofjord.json'
import viksfjord from './mos/mos_viksfjord.json'
import san_juan from './mos/mos_san_juan.json'
import long_beach from './mos/mos_long_beach.json'
import { wallHour, wallMonth } from './venueTz'
import { venueAt, venueByKey, VENUE_MATCH_NM } from '../../lib/venues'
import { solveSurfaceLayer, profileRatio, transferWind } from '../../lib/windProfile'
import { deltaKFromHourly } from '../../lib/seaTemp'

// SPECS ARE KEYED BY VENUE KEY — the one in lib/venues.ts, hyphenated. This
// file used to keep its own venue list, keyed with underscores, beside its own
// copy of the centre positions; forecastDiagnostics then keyed VENUE_COAST_NORMAL
// by THOSE keys while the observation network used hyphens. Three spellings of
// the same places, nothing keeping them in step, and every mismatch silent:
// a key that matches nothing is simply no correction.
//
// The JSON filenames keep their underscores; only the keys are shared.
const SPECS = {
  sorrento,
  'porto-cervo': porto_cervo,
  'st-tropez': st_tropez,
  // Fitted at 10 m against a station rather than at 30 m against a boat, so
  // needsPreLift() is TRUE for these three and the correction is applied
  // BEFORE the lift to mast height. That ordering is the whole reason
  // fit_height_m exists; see the block above fitHeightM().
  oslofjord,                 // Horten / Moss, truth frost:SN17280 Gullholmen
  viksfjord,                 // Larvik, truth frost:SN29950
  'san-juan': san_juan,      // truth ndbc:SISW1 Smith Island
  // Long Beach / San Pedro, truth coops:9410647 Angels Gate. The first spec
  // whose slope is PINNED at 1 (`slope_policy.constrained`): the rmse-optimal
  // slope here is 0.40-0.77 and shrinks the strong-wind tail away, so only the
  // bias, sector and diurnal offsets are fitted. It is also the first with a
  // seasonal window earned on its own — June-September, the Olympic and
  // Transpac racing season.
  'long-beach': long_beach,
}

/**
 * The venue key for a position, or null when it is not near a calibrated one.
 *
 * The position match, the radius and the venue centres all come from
 * lib/venues.ts now. The radius still matters for the same reason it always
 * did: outside it a point gets the raw forecast rather than a neighbour's
 * correction, because a correction fitted off Saint-Tropez is worse than
 * nothing at La Spezia.
 */
export function matchVenue(lat, lon) {
  const v = venueAt(lat, lon, VENUE_MATCH_NM)
  return v ? v.key : null
}

/** The venue's display name — "St Tropez", not a de-underscored key. */
export function venueLabel(key) {
  return venueByKey(key)?.name || null
}

export function specFor(venue) {
  return (venue && SPECS[venue]) || null
}

/** Venue keys that actually have fitted coefficients. */
export function calibratedVenues() {
  return Object.keys(SPECS)
}

/**
 * The height the correction was FITTED at, which decides the order of
 * operations — and it is not always the height the correction is wanted at.
 *
 * The three Mediterranean specs were fitted against a boat's 30 m masthead
 * log, so for them the model is lifted to 30 m and the correction applied
 * there. An Oslofjord spec is fitted against a 10 m lighthouse anemometer,
 * because that is where the only truth is, and it must be applied to the
 * model's own 10 m field BEFORE the lift.
 *
 * Getting that backwards is not a subtlety. A 10 m-fitted `a·x + b` applied to
 * a 30 m value keeps its slope but its INTERCEPT is wrong by the lift ratio —
 * about 1.08-1.12 in near-neutral marine air and considerably more on a stable
 * fjord morning, which is exactly when the lift is largest. So a +1.0 kn
 * offset silently becomes the wrong number precisely where it matters most.
 *
 * `fit_height_m` is the explicit answer; `target_height_m` is honoured as a
 * fallback so an older spec keeps its meaning, and 30 is the final default
 * because that is what every existing spec says.
 */
export function fitHeightM(spec) {
  const v = spec?.fit_height_m ?? spec?.target_height_m
  return Number.isFinite(v) && v > 0 ? v : 30
}

/**
 * Does this spec have to be applied BEFORE the vertical lift?
 *
 * True only when it was fitted below the height it is wanted at — a 10 m
 * lighthouse fit for a 30 m display. The three Mediterranean specs were fitted
 * at the display height itself, so they are false and keep their old
 * behaviour exactly, including where a boat's mast is not precisely 30 m.
 *
 * This is the question the call sites actually need answered. An earlier
 * version asked "is the fit height equal to the height I am working at",
 * which broke every existing path the moment a mast was 28 or 40 m rather
 * than exactly 30 — the spec was never claiming that precision.
 */
export function needsPreLift(spec) {
  const target = Number.isFinite(spec?.target_height_m) ? spec.target_height_m : 30
  return fitHeightM(spec) < target
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
export function wind30(hourly, heights, idx, targetZ = 30, defaultAlpha = 0.11, deltaK = null) {
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
    // ONE LEVEL ONLY — e.g. ICON-2I, which Open-Meteo serves at 10 m alone.
    // With two levels the fitted alpha above already carries whatever
    // stability the model has in it; with one there is nothing to fit, and a
    // blind exponent is a guess.
    //
    // So use the NEUTRAL MARINE LOG LAW instead, solved self-consistently
    // (Charnock roughness from the speed's own friction velocity) rather than
    // assumed. Over water that is alpha_eq ~ 0.074 at 10->30 m, against the
    // 0.11 this used to apply: the old default was about 2.5 % high, and the
    // textbook 1/7 would be 6.2 % high.
    //
    // IT IS STILL NEUTRAL, AND NEUTRAL IS NOT UNBIASED. A warm land breeze
    // over cooler water — the ordinary offshore morning — makes the true
    // 10->30 m increase +29.7 % where neutral says +8.4 %, so this
    // UNDERSTATES the masthead wind by about 2.1 kn at 10 kn and +2 K, and by
    // around 9 % on average. Fixing that needs an air-sea temperature
    // difference, which this fetch does not currently request; lib/windProfile
    // has the physics ready for when it does.
    // deltaK is air minus sea in kelvin, POSITIVE = stable. With it this is
    // the full Monin-Obukhov profile; without it the neutral one, which
    // understates the masthead by ~9 % and by 2.1 kn on a light offshore
    // morning. Passing 0 would claim neutrality we have not measured, so a
    // missing value stays null and solveSurfaceLayer is given 0 only as the
    // honest no-information case.
    const dK = Number.isFinite(deltaK) ? deltaK : 0
    const layer = solveSurfaceLayer(lv[0].sp * 0.514444, dK, { refZ: lv[0].z })
    const r = profileRatio(targetZ, lv[0].z, layer.z0, layer.lengthM)
    sp30 = lv[0].sp * (r > 0 ? r : Math.pow(targetZ / lv[0].z, defaultAlpha))
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

/**
 * The months a spec's SEASONAL coefficients apply in, or null when it has none.
 *
 * A season window exists because the thing being corrected is seasonal. The
 * three Mediterranean specs were fitted on regatta days, every one of them in
 * summer, so their diurnal term is a summer sea-breeze harmonic that was never
 * asked to survive a February gale. A fit that spans twelve months averages
 * that amplitude against the months that have none and then applies the
 * average in both, which is wrong twice.
 */
export function seasonMonths(spec) {
  const m = spec?.seasonal?.months
  return Array.isArray(m) && m.length ? m.map(Number) : null
}

/** Does this spec carry a separate set of seasonal coefficients? */
export function hasSeasonal(spec) {
  return !!(seasonMonths(spec) && spec.seasonal?.models)
}

/**
 * The coefficients for one model at one month: the seasonal set inside the
 * window, the year-round set outside it.
 *
 * A caller that cannot work out the venue-local month gets the year-round set.
 * That is the right default — it is the set fitted on the most data — but it
 * means a path with no date in scope silently disagrees with the hourly table
 * inside the window, so such paths refuse a seasonal spec outright instead
 * (see applyMosToField).
 */
export function modelSpecFor(spec, mosModelId, localMonth) {
  const year = spec?.models?.[mosModelId] || null
  const months = seasonMonths(spec)
  if (!months || localMonth == null || !months.includes(Number(localMonth))) {
    return { m: year, season: null }
  }
  const s = spec.seasonal?.models?.[mosModelId]
  if (!s) return { m: year, season: null }
  return { m: s, season: spec.seasonal.label || months.join(',') }
}

// Apply the fitted correction. `mosModelId` is the Open-Meteo id the MOS was
// trained on (MODELS[key].mosModel). `localMonth` (1-12, venue-local) selects
// the seasonal coefficients where a spec has them; omitting it keeps the
// year-round set, which is what every pre-seasonal caller gets.
// Returns { ws (kn), type, season } or null when no correction exists for this
// model/venue.
export function applyMOS(spec, mosModelId, ws30, twd, localHour, localMonth) {
  const { m, season } = modelSpecFor(spec, mosModelId, localMonth)
  if (!m) return null
  const t = m.type || 'raw'
  if (t === 'raw') return { ws: ws30, type: 'raw', season }
  const base = m.a * ws30 + m.b
  if (t === 'bias_scale') return { ws: base, type: t, season }
  if (t === 'diurnal') {
    if (localHour == null) return { ws: base, type: t, season }
    const ang = (2 * Math.PI * localHour) / 24
    return { ws: base + m.c0 + m.c1 * Math.sin(ang) + m.c2 * Math.cos(ang), type: t, season }
  }
  if (t === 'sector') {
    if (twd == null) return { ws: base, type: t, season }
    const sec = assignSector(twd, spec.bands || [])
    const d = m.delta || {}
    return { ws: base + (sec in d ? d[sec] : m.global), type: t, sector: sec, season }
  }
  if (t === 'sector_diurnal') {
    // Both terms, each degrading on its own: no direction drops the band
    // offset and keeps the harmonic, no hour the other way round. predictSpecModel
    // in lib/mosFit.ts mirrors this term for term and a test pins the two together.
    let ws = base
    let sec = null
    if (twd != null) {
      sec = assignSector(twd, spec.bands || [])
      const d = m.delta || {}
      ws += sec in d ? d[sec] : m.global
    }
    if (localHour != null) {
      const ang = (2 * Math.PI * localHour) / 24
      ws += (m.c0 || 0) + m.c1 * Math.sin(ang) + m.c2 * Math.cos(ang)
    }
    return { ws, type: t, sector: sec, season }
  }
  return { ws: ws30, type: 'raw', season }
}

// Local clock hour in a timezone (mirrors the table's hour calc). A zone-less
// Open-Meteo time is already venue wall-clock, so its digits ARE the hour — the old
// new Date() round-trip applied MOS at the wrong hour whenever the viewer's zone
// differed from the venue's.
export function hourInTz(timeStr, tz) {
  const h = wallHour(timeStr, tz)
  return Number.isFinite(h) ? h : new Date(timeStr).getHours()
}

/**
 * The corrected 30 m wind for one hour, in the right order for this spec.
 *
 * ONE PLACE OWNS THE ORDERING. Both orders are here because both are needed:
 *
 *   fit at 30 m  ->  lift the model to 30 m, then correct    (the Med specs)
 *   fit at 10 m  ->  correct the model's 10 m field, then lift  (Oslofjord)
 *
 * The second order is what the research concluded: fit the statistical step in
 * the space where the observations are, so the residual is a pure measure of
 * model-versus-observation disagreement and the profile's own error stays a
 * separate, inspectable term instead of being absorbed into the slope. The
 * literature has no head-to-head test of the two orders, but it is unanimous
 * in practice about fitting where the truth is.
 *
 * The surface layer is solved from the CORRECTED speed, not the raw one: once
 * the correction is applied, that is our best estimate of the actual wind, and
 * the roughness and stability length should follow it.
 *
 * Returns { ws, twd, fitZ, lifted } or null.
 */
export function correctedWind30(hourly, heights, idx, spec, mosModelId, tz, sst = null, targetZ = 30) {
  const fitZ = fitHeightM(spec)
  const dK = deltaKFromHourly(hourly, idx, sst)
  const hour = hourInTz(hourly.time[idx], tz)
  // Venue-local, for the same reason the hour is: a season boundary is a
  // statement about the weather there, not about the viewer's calendar.
  const month = wallMonth(hourly.time[idx], tz)

  if (fitZ >= targetZ) {
    // Lift first, correct second — correct for a spec fitted at the target.
    const w = wind30(hourly, heights, idx, targetZ, 0.11, dK)
    if (!w) return null
    const r = applyMOS(spec, mosModelId, w.ws30, w.twd, hour, month)
    return r ? { ws: r.ws, twd: w.twd, fitZ, lifted: false, season: r.season } : null
  }

  // Correct at the fit height, then lift. wind30 at the fit height returns the
  // model's own field there: for a single-level model the profile ratio is
  // exactly 1, so nothing is modelled on the way in.
  const w = wind30(hourly, heights, idx, fitZ, 0.11, dK)
  if (!w) return null
  const r = applyMOS(spec, mosModelId, w.ws30, w.twd, hour, month)
  if (!r) return null
  if (!(r.ws > 0)) return { ws: r.ws, twd: w.twd, fitZ, lifted: false, season: r.season }
  const layer = solveSurfaceLayer(r.ws * 0.514444, Number.isFinite(dK) ? dK : 0, { refZ: fitZ })
  const t = transferWind(r.ws, fitZ, targetZ, layer)
  // `uncertainty` is carried out deliberately. The research is explicit that
  // nothing in this data validates a 30 m value: the correction is verified at
  // the fit height and the lift is a separate, unverified step. Returning its
  // own uncertainty is what keeps those two things from being confused.
  return {
    ws: t.kn, twd: w.twd, fitZ, lifted: true, season: r.season,
    quality: t.quality, liftRatio: t.ratio, liftUncertainty: t.uncertainty, note: t.note,
  }
}

// Whole MOS-corrected 30 m series (kn) for a model's hourly payload, or null.
export function mosSeries(hourly, heights, spec, mosModelId, tz, sst = null) {
  if (!hourly?.time || !spec?.models?.[mosModelId]) return null
  if ((spec.models[mosModelId].type || 'raw') === 'raw') return null
  return hourly.time.map((t, i) => {
    // The venue's SST, where it was fetched, gives the stability term its
    // air-sea difference. Null simply falls back to the neutral profile.
    const r = correctedWind30(hourly, heights, i, spec, mosModelId, tz, sst)
    return r ? r.ws : null
  })
}

// Convenience: does a usable (non-raw) correction exist for this model+venue?
export function correctionInfo(venue, mosModelId) {
  const spec = SPECS[venue]
  const m = spec?.models?.[mosModelId]
  if (!m || (m.type || 'raw') === 'raw') return null
  // `reexpressed` says the coefficients were rewritten for a different model
  // input — the sea grid cell, after cell_selection was fixed — rather than
  // refitted. Such a spec carries no cv_rmse ON PURPOSE: the stored one
  // measured a regression against the old input and does not describe this
  // one. The badge has to say that instead of printing "CV RMSE undefined".
  return { type: m.type, cv_rmse: m.cv_rmse, reduction_pct: m.reduction_pct,
           sector_agreement: m.sector_agreement, reexpressed: !!m.reexpressed_from }
}
