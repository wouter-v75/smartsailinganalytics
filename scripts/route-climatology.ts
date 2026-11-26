// Weather-routing climatology: one course, one local start time, N years of ERA5.
//
//   npx vite-node scripts/route-climatology.ts -- \
//     --data ~/routing/msr --gpx ~/Downloads/msr.gpx --polar ~/Downloads/n76.pol \
//     --start "2026-10-17 11:00" --mast 35 --out ~/routing/msr/results
//
// --data is the folder scripts/routing/era5_fetch.py wrote (era5/<year>.bin +
// land.bin). Every year it holds is routed unless --years narrows it.
//
// WHAT IT DOES, per year: the start's LOCAL wall time turned into UTC with the
// start position's own zone (so a start either side of a DST change is still
// 11:00 on the clock), ERA5's 10/100 m wind lifted to the polar's height, and
// the course routed mark by mark with the isochrone method and the grid method.
// Then: elapsed time min / max / mean / median / 1 sigma (with a bootstrap
// interval, because 20 years is a small sample of a climate), share of time
// upwind / reaching / downwind and on starboard, and the TWA x TWS table of
// where the hours were spent (5 deg x 2 kn, 30-160 deg x 0-30 kn, with
// under/over bins so no time drops out of the table).
//
// HEIGHT: --mast is the height the POLAR's TWS is defined at. For a polar from a
// boat's own masthead instruments that is the masthead; for a designer's VPP it
// is usually 10 m (Expedition's manual says most designers' polars are). The
// lift defaults to 'power' — ERA5's own 10->100 m shear, interpolated — which
// carries the model's stability; 'mo' re-solves the surface layer from t2m-SST
// and is the hook for the boundary-layer step (docs/weather-routing-climatology).
//
// SEVERAL STARTS A YEAR: --window 15 --every 48 starts the race every 48 h from
// 15 days before the date to 15 days after (16 starts a year, ~320 over twenty
// years), at the same local clock time. Twenty single starts are twenty samples
// of a climate; a window round the date multiplies that without leaving the
// season. The starts within one year are NOT independent (a weather regime can
// last a fortnight), so the confidence intervals resample whole YEARS (a block
// bootstrap) rather than routes, and the report breaks the result down by start
// offset so a trend through the window is visible rather than averaged away.
// The fetch must have been made with the same --window (era5_fetch.py).
//
// Outputs in --out: summary.json (everything), elapsed.csv (per route and method),
// table-<method>-pct.csv and -hours.csv, routes.geojson, report.html.

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { parseRoutingPolar } from '../src/lib/routing/polar'
import { parseCourseGpx } from '../src/lib/routing/course'
import { liftToHeight, type LiftMethod, type RawFields } from '../src/lib/routing/windField'
import { routeIsochrone, type RouteResult } from '../src/lib/routing/isochrone'
import { routeGrid } from '../src/lib/routing/gridRouter'
import { elapsedStats, twaTwsTable, tableCsv, localStartToUtc, pointOfSail, bootstrapBlocks, foldToTargets } from '../src/lib/routing/climatology'
import { heatTableHtml, dh } from '../src/lib/routing/heatTable'
import { offsetFromCoords } from '../src/lib/tzFromCoords'
import { makePerf, isDark } from '../src/lib/routing/daylight'
import { normaliseSailChart, parseCrossoverXml, type SailChart } from '../src/lib/sailchart/model'
import { sailSectionHtml } from '../src/lib/routing/sailReport'
import { sailHours, type SailHours } from '../src/lib/sailchart/assign'
import { stepHitsLand, type LandMask } from '../src/lib/routing/land'
import type { Env } from '../src/lib/routing/motion'

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter(a => a !== '--')
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const flag = (k: string) => argv.includes(`--${k}`)
const home = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir())
if (flag('help') || !arg('data') || !arg('gpx') || !arg('polar') || !arg('start')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 30).map(l => l.slice(3)).join('\n'))
  console.log(`
  --data DIR --gpx FILE --polar FILE --start "YYYY-MM-DD HH:MM"   (local time at the start)
  --years 2006-2025      default: every year in DIR/era5
  --window D --every H   also start D days either side of the date, every H hours (default 0 / 48)
  --method both|iso|grid default both
  --workers N            route the years in N parallel processes (each holds one year's wind, ~0.5-1 GB)
  --mast M               polar reference height, m (default 10)
  --lift power|mo|neutral|none   default power (none when --mast 10)
  --tack S --gybe S      manoeuvre losses, seconds (default 60 / 45)
  --factor F             polar multiplier (default 1), applied under the day/night factors
  --day-factor F         share of the polar sailed in daylight (default 0.95)
  --night-factor F       share of the polar sailed in darkness (default 0.90)
  --dark-below DEG       sun altitude below which it is dark (default -0.833 = sunset; -6 = civil dusk)
  --name TEXT            report title (default: the GPX route's own name)
  --sailchart FILE       the boat's crossover chart: SSA's chart JSON (Boat → Sail chart) or Expedition XML;
                         adds hours per sail and the chart itself to the report
  --radius NM            mark rounding radius (default 0.25)
  --step MIN             isochrone step (default 90; --step 30 --sector-nm 0.5 for a short inshore race)
  --sector-nm NM         isochrone pruning resolution (default 2)
  --cell NM --stencil N  grid lattice spacing (default 2) and directions (16|32|48, default 32)
  --max-nodes N          grid lattice cap (default 400000); an ocean leg needs a coarser --cell or more nodes
  --no-land              ignore the land mask
  --convergence          also route the first year at half step / half sector and report the change
  --out DIR              default DATA/results`)
  process.exit(flag('help') ? 0 : 1)
}

const dataDir = home(arg('data')!)
const outDir = home(arg('out', path.join(dataDir, 'results'))!)
const mast = Number(arg('mast', '10'))
const lift = (arg('lift') ?? (mast === 10 ? 'none' : 'power')) as LiftMethod
const method = arg('method', 'both')!
const startM = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(arg('start')!)
if (!startM) throw new Error('--start must be "YYYY-MM-DD HH:MM" (local time at the start line)')
const [, , MM, DD, hh, mm] = startM.map(Number)

