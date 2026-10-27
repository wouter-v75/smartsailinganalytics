// What the cell_selection fix does to the Mediterranean MOS specs, measured
// against the boats' own masthead logs — and the re-expressed coefficients.
//
//   npx vite-node scripts/mos-cell-refit.ts                      # all three, dry run
//   npx vite-node scripts/mos-cell-refit.ts -- --venue porto-cervo
//   npx vite-node scripts/mos-cell-refit.ts -- --write            # rewrites the spec JSONs
//
// WHY THIS EXISTS. Open-Meteo's `cell_selection` defaults to `land`, and for a
// race area that returns a cell ashore: at Porto Cervo the ECMWF cell was
// 41.00, 9.50 — fifteen miles inland, averaging 6.05 kn where the sea cell
// averages 12.63. The app is being changed to ask for `sea`, which is right,
// and that changes the NUMBER EVERY MOS SPEC WAS FITTED TO. `a·x + b` fitted
// against one cell and fed another is not a correction, it is an offset of
// a·(x_land − x_sea) applied to a forecast nobody looked at. At Porto Cervo
// that is 0.856 × 4.13 ≈ 3.5 kn of invented wind in the racing window.
//
// WHAT IT CANNOT DO. The original fits used three years of logfile wind from a
// project that is not in this repo, so this is NOT that fit repeated. What is
// in the cloud is 2026: Porto Cervo (Sept, 11 days), St Tropez (Jul + Sep, 11
// days) and Sorrento (May, 5 days) — forty-odd usable hours each, which is
// plenty to MEASURE a 3.5 kn bias and nowhere near enough to fit a new form to.
// So this script measures and re-expresses; it does not pretend to refit.
//
// THE RE-EXPRESSION. If the old spec says truth ≈ a·x_land + b, and the two
// cells are related by x_land ≈ p·x_sea + q, then in terms of the new input
// truth ≈ (a·p)·x_sea + (a·q + b). The sector and diurnal offsets are additive
// in the OUTPUT and carry over unchanged. This keeps whatever the three-year
// fit knew about the venue instead of throwing it away — but it inherits the
// scatter of that mapping, so the stored cv_rmse and reduction_pct are DROPPED
// rather than carried over. They were measurements of a different regression.
//
// AND IT IS CHECKED, NOT ASSUMED. Every candidate — the old spec on the old
// cell, raw on the new cell, the old spec wrongly on the new cell, and the
// re-expression — is scored against the boats' logged 30 m TWS on the same
// hours. A re-expression is written only if it beats raw there. The map is fit
// on the ARCHIVE (thousands of hours), the choice is made on the LOGS.
//
// THE TRUTH IS THE BOAT'S OWN MASTHEAD, which is what the Mediterranean specs
// were always fitted against, so `fit_height_m` stays 30 and the correction is
// still applied after the lift. Dock hours are dropped: a log that starts in
// Porto Cervo's marina records sheltered wind that is not the race area's, so
// an hour counts only when the boat was under way for most of it.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { VENUES, venueAt, VENUE_MATCH_NM } from '../src/lib/venues'
import { MODELS } from '../src/components/weather/openMeteo'
import { wind30, applyMOS, specFor } from '../src/components/weather/mos'
import { score, solveOls, lag1, effectiveN, piRmse, type Band } from '../src/lib/mosFit'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const env: Record<string, string> = (() => {
  const p = new URL('../.env.local', import.meta.url)
  if (!existsSync(p)) return {}
  return Object.fromEntries(
    readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
  )
})()

const ONLY = flag('venue')
const TARGET_Z = 30
/** An hour counts only if the boat was under way for most of it. */
const MIN_BSP = Number(flag('min-bsp', '2'))
const MIN_UNDERWAY = Number(flag('min-underway', '0.7'))
const MIN_SAMPLES = Number(flag('min-samples', '20'))
const MIN_SPAN_S = Number(flag('min-span', '1500'))
/** The window the land-to-sea map is fitted on: the season and hours that race. */
const MAP_MONTHS = [5, 6, 7, 8, 9]
const MAP_HOURS: [number, number] = [9, 19]
// One year, not two. The map needs a few hundred racing hours and gets ~1,500
// from a single season; two years of a 1.3 km model with six height levels is
// a response large enough to stall the request, which is how this was found.
const MAP_FROM = flag('map-from', '2026-01-01')!
/**
 * Venue-local hours, as UTC+2.
 *
 * Both Mediterranean countries here keep CEST from late March to late October,
 * and every hour this script looks at — the May-September map window and the
 * logged days, which run May to 2 October — is inside that. So one offset is
 * exact rather than approximate, and it avoids giving `Venue` a timezone field
 * that only this script would read. A date outside summer time is refused
 * below rather than quietly shifted by an hour.
 */
