// The Sails section of a routing-climatology report: the boat's crossover chart
// with the race's sailing time drawn on it, the share of time per sail as bars,
// and a table. Shared by scripts/route-climatology.ts (hours off the routes
// themselves) and scripts/route-sail-hours.ts (hours off a finished study's saved
// TWA x TWS table, so a study can be read against a chart without routing again).
//
// Time outside every shape went to the sail on the chart's VMG edge (assign.ts) and is
// hatched in the bars, so an extrapolation is never mistaken for the chart's answer.
// The section carries its own <style>, so it can be dropped into a report written
// before it existed.

import { outline } from '../sailchart/geometry'
import { centroid, type SailChart } from '../sailchart/model'
import type { SailHours, HoursTable } from '../sailchart/assign'

export interface SailMethod { key: string; label: string; sails: SailHours; table: HoursTable }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const pc = (f: number | undefined) => (f != null && Number.isFinite(f) ? `${Math.round(100 * f)} %` : '–')

export const SAIL_SECTION_CSS = `.sc .grat line{stroke:#ddd;stroke-width:.6}.sc text{font-size:11px;fill:#555}.sc .sl{font-size:12px;font-weight:700;fill:#111;paint-order:stroke;stroke:#fff;stroke-width:3px}.sc .tdot{fill:#111;fill-opacity:.42}.sb text{font-size:11px;fill:#333}.sb .bl{font-size:12px;font-weight:600}.sw{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:2px;vertical-align:-1px}
@media (prefers-color-scheme:dark){.sc .grat line{stroke:#333}.sc text,.sb text{fill:#bbb}.sc .sl{fill:#eee;stroke:#111}.sc .tdot{fill:#eee;fill-opacity:.5}}`