const polar = parseRoutingPolar(fs.readFileSync(home(arg('polar')!), 'utf8'), {
  refHeightM: mast, tackSec: Number(arg('tack', '60')), gybeSec: Number(arg('gybe', '45')), factor: Number(arg('factor', '1')),
})
const course = parseCourseGpx(fs.readFileSync(home(arg('gpx')!), 'utf8'), { radiusNm: Number(arg('radius', '0.25')) })
// Expedition carries a route's name over when a route is copied, so a GPX can
// arrive titled after another race; --name says what this one is.
if (arg('name')) course.name = arg('name')!
// 90 min / 2 nm by default: the wind is ERA5 at 0.25° and hourly, and on 8
// Transpac starts 90/2 differed from 30/0.5 by -0.06 % on the mean (1.1 h at most
// on one start) for a fraction of the time. A short inshore race wants --step 30.
const isoOpts = { stepMin: Number(arg('step', '90')), sectorNm: Number(arg('sector-nm', '2')) }
// Day/night performance: the share of the polar the crew sails, switched on the
// sun's altitude at the BOAT (daylight.ts). 95 % by day and 90 % by night is the
// standard offshore set-up here; --day-factor 1 --night-factor 1 routes the raw polar.
const dayNight = { dayFactor: Number(arg('day-factor', '0.95')), nightFactor: Number(arg('night-factor', '0.90')), darkBelowDeg: Number(arg('dark-below', '-0.833')) }
if (![dayNight.dayFactor, dayNight.nightFactor].every(f => f > 0 && f <= 1.2)) throw new Error('--day-factor / --night-factor must be in (0, 1.2]')
const perf = makePerf(dayNight)
const gridOpts = { cellNm: Number(arg('cell', '2')), stencil: Number(arg('stencil', '32')) as 16 | 32 | 48, maxNodes: Number(arg('max-nodes', '400000')) }

// ── data ────────────────────────────────────────────────────────────────────
function readF32(file: string, offsetFloats: number, n: number): Float32Array {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(n * 4)
  fs.readSync(fd, buf, 0, n * 4, offsetFloats * 4)
  fs.closeSync(fd)
  // Copy: a Buffer's byteOffset need not be 4-aligned.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4))
}

function loadYear(year: number): RawFields {
  const h = JSON.parse(fs.readFileSync(path.join(dataDir, 'era5', `${year}.json`), 'utf8'))
  const n = h.nT * h.nLat * h.nLon
  const bin = path.join(dataDir, 'era5', `${year}.bin`)
  const get = (k: string) => { const i = h.vars.indexOf(k); return i >= 0 ? readF32(bin, i * n, n) : undefined }
  return {
    lat0: h.lat0, dLat: h.dLat, nLat: h.nLat, lon0: h.lon0, dLon: h.dLon, nLon: h.nLon, t0: h.t0, dtMs: h.dtMs, nT: h.nT,
    u10: get('u10')!, v10: get('v10')!, u100: get('u100'), v100: get('v100'), t2m: get('t2m'), sst: get('sst'),
  }
}

function loadLand(): LandMask | null {
  if (flag('no-land')) return null
  const j = path.join(dataDir, 'land.json')
  if (!fs.existsSync(j)) { console.warn('no land.json: routing WITHOUT land'); return null }
  const h = JSON.parse(fs.readFileSync(j, 'utf8'))
  return { ...h, cells: new Uint8Array(fs.readFileSync(path.join(dataDir, 'land.bin'))) }
}

const yearsAvail = fs.readdirSync(path.join(dataDir, 'era5')).map(f => /^(\d{4})\.bin$/.exec(f)?.[1]).filter(Boolean).map(Number).sort()
let years = yearsAvail
if (arg('years')) {
  // "2006-2025", "2006,2010,2014" or a mix ("2006-2008,2012").
  const want = new Set<number>()
  for (const part of arg('years')!.split(',')) {
    const [a, b] = part.split('-').map(Number)
    for (let y = a; y <= (b || a); y++) want.add(y)
  }
  years = yearsAvail.filter(y => want.has(y))
}
if (!years.length) throw new Error(`no years in ${dataDir}/era5`)
const land = loadLand()
// The crossover chart, for hours per sail. SSA stores it as JSON (boat_sailcharts,
// normalised by model.ts); a file straight off the nav computer is Expedition XML.
const sailChart: SailChart | null = (() => {
  const f = arg('sailchart')
  if (!f) return null
  const text = fs.readFileSync(home(f), 'utf8')
  const c = text.trimStart().startsWith('<') ? parseCrossoverXml(text, path.basename(f)) : normaliseSailChart(JSON.parse(text))
  if (!c.sails.some(x => x.visible && x.points.length >= 3)) throw new Error(`--sailchart ${f}: no sail shapes in it`)
  return c
})()

// ── run ─────────────────────────────────────────────────────────────────────
const start = course.marks[0]
const offsetAt = (ms: number) => {
  const o = offsetFromCoords(start.lat, start.lon, ms)
  if (!o) throw new Error('could not resolve the time zone at the start position')
  return o.offsetMin
}
const methods = method === 'both' ? ['iso', 'grid'] : [method]
const windowD = Number(arg('window', '0')), everyH = Number(arg('every', '48'))
if (!(windowD >= 0) || !(everyH > 0)) throw new Error('--window must be >= 0 and --every > 0')
const offsetsH: number[] = []
for (let o = -windowD * 24; o <= windowD * 24 + 1e-9; o += everyH) offsetsH.push(Math.round(o))
type Run = { year: number; offsetH: number; startLocal: string; startUtc: string; r: RouteResult; ms: number }
const results: Record<string, Run[]> = { iso: [], grid: [] }
const liftLog: { year: number; meanRatio: number; stableShare: number | null; fallbacks: number }[] = []
const zone = offsetFromCoords(start.lat, start.lon, Date.now())?.zone

console.log(`${course.name ?? 'course'}: ${course.marks.map(m => m.name).join(' -> ')}, ${course.rhumbNm.toFixed(1)} nm rhumb`)
console.log(`start ${String(DD).padStart(2, '0')}/${String(MM).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} local (${zone}), ${years.length} years x ${offsetsH.length} start${offsetsH.length > 1 ? `s (${offsetsH[0] / 24} to +${offsetsH[offsetsH.length - 1] / 24} d, every ${everyH} h)` : ''}, polar at ${mast} m, lift '${lift}', land ${land ? 'on' : 'OFF'}`)

