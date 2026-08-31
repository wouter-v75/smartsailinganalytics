// windweightPoint.js — the ONE point-1 windweight recompute, shared by the
// Stability tab's WindWeightPanel and the forecast deck.
//
// Why it exists: the box publishes icon-race/<domain>/<venue>/windweight.json from
// a BOX-AVERAGED profile whose u/v are averaged as VECTORS, so horizontal
// directional spread cancels and V_H reads several knots low exactly when the sea
// breeze is setting up. Worse, that cancellation shrinks with height, so it also
// fabricates vertical shear. The venue grid the app already holds carries wind
// SPEED per height at every cell, so the shape term can be redone at POINT 1 and
// anchored to the MOS masthead speed — the same wind the tables and map show.
//
// Density / gust / funnel are near-uniform across a ~30 km race box and need T/RH/p
// and turbulence the app has no point value for, so those factors pass through from
// the published hour unchanged.
//
// Directional shear is returned ALONGSIDE, never inside the weight: force at each
// height is set by the local wind SPEED and the sail is twisted to the local
// direction, so veer is a tack asymmetry (it frees the top on one tack and heads it
// on the other), not a load term.

import { MODELS, rigDirectionShearDeg, interpolateDirectionAtHeight } from './openMeteo'
import { matchVenue, specFor, applyMOS } from './mos'
import { windweightFromProfile } from '../../lib/windweight'

// The SSA-Race resolution a published windweight domain came from.
export function modelKeyForDomain(domain) {
  return String(domain || '').endsWith('_1km') ? 'ICONRACE_1KM' : 'ICONRACE'
}

// Pull the point's hourly payload for that model, preferring the named location.
function hourlyFor(windData, locKey, modelKey) {
  return (locKey && windData?.[locKey]?.surfaceByModel?.[modelKey]?.hourly)
    || Object.values(windData || {}).find((p) => p?.surfaceByModel?.[modelKey]?.hourly)
      ?.surfaceByModel?.[modelKey]?.hourly
    || null
}

// hour -> { ww, vHKt, vEffKt, fProfile, cls, profile, shearDeg, mosOn }
// keyed by LOCAL hour on `todayLocal` (YYYY-MM-DD, venue-local).
//
// `localHour` / `localDate` are injected so each caller keeps its own tz helpers
// (the panel and the deck format local time differently) without this module
// growing a third one.
export function pointWindweightByHour({
  windData, locKey, coords, domain, mastHeight = 34,
  boxByHour = {}, localHour, localDate, todayLocal,
}) {
  const out = {}
  const modelKey = modelKeyForDomain(domain)
  const hourly = hourlyFor(windData, locKey, modelKey)
  const heights = MODELS[modelKey]?.heights
  const times = hourly?.time
  if (!hourly || !heights || !times || !coords) return out

  // MOS for this venue + the model the grid came from. The SSA-Race pair inherit
  // icon_eu (mosApprox), which is flagged as approximate elsewhere in the UI.
  const venueKey = matchVenue(coords.latitude, coords.longitude)
  const spec = venueKey ? specFor(venueKey) : null
  const mosId = MODELS[modelKey]?.mosModel

  for (let i = 0; i < times.length; i++) {
    const ms = Date.parse(times[i])
    if (isNaN(ms) || localDate(ms) !== todayLocal) continue
    const hr = localHour(ms)
    const box = boxByHour[hr]

    // payload speeds are km/h; the integral wants m/s
    const speeds = heights.map((h) => { const v = hourly[`wind_speed_${h}m`]?.[i]; return v == null ? null : v / 3.6 })
    const hs = heights.filter((_, k) => speeds[k] != null)
    const ss = speeds.filter((v) => v != null)
    if (hs.length < 2) continue

    // Raw masthead speed at point 1, then MOS on the ANCHOR only. MOS is a
    // single-height scalar fit; applying it level by level would distort the shape
    // (its additive term bites hardest at the slowest, lowest levels).
    const raw = windweightFromProfile({ heightsM: hs, speedsMs: ss, H: mastHeight })
    if (!raw) continue
    let vHKt = raw.vHKt
    let mosOn = false
    if (spec && mosId) {
      const twd = interpolateDirectionAtHeight(hourly, heights, mastHeight, i)
      const m = applyMOS(spec, mosId, vHKt, twd, hr)
      if (m && m.ws > 0 && m.type !== 'raw') { vHKt = m.ws; mosOn = true }
    }

    const r = windweightFromProfile({
      heightsM: hs, speedsMs: ss, H: mastHeight, vHKtOverride: vHKt,
      fRho: box?.factors?.rho, fGust: box?.factors?.gust, fFunnel: box?.factors?.funnel,
    })
    if (!r) continue

    const sh = rigDirectionShearDeg(hourly, heights, mastHeight, i)
    out[hr] = { ...r, shearDeg: sh == null ? null : Math.round(sh), mosOn, hasBoxFactors: !!box?.factors }
  }
  return out
}

// Shape a point-1 result like a published windweight.json hour, so callers that
// already render the box product can swap it in without touching their renderers.
export function asBoxHour(pt, boxHour) {
  if (!pt) return boxHour || null
  return {
    ...(boxHour || {}),
    WW: Math.round(pt.ww * 10) / 10,
    V_eff: Math.round(pt.vEffKt * 10) / 10,
    V_H: Math.round(pt.vHKt * 10) / 10,
    cls: pt.cls,
    profile: pt.profile,
    shearDeg: pt.shearDeg,
    mosOn: pt.mosOn,
  }
}