export function sailSectionHtml(
  chart: SailChart,
  ms: SailMethod[],
  o: { mast: number; races?: number; fromTable?: boolean },
): string {
  if (!ms.length) return ''
  const colourOf = new Map<string, string>()
  for (const s of chart.sails) if (!colourOf.has(s.name)) colourOf.set(s.name, s.colour)
  const drawn = chart.sails.filter(s => s.visible && s.points.length >= 3)
  const find = (m: SailMethod, nm: string) => m.sails.sails.find(y => y.name === nm)!

  // The chart: TWA across, TWS up, as the Sail chart tab draws it.
  const W = 900, H = 430, L = 46, R = 14, T = 12, B = 38
  const a0 = 30, a1 = 180, w0 = 0, w1 = 32
  const X = (a: number) => L + ((Math.max(a0, Math.min(a1, a)) - a0) / (a1 - a0)) * (W - L - R)
  const Y = (w: number) => H - B - ((Math.max(w0, Math.min(w1, w)) - w0) / (w1 - w0)) * (H - T - B)
  let g = ''
  for (let a = a0; a <= a1; a += 10) g += `<line x1="${X(a)}" y1="${T}" x2="${X(a)}" y2="${H - B}"/><text x="${X(a)}" y="${H - B + 15}" text-anchor="middle">${a}</text>`
  for (let w = w0; w <= w1; w += 4) g += `<line x1="${L}" y1="${Y(w)}" x2="${W - R}" y2="${Y(w)}"/><text x="${L - 6}" y="${Y(w) + 4}" text-anchor="end">${w}</text>`
  const shapes = drawn.map(s => {
    const d = outline(s.points, 12, !!s.extra?.straight).map((p, k) => `${k ? 'L' : 'M'}${X(p.twa).toFixed(1)},${Y(p.tws).toFixed(1)}`).join('') + 'Z'
    return `<path d="${d}" fill="${s.colour}" fill-opacity="${(Math.max(15, Math.min(70, s.opacity || 40)) / 100).toFixed(2)}" stroke="${s.colour}" stroke-width="1.6"${s.dashed ? ' stroke-dasharray="5 3"' : ''}><title>${esc(s.name)} (${esc(s.group)})</title></path>`
  }).join('')
  const labels = drawn.map(s => {
    const c = s.label ?? centroid(s.points)
    return `<text class="sl" x="${X(c.twa).toFixed(1)}" y="${(Y(c.tws) + 4).toFixed(1)}" text-anchor="middle">${esc(s.name)}</text>`
  }).join('')
  // Sailing time: a dot per table bin, area proportional to the hours.
  const tm = ms[0].table
  let hmax = 1e-9
  for (const row of tm.hours) for (const v of row) if (v > hmax) hmax = v
  const aStep = tm.twaEdges.length > 2 ? tm.twaEdges[2] - tm.twaEdges[1] : 5
  let dots = ''
  tm.hours.forEach((row, r) => row.forEach((hh, c) => {
    if (!(hh > 0)) return
    const lastA = r === tm.twaEdges.length - 1, lastW = c === tm.twsEdges.length - 1
    const ac = r === 0 ? tm.twaEdges[1] - aStep / 2 : lastA ? tm.twaEdges[r] + aStep : (tm.twaEdges[r] + tm.twaEdges[r + 1]) / 2
    const wc = lastW ? tm.twsEdges[c] + 1 : (tm.twsEdges[c] + tm.twsEdges[c + 1]) / 2
    const rad = 11 * Math.sqrt(hh / hmax)
    if (rad < 0.6) return
    dots += `<circle cx="${X(ac).toFixed(1)}" cy="${Y(wc).toFixed(1)}" r="${rad.toFixed(1)}"><title>${(100 * hh / tm.totalHours).toFixed(1)} % of sailing time</title></circle>`
  }))
  const svg = `<svg class="sc" viewBox="0 0 ${W} ${H}" width="100%"><g class="grat">${g}</g>${shapes}<g class="tdot">${dots}</g>${labels}
<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">TWA °</text><text x="12" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">TWS kn at ${o.mast} m</text></svg>`

  // Bars: one per method, the share of sailing time, the outside-chart part hatched.
  const order = ms[0].sails.sails.filter(x => ms.some(m => (find(m, x.name)?.hours ?? 0) > 0))
    .sort((a, b) => b.share - a.share).map(x => x.name)
  let smax = 1e-9
  for (const m of ms) for (const x of m.sails.sails) if (x.share > smax) smax = x.share
  const BW = 560, LW = 64, rowH = 14 * ms.length + 12
  const bars = order.map((nm, i) => {
    const y0 = 6 + i * rowH
    const col = colourOf.get(nm) ?? '#888'
    return `<text class="bl" x="${LW - 8}" y="${y0 + 7 * ms.length + 4}" text-anchor="end">${esc(nm)}</text>` + ms.map((m, k) => {
      const x = find(m, nm)
      const w = (x.share / smax) * BW, wo = x.hours > 0 ? w * (x.outsideHours / x.hours) : 0
      const y = y0 + k * 14
      return `<rect x="${LW}" y="${y}" width="${w.toFixed(1)}" height="12" fill="${col}"${k ? ' fill-opacity=".6"' : ''}><title>${m.label}: ${(100 * x.share).toFixed(1)} %, ${x.hours.toFixed(1)} h per race</title></rect>`
        + (wo > 0.5 ? `<rect x="${(LW + w - wo).toFixed(1)}" y="${y}" width="${wo.toFixed(1)}" height="12" fill="url(#hatch)"/>` : '')
        + `<text class="bv" x="${(LW + w + 6).toFixed(1)}" y="${y + 10}">${(100 * x.share).toFixed(1)} %  ·  ${x.hours.toFixed(1)} h${ms.length > 1 ? `  (${m.key})` : ''}</text>`
    }).join('')
  }).join('')
  const barSvg = `<svg class="sb" viewBox="0 0 ${LW + BW + 200} ${order.length * rowH + 10}" width="100%"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff" fill-opacity=".35"/><line x1="0" y1="0" x2="0" y2="6" stroke="#000" stroke-opacity=".45" stroke-width="2.5"/></pattern></defs>${bars}</svg>`

  // "Races using it" only exists when the hours came off the individual routes.
  const used = ms.every(m => m.sails.sails.every(x => x.usedIn != null))
  const cols = used ? 4 : 3
  const head = `<tr><th rowspan="2">Sail</th><th rowspan="2">Group</th>${ms.map(m => `<th colspan="${cols}">${m.label}</th>`).join('')}</tr><tr>${ms.map(() => `<th>h / race</th><th>% of time</th><th>outside chart</th>${used ? '<th>races using it</th>' : ''}`).join('')}</tr>`
  const rows = order.map(nm => `<tr><th style="text-align:left"><span class="sw" style="background:${colourOf.get(nm) ?? '#888'}"></span>${esc(nm)}</th><td style="text-align:left">${esc(find(ms[0], nm).group)}</td>${ms.map(m => {
    const x = find(m, nm)
    return `<td>${x.hours.toFixed(1)}</td><td>${(100 * x.share).toFixed(1)}</td><td>${x.outsideHours.toFixed(1)} h</td>${used ? `<td>${pc(x.usedIn)}</td>` : ''}`
  }).join('')}</tr>`).join('')
  const tot = `<tr class="totrow"><th style="text-align:left">all</th><td></td>${ms.map(m => `<td>${m.sails.totalHours.toFixed(1)}</td><td>100</td><td>${(m.sails.totalHours * m.sails.outsideShare).toFixed(1)} h</td>${used ? '<td></td>' : ''}`).join('')}</tr>`
  const out = ms.map(m => `${m.label} ${pc(m.sails.outsideShare)}`).join(', ')
  let twaLo = Infinity, twaHi = -Infinity, twsLo = Infinity, twsHi = -Infinity
  for (const s of drawn) for (const p of s.points) {
    twaLo = Math.min(twaLo, p.twa); twaHi = Math.max(twaHi, p.twa); twsLo = Math.min(twsLo, p.tws); twsHi = Math.max(twsHi, p.tws)
  }
  const how = o.fromTable
    ? `The study's TWA × TWS time table (5° × 2 kn bins) is read against the chart: each bin's hours are spread evenly across it and charged to the sail under each part, so a bin a shape's edge cuts through is split between the two sails.`
    : `Each stretch of every route is charged to the sail whose shape contains its TWA and TWS.`
  return `<style>${SAIL_SECTION_CSS}</style><h2 id="sails">Sails</h2>
<p>${esc(chart.fileName ?? 'Sail chart')}: ${drawn.length} shapes. ${how} <b>Time outside every shape (${out}) is counted with the sail on the chart's edge</b> and hatched below: deeper than the downwind VMG edge goes to the sail on that edge at the same TWS, tighter than the upwind edge to the sail on the upwind edge, and a wind the chart does not reach takes the sail at the nearest TWS that covers the same TWA. The chart covers ${Math.round(twaLo)}–${Math.round(twaHi)}° TWA and ${twsLo.toFixed(1)}–${twsHi.toFixed(1)} kn, so beyond that is an extrapolation, not the chart's answer.</p>
<h3>Sail chart, with where the time was spent</h3><p class="dim">Shapes as on SSA's Boat → Sail chart tab. Dots: sailing time per 5° × 2 kn bin (${ms[0].label.toLowerCase()} routes), area proportional to the hours; hover for the share.</p>${svg}
<h3>Share of sailing time per sail</h3><p class="dim">${ms.length > 1 ? `Top bar ${ms[0].label.toLowerCase()}, bottom (lighter) ${ms[1].label.toLowerCase()}. ` : ''}Hatched: the part that fell outside the chart and was counted with the sail on its edge.</p>${barSvg}
<table>${head}${rows}${tot}</table><p class="dim">h / race: mean hours per race carrying that sail.${used && o.races ? ` Races using it: the share of the ${o.races} routed races that carried it for an hour or more.` : ''}</p>`
}