const failed = (reason: string): RouteResult => ({ ok: false, reason, elapsedSec: null, legSec: [], path: [], sailedNm: 0, tacks: 0, gybes: 0 } as unknown as RouteResult)
let convergence: Record<string, number> | null = null
function routeYears(ys: number[]) {
for (const y of ys) {
  const raw = loadYear(y)
  const { grid, stats } = liftToHeight(raw, mast, lift)
  liftLog.push({ year: y, ...stats })
  const env: Env = { polar, wind: grid, land, perf }
  const dataEnd = raw.t0 + (raw.nT - 1) * raw.dtMs
  for (const offH of offsetsH) {
    // The same LOCAL clock time on each start date, so the sea breeze lines up.
    const wall = new Date(Date.UTC(y, MM - 1, DD, hh, mm) + offH * 3600e3)
    const t0 = localStartToUtc(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), offsetAt)
    const startLocal = wall.toISOString().slice(0, 16).replace('T', ' ')
    // A leg may run as long as the year's data lasts. A fixed cap (the router's
    // default is 240 h) fails the SLOW starts on an ocean course, and a failed
    // start drops out of the statistics — biasing the mean fast exactly where it matters.
    const dataHours = (dataEnd - t0) / 3600e3
    const isoY = { ...isoOpts, maxLegHours: Math.max(1, dataHours) }
    for (const m of methods) {
      const t = Date.now()
      const r = t0 < raw.t0 ? failed(`start ${startLocal} is before the data (fetch with a --window this wide)`)
        : m === 'iso' ? routeIsochrone(env, course, t0, isoY) : routeGrid(env, course, t0, gridOpts)
      results[m].push({ year: y, offsetH: offH, startLocal, startUtc: new Date(t0).toISOString(), r, ms: Date.now() - t })
      const e = r.ok ? dh(r.elapsedSec! / 3600) : `FAILED: ${r.reason}`
      console.log(`  ${startLocal} ${m.padEnd(4)} ${e}  ${r.ok ? `${r.sailedNm.toFixed(0)} nm sailed, ${r.tacks} tacks, ${r.gybes} gybes` : ''}  (${((Date.now() - t) / 1000).toFixed(1)} s)`)
    }
    if (flag('convergence') && !convergence && methods.includes('iso') && results.iso[results.iso.length - 1].r.ok) {
      const base = results.iso[results.iso.length - 1].r.elapsedSec!
      const half = routeIsochrone(env, course, t0, { ...isoY, stepMin: isoOpts.stepMin / 2, sectorNm: isoOpts.sectorNm / 2, headingStepDeg: 2.5 }).elapsedSec!
      const g = routeGrid(env, course, t0, { cellNm: gridOpts.cellNm / 2, stencil: 48, maxNodes: Math.max(3_000_000, 4 * gridOpts.maxNodes) }).elapsedSec!
      convergence = { year: y, isoSec: base, isoHalfSec: half, isoChangePct: (100 * (half - base)) / base, gridFineSec: g, gridFineVsIsoPct: (100 * (g - base)) / base }
      console.log(`  convergence ${startLocal}: iso at half step/sector/fan ${(half / 3600).toFixed(3)} h (${convergence.isoChangePct.toFixed(2)} %), grid at half cell / 48 dir ${(g / 3600).toFixed(3)} h (${convergence.gridFineVsIsoPct.toFixed(2)} % vs iso)`)
    }
  }
}
}

// ── parallel ────────────────────────────────────────────────────────────────
// --workers N: the starts are independent, so the YEARS are dealt round-robin to
// N child processes of this same script (each loads only its own years' wind, so
// memory is N x one year, ~0.5-1 GB each) and the parent merges what they route.
// A child gets --shard FILE and writes its routes there instead of a report; only
// the child holding the first year runs --convergence, as a serial run would.
const workers = Math.max(1, Math.min(years.length, Number(arg('workers', '1'))))
const shardFile = arg('shard')
async function runSharded(): Promise<void> {
  const groups: number[][] = Array.from({ length: workers }, () => [])
  years.forEach((y, i) => groups[i % workers].push(y))
  const script = fileURLToPath(import.meta.url)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-shards-'))
  const base: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--years' || k === '--workers' || k === '--out' || k === '--shard') { i++; continue }
    if (k === '--convergence') continue
    base.push(k)
  }
  console.log(`  ${workers} workers: ${groups.map(g => g.join(',')).join(' | ')}`)
  const t0 = Date.now()
  await Promise.all(groups.map((g, w) => new Promise<void>((resolve, reject) => {
    const file = path.join(tmp, `shard-${w}.json`)
    const args = ['vite-node', script, '--', ...base, '--years', g.join(','), '--shard', file, ...(g.includes(years[0]) && flag('convergence') ? ['--convergence'] : [])]
    const child = spawn('npx', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n'); buf = lines.pop()!
      for (const l of lines) if (/^\s+\d{4}-|convergence|FAILED/.test(l)) console.log(l)
    })
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`worker ${w} (years ${g.join(',')}) exited ${code}`))
      const sh = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const m of Object.keys(sh.results)) results[m].push(...sh.results[m])
      liftLog.push(...sh.liftLog)
      if (sh.convergence) convergence = sh.convergence
      resolve()
    })
  })))
  const order = (a: Run, b: Run) => a.year - b.year || a.offsetH - b.offsetH
  for (const m of Object.keys(results)) results[m].sort(order)
  liftLog.sort((a, b) => a.year - b.year)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`  routed in ${((Date.now() - t0) / 60e3).toFixed(1)} min`)
}

