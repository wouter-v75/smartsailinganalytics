// How an observation DRAWS and what it says when you tap it.
//
// Pure so it can be tested: ForecastView hands the HTML to a Leaflet divIcon and
// the text to a tooltip. Kept out of the component for the same reason the rest
// of lib/ is — the arithmetic here (what gets corrected, what does not) is the
// part worth pinning down, and a JSX file is not typechecked in this repo.

import { OBS_SOURCES, ageMinutes, OBS_STALE_MIN, type WindObs } from './windObs'
import { barbSvg, kn1 } from './windBarb'
import { trueToMagnetic } from './magVar'
import type { ObsDetail } from './windObsDeclutter'

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
 * The marker: a standard wind BARB pointing at the wind's source, coloured by
 * network, with the exact speed beside it to one decimal.
 *
 * The barb replaced an arrow because a field of arrows has to be read one
 * station at a time — each one needs its number parsed before it means anything.
 * Feathers are read as a picture: you see where the breeze is up across the
 * course without reading a single digit. The number stays because a barb is
 * quantised to 5 kn and the difference between 12 and 14 matters to a trimmer.
 *
 * A variable or calm wind gets a ring — it has a speed but no direction, and a
 * barb would invent one.
 */
export function obsMarkerHtml(o: WindObs, nowMs: number = Date.now(), detail: ObsDetail = 'speed'): string {
  const src = OBS_SOURCES[o.source]
  const col = src?.colour || '#94A3B8'
  const op = ageOpacity(o, nowMs)

  // MAGNETIC, not true. The barb already shows direction well enough to read a
  // shift across a course; a number is for when you have zoomed in to ask a
  // precise question, and then the useful one is what the compass in front of
  // the helm reads. Omitted rather than defaulted when the variation is
  // unknown — a true bearing under an M is the bug magVar.ts exists to prevent.
  const mag = detail === 'full' && o.twdDeg != null ? trueToMagnetic(o.twdDeg, o.lat, o.lon) : null

  // STACKED, speed over direction, not side by side. Side by side the two
  // numbers run together into one wide string and the eye cannot tell which is
  // which at a glance — and a wide label is also what collides first with the
  // next station's. Two short lines sit in the barb's own footprint.
  const rows = detail === 'barb' ? []
    : mag != null ? [kn1(o.twsKn), `${Math.round(mag)}°M`]
    : [kn1(o.twsKn)]

  const label = rows.length
    ? `<span style="display:flex;flex-direction:column;align-items:flex-start;`
      + `font:700 10px/1.05 system-ui,sans-serif;color:${col};`
      + `text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap">`
      + rows.map((r) => `<span>${r}</span>`).join('') + '</span>'
    : ''
  return `<div style="display:flex;align-items:center;gap:1px;opacity:${op.toFixed(2)};`
    + `pointer-events:auto;cursor:pointer">${barbSvg(o.twsKn, o.twdDeg, col, 1)}${label}</div>`
}

/**
 * Five facts and a prompt. Nothing else.
 *
 * It used to editorialise — "rougher surface than the water, so it reads low",
 * "reads the hill, not the course", "shown as measured, not corrected to 10 m".
 * All true, all worth knowing ONCE, and none of it worth re-reading every time
 * the pointer crosses a barb. What a tooltip is for is the numbers you cannot
 * fit on the map; the reasoning belongs in the panel and in the code.
 *
 * ANEMOMETER HEIGHT STAYS, and shows "--" when the network does not publish it.
 * That is the one line that distinguishes "this station disagrees with the
 * model" from "this station is not measuring the same quantity as the model",
 * and a blank is a real answer rather than a missing one.
 */
export function obsTooltipLines(o: WindObs, nowMs: number = Date.now()): string[] {
  const src = OBS_SOURCES[o.source]

  // Direction in MAGNETIC as well as true: magnetic is what the compass on the
  // boat reads and what a crew calls a shift in. Omitted, never defaulted, when
  // the variation is unknown — a true bearing under an M is the bug magVar.ts
  // exists to prevent.
  const mag = o.twdDeg == null ? null : trueToMagnetic(o.twdDeg, o.lat, o.lon)
  const dir = o.twdDeg == null
    ? 'variable'
    : `${Math.round(o.twdDeg)}°T${mag != null ? ` / ${Math.round(mag)}°M` : ''}`

  const a = ageMinutes(o, nowMs)
  const age = a == null ? '--'
    : a < 1 ? 'just now'
    : a >= OBS_STALE_MIN ? `${Math.round(a)} min — stale`
    : `${Math.round(a)} min`

  return [
    `${o.name} · ${src?.label || o.source}`,
    `Wind    ${kn1(o.twsKn)} kn`,
    `Dir     ${dir}`,
    `Gust    ${o.gustKn != null ? `${kn1(o.gustKn)} kn` : '--'}`,
    `Age     ${age}`,
    `Height  ${o.heightM != null ? `${o.heightM} m` : '--'}`,
    'Click to see data graph',
  ]
}

export const obsTooltipHtml = (o: WindObs, nowMs: number = Date.now()): string => {
  const lines = obsTooltipLines(o, nowMs)
  return lines.map((l, i) => {
    if (i === 0) return `<div style="font-weight:700">${esc(l)}</div>`
    // The prompt is not a fact; it should not read like one.
    if (i === lines.length - 1) return `<div style="opacity:.6;margin-top:3px;font-style:italic">${esc(l)}</div>`
    // The facts line up, so the eye runs down the values rather than hunting.
    return `<div style="opacity:.9;white-space:pre;font-family:ui-monospace,Menlo,monospace">${esc(l)}</div>`
  }).join('')
}

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