const LOCAL_OFFSET_H = 2
const localHourOf = (t: number) => Math.floor(((t / 3600_000) + LOCAL_OFFSET_H) % 24)
const localMonthOf = (t: number) => new Date(t + LOCAL_OFFSET_H * 3600_000).getUTCMonth() + 1
const MAP_TO = flag('map-to', '2026-10-20')!

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

/**
 * An on-disk cache of the archive responses, outside the repo.
 *
 * Each venue needs four requests per model — the two cells over the logged
 * days, and the two cells over two years for the map — which is twenty minutes
 * of waiting for a run that mostly repeats the previous one. The archive is
 * immutable for past dates, so caching it is free, and it is what makes the
 * dry run worth reading twice. `--no-cache` forces fresh.
 */
const TIMEOUT_MS = Number(flag('timeout', '180')) * 1000
const CACHE = !argv.includes('--no-cache')
const CACHE_DIR = join(tmpdir(), 'ssa-mos-archive-cache')
function cached(url: string): string | null {
  if (!CACHE) return null
  const f = join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex')}.json`)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}
function putCache(url: string, body: string) {
  if (!CACHE) return
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex')}.json`), body)
}
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '    -')
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '     -')

type Db = { from: (table: string) => any }
interface LogRow { utc: number; lat?: number; lon?: number; tws?: number; twd?: number; bsp?: number }
interface Hour { t: number; tws: number; twd: number | null; n: number }

/** The height ladder the app would use for a mos model id. */
function heightsFor(mosModel: string): number[] | null {
  for (const m of Object.values(MODELS) as Array<Record<string, unknown>>) {
    if (m.mosModel === mosModel) return (m.heights as number[]) ?? null
  }
  return null
}

/** Hourly means of the boat's own masthead wind, dock hours dropped. */
function hourly(rows: readonly LogRow[]): Hour[] {
  const bins = new Map<number, LogRow[]>()
  for (const r of rows) {
    if (!Number.isFinite(r.utc) || !Number.isFinite(r.tws as number)) continue
    const h = Math.floor(r.utc / 3600_000) * 3600_000
    const a = bins.get(h) ?? []
    a.push(r)
    bins.set(h, a)
  }
  const out: Hour[] = []
  for (const [t, a] of Array.from(bins.entries())) {
    if (a.length < MIN_SAMPLES) continue
    const span = (Math.max(...a.map((r) => r.utc)) - Math.min(...a.map((r) => r.utc))) / 1000
    if (span < MIN_SPAN_S) continue
    const moving = a.filter((r) => (r.bsp ?? 0) >= MIN_BSP).length / a.length
    if (moving < MIN_UNDERWAY) continue
    const tws = a.reduce((q, r) => q + (r.tws as number), 0) / a.length
    // Direction as a vector mean; a scalar mean of degrees is wrong across north.
    let u = 0; let v = 0; let nd = 0
    for (const r of a) {
      if (!Number.isFinite(r.twd as number)) continue
      const rad = ((r.twd as number) * Math.PI) / 180
      u += Math.sin(rad); v += Math.cos(rad); nd++
    }
    const twd = nd ? ((Math.atan2(u / nd, v / nd) * 180) / Math.PI + 360) % 360 : null
    if (tws > 0) out.push({ t, tws, twd, n: a.length })
  }
  return out.sort((p, q) => p.t - q.t)
}

