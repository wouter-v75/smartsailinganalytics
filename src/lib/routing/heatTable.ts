// The TWA x TWS "% of sailing time" table of a routing-climatology report, shared
// by scripts/route-climatology.ts and scripts/route-sail-hours.ts (which redraws
// a finished study's tables folded onto the VMG targets without routing again).
//
// TWS rises up the page (0 kn at the bottom, like a chart's y axis); TWA columns
// are labelled by their LOWER edge (30 = 30-35°) so 29 of them fit a page. Red is
// little time, green the most, on a square-root scale so a bin with a fraction of
// a percent still shows; an empty bin stays blank.

import type { TwaTwsTable } from './climatology'

/** Red -> yellow -> green for f in 0..1. */
export function redGreen(f: number): { bg: string; fg: string } {
  const stops = [[215, 48, 39], [252, 141, 89], [254, 224, 139], [145, 207, 96], [26, 152, 80]]
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), u = x - k
  const c = stops[k].map((v, n) => Math.round(v + u * (stops[k + 1][n] - v)))
  return { bg: `rgb(${c.join(',')})`, fg: f > 0.85 ? '#fff' : '#111' }
}

/** Elapsed hours as days and hours, 12d6h. */
export function dh(hours: number): string {
  if (!Number.isFinite(hours)) return '–'
  const t = Math.round(hours), d = Math.floor(t / 24), r = t % 24
  return d ? `${d}d${r}h` : `${r}h`
}

/** `folded`: the share of time moved onto the VMG targets (foldToTargets), when it was. */
export function heatTableHtml(t: TwaTwsTable, o: { label: string; mast: number; folded?: number }): string {
  let max = 0
  for (const row of t.hours) for (const v of row) if (v > max) max = v
  const twsStep = t.twsEdges[1] - t.twsEdges[0], twaStep = t.twaEdges[2] - t.twaEdges[1]
  const twaLab = (r: number) => r === 0 ? `&lt;${t.twaEdges[1]}` : r === t.twaEdges.length - 1 ? `≥${t.twaEdges[r]}` : `${t.twaEdges[r]}`
  const head = `<tr><th>kn \\ °</th>${t.twaEdges.map((_, r) => `<th>${twaLab(r)}</th>`).join('')}<th>all</th></tr>`
  const rows = t.twsEdges.map((sv, c) => {
    const lab = c === t.twsEdges.length - 1 ? `≥${sv}` : `${sv}–${sv + twsStep}`
    let rowSum = 0
    const cells = t.hours.map(row => {
      const v = row[c]; rowSum += v
      const pct = t.totalHours ? (100 * v) / t.totalHours : 0
      if (!(pct >= 0.05)) return '<td></td>'
      const { bg, fg } = redGreen(max ? Math.sqrt(v / max) : 0)
      return `<td style="background:${bg};color:${fg}">${pct.toFixed(1)}</td>`
    }).join('')
    const rp = t.totalHours ? (100 * rowSum) / t.totalHours : 0
    return `<tr><th>${lab}</th>${cells}<td class="tot">${rp >= 0.05 ? rp.toFixed(1) : ''}</td></tr>`
  }).reverse().join('')
  const colTot = t.twaEdges.map((_, r) => {
    const v = t.hours[r].reduce((a, b) => a + b, 0)
    const pct = t.totalHours ? (100 * v) / t.totalHours : 0
    return `<td class="tot">${pct >= 0.05 ? pct.toFixed(1) : ''}</td>`
  }).join('')
  const fold = o.folded != null
    ? ` Time deeper than the downwind VMG target, or tighter than the upwind one, is counted in the box of that TWS row's target angle (${(100 * o.folded).toFixed(0)} % of the time moved).`
    : ''
  return `<h3>${o.label} — % of sailing time (mean ${dh(t.totalHours)} per race)</h3><p class="dim">Rows: TWS at ${o.mast} m in ${twsStep} kn bands, rising up the page. Columns: |TWA| in ${twaStep}° bins, labelled by their lower edge (30 = 30–${30 + twaStep}°). Red is little time, green the most.${fold}</p><div class="scroll"><table class="heat">${head}${rows}<tr class="totrow"><th>all</th>${colTot}<td class="tot">100</td></tr></table></div>`
}