void (async () => {
if (workers > 1 && !shardFile) await runSharded()
else routeYears(years)
if (shardFile) {
  fs.writeFileSync(shardFile, JSON.stringify({ results, liftLog, convergence }))
  process.exit(0)
}

// ── results ─────────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true })
const h = (s: number) => (s / 3600)
const summary: Record<string, unknown> = {
  course: { name: course.name, marks: course.marks, rhumbNm: course.rhumbNm },
  start: { local: arg('start'), zone, years, windowDays: windowD, everyHours: everyH, offsetsH },
  polar: { file: path.basename(arg('polar')!), refHeightM: mast, tackSec: polar.tackSec, gybeSec: polar.gybeSec, factor: polar.factor, ...dayNight },
  wind: { source: 'ERA5 single levels', lift, liftLog },
  options: { iso: isoOpts, grid: gridOpts, radiusNm: Number(arg('radius', '0.25')) },
  convergence,
  methods: {},
}
const csvRows = ['year,offset_h,start_local,start_utc,method,elapsed_h,sailed_nm,tacks,gybes,' + course.marks.slice(1).map(m => `leg_${m.name}_h`).join(',')]
for (const m of methods) {
  const rs = results[m]
  const st = elapsedStats(rs.map(x => x.r))
  const ok = rs.filter(x => x.r.ok)
  const paths = ok.map(x => x.r.path)
  const table = twaTwsTable(paths)
  const pos = pointOfSail(paths)
  // The time tables as the report shows them: time past the VMG targets counted
  // in the target's box (foldToTargets), and the sails read the same way.
  const atTargets = foldToTargets(table, w => polar.vmg(w))
  const sails: SailHours | null = sailChart ? sailHours(sailChart, paths, (twa, tws) => {
    const v = polar.vmg(tws)
    return v.upTwa > 0 && v.dnTwa > v.upTwa ? Math.max(v.upTwa, Math.min(v.dnTwa, Math.abs(twa))) : Math.abs(twa)
  }) : null
  // Share of sailing time in the dark, by the same rule the routers used.
  let darkH = 0, allH = 0
  for (const pth of paths) for (let k = 0; k < pth.length - 1; k++) {
    const hh = (pth[k + 1].t - pth[k].t) / 3600e3
    if (!(hh > 0)) continue
    allH += hh
    if (isDark(pth[k].lat, pth[k].lon, (pth[k].t + pth[k + 1].t) / 2, dayNight.darkBelowDeg)) darkH += hh
  }
  const darkShare = allH ? darkH / allH : NaN
  // Land audit: every drawn segment of every route, re-checked against the mask
  // the routers used. The routers refuse any step that touches land, so this
  // should be zero; it is here so a report SAYS so rather than asks to be trusted.
  const landHits = land ? ok.filter(x => x.r.path.some((p, k) => k > 0 && stepHitsLand(land, x.r.path[k - 1], p)))
    .map(x => x.startLocal) : []
  // Resample whole years: the starts inside one year share its weather regimes.
  const byYear = years.map(y => ok.filter(x => x.year === y).map(x => x.r.elapsedSec!)).filter(g => g.length)
  const ci = bootstrapBlocks(byYear)
  const off = offsetsH.map(o => {
    const v = ok.filter(x => x.offsetH === o).map(x => x.r.elapsedSec!).sort((a, b) => a - b)
    const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1)
    return { offsetH: o, n: v.length, mean: h(mean), median: v.length ? h(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : NaN, min: h(v[0]), max: h(v[v.length - 1]) }
  })
  const perYear = years.map(y => {
    const v = ok.filter(x => x.year === y).map(x => x.r.elapsedSec!)
    return { year: y, n: v.length, of: rs.filter(x => x.year === y).length, mean: v.length ? h(v.reduce((a, b) => a + b, 0) / v.length) : NaN, min: v.length ? h(Math.min(...v)) : NaN, max: v.length ? h(Math.max(...v)) : NaN }
  })
  fs.writeFileSync(path.join(outDir, `table-${m}-pct.csv`), tableCsv(table, 'pct') + '\n')
  fs.writeFileSync(path.join(outDir, `table-${m}-hours.csv`), tableCsv(table, 'hours') + '\n')
  fs.writeFileSync(path.join(outDir, `table-${m}-targets-pct.csv`), tableCsv(atTargets.table, 'pct') + '\n')
  ;(summary.methods as Record<string, unknown>)[m] = {
    elapsedHours: { n: st.n, failed: st.failed, min: h(st.minSec), max: h(st.maxSec), mean: h(st.meanSec), median: h(st.medianSec), sd: h(st.sdSec),
      medianCI90: ci.median.map(h), meanCI90: ci.mean.map(h) },
    pointOfSail: pos, darkShare, landHits, sails, table, tableAtTargets: atTargets.table, movedToTargets: atTargets.movedShare, byOffset: off, byYear: perYear,
    routes: rs.map(x => ({ year: x.year, offsetH: x.offsetH, startLocal: x.startLocal, startUtc: x.startUtc, ok: x.r.ok, reason: x.r.reason, elapsedH: x.r.elapsedSec != null ? h(x.r.elapsedSec) : null,
      legH: x.r.legSec.map(h), sailedNm: x.r.sailedNm, tacks: x.r.tacks, gybes: x.r.gybes, runMs: x.ms })),
  }
  for (const x of rs) csvRows.push([x.year, x.offsetH, x.startLocal, x.startUtc, m, x.r.ok ? h(x.r.elapsedSec!).toFixed(3) : '', x.r.sailedNm.toFixed(1), x.r.tacks, x.r.gybes, ...x.r.legSec.map(s => h(s).toFixed(3))].join(','))
  console.log(`\n${m.toUpperCase()}  n=${st.n}${st.failed ? ` (${st.failed} failed)` : ''}
  elapsed  min ${dh(h(st.minSec))}  max ${dh(h(st.maxSec))}  mean ${dh(h(st.meanSec))}  median ${dh(h(st.medianSec))}  1 sigma ${dh(h(st.sdSec))}
           median 90 % CI ${dh(h(ci.median[0]))}-${dh(h(ci.median[1]))} (bootstrap over whole years)
  time     upwind ${(100 * pos.upwind).toFixed(0)} %  reaching ${(100 * pos.reach).toFixed(0)} %  downwind ${(100 * pos.downwind).toFixed(0)} %  starboard ${(100 * pos.starboard).toFixed(0)} %  in the dark ${(100 * darkShare).toFixed(0)} %
  ${sails ? `sails    ${sails.sails.filter(x => x.hours > 0).sort((a, b) => b.hours - a.hours).map(x => `${x.name} ${(100 * x.share).toFixed(0)} %`).join(', ')}  (${(100 * sails.outsideShare).toFixed(0)} % of the time outside the chart, counted with the sail on its VMG edge)\n  ` : ''}land     ${land ? (landHits.length ? `${landHits.length} route(s) touch land: ${landHits.join(', ')}` : `no route touches land (${ok.length} checked)`) : 'NOT CHECKED (no land mask)'}`)
}
fs.writeFileSync(path.join(outDir, 'elapsed.csv'), csvRows.join('\n') + '\n')
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1))