/** Archived forecasts, lifted to 30 m exactly as the app lifts them. */
async function archive30(
  model: string, heights: number[], lat: number, lon: number,
  from: string, to: string, cell: 'land' | 'sea',
) {
  const params: string[] = []
  for (const h of heights) params.push(`wind_speed_${h}m`, `wind_direction_${h}m`)
  params.push('temperature_2m')
  const url = 'https://historical-forecast-api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}&start_date=${from}&end_date=${to}`
    + `&hourly=${params.join(',')}&models=${encodeURIComponent(model)}`
    + `&cell_selection=${cell}`
  let body = cached(url)
  if (body == null) {
    // A TIMEOUT, because there was none: AROME HD over two years with six
    // height levels simply never came back, and a run that hangs for ever
    // looks exactly like a run that is working.
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    body = await r.text()
    if (!r.ok) throw new Error(`${model} ${cell}: HTTP ${r.status}: ${body.slice(0, 160)}`)
    putCache(url, body)
  }
  const j = JSON.parse(body)
  if (j.error) throw new Error(`${model} ${cell}: ${j.reason}`)
  const t: string[] = j.hourly?.time ?? []
  // wind30 wants the payload shape and km/h, and returns knots. Passing the
  // payload straight through is what keeps this identical to the app.
  const out = new Map<number, { ws: number; twd: number | null }>()
  for (let i = 0; i < t.length; i++) {
    const w = wind30(j.hourly, heights, i, TARGET_Z, 0.11, null)
    if (!w || !(w.ws30 > 0)) continue
    out.set(Date.parse(`${t[i]}:00Z`), { ws: w.ws30, twd: w.twd ?? null })
  }
  return { rows: out, cell: { lat: j.latitude as number, lon: j.longitude as number }, times: t }
}

/** x_land ≈ p·x_sea + q, over the racing window of the whole archive. */
function landFromSea(
  land: Map<number, { ws: number }>, sea: Map<number, { ws: number }>,
): { p: number; q: number; r2: number; sd: number; n: number } | null {
  const xs: number[] = []; const ys: number[] = []
  for (const [t, l] of Array.from(land.entries())) {
    const s = sea.get(t)
    if (!s) continue
    const mo = localMonthOf(t)
    const hr = localHourOf(t)
    if (!MAP_MONTHS.includes(mo) || hr < MAP_HOURS[0] || hr >= MAP_HOURS[1]) continue
    xs.push(s.ws); ys.push(l.ws)
  }
  if (xs.length < 200) return null
  const beta = solveOls(xs.map((x) => [x, 1]), ys)
  if (!beta) return null
  const [p, q] = beta
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let ssr = 0; let sst = 0
  for (let i = 0; i < xs.length; i++) { ssr += (ys[i] - (p * xs[i] + q)) ** 2; sst += (ys[i] - my) ** 2 }
  return { p, q, r2: sst > 0 ? 1 - ssr / sst : NaN, sd: Math.sqrt(ssr / xs.length), n: xs.length }
}

/** The same coefficients, expressed in terms of the new input. */
function reexpress(m: Record<string, unknown>, p: number, q: number): Record<string, unknown> {
  const a = (m.a as number) ?? 1
  const b = (m.b as number) ?? 0
  const out: Record<string, unknown> = { ...m, a: a * p, b: a * q + b }
  // The offsets are added to the OUTPUT, so they are unchanged by a change of
  // input variable. Everything that described the OLD regression's quality is
  // removed instead of being carried over as if it still applied.
  for (const k of ['cv_rmse', 'raw_rmse', 'reduction_pct', 'sector_agreement', 'best']) delete out[k]
  return out
}

