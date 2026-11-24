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
// Outputs in --out: summary.json (everything), elapsed.csv (per year and method),
// table-<method>-pct.csv and -hours.csv, routes.geojson, report.html.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseRoutingPolar } from '../src/lib/routing/polar'
import { parseCourseGpx } from '../src/lib/routing/course'
import { liftToHeight, type LiftMethod, type RawFields } from '../src/lib/routing/windField'
import { routeIsochrone, type RouteResult } from '../src/lib/routing/isochrone'
import { routeGrid } from '../src/lib/routing/gridRouter'
import { elapsedStats, twaTwsTable, tableCsv, localStartToUtc, pointOfSail, bootstrap } from '../src/lib/routing/climatology'
import { offsetFromCoords } from '../src/lib/tzFromCoords'
import type { LandMask } from '../src/lib/routing/land'
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
  --method both|iso|grid default both
  --mast M               polar reference height, m (default 10)
  --lift power|mo|neutral|none   default power (none when --mast 10)
  --tack S --gybe S      manoeuvre losses, seconds (default 60 / 45)
  --factor F             polar multiplier (default 1)
  --radius NM            mark rounding radius (default 0.25)
  --step MIN             isochrone step (default 30)
  --sector-nm NM         isochrone pruning resolution (default 0.5)
  --cell NM --stencil N  grid lattice spacing (default 2) and directions (16|32|48, default 32)
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
const isoOpts = { stepMin: Number(arg('step', '30')), sectorNm: Number(arg('sector-nm', '0.5')) }
const gridOpts = { cellNm: Number(arg('cell', '2')), stencil: Number(arg('stencil', '32')) as 16 | 32 | 48 }

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
  const [a, b] = arg('years')!.split('-').map(Number)
  years = yearsAvail.filter(y => y >= a && y <= (b || a))
}
if (!years.length) throw new Error(`no years in ${dataDir}/era5`)
const land = loadLand()

// ── run ─────────────────────────────────────────────────────────────────────
const start = course.marks[0]
const offsetAt = (ms: number) => {
  const o = offsetFromCoords(start.lat, start.lon, ms)
  if (!o) throw new Error('could not resolve the time zone at the start position')
  return o.offsetMin
}
const methods = method === 'both' ? ['iso', 'grid'] : [method]
const results: Record<string, { year: number; startUtc: string; r: RouteResult; ms: number }[]> = { iso: [], grid: [] }
const liftLog: { year: number; meanRatio: number; stableShare: number | null; fallbacks: number }[] = []
const zone = offsetFromCoords(start.lat, start.lon, Date.now())?.zone

console.log(`${course.name ?? 'course'}: ${course.marks.map(m => m.name).join(' -> ')}, ${course.rhumbNm.toFixed(1)} nm rhumb`)
console.log(`start ${String(DD).padStart(2, '0')}/${String(MM).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} local (${zone}), ${years.length} years, polar at ${mast} m, lift '${lift}', land ${land ? 'on' : 'OFF'}`)

