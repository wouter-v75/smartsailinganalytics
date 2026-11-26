// Hours per sail for a routing study that is ALREADY done: reads the study's
// saved TWA x TWS tables (summary.json) against the boat's crossover chart and
// adds the Sails section to its report — no routing again.
//
//   npx vite-node scripts/route-sail-hours.ts -- --results ~/routing/transpac/results \
//     --sailchart ~/routing/ryujin-sailchart.json --polar ~/Downloads/ryujin.txt \
//     [--report Transpac_study_2027.html]
//
// --polar (the study's own) gives the VMG targets: time deeper than the downwind
// target, or tighter than the upwind, is counted in the target's box of each TWS
// row (foldToTargets) — in the redrawn time tables AND before the sails are read.
//
// --sailchart is SSA's chart JSON (Boat → Sail chart) or Expedition XML.
// --report is the report to add the section to (default report.html in --results);
// the result is written beside it as <name>-sails.html, the original untouched.
// Also writes sails-<method>.csv. Each bin's hours are spread evenly over the bin
// (sailHoursFromTable), so a bin a shape's edge cuts through is split; routing
// with --sailchart instead charges every route step exactly and adds "races using
// it", which the summed table cannot give.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normaliseSailChart, parseCrossoverXml } from '../src/lib/sailchart/model'
import { sailHoursFromTable } from '../src/lib/sailchart/assign'
import { foldToTargets, tableCsv } from '../src/lib/routing/climatology'
import { parseRoutingPolar } from '../src/lib/routing/polar'
import { heatTableHtml } from '../src/lib/routing/heatTable'
import { sailSectionHtml, type SailMethod } from '../src/lib/routing/sailReport'

const argv = process.argv.slice(2).filter(a => a !== '--')
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined }
const home = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir())
if (!arg('results') || !arg('sailchart') || !arg('polar')) {
  console.log('usage: --results DIR --sailchart FILE --polar FILE [--report FILE]')
  process.exit(1)
}
const dir = home(arg('results')!)
const chartFile = home(arg('sailchart')!)
const text = fs.readFileSync(chartFile, 'utf8')
const chart = text.trimStart().startsWith('<') ? parseCrossoverXml(text, path.basename(chartFile)) : normaliseSailChart(JSON.parse(text))
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'))
const mast = summary.polar?.refHeightM ?? 10
const polar = parseRoutingPolar(fs.readFileSync(home(arg('polar')!), 'utf8'), { refHeightM: mast })
if (summary.polar?.file && path.basename(arg('polar')!) !== summary.polar.file) {
  console.warn(`note: the study was routed with ${summary.polar.file}, the targets here come from ${path.basename(arg('polar')!)}`)
}
const heats: string[] = []

const ms: SailMethod[] = []
for (const key of Object.keys(summary.methods)) {
  const m = summary.methods[key]
  const label = key === 'iso' ? 'Isochrone' : key === 'grid' ? 'Grid' : key
  const fold = foldToTargets(m.table, w => polar.vmg(w))
  fs.writeFileSync(path.join(dir, `table-${key}-targets-pct.csv`), tableCsv(fold.table, 'pct') + '\n')
  heats.push(heatTableHtml(fold.table, { label, mast, folded: fold.movedShare }))
  console.log(`\n${label}: ${(100 * fold.movedShare).toFixed(1)} % of the time was past a VMG target and is counted at the target`)
  const sails = sailHoursFromTable(chart, fold.table)
  if (!sails) throw new Error(`${chartFile}: no sail shapes in it`)
  ms.push({ key, label, sails, table: fold.table })
  const order = [...sails.sails].sort((a, b) => b.hours - a.hours)
  fs.writeFileSync(path.join(dir, `sails-${key}.csv`), ['sail,group,hours_per_race,pct_of_time,outside_chart_hours']
    .concat(order.map(x => [x.name, x.group, x.hours.toFixed(2), (100 * x.share).toFixed(2), x.outsideHours.toFixed(2)].join(','))).join('\n') + '\n')
  console.log(`\n${summary.course?.name ?? ''} ${key}: ${sails.totalHours.toFixed(1)} h per race, ${(100 * sails.outsideShare).toFixed(0)} % outside the chart (counted with the sail on its VMG edge)`)
  for (const x of order) if (x.hours > 0) console.log(`  ${x.name.padEnd(6)} ${(100 * x.share).toFixed(1).padStart(5)} %  ${x.hours.toFixed(1).padStart(6)} h   (outside chart ${x.outsideHours.toFixed(1)} h)`)
}

const reportFile = home(arg('report') ?? path.join(dir, 'report.html'))
let html = fs.readFileSync(reportFile, 'utf8')
// The time tables, redrawn folded onto the targets (in method order).
let k = 0
html = html.replace(/<h3>[^<]* — % of sailing time[\s\S]*?<\/table><\/div>/g, m0 => (k < heats.length ? heats[k++] : m0))
if (k !== heats.length) console.warn(`note: replaced ${k} of ${heats.length} time tables in the report`)
// Replace a Sails section added before, else put it ahead of the by-start tables.
html = html.replace(/<style>[^<]*<\/style><h2 id="sails">[\s\S]*?(?=<h2>By start date|<h2>Per year)/, '')
const at = ['<h2>By start date', '<h2>Per year', '</body>'].map(t => html.indexOf(t)).find(i => i >= 0)!
html = html.slice(0, at) + sailSectionHtml(chart, ms, { mast, fromTable: true }) + '\n' + html.slice(at)
const out = reportFile.replace(/(-sails)?\.html$/, '-sails.html')
fs.writeFileSync(out, html)
console.log(`\nwritten: ${out}, sails-*.csv`)