async function main() {
  const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
  const svc = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !svc) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local')
    process.exit(1)
  }
  const sb: Db = createClient(url, svc, { auth: { persistSession: false } })

  // Which venues have a stored spec at all.
  const targets = VENUES.filter((v) => specFor(v.key) && (!ONLY || v.key === ONLY))
  if (!targets.length) { console.error(`No calibrated venue matches ${ONLY}`); process.exit(1) }
  console.log('\nMOS specs against the cell_selection change')
  console.log(`  venues     ${targets.map((v) => v.key).join(', ')}`)
  console.log(`  truth      the boats' own logged 30 m TWS, hours under way (bsp >= ${MIN_BSP} kn for ${(100 * MIN_UNDERWAY).toFixed(0)}% of the hour)`)
  console.log(`  map window ${MAP_FROM} to ${MAP_TO}, months ${MAP_MONTHS.join(',')}, ${MAP_HOURS[0]}-${MAP_HOURS[1]} local`)

  // Every cloud log, with just enough of it to place the session.
  const { data: sessions, error } = await sb.from('sessions')
    .select('id,date,tz_offset_minutes,boats(name),lat:log_data->rows->0->>lat,lon:log_data->rows->0->>lon')
    .not('log_data', 'is', null)
    .order('date', { ascending: true })
  if (error) throw new Error(`sessions: ${error.message}`)
  console.log(`\n${sessions.length} sessions carry a cloud log.`)

  type Sess = { id: string; date: string; boat: string; venue: string | null }
  const placed: Sess[] = []
  for (const s of sessions as Array<Record<string, any>>) {
    let lat = Number(s.lat); let lon = Number(s.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      // First row had no fix. Fetch the log and take the first row that has one
      // rather than dropping the day — 09-03 and 09-12 at Porto Cervo are both
      // like this, and they are two of eleven.
      const { data } = await sb.from('sessions').select('log_data').eq('id', s.id).single()
      const rows: LogRow[] = data?.log_data?.rows ?? []
      const fix = rows.find((r) => Number.isFinite(r.lat as number) && Number.isFinite(r.lon as number))
      lat = fix?.lat as number; lon = fix?.lon as number
    }
    const v = venueAt(lat, lon, VENUE_MATCH_NM)
    placed.push({ id: s.id, date: s.date, boat: s.boats?.name ?? '?', venue: v?.key ?? null })
  }

  const specs: Record<string, Record<string, unknown>> = {}

  for (const venue of targets) {
    const mine = placed.filter((p) => p.venue === venue.key)
    console.log(`\n${'─'.repeat(76)}\n${venue.name} (${venue.key}) — ${venue.lat}, ${venue.lon}`)
    if (!mine.length) {
      console.log('  no cloud log was sailed here, so nothing can be measured. Spec untouched.')
      continue
    }
    console.log(`  ${mine.length} days: ${mine.map((m) => `${m.date}(${m.boat.split(' ')[0]})`).join(' ')}`)

    // The boat truth, hour by hour.
    const truth: Hour[] = []
    const boats = new Set<string>()
    for (const s of mine) {
      const { data } = await sb.from('sessions').select('log_data').eq('id', s.id).single()
      const rows: LogRow[] = data?.log_data?.rows ?? []
      const hrs = hourly(rows)
      truth.push(...hrs)
      boats.add(s.boat)
      console.log(`    ${s.date}  ${String(rows.length).padStart(6)} log rows -> ${String(hrs.length).padStart(2)} usable hours`
        + `  ${hrs.length ? `${f2(Math.min(...hrs.map((h) => h.tws)))}-${f2(Math.max(...hrs.map((h) => h.tws)))} kn` : ''}`)
    }
    truth.sort((a, b) => a.t - b.t)
    const outside = truth.filter((h) => {
      const m = new Date(h.t).getUTCMonth() + 1
      return m < 4 || m > 10
    })
    if (outside.length) {
      console.log(`  ${outside.length} hours fall outside CEST, where the +2 offset this script`)
      console.log('  uses for local time is wrong by an hour. Refusing rather than shifting them.')
      continue
    }
    // Too little truth to CHECK anything is not a reason to skip the venue:
    // whether the fix moves a model's cell at all is a property of the grid,
    // not of the boat, and at Sorrento three of four models turn out to get
    // the same cell either way. Those still need recording.
    if (truth.length < 10) {
      console.log(`  only ${truth.length} usable hours here — the candidates below cannot be`)
      console.log('  scored, so a coefficient set is only touched if its cell did not move.')
    }
    const byT = new Map(truth.map((h) => [h.t, h]))
    const r1 = lag1(truth.map((h) => h.tws))
    console.log(`  ${truth.length} usable hours from ${boats.size > 1 ? Array.from(boats).join(' + ') : Array.from(boats)[0]}`
      + `, lag-1 ${f3(r1)} so nEff ~ ${effectiveN(truth.length, r1).toFixed(0)}`)
    console.log('  NOTE: that effective count is why this script does not refit. It MEASURES.')

    const spec = specFor(venue.key) as Record<string, any>
    const bands: Band[] = (spec.bands ?? []) as Band[]
    const dates = mine.map((m) => m.date).sort()
    const out: Record<string, unknown> = {}

    for (const [mosId, stored] of Object.entries(spec.models) as Array<[string, Record<string, unknown>]>) {
      const hs = heightsFor(mosId)
      if (!hs) {
        // No MODELS entry claims this mos id, so the app never asks applyMOS for
        // it — `gfs_seamless` is in all three Mediterranean specs and GFS is only
        // a sounding source here, with no surface entry. Harmless, but it should
        // not read as a live correction.
        console.log(`\n  ${mosId}: no MODELS entry has this mosModel, so the app never applies it.`)
        out[mosId] = { ...stored, unused_by_app: 'no MODELS entry has this mosModel' }
        continue
      }
      let L; let S; let MAPL; let MAPS
      try {
        L = await archive30(mosId, hs, venue.lat, venue.lon, dates[0], dates[dates.length - 1], 'land')
        S = await archive30(mosId, hs, venue.lat, venue.lon, dates[0], dates[dates.length - 1], 'sea')
        MAPL = await archive30(mosId, hs, venue.lat, venue.lon, MAP_FROM, MAP_TO, 'land')
        MAPS = await archive30(mosId, hs, venue.lat, venue.lon, MAP_FROM, MAP_TO, 'sea')
      } catch (e) {
        console.log(`\n  ${mosId}: ${(e as Error).message} — spec kept unchanged.`)
        out[mosId] = stored
        continue
      }
      const same = L.cell.lat === S.cell.lat && L.cell.lon === S.cell.lon
      const type = (stored.type as string) || 'raw'
      console.log(`\n  ${mosId}  (${type}, ${hs.length} level${hs.length > 1 ? 's' : ''})`)
      console.log(`    land cell ${L.cell.lat.toFixed(4)}, ${L.cell.lon.toFixed(4)}`
        + `   sea cell ${S.cell.lat.toFixed(4)}, ${S.cell.lon.toFixed(4)}${same ? '   SAME CELL' : ''}`)
      if (same) {
        console.log('    the fix changes nothing for this model, so its coefficients still')
        console.log('    describe their own input. Kept exactly as they are.')
        out[mosId] = { ...stored, cell_selection: 'sea', cell_unchanged_by_fix: true }
        continue
      }

      const map = landFromSea(MAPL.rows, MAPS.rows)
      if (!map) {
        console.log('    not enough overlapping archive to map one cell onto the other — spec kept.')
        out[mosId] = stored
        continue
      }
      console.log(`    x_land = ${f3(map.p)}·x_sea ${map.q >= 0 ? '+' : '-'} ${f3(Math.abs(map.q))}`
        + `   R² ${f3(map.r2)}  residual sd ${f2(map.sd)} kn  (n=${map.n})`)

      const reex = reexpress(stored, map.p, map.q)
      // Four candidates on the SAME hours: what the app does today, what it
      // would do after the fix with the spec untouched, raw on the new cell,
      // and the re-expression.
      const rows: Array<{ obs: number; land: number; sea: number; twd: number | null; hour: number }> = []
      for (const [t, h] of Array.from(byT.entries())) {
        const l = L.rows.get(t); const s = S.rows.get(t)
        if (!l || !s) continue
        rows.push({ obs: h.tws, land: l.ws, sea: s.ws, twd: s.twd, hour: localHourOf(t) })
      }
      if (rows.length < 10) {
        console.log(`    the cell MOVED and there are only ${rows.length} paired logged hours here, so`)
        console.log('    nothing can be checked. Coefficients kept, and flagged as unverified')
        console.log('    against the input they are now being fed.')
        out[mosId] = {
          ...stored,
          cell_selection: 'sea',
          unverified_after_cell_fix: `fitted against the land cell ${L.cell.lat.toFixed(4)},${L.cell.lon.toFixed(4)};`
            + ` only ${rows.length} logged hours at this venue, too few to check`,
        }
        continue
      }
      const mos = (m: Record<string, unknown>, x: number, twd: number | null, hour: number) => {
        const r = applyMOS({ ...spec, models: { X: m } }, 'X', x, twd, hour)
        return r ? r.ws : x
      }
      const cand: Array<[string, number[]]> = [
        ['land raw          (the old input)', rows.map((r) => r.land)],
        ['land + stored     (today)', rows.map((r) => mos(stored, r.land, r.twd, r.hour))],
        ['sea raw           (after the fix)', rows.map((r) => r.sea)],
        ['sea + stored      (the BUG)', rows.map((r) => mos(stored, r.sea, r.twd, r.hour))],
        ['sea + re-expressed', rows.map((r) => mos(reex, r.sea, r.twd, r.hour))],
      ]
      const obs = rows.map((r) => r.obs)
      const searaw = score(rows.map((r) => r.sea), obs)
      const seareex = score(rows.map((r) => mos(reex, r.sea, r.twd, r.hour)), obs)
      console.log(`    against ${rows.length} logged hours (mean ${f2(obs.reduce((a, b) => a + b, 0) / obs.length)} kn):`)
      console.log('      candidate                             bias    rmse')
      const sc: Record<string, { bias: number; rmse: number }> = {}
      for (const [label, pred] of cand) {
        const s2 = score(pred, obs)
        sc[label.split(' ')[0] + label.split(' ')[1]] = s2
        console.log(`      ${label.padEnd(36)} ${f2(s2.bias).padStart(6)}  ${f2(s2.rmse).padStart(6)}`)
      }
      // KEEP UNLESS WORSE. The re-expression is not a new fit competing for a
      // place; it is the existing three-year fit written in terms of the new
      // input. Thirty-odd hours of 2026 cannot justify replacing that, but they
      // can show it has become actively harmful — which at Porto Cervo, where
      // the two ECMWF cells are 15 nm apart and the map's R² is 0.45, it has.
      // So the check is a veto, not a selection.
      if (type === 'raw') {
        // Nothing to re-express. The measurement is still worth printing: it
        // says what the fix alone did to a model nobody corrects.
        console.log('    stored as raw, so there are no coefficients to re-express. The rows')
        console.log('    above are what the cell fix alone is worth for this model.')
        out[mosId] = {
          ...stored,
          cell_selection: 'sea',
          cell_fix_check: { hours: rows.length, land_rmse_kn: Number(score(rows.map((r) => r.land), obs).rmse.toFixed(2)), sea_rmse_kn: Number(searaw.rmse.toFixed(2)) },
        }
        continue
      }
      const keep = seareex.rmse <= searaw.rmse
      console.log(`    VERDICT: ${keep ? 're-express' : 'drop to raw'} — the re-expression is`
        + ` ${keep ? 'not worse' : 'WORSE'} than raw on the new cell`
        + ` (${f2(seareex.rmse)} vs ${f2(searaw.rmse)} kn).`)
      out[mosId] = keep
        ? {
          ...reex,
          best: `${type} (re-expressed for the sea cell)`,
          cell_selection: 'sea',
          reexpressed_from: { a: stored.a ?? null, b: stored.b ?? null, cell_selection: 'land' },
          land_from_sea: { p: Number(map.p.toFixed(4)), q: Number(map.q.toFixed(4)), r2: Number(map.r2.toFixed(3)), residual_sd_kn: Number(map.sd.toFixed(2)) },
          checked_on: { hours: rows.length, rmse_kn: Number(seareex.rmse.toFixed(2)), bias_kn: Number(seareex.bias.toFixed(2)), raw_rmse_kn: Number(searaw.rmse.toFixed(2)) },
        }
        : {
          type: 'raw',
          best: 'raw',
          not_shipped: type,
          why: 'fitted against the land cell; the re-expression did not beat raw on the sea cell',
          cell_selection: 'sea',
          voided: { a: stored.a ?? null, b: stored.b ?? null, reduction_pct: stored.reduction_pct ?? null },
        }
    }

    specs[venue.key] = { ...spec, cell_selection: 'sea', models: out }
  }

  if (!WRITE) {
    console.log(`\n${'─'.repeat(76)}\n(dry run — add --write to rewrite the spec JSONs)`)
    return
  }
  for (const [key, s] of Object.entries(specs)) {
    const f = `src/components/weather/mos/mos_${key.replace(/-/g, '_')}.json`
    writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`)
    console.log(`Wrote ${f}`)
  }
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