const features = methods.flatMap(m => results[m].filter(x => x.r.ok).map(x => ({
  type: 'Feature', properties: { method: m, year: x.year, start: x.startLocal, elapsedH: h(x.r.elapsedSec!) },
  geometry: { type: 'LineString', coordinates: x.r.path.map(p => [Number(p.lon.toFixed(4)), Number(p.lat.toFixed(4))]) },
})))
features.push(...course.marks.map(mk => ({ type: 'Feature', properties: { mark: mk.name, kind: mk.kind } as any, geometry: { type: 'Point', coordinates: [mk.lon, mk.lat] } as any })))
fs.writeFileSync(path.join(outDir, 'routes.geojson'), JSON.stringify({ type: 'FeatureCollection', features }))

fs.writeFileSync(path.join(outDir, 'report.html'), report())
console.log(`\nwritten: ${outDir}/report.html, summary.json, elapsed.csv, table-*.csv, routes.geojson`)

/** Hours as days and hours, rounded to the hour: 294.4 -> "12d6h", 14 -> "14h". */

// ── route map ───────────────────────────────────────────────────────────────
// Equirectangular at the mid latitude (true shape at that latitude, which is
// what a chart table shows for an ocean this size), land drawn from the SAME
// mask the router used, so a route that looks like it crosses land is a real
// fault rather than a coastline that disagrees with the router's.
/**
 * A wind barb at (x, y) in SVG pixels. The staff points the way the wind comes
 * FROM; feathers sit at its outer end on the side 90 deg clockwise of the staff
 * (northern-hemisphere convention: a westerly's feathers point north). Rounded
 * to the nearest 5 kn; a pennant is 50, a full feather 10, a half 5, and under
 * 2.5 kn is drawn as a calm circle.
 */
function barb(x: number, y: number, fromDeg: number, kn: number, title: string, o: { len?: number; color?: string } = {}): string {
  const r = (fromDeg * Math.PI) / 180
  const ux = Math.sin(r), uy = -Math.cos(r)          // staff direction in SVG (y down)
  const px = -uy, py = ux                            // 90 deg clockwise of the staff, on screen
  const len = o.len ?? 32, fl = len * 0.375, gap = len * 0.16
  const st = o.color ? ` style="stroke:${o.color}"` : '', fi = o.color ? ` style="fill:${o.color}"` : ''
  const t = `<title>${title}</title>`
  if (kn < 2.5) return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="none" class="barb"${st}/>${t}</g>`
  let v = Math.round(kn / 5) * 5
  const parts: string[] = [`M${x.toFixed(1)},${y.toFixed(1)}L${(x + ux * len).toFixed(1)},${(y + uy * len).toFixed(1)}`]
  let d = len
  const at = (k: number) => [x + ux * k, y + uy * k]
  const fill: string[] = []
  while (v >= 50) {
    const [ax, ay] = at(d), [bx, by] = at(d - len * 0.19)
    fill.push(`M${ax.toFixed(1)},${ay.toFixed(1)}L${(ax + px * fl).toFixed(1)},${(ay + py * fl).toFixed(1)}L${bx.toFixed(1)},${by.toFixed(1)}Z`)
    d -= len * 0.25; v -= 50
  }
  while (v >= 10) {
    const [ax, ay] = at(d)
    parts.push(`M${ax.toFixed(1)},${ay.toFixed(1)}L${(ax + px * fl + ux * 3).toFixed(1)},${(ay + py * fl + uy * 3).toFixed(1)}`)
    d -= gap; v -= 10
  }
  if (v >= 5) {
    if (d === len) d -= gap                           // a lone half barb sits in from the end
    const [ax, ay] = at(d)
    parts.push(`M${ax.toFixed(1)},${ay.toFixed(1)}L${(ax + px * fl * 0.5 + ux * 1.5).toFixed(1)},${(ay + py * fl * 0.5 + uy * 1.5).toFixed(1)}`)
  }
  return `<g><path d="${parts.join('')}" fill="none" class="barb"${st}/>${fill.length ? `<path d="${fill.join('')}" class="pennant"${fi}/>` : ''}<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(len / 18).toFixed(1)}" class="pennant"${fi}/>${t}</g>`
}