let convergence: Record<string, number> | null = null
for (const y of years) {
  const raw = loadYear(y)
  const { grid, stats } = liftToHeight(raw, mast, lift)
  liftLog.push({ year: y, ...stats })
  const env: Env = { polar, wind: grid, land }
  const t0 = localStartToUtc(y, MM, DD, hh, mm, offsetAt)
  for (const m of methods) {
    const t = Date.now()
    const r = m === 'iso' ? routeIsochrone(env, course, t0, isoOpts) : routeGrid(env, course, t0, gridOpts)
    results[m].push({ year: y, startUtc: new Date(t0).toISOString(), r, ms: Date.now() - t })
    const e = r.ok ? `${(r.elapsedSec! / 3600).toFixed(2)} h` : `FAILED: ${r.reason}`
    console.log(`  ${y} ${m.padEnd(4)} ${e}  ${r.ok ? `${r.sailedNm.toFixed(0)} nm sailed, ${r.tacks} tacks, ${r.gybes} gybes` : ''}  (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  }
  if (flag('convergence') && !convergence && methods.includes('iso')) {
    const base = results.iso[results.iso.length - 1].r.elapsedSec!
    const half = routeIsochrone(env, course, t0, { stepMin: isoOpts.stepMin / 2, sectorNm: isoOpts.sectorNm / 2, headingStepDeg: 2.5 }).elapsedSec!
    const g = routeGrid(env, course, t0, { cellNm: gridOpts.cellNm / 2, stencil: 48, maxNodes: 3_000_000 }).elapsedSec!
    convergence = { year: y, isoSec: base, isoHalfSec: half, isoChangePct: (100 * (half - base)) / base, gridFineSec: g, gridFineVsIsoPct: (100 * (g - base)) / base }
    console.log(`  convergence ${y}: iso at half step/sector/fan ${(half / 3600).toFixed(3)} h (${convergence.isoChangePct.toFixed(2)} %), grid at half cell / 48 dir ${(g / 3600).toFixed(3)} h (${convergence.gridFineVsIsoPct.toFixed(2)} % vs iso)`)
  }
}

// ── results ─────────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true })
const h = (s: number) => (s / 3600)
const summary: Record<string, unknown> = {
  course: { name: course.name, marks: course.marks, rhumbNm: course.rhumbNm },
  start: { local: arg('start'), zone, years },
  polar: { file: path.basename(arg('polar')!), refHeightM: mast, tackSec: polar.tackSec, gybeSec: polar.gybeSec, factor: polar.factor },
  wind: { source: 'ERA5 single levels', lift, liftLog },
  options: { iso: isoOpts, grid: gridOpts, radiusNm: Number(arg('radius', '0.25')) },
  convergence,
  methods: {},
}
const csvRows = ['year,start_utc,method,elapsed_h,sailed_nm,tacks,gybes,' + course.marks.slice(1).map(m => `leg_${m.name}_h`).join(',')]
for (const m of methods) {
  const rs = results[m]
  const st = elapsedStats(rs.map(x => x.r))
  const ok = rs.filter(x => x.r.ok)
  const paths = ok.map(x => x.r.path)
  const table = twaTwsTable(paths)
  const pos = pointOfSail(paths)
  const ci = bootstrap(ok.map(x => x.r.elapsedSec!))
  fs.writeFileSync(path.join(outDir, `table-${m}-pct.csv`), tableCsv(table, 'pct') + '\n')
  fs.writeFileSync(path.join(outDir, `table-${m}-hours.csv`), tableCsv(table, 'hours') + '\n')
  ;(summary.methods as Record<string, unknown>)[m] = {
    elapsedHours: { n: st.n, failed: st.failed, min: h(st.minSec), max: h(st.maxSec), mean: h(st.meanSec), median: h(st.medianSec), sd: h(st.sdSec),
      medianCI90: ci.median.map(h), meanCI90: ci.mean.map(h) },
    pointOfSail: pos, table,
    years: rs.map(x => ({ year: x.year, startUtc: x.startUtc, ok: x.r.ok, reason: x.r.reason, elapsedH: x.r.elapsedSec != null ? h(x.r.elapsedSec) : null,
      legH: x.r.legSec.map(h), sailedNm: x.r.sailedNm, tacks: x.r.tacks, gybes: x.r.gybes, runMs: x.ms })),
  }
  for (const x of rs) csvRows.push([x.year, x.startUtc, m, x.r.ok ? h(x.r.elapsedSec!).toFixed(3) : '', x.r.sailedNm.toFixed(1), x.r.tacks, x.r.gybes, ...x.r.legSec.map(s => h(s).toFixed(3))].join(','))
  console.log(`\n${m.toUpperCase()}  n=${st.n}${st.failed ? ` (${st.failed} failed)` : ''}
  elapsed  min ${h(st.minSec).toFixed(2)}  max ${h(st.maxSec).toFixed(2)}  mean ${h(st.meanSec).toFixed(2)}  median ${h(st.medianSec).toFixed(2)}  1 sigma ${h(st.sdSec).toFixed(2)} h
           median 90 % CI ${h(ci.median[0]).toFixed(2)}-${h(ci.median[1]).toFixed(2)} h (bootstrap over years)
  time     upwind ${(100 * pos.upwind).toFixed(0)} %  reaching ${(100 * pos.reach).toFixed(0)} %  downwind ${(100 * pos.downwind).toFixed(0)} %  starboard ${(100 * pos.starboard).toFixed(0)} %`)
}
fs.writeFileSync(path.join(outDir, 'elapsed.csv'), csvRows.join('\n') + '\n')
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1))

const features = methods.flatMap(m => results[m].filter(x => x.r.ok).map(x => ({
  type: 'Feature', properties: { method: m, year: x.year, elapsedH: h(x.r.elapsedSec!) },
  geometry: { type: 'LineString', coordinates: x.r.path.map(p => [Number(p.lon.toFixed(4)), Number(p.lat.toFixed(4))]) },
})))
features.push(...course.marks.map(mk => ({ type: 'Feature', properties: { mark: mk.name, kind: mk.kind } as any, geometry: { type: 'Point', coordinates: [mk.lon, mk.lat] } as any })))
fs.writeFileSync(path.join(outDir, 'routes.geojson'), JSON.stringify({ type: 'FeatureCollection', features }))

fs.writeFileSync(path.join(outDir, 'report.html'), report())
console.log(`\nwritten: ${outDir}/report.html, summary.json, elapsed.csv, table-*.csv, routes.geojson`)

// ── report ──────────────────────────────────────────────────────────────────
function report(): string {
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const ms = summary.methods as Record<string, any>
  const statRows = methods.map(m => {
    const e = ms[m].elapsedHours
    return `<tr><th>${m === 'iso' ? 'Isochrone' : 'Grid'}</th>${[e.min, e.max, e.mean, e.median, e.sd].map((v: number) => `<td>${v.toFixed(2)}</td>`).join('')}<td>${e.medianCI90[0].toFixed(2)}–${e.medianCI90[1].toFixed(2)}</td><td>${e.n}${e.failed ? ` (${e.failed} failed)` : ''}</td></tr>`
  }).join('')
  const yearRows = years.map(y => `<tr><th>${y}</th>${methods.map(m => {
    const r = ms[m].years.find((x: any) => x.year === y)
    return `<td>${r?.ok ? r.elapsedH.toFixed(2) : 'DNF'}</td><td class="dim">${r?.ok ? `${r.tacks}/${r.gybes}` : ''}</td>`
  }).join('')}</tr>`).join('')
  const heat = (m: string) => {
    const t = ms[m].table
    const max = Math.max(...t.hours.flat())
    const twsStep = t.twsEdges[1] - t.twsEdges[0]
    const head = `<tr><th>TWA \\ TWS</th>${t.twsEdges.map((s: number, i: number) => `<th>${i === t.twsEdges.length - 1 ? `≥${s}` : `${s}–${s + twsStep}`}</th>`).join('')}</tr>`
    const rows = t.hours.map((row: number[], r: number) => {
      const lab = r === 0 ? `&lt;${t.twaEdges[1]}` : r === t.twaEdges.length - 1 ? `≥${t.twaEdges[r]}` : `${t.twaEdges[r]}–${t.twaEdges[r] + 5}`
      return `<tr><th>${lab}</th>${row.map(v => {
        const pct = t.totalHours ? (100 * v) / t.totalHours : 0
        const a = max ? Math.sqrt(v / max) : 0
        return `<td style="background:rgba(37,99,235,${a.toFixed(3)});color:${a > 0.55 ? '#fff' : 'inherit'}">${pct >= 0.05 ? pct.toFixed(1) : ''}</td>`
      }).join('')}</tr>`
    }).join('')
    return `<h3>${m === 'iso' ? 'Isochrone' : 'Grid'} — % of sailing time (mean ${t.totalHours.toFixed(1)} h per race)</h3><table class="heat">${head}${rows}</table>`
  }
  // Routes: equirectangular SVG.
  const all = methods.flatMap(m => results[m].filter(x => x.r.ok).flatMap(x => x.r.path))
  const la = [...all.map(p => p.lat), ...course.marks.map(k => k.lat)], lo = [...all.map(p => p.lon), ...course.marks.map(k => k.lon)]
  const la0 = Math.min(...la), la1 = Math.max(...la), lo0 = Math.min(...lo), lo1 = Math.max(...lo)
  const k = Math.cos(((la0 + la1) / 2) * Math.PI / 180)
  const W = 640, Hh = Math.max(200, Math.min(900, (W * (la1 - la0)) / ((lo1 - lo0) * k || 1)))
  const X = (x: number) => (((x - lo0) / (lo1 - lo0 || 1)) * (W - 20) + 10).toFixed(1)
  const Y = (y: number) => ((1 - (y - la0) / (la1 - la0 || 1)) * (Hh - 20) + 10).toFixed(1)
  const lines = methods.flatMap(m => results[m].filter(x => x.r.ok).map(x =>
    `<polyline fill="none" stroke="${m === 'iso' ? '#2563eb' : '#d97706'}" stroke-opacity="0.45" stroke-width="1.2" points="${x.r.path.map(p => `${X(p.lon)},${Y(p.lat)}`).join(' ')}"><title>${m} ${x.year}: ${h(x.r.elapsedSec!).toFixed(2)} h</title></polyline>`)).join('')
  const marks = course.marks.map(mk => `<circle cx="${X(mk.lon)}" cy="${Y(mk.lat)}" r="4" fill="#111"/><text x="${Number(X(mk.lon)) + 6}" y="${Number(Y(mk.lat)) - 6}" font-size="11">${esc(mk.name)}</text>`).join('')
  const conv = convergence ? `<p class="dim">Convergence (${convergence.year}): isochrone at half step, half sector and a 2.5° fan changed elapsed time by ${convergence.isoChangePct.toFixed(2)} %; the grid at half cell and 48 directions differs from the isochrone by ${convergence.gridFineVsIsoPct.toFixed(2)} %.</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(course.name ?? 'Routing climatology')}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#111}
table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #ddd;padding:3px 7px;text-align:right;font-variant-numeric:tabular-nums}
th{background:#f6f6f6}.heat td{min-width:30px;font-size:12px}.dim{color:#666}h1{font-size:22px}h2{font-size:17px;margin-top:28px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}th{background:#222}td,th{border-color:#333}.dim{color:#999}}</style></head><body>
<h1>${esc(course.name ?? 'Routing climatology')}</h1>
<p>${esc(course.marks.map(m => m.name).join(' → '))} · ${course.rhumbNm.toFixed(1)} nm rhumb · start ${esc(arg('start')!.slice(5))} local (${esc(zone ?? '')}) · ${years[0]}–${years[years.length - 1]} (${years.length} years) · polar ${esc(path.basename(arg('polar')!))} at ${mast} m, lift “${lift}” · tack ${polar.tackSec}s / gybe ${polar.gybeSec}s</p>
<h2>Elapsed time, hours</h2><table><tr><th></th><th>min</th><th>max</th><th>mean</th><th>median</th><th>1σ</th><th>median 90% CI</th><th>n</th></tr>${statRows}</table>${conv}
<h2>Routes</h2><svg viewBox="0 0 ${W} ${Hh.toFixed(0)}" width="100%" style="max-width:${W}px;border:1px solid #ddd">${lines}${marks}</svg>
<p class="dim">Blue isochrone, orange grid. Hover a line for its year.</p>
<h2>Time on each point of sail</h2>${methods.map(heat).join('')}
<h2>Per year</h2><table><tr><th></th>${methods.map(m => `<th>${m} h</th><th>tacks/gybes</th>`).join('')}</tr>${yearRows}</table>
<p class="dim">ERA5 (C3S) hourly 0.25°; wind sampled bilinear in space, linear in time, direction from u/v and speed preserved. Arrival at each mark solved exactly from every front point (no isochrone quantisation). Marks routed leg by leg, which is exact for point marks.</p>
</body></html>`
}
