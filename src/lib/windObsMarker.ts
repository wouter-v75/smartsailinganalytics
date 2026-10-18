// How an observation DRAWS and what it says when you tap it.
//
// Pure so it can be tested: ForecastView hands the HTML to a Leaflet divIcon and
// the text to a tooltip. Kept out of the component for the same reason the rest
// of lib/ is — the arithmetic here (what gets corrected, what does not) is the
// part worth pinning down, and a JSX file is not typechecked in this repo.

import { OBS_SOURCES, obs10mKn, ageMinutes, OBS_STALE_MIN, type WindObs } from './windObs'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
))

/**
 * Opacity by age. A station that stopped reporting an hour ago should LOOK like
 * it stopped — the alternative is a confident barb that is quietly historical.
 */
export function ageOpacity(o: WindObs, nowMs: number = Date.now()): number {
  const a = ageMinutes(o, nowMs)
  if (a == null) return 0.35
  if (a <= 15) return 1
  if (a >= OBS_STALE_MIN) return 0.3
  return 1 - 0.7 * ((a - 15) / (OBS_STALE_MIN - 15))
}

/**
 * The marker: an arrow pointing at the wind's SOURCE (met convention, same as the
 * deck's barbs), the speed in knots beside it, coloured by network.
 * A variable or calm wind gets a ring instead — it has a speed but no direction,
 * and an arrow would invent one.
 */
export function obsMarkerHtml(o: WindObs, nowMs: number = Date.now()): string {
  const src = OBS_SOURCES[o.source]
  const col = src?.colour || '#94A3B8'
  const op = ageOpacity(o, nowMs)
  const kn = Math.round(o.twsKn)
  const label = `<span style="font:700 11px/1 system-ui,sans-serif;color:${col};text-shadow:0 0 3px #000,0 0 2px #000">${kn}</span>`
  const body = o.twdDeg == null
    ? `<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="5.5" fill="none" stroke="${col}" stroke-width="2"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 18 18" style="transform:rotate(${o.twdDeg}deg)">`
      + `<path d="M9 1 L9 17 M9 1 L5.5 6 M9 1 L12.5 6" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"/></svg>`
  return `<div style="display:flex;align-items:center;gap:2px;opacity:${op.toFixed(2)};pointer-events:auto">${body}${label}</div>`
}

/**
 * What the station actually told us, and what we did to it. The height line is
 * the important one: it is the difference between "this reading disagrees with
 * the model" and "this reading is not the same quantity as the model".
 */
export function obsTooltipLines(o: WindObs, nowMs: number = Date.now()): string[] {
  const src = OBS_SOURCES[o.source]
  const lines: string[] = [`${o.name} · ${src?.label || o.source}`]

  const dir = o.twdDeg == null ? 'variable' : `${Math.round(o.twdDeg)}°`
  const gust = o.gustKn != null ? `, gusting ${Math.round(o.gustKn)}` : ''
  lines.push(`${o.twsKn.toFixed(1)} kn from ${dir}${gust}`)

  const v10 = obs10mKn(o)
  if (o.heightM == null) {
    // Not a detail: without a height we cannot put this on the same footing as
    // the model's 10 m wind, and saying so is the whole point of the line.
    lines.push('anemometer height not published — shown as measured, not corrected to 10 m')
  } else if (Math.abs(o.heightM - 10) < 0.5) {
    lines.push('measured at 10 m — directly comparable')
  } else if (v10 != null) {
    lines.push(`measured at ${o.heightM} m; ${v10.toFixed(1)} kn at 10 m`)
  }

  if (o.surface === 'land') {
    lines.push(o.elevM != null && o.elevM > 50
      ? `on land, ${Math.round(o.elevM)} m up — reads the hill, not the course`
      : 'on land — rougher surface than the water, so it reads low')
  }

  const a = ageMinutes(o, nowMs)
  if (a != null) lines.push(a < 1 ? 'just now' : a >= OBS_STALE_MIN ? `${Math.round(a)} min old — stale` : `${Math.round(a)} min old`)
  return lines
}

export const obsTooltipHtml = (o: WindObs, nowMs: number = Date.now()): string =>
  obsTooltipLines(o, nowMs).map((l, i) => (i === 0
    ? `<div style="font-weight:700">${esc(l)}</div>`
    : `<div style="opacity:.85">${esc(l)}</div>`)).join('')

/** Legend rows for the sources actually on screen — an unused colour is noise. */
export function obsLegend(obs: WindObs[]): Array<{ key: string; label: string; colour: string; n: number }> {
  const seen = new Map<string, number>()
  for (const o of obs) seen.set(o.source, (seen.get(o.source) || 0) + 1)
  // Array.from, not a spread: this repo's tsc target does not allow iterating a
  // Map iterator directly (TS2802).
  return Array.from(seen.entries())
    .map(([key, n]) => ({ key, label: OBS_SOURCES[key as keyof typeof OBS_SOURCES]?.label || key, colour: OBS_SOURCES[key as keyof typeof OBS_SOURCES]?.colour || '#94A3B8', n }))
    .sort((a, b) => b.n - a.n)
}