function routeMap(m: string): string {
  const esc = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const ok = results[m].filter(x => x.r.ok)
  const pts = ok.flatMap(x => x.r.path)
  // A loop, not Math.min(...xs): 320 ocean routes are ~10^5 points, past what a
  // spread can pass as arguments (RangeError: Maximum call stack size exceeded).
  let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity
  for (const p of [...pts, ...course.marks]) {
    if (p.lat < laMin) laMin = p.lat; if (p.lat > laMax) laMax = p.lat
    if (p.lon < loMin) loMin = p.lon; if (p.lon > loMax) loMax = p.lon
  }
  const pad = Math.max(0.5, 0.06 * Math.max(laMax - laMin, loMax - loMin))
  const la0 = laMin - pad, la1 = laMax + pad, lo0 = loMin - pad, lo1 = loMax + pad
  const k = Math.cos(((la0 + la1) / 2) * Math.PI / 180)
  const W = 940, L = 34, B = 22, Wp = W - L - 8
  const Hp = Math.max(160, Math.min(1100, (Wp * (la1 - la0)) / ((lo1 - lo0) * k)))
  const H = Hp + B + 8
  const xf = (x: number) => L + ((x - lo0) / (lo1 - lo0)) * Wp, yf = (y: number) => 8 + (1 - (y - la0) / (la1 - la0)) * Hp
  const X = (x: number) => xf(x).toFixed(1), Y = (y: number) => yf(y).toFixed(1)

  // Land: one rect per horizontal run of land pixels, 2 px cells, each cell
  // sampled at 3 x 3 points so a small island (Catalina is ~6 px) is not missed.
  let landSvg = ''
  if (land) {
    const cell = 2, nx = Math.ceil(Wp / cell), ny = Math.ceil(Hp / cell)
    const isL = (lat: number, lon: number) => {
      const i = Math.round((lat - land.lat0) / land.dLat), j = Math.round((lon - land.lon0) / land.dLon)
      return i >= 0 && i < land.nLat && j >= 0 && j < land.nLon && land.cells[i * land.nLon + j] === 1
    }
    const rects: string[] = []
    for (let r = 0; r < ny; r++) {
      let run = -1
      for (let c = 0; c <= nx; c++) {
        let hit = false
        if (c < nx) for (let a = 0; a < 3 && !hit; a++) for (let b = 0; b < 3 && !hit; b++) {
          const lon = lo0 + ((c + (a + 0.5) / 3) * cell / Wp) * (lo1 - lo0)
          const lat = la1 - ((r + (b + 0.5) / 3) * cell / Hp) * (la1 - la0)
          hit = isL(lat, lon)
        }
        if (hit && run < 0) run = c
        if (!hit && run >= 0) { rects.push(`<rect x="${(L + run * cell).toFixed(0)}" y="${(8 + r * cell).toFixed(0)}" width="${(c - run) * cell}" height="${cell}"/>`); run = -1 }
      }
    }
    landSvg = `<g fill="#bdbdb6" class="land">${rects.join('')}</g>`
  }

  // Graticule: a round step giving 4-10 lines across the longer side.
  const span = Math.max(la1 - la0, lo1 - lo0)
  const step = [0.25, 0.5, 1, 2, 5, 10, 20].find(s => span / s <= 10) ?? 20
  const grat: string[] = []
  const fmt = (v: number, pos: string, neg: string) => `${Math.abs(v) % 1 ? Math.abs(v).toFixed(2).replace(/0+$/, '') : Math.abs(v)}°${v >= 0 ? pos : neg}`
  for (let v = Math.ceil(lo0 / step) * step; v <= lo1; v += step) grat.push(`<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${(8 + Hp).toFixed(1)}"/><text x="${X(v)}" y="${(8 + Hp + 15).toFixed(1)}" text-anchor="middle">${fmt(v, 'E', 'W')}</text>`)
  for (let v = Math.ceil(la0 / step) * step; v <= la1; v += step) grat.push(`<line x1="${L}" x2="${L + Wp}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${(yf(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v, 'N', 'S')}</text>`)

  // Colour by elapsed time, fast (dark blue) to slow (orange).
  const ramp = ['#0b3c8c', '#2a6fb8', '#3fa3a8', '#9cbf5a', '#e0a032', '#d9592b']
  const col = (f: number) => {
    const x = Math.max(0, Math.min(1, f)) * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(x)), t = x - i
    const p = (c: string, o: number) => parseInt(c.slice(o, o + 2), 16)
    const mix = (o: number) => Math.round(p(ramp[i], o) + t * (p(ramp[i + 1], o) - p(ramp[i], o)))
    return `rgb(${mix(1)},${mix(3)},${mix(5)})`
  }
  const es = ok.map(x => x.r.elapsedSec! / 3600)
  const e0 = Math.min(...es), e1 = Math.max(...es)
  const op = Math.max(0.25, Math.min(0.85, 3 / Math.sqrt(ok.length || 1)))
  const byE = [...ok].sort((a, b) => a.r.elapsedSec! - b.r.elapsedSec!)
  const rep = byE.length ? byE[Math.floor((byE.length - 1) / 2)] : null
  // One barb interval for every route, set on the median one so its barbs do
  // not overlap along the line.
  let every = 12
  if (rep) {
    const P = rep.r.path
    let pxLen = 0
    for (let i = 1; i < P.length; i++) pxLen += Math.hypot(xf(P[i].lon) - xf(P[i - 1].lon), yf(P[i].lat) - yf(P[i - 1].lat))
    const hours = (P[P.length - 1].t - P[0].t) / 3600e3
    every = [1, 2, 3, 6, 12, 24, 48].find(hh => (pxLen / (hours / hh)) >= 40) ?? 48
  }
  // The wind each route MET, at the polar's height, every `every` hours of it.
  const barbsFor = (P: RouteResult['path'], o: { len?: number; color?: string }) => {
    const out: string[] = []
    let seg = 0
    for (let tt = P[0].t; tt <= P[P.length - 1].t; tt += every * 3600e3) {
      while (seg < P.length - 2 && P[seg + 1].t <= tt) seg++
      const a = P[seg], b = P[seg + 1] ?? a
      const f = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0
      const lat = a.lat + f * (b.lat - a.lat), lon = a.lon + f * (b.lon - a.lon)
      // TWA is signed relative to the heading (+ = starboard): TWD = heading + TWA.
      const hdg = Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180 / Math.PI
      const twd = (((hdg + a.twa) % 360) + 360) % 360
      out.push(barb(xf(lon), yf(lat), twd, a.tws, `${new Date(tt).toISOString().slice(5, 16).replace('T', ' ')} UTC: ${a.tws.toFixed(1)} kn from ${twd.toFixed(0)}°, TWA ${Math.abs(a.twa).toFixed(0)}° ${a.twa >= 0 ? 'stbd' : 'port'}, ${a.bsp.toFixed(1)} kn`, o))
    }
    return out.join('')
  }
  // Every route with its own barbs, in its own colour, slowest first so the
  // fast routes are drawn on top. A route and its barbs are one group, tagged
  // with its year, so the year selector shows or hides them together.
  const lines = [...ok].sort((a, b) => b.r.elapsedSec! - a.r.elapsedSec!).map(x => {
    const e = x.r.elapsedSec! / 3600
    const c = col(e1 > e0 ? (e - e0) / (e1 - e0) : 0)
    return `<g class="rt" data-year="${x.year}"><polyline fill="none" stroke="${c}" stroke-opacity="${op.toFixed(2)}" stroke-width="1.4" stroke-linejoin="round" points="${x.r.path.map(p => `${X(p.lon)},${Y(p.lat)}`).join(' ')}"><title>${esc(x.startLocal)} local: ${dh(e)}, ${x.r.sailedNm.toFixed(0)} nm</title></polyline><g class="rb">${barbsFor(x.r.path, { len: 22, color: c })}</g></g>`
  }).join('')
  let repSvg = '', repNote = ''
  if (rep) {
    const P = rep.r.path
    const pts2 = P.map(p => `${X(p.lon)},${Y(p.lat)}`).join(' ')
    repSvg = `<g class="rt rep" data-year="${rep.year}"><polyline fill="none" stroke-width="5" class="halo" points="${pts2}"/><polyline fill="none" stroke="#111" stroke-width="2.2" class="ink" points="${pts2}"/><g class="barbs">${barbsFor(P, {})}</g></g>`
    const e = rep.r.elapsedSec! / 3600
    repNote = `<p class="dim">Bold: the median start, ${esc(rep.startLocal)} local, ${dh(e)}, ${rep.r.sailedNm.toFixed(0)} nm sailed. Barbs every ${every} h on every route show the wind it met at ${mast} m, in the route's colour (half barb 5 kn, full 10, pennant 50); hover one for the time, TWA and boat speed.${ok.length > 40 ? ' With this many routes the barbs are shown one year at a time: pick a year above the map.' : ''}</p>`
  }
  const rhumb = `<polyline fill="none" stroke="#111" stroke-dasharray="5 4" stroke-width="1" class="ink" points="${course.marks.map(mk => `${X(mk.lon)},${Y(mk.lat)}`).join(' ')}"/>`
  const marks = course.marks.map(mk => `<circle cx="${X(mk.lon)}" cy="${Y(mk.lat)}" r="4" class="mark"/><text x="${(xf(mk.lon) + 7).toFixed(1)}" y="${(yf(mk.lat) - 7).toFixed(1)}" class="lbl">${esc(mk.name)}</text>`).join('')
  // Legend: the ramp with its two ends in hours and days.
  const lg = Array.from({ length: 40 }, (_, i) => `<rect x="${i * 4}" y="0" width="4" height="10" fill="${col(i / 39)}"/>`).join('')
  // The legend sits under the map, not on it: on an ocean course the empty
  // corner is never the same one, and on Transpac it landed on Hawaii.
  const legend = ok.length > 1 ? `<p class="dim legend">fastest ${dh(e0)} <svg width="160" height="10" style="vertical-align:middle">${lg}</svg> slowest ${dh(e1)}</p>` : ''
  // Barbs on every route are readable for a year's worth of starts, not for
  // twenty years' worth on one chart: past 40 routes they wait for a year to
  // be picked. The selector filters routes AND their barbs.
  const yrs = Array.from(new Set(ok.map(x => x.year))).sort()
  const manyRoutes = ok.length > 40
  const picker = yrs.length > 1 ? `<p class="dim">Show <select onchange="pickYear(this)"><option value="">all years${manyRoutes ? ' (barbs on the median route only)' : ''}</option>${yrs.map(y => `<option>${y}</option>`).join('')}</select></p>` : ''
  return `<h3>${m === 'iso' ? 'Isochrone' : 'Grid'} — ${ok.length} route${ok.length === 1 ? '' : 's'}</h3>
${picker}<svg viewBox="0 0 ${W} ${H.toFixed(0)}" width="100%" class="map${manyRoutes ? '' : ' showbarbs'}" data-many="${manyRoutes ? 1 : 0}" style="max-width:${W}px">
<rect x="${L}" y="8" width="${Wp}" height="${Hp.toFixed(1)}" class="sea"/>${landSvg}<g class="grat">${grat.join('')}</g>${rhumb}${lines}${repSvg}${marks}</svg>${legend}${repNote}`
}

// ── report ──────────────────────────────────────────────────────────────────
function report(): string {
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const ms = summary.methods as Record<string, any>
  const statRows = methods.map(m => {
    const e = ms[m].elapsedHours
    return `<tr><th>${m === 'iso' ? 'Isochrone' : 'Grid'}</th>${[e.min, e.max, e.mean, e.median, e.sd].map((v: number) => `<td>${dh(v)}</td>`).join('')}<td>${dh(e.medianCI90[0])}–${dh(e.medianCI90[1])}</td><td>${dh(e.meanCI90[0])}–${dh(e.meanCI90[1])}</td><td>${e.n}${e.failed ? ` (${e.failed} failed)` : ''}</td></tr>`
  }).join('')
  const f2 = dh
  const pc = (f: number) => (Number.isFinite(f) ? `${Math.round(100 * f)} %` : '–')
  const multi = offsetsH.length > 1
  // Red -> yellow -> green with the share of time, on a square-root scale so a
  // bin with a fraction of a percent still shows; an empty bin stays blank.
  const rg = (f: number) => {
    const stops = [[215, 48, 39], [252, 141, 89], [254, 224, 139], [145, 207, 96], [26, 152, 80]]
    const x = Math.max(0, Math.min(1, f)) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), u = x - k
    const c = stops[k].map((v, n) => Math.round(v + u * (stops[k + 1][n] - v)))
    return { bg: `rgb(${c.join(',')})`, fg: f > 0.85 ? '#fff' : '#111' }
  }
  // Elapsed-time tables filled on the same scale, inverted: green is fast, red
  // slow, spread over the table's own range (every value but n), so the
  // fastest and slowest cells in it are the two ends.
  const eFill = (v: number, lo: number, hi: number) => {
    if (!Number.isFinite(v)) return ''
    const { bg, fg } = rg(hi > lo ? 1 - (v - lo) / (hi - lo) : 0.5)
    return ` style="background:${bg};color:${fg}"`
  }
  const range = (vals: number[]) => { const v = vals.filter(Number.isFinite); return [Math.min(...v), Math.max(...v)] as const }
  const [yLo, yHi] = range(methods.flatMap(m => ms[m].byYear.flatMap((r: any) => [r.mean, r.min, r.max])))
  const [oLo, oHi] = range(methods.flatMap(m => ms[m].byOffset.flatMap((r: any) => [r.mean, r.median, r.min, r.max])))
  const ec = (v: number, lo: number, hi: number) => `<td${eFill(v, lo, hi)}>${f2(v)}</td>`
  const yearRows = years.map(y => `<tr><th>${y}</th>${methods.map(m => {
    const r = ms[m].byYear.find((x: any) => x.year === y)
    return multi ? `${ec(r.mean, yLo, yHi)}${ec(r.min, yLo, yHi)}${ec(r.max, yLo, yHi)}<td class="dim">${r.n}/${r.of}</td>`
      : r.n ? ec(r.mean, yLo, yHi) : '<td>DNF</td>'
  }).join('')}</tr>`).join('')
  const yearHead = multi ? methods.map(m => `<th>${m} mean</th><th>min</th><th>max</th><th>n</th>`).join('') : methods.map(m => `<th>${m} h</th>`).join('')
  const offRows = offsetsH.map((o, i) => `<tr><th>${o >= 0 ? '+' : ''}${(o / 24).toFixed(o % 24 ? 1 : 0)} d</th>${methods.map(m => {
    const r = ms[m].byOffset[i]
    return `${ec(r.mean, oLo, oHi)}${ec(r.median, oLo, oHi)}${ec(r.min, oLo, oHi)}${ec(r.max, oLo, oHi)}<td class="dim">${r.n}</td>`
  }).join('')}</tr>`).join('')
  const offTable = multi ? `<h2>By start date</h2><p class="dim">Each row is one start offset from ${esc(arg('start')!.slice(5, 10))}, over all years. Green is fast, red slow, across the whole table.</p><table><tr><th></th>${methods.map(m => `<th>${m} mean</th><th>median</th><th>min</th><th>max</th><th>n</th>`).join('')}</tr>${offRows}</table>` : ''
  // TWS down the side, TWA across: one row per 2 kn band reads as "in this
  // breeze, where on the dial was the boat".
  const heat = (m: string) => heatTableHtml(ms[m].tableAtTargets, { label: m === 'iso' ? 'Isochrone' : 'Grid', mast, folded: ms[m].movedToTargets, targetsFrom: "the polar's own tabulated targets" })
  const sailSec = sailChart ? sailSectionHtml(sailChart, methods.map(m => ({ key: m, label: m === 'iso' ? 'Isochrone' : 'Grid', sails: ms[m].sails, table: ms[m].tableAtTargets })),
    { mast, races: ms[methods[0]].elapsedHours.n }) : ''
  const maps = methods.map(routeMap).join('')
  const conv = convergence ? `<p class="dim">Convergence (${convergence.year}): isochrone at half step, half sector and a 2.5° fan changed elapsed time by ${convergence.isoChangePct.toFixed(2)} %; the grid at half cell and 48 directions differs from the isochrone by ${convergence.gridFineVsIsoPct.toFixed(2)} %.</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(course.name ?? 'Routing climatology')}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#111}
table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #ddd;padding:3px 7px;text-align:right;font-variant-numeric:tabular-nums}
th{background:#f6f6f6}.heat td,.heat th{min-width:22px;font-size:10.5px;padding:2px 3px;white-space:nowrap}.heat{margin-top:2px}.heat .tot{font-weight:600}.heat .totrow td,.heat .totrow th{border-top:2px solid #888}.scroll{overflow-x:auto}.dim{color:#666}h1{font-size:22px}h2{font-size:17px;margin-top:28px}
.map .sea{fill:#eef4f8}.map .grat line{stroke:#c9d6df;stroke-width:.6}.map text{font-size:11px;fill:#555}.map .lbl{font-size:12px;fill:#111}.map .mark{fill:#111}.map .rb{display:none}.map.showbarbs .rb{display:inline}.map .rb .barb{stroke-width:1.1}.map .barb{stroke:#b3121b;stroke-width:1.8;stroke-linecap:round}.legend{margin:4px 0}.map .pennant{fill:#b3121b}.map .halo{stroke:#fff;stroke-opacity:.8}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}th{background:#222}td,th{border-color:#333}.dim{color:#999}
.map .sea{fill:#16202a}.map .land{fill:#3a3d40}.map .grat line{stroke:#2c3a46}.map text{fill:#aaa}.map .lbl{fill:#eee}.map .mark{fill:#eee}.map .ink{stroke:#ddd}.map .barb{stroke:#ff8a7a}.map .pennant{fill:#ff8a7a}.map .halo{stroke:#000}}</style>
<script>function pickYear(sel){var svg=sel.parentNode.nextElementSibling,y=sel.value;svg.querySelectorAll('.rt').forEach(function(g){g.style.display=!y||g.getAttribute('data-year')===y?'':'none'});svg.classList.toggle('showbarbs',!!y||svg.getAttribute('data-many')!=='1')}</script></head><body>
<h1>${esc(course.name ?? 'Routing climatology')}</h1>
<p>${esc(course.marks.map(m => m.name).join(' → '))} · ${course.rhumbNm.toFixed(1)} nm rhumb · start ${esc(arg('start')!.slice(5))} local (${esc(zone ?? '')}) · ${years[0]}–${years[years.length - 1]} (${years.length} years${multi ? ` × ${offsetsH.length} starts, ±${windowD} d every ${everyH} h` : ''}) · polar ${esc(path.basename(arg('polar')!))} at ${mast} m, lift “${lift}” · tack ${polar.tackSec}s / gybe ${polar.gybeSec}s · sailed at ${pc(dayNight.dayFactor)} of the polar by day and ${pc(dayNight.nightFactor)} in the dark (sun below ${dayNight.darkBelowDeg}° at the boat)${polar.factor !== 1 ? `, × ${polar.factor} overall` : ''}</p>
<h2>Elapsed time</h2><table><tr><th></th><th>min</th><th>max</th><th>mean</th><th>median</th><th>1σ</th><th>median 90% CI</th><th>mean 90% CI</th><th>n</th></tr>${statRows}</table>${conv}
<h2>Routes</h2>${maps}
<p class="dim">Each line is one start, coloured by its elapsed time. Hover a line for its start date and time. Grey is the land mask the router avoided; dashed is the rhumb line between the marks.</p>
<h2>Time on each point of sail</h2><p class="dim">${methods.map(m => `${m === 'iso' ? 'Isochrone' : 'Grid'}: ${pc(ms[m].pointOfSail.upwind)} upwind (&lt;70°), ${pc(ms[m].pointOfSail.reach)} reaching, ${pc(ms[m].pointOfSail.downwind)} downwind (&gt;120°), ${pc(ms[m].pointOfSail.starboard)} on starboard, ${pc(ms[m].darkShare)} in the dark.`).join(' ')} ${land ? methods.map(m => ms[m].landHits.length ? `<b>${m === 'iso' ? 'Isochrone' : 'Grid'}: ${ms[m].landHits.length} route(s) touch land (${esc(ms[m].landHits.join(', '))}).</b>` : '').filter(Boolean).join(' ') || 'Every route re-checked against the land mask: none touches land.' : '<b>Routed without a land mask.</b>'}</p>${methods.map(heat).join('')}
${sailSec}${offTable}<h2>Per year</h2><p class="dim">Green is fast, red slow, across the whole table.</p><table><tr><th></th>${yearHead}</tr>${yearRows}</table>
<p class="dim">ERA5 (C3S) hourly 0.25°; wind sampled bilinear in space, linear in time, direction from u/v and speed preserved. Arrival at each mark solved exactly from every front point (no isochrone quantisation). Marks routed leg by leg, which is exact for point marks.</p>
</body></html>`
}
})().catch(e => { console.error(e); process.exit(1) })
