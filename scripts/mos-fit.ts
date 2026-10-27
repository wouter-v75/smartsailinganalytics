// Fit a MOS correction for a venue, to the method in
// reports/Mesoscale wind MOS post processing.md.
//
//   npx vite-node scripts/mos-fit.ts                              # Oslofjord, dry run
//   npx vite-node scripts/mos-fit.ts -- --write                   # writes the spec JSON
//   npx vite-node scripts/mos-fit.ts -- --model metno_nordic
//   npx vite-node scripts/mos-fit.ts -- --station SN29950          # fit elsewhere
//   npx vite-node scripts/mos-fit.ts -- --months 5,6,7,8            # season window
//   npx vite-node scripts/mos-fit.ts -- --no-season                 # year-round only
//
// WHAT IT DOES, AND WHY EACH CHOICE IS THE CHOICE.
//
// FITS AT 10 m, NOT 30 m. The truth is a 10 m lighthouse anemometer and the
// model has a native 10 m field, so both sides of the regression are the same
// measured quantity at the same height. Fitting in 30 m space would mean
// MANUFACTURING a 30 m observation with the very profile that is about to be
// applied to the model — and since all physical profiles err in the same
// direction in stable air, the correction would absorb a one-signed profile
// error and report a small residual. The spec carries `fit_height_m: 10` and
// correctedWind30() in mos.js applies it before the lift.
//
// NOTHING HERE VALIDATES A 30 m VALUE. The correction is verified where the
// observations are; the 10->30 m lift is a separate, unverified step with its
// own uncertainty. The report is explicit that no published work tests either
// that vertical transfer or the 3 nm horizontal one for a case like this.
//
// LEAVE-ONE-YEAR-OUT, because the hourly series is heavily autocorrelated:
// Gullholmen's lag-1 is 0.883, so 33,932 hours behave like ~2,100 independent
// samples and random k-fold would put near-duplicate hours on both sides of a
// fold. Year blocks sit far beyond any plausible residual timescale and test
// across-season and across-year transfer, which is the realistic failure mode.
//
// FOUR TO SEVEN PARAMETERS, because that effective sample size is what the
// data can support. Forms are nested (raw -> a*x+b -> + diurnal -> + sector ->
// both) and a step is kept only if it wins out of sample, chosen by the
// one-standard-error rule computed on nEff rather than n. The flat ceiling is
// a backstop; the real gate is twenty effective samples per parameter, which
// is what stops a seven-parameter form being fitted to one summer.
//
// A SEASON WINDOW IS TESTED, NOT ASSUMED. Sectorised offsets and a thermal
// harmonic are what paid off at the Mediterranean venues, and those fits were
// summer-only by accident of being fitted on regatta days. So the season is
// fitted as its own arm, held out on the same hours as the year-round arm, and
// shipped only if it wins there — see the season block below. Measured on 27
// Oct 2026 it did not win at either Oslofjord station, for a reason worth
// knowing: the thermal signal is REAL at Gullholmen (a 1.25 kn swing through
// the summer day against 0.50 the rest of the year) but it is collinear with
// DIRECTION, so the sector offsets already carry it.
//
// THE GRID CELL IS CHOSEN EXPLICITLY. Open-Meteo's default cell_selection is
// `land`; see the CELL constant. Every number this script printed before 27
// Oct 2026 was against a land cell, and for the coarse models that was a cell
// several miles inland.
//
// WHAT IT REFUSES. Lead-time stratification: the archive gives two levels and
// only from 2024, and `previous_day2` never populates at all, so this fits the
// stitched short-lead series and SAYS SO in the spec. `metno_seamless` and
// `best_match`: one is a splice whose error statistics change character at the
// seam, the other is a blend and not a fittable target. Direction bands
// narrower than 90 degrees: the model's direction field is nearest-neighbour
// from 2.5 km and piecewise-constant, so finer bands are partly spurious
// resolution.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { VENUES } from '../src/lib/venues'
import { FROST_SITES } from '../src/lib/obsSources'
import { nmBetween } from '../src/lib/obsDensity'
import {
  crossValidateForms, selectForm, fitForm, predictSpecModel, score, lag1, effectiveN,
  piRmse, skill, persistenceRmse, dieboldMariano, blockBootstrapCI, assignSector,
  gainHoldsEveryBlock, seasonComparison, inMonths,
  type Pair, type Band, type MosModelSpec, type FormResult,
} from '../src/lib/mosFit'

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

const VENUE_KEY = flag('venue', 'oslofjord')!
const STATION = flag('station', 'SN17280')!          // Gullholmen, 3.13 nm from the venue
const HOLDOUTS = (flag('holdouts', 'SN17000,SN27500')!).split(',').filter(Boolean)
// 2024-01-01, not the start of the archive, and this was MEASURED not assumed.
// metno_nordic's raw bias at Gullholmen jumped from -0.22 kn in 2023 to
// -1.51 in 2024, the step falling at the year boundary, which is the
// model-version non-stationarity the research names as the central risk for a
// km-scale archive. Fitting across the step produced a correction that was
// NEGATIVE in its earliest held-out block (-4.5 %) while gaining ~10 % in the
// three later ones; fitting from 2024 alone gains 10.8 % and holds in every
// year. The step report below prints the evidence each run, because the next
// upgrade will move it again. (Those figures are the re-measured, sea-cell
// ones; the step survived that fix and got sharper.)
const FROM = flag('from', '2024-01-01')!
const TO = flag('to', new Date().toISOString().slice(0, 10))!
const FIT_Z = 10
const TZ = flag('tz', 'Europe/Oslo')!
// Seven, because that is a four-band sector fit WITH the 24 h harmonic, and
// selectForm's real gate is effective samples per parameter rather than this
// ceiling. On 22,000 year-round hours seven parameters are comfortable; on one
// summer's worth they are not, and the nEff test is what notices.
const MAX_PARAMS = Number(flag('max-params', '7'))
const BUFFER_H = Number(flag('buffer', '48'))

// THE SEASON WINDOW, and why there is one at all.
//
// The Mediterranean specs that worked were fitted on regatta days — every one
// of them in summer — so their diurnal term is a SUMMER sea-breeze harmonic.
// Fitting the same term across twelve months of fjord data averages that
// amplitude against the months that have none: the amplitude comes out shrunk
// by roughly the fraction of the year that is not summer, and then gets
// applied in January where it is noise. So the season is fitted as its own
// arm, held out on the same hours as the year-round arm, and shipped only if
// it WINS there — a seasonal spec trades away most of its training data for
// the privilege of its own coefficients, and has to pay for that.
//
// May to August for the Oslofjord: the Norwegian season, and the months a
// thermal breeze can actually form. Change it with --months.
const MONTHS = (flag('months', '5,6,7,8')!).split(',').map(Number).filter((m) => m >= 1 && m <= 12)
const SEASON = !argv.includes('--no-season') && MONTHS.length > 0 && MONTHS.length < 12
const SEASON_MIN_ROWS = Number(flag('season-min-rows', '500'))

// THE BARS ARE ENFORCED, NOT JUST PRINTED. A form that fails one of the
// report's own tests used to be written into the spec anyway, with the failure
// noted twenty lines above it in the console — and the spec is what gets
// registered, long after the console has scrolled away. So a model whose gain
// does not hold in every held-out year, or whose gain is below MIN_PI %, is
// written as `raw` with the measurement recorded beside it. Absent beats wrong,
// the same rule the project applies to a sail's target shape.
//
// 2 % because published marine post-processing gains are 5-10 %: at one station,
// with ~900 effective samples, a claim below 2 % is not distinguishable from
// the choice of station.
const MIN_PI = Number(flag('min-pi', '2'))
// WHICH GRID CELL. Open-Meteo's default is `cell_selection=land`: it prefers a
// cell that is on land AND at a similar elevation to the requested point. For a
// lighthouse that is the wrong cell twice over. Svenner's own DEM elevation is
// 12 m, so the default sent ICON-EU 5.7 nm inland (59.0625, 10.125) and
// ECMWF 4.9 nm inland (59.00, 10.00) — and an inland cell's 10 m wind carries a
// land roughness the anemometer never sees. Measured over 1-3 June 2025 the
// same request returned 16.99 km/h on the land cell against 23.27 on the sea
// cell for ICON-EU: a 37 % difference, which is larger than any bias a MOS
// correction has ever found here. `sea` is therefore the default here, and
// metno_nordic barely notices (32.60 against 32.17) because a 1 km grid has a
// sea cell at the station anyway. The ELEVATION Open-Meteo reports back is the
// requested point's, not the cell's, so it is the OFFSET that tells you which
// cell you got.
const CELL = flag('cell-selection', 'sea')!

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SEASON_LABEL = MONTHS.length ? `${MONTH_NAMES[MONTHS[0]]}-${MONTH_NAMES[MONTHS[MONTHS.length - 1]]}` : ''

/** The models worth fitting, and the ones that must never be fitted. */
const CANDIDATES = ['metno_nordic', 'icon_eu', 'ecmwf_ifs025']
const FORBIDDEN = new Set(['metno_seamless', 'best_match', 'metno_nordic_pp'])
const MODELS = (flag('model') ? [flag('model')!] : CANDIDATES).filter((m) => {
  if (FORBIDDEN.has(m)) {
    console.error(`Refusing ${m}: a splice or a blend, not a fittable target. See the report.`)
    return false
  }
  return true
})

/**
 * Four 90-degree bands. Not narrower, on purpose: MET Nordic's direction is
 * nearest-neighbour from the 2.5 km field, so it is piecewise-constant in
 * ~2.5 km blocks and finer bands would be resolving the interpolation rather
 * than the wind. The existing Mediterranean specs also record sector agreement
 * of only 0.70-0.83, meaning the model puts the wind in the wrong band in up
 * to three cases in ten, which dilutes any sector term by about that fraction.
 */
const BANDS: Band[] = [
  ['N', 315, 45],
  ['E', 45, 135],
  ['S', 135, 225],
  ['W', 225, 315],
]

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const KMH_TO_KN = 0.539957

// ── data ───────────────────────────────────────────────────────────────────

/**
 * Venue wall-clock hour AND month from a UTC instant.
 *
 * Both are local because both are statements about the weather at the venue:
 * a sea breeze keeps venue time, and so does the boundary of a season. Taking
 * the month from UTC instead is wrong by an hour, which is wrong by a day at
 * the turn of a month — harmless for a season edge, and not worth being
 * casually wrong about when the correct value costs nothing.
 */
function localParts(ms: number, tz: string): { hour: number; month: number } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', month: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? NaN)
  const h = g('hour')
  const mi = g('minute')
  return {
    hour: Number.isFinite(h) ? (h % 24) + (Number.isFinite(mi) ? mi : 0) / 60 : NaN,
    month: g('month'),
  }
}

/** Just enough of the Supabase client to read a table — the library's own
 * generic signature does not line up with ReturnType<typeof createClient>
 * here, and a structural type says what is actually needed. */
type Db = { from: (table: string) => any }

/** Every stored observation for a station, paged past PostgREST's 1000 cap. */
async function loadObs(sb: Db, stationId: string) {
  const out = new Map<number, number>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('wind_observations')
      .select('t,tws_kn')
      .eq('station_id', `frost:${stationId}`)
      .gte('t', `${FROM}T00:00:00Z`)
      .lt('t', `${TO}T00:00:00Z`)
      .order('t', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`observations: ${error.message}`)
    if (!data?.length) break
    for (const r of data as Array<{ t: string; tws_kn: number }>) {
      const ms = Date.parse(r.t)
      // Snap to the hour so model and observation share a key. Frost's hourly
      // series is already on the hour; anything else is a resolution mismatch
      // and is dropped rather than interpolated.
      if (ms % 3600_000 === 0 && Number.isFinite(r.tws_kn)) out.set(ms, r.tws_kn)
    }
    if (data.length < PAGE) break
  }
  return out
}

/** Where the model's nearest grid cell actually is, and how high. */
interface Cell { lat: number; lon: number; elevation: number | null }

/**
 * Archived forecasts for one model at one position, a year at a time — and
 * the grid cell they came from.
 *
 * THE CELL IS NOT THE STATION, and at a coarse resolution it may not even be
 * at sea. Open-Meteo answers with the cell's own centre and elevation, which
 * is the cheapest possible test of the representativeness problem the research
 * names: a 7 km model asked for an offshore lighthouse can return a cell whose
 * surface is mainland, where the 10 m wind is slower by several knots for
 * reasons that have nothing to do with the forecast being wrong. A fit then
 * removes that as if it were bias — a real improvement at that point, but it
 * should be named for what it is.
 */
async function loadModel(model: string, lat: number, lon: number) {
  const out = new Map<number, { ws: number; twd: number | null }>()
  let cell: Cell | null = null
  const y0 = Number(FROM.slice(0, 4))
  const y1 = Number(TO.slice(0, 4))
  for (let y = y0; y <= y1; y++) {
    const start = y === y0 ? FROM : `${y}-01-01`
    const end = y === y1 ? TO : `${y}-12-31`
    if (start >= end) continue
    const url = 'https://historical-forecast-api.open-meteo.com/v1/forecast'
      + `?latitude=${lat}&longitude=${lon}`
      + `&start_date=${start}&end_date=${end}`
      + '&hourly=wind_speed_10m,wind_direction_10m'
      + `&models=${encodeURIComponent(model)}`
      + `&cell_selection=${encodeURIComponent(CELL)}`
    const r = await fetch(url, { headers: { 'User-Agent': UA } })
    const body = await r.text()
    if (!r.ok) throw new Error(`${model} ${y}: HTTP ${r.status}: ${body.slice(0, 200)}`)
    const j = JSON.parse(body)
    if (j.error) throw new Error(`${model} ${y}: ${j.reason}`)
    if (!cell && Number.isFinite(j.latitude)) {
      cell = { lat: j.latitude, lon: j.longitude, elevation: Number.isFinite(j.elevation) ? j.elevation : null }
    }
    const t: string[] = j.hourly?.time ?? []
    const sp: Array<number | null> = j.hourly?.wind_speed_10m ?? []
    const di: Array<number | null> = j.hourly?.wind_direction_10m ?? []
    for (let i = 0; i < t.length; i++) {
      const ms = Date.parse(`${t[i]}:00Z`)
      if (!Number.isFinite(ms) || sp[i] == null) continue
      out.set(ms, { ws: sp[i]! * KMH_TO_KN, twd: di[i] ?? null })
    }
  }
  return { rows: out, cell }
}

/**
 * One line on where the model actually sampled.
 *
 * The OFFSET is the diagnostic, not the elevation: Open-Meteo echoes back the
 * elevation of the point that was ASKED for, so it reads 12 m here for every
 * model including a 1 km one whose cell is at sea. A cell further away than
 * half the grid's diagonal means cell selection moved it, which at this coast
 * means it moved it ashore.
 */
function reportCell(cell: Cell | null, site: { lat: number; lon: number; name: string }) {
  if (!cell) { console.log('  grid cell  unreported'); return }
  const off = nmBetween(site.lat, site.lon, cell.lat, cell.lon)
  console.log(`  grid cell  ${cell.lat.toFixed(4)}, ${cell.lon.toFixed(4)}`
    + `  — ${off.toFixed(2)} nm from the anemometer, cell_selection=${CELL}`)
  if (off > 3) {
    console.log(`             ^ ${off.toFixed(1)} nm is a long way for a point comparison. At this coast`)
    console.log('               a cell that far off is probably ashore; check it on a chart before')
    console.log('               believing any bias the fit removes.')
  }
}

function pairUp(
  obs: Map<number, number>,
  mod: Map<number, { ws: number; twd: number | null }>,
): Pair[] {
  const rows: Pair[] = []
  for (const [ms, o] of Array.from(obs.entries())) {
    const m = mod.get(ms)
    if (!m) continue
    if (!(o >= 0) || !(m.ws >= 0)) continue
    const lp = localParts(ms, TZ)
    rows.push({ t: ms, model: m.ws, obs: o, twd: m.twd, hour: lp.hour, month: lp.month })
  }
  return rows.sort((a, b) => a.t - b.t)
}

// ── reporting ──────────────────────────────────────────────────────────────

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '   -')
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '    -')

function reportConditional(rows: readonly Pair[], m: MosModelSpec, label: string) {
  // Conditioned on the FORECAST as well as the observation: conditioning on
  // truth alone guarantees apparent under-forecasting of high winds, which is
  // a statistical artefact rather than a model fault.
  const bins: Array<[string, (r: Pair) => boolean]> = [
    ['model 0-6 kn', (r) => r.model < 6],
    ['model 6-12', (r) => r.model >= 6 && r.model < 12],
    ['model 12-20', (r) => r.model >= 12 && r.model < 20],
    ['model 20+', (r) => r.model >= 20],
    ['obs 0-6 kn', (r) => r.obs < 6],
    ['obs 6-12', (r) => r.obs >= 6 && r.obs < 12],
    ['obs 12-20', (r) => r.obs >= 12 && r.obs < 20],
    ['obs 20+', (r) => r.obs >= 20],
    ['winter (DJF)', (r) => [11, 0, 1].includes(new Date(r.t).getUTCMonth())],
    ['spring (MAM)', (r) => [2, 3, 4].includes(new Date(r.t).getUTCMonth())],
    ['summer (JJA)', (r) => [5, 6, 7].includes(new Date(r.t).getUTCMonth())],
    ['autumn (SON)', (r) => [8, 9, 10].includes(new Date(r.t).getUTCMonth())],
    ['night 22-05', (r) => r.hour >= 22 || r.hour < 5],
    ['morning 05-11', (r) => r.hour >= 5 && r.hour < 11],
    ['midday 11-17', (r) => r.hour >= 11 && r.hour < 17],
    ['evening 17-22', (r) => r.hour >= 17 && r.hour < 22],
    ...BANDS.map(([n]) => [`dir ${n}`, (r: Pair) => r.twd != null && assignSector(r.twd, BANDS) === n] as [string, (r: Pair) => boolean]),
  ]
  console.log(`\n  ${label} — conditional skill`)
  console.log('    subset              n     raw rmse   mos rmse   bias   PI%')
  for (const [name, pred] of bins) {
    const sub = rows.filter(pred)
    if (sub.length < 100) continue
    const raw = score(sub.map((r) => r.model), sub.map((r) => r.obs))
    const mos = score(
      sub.map((r) => predictSpecModel(m, r.model, r.twd, r.hour, BANDS)),
      sub.map((r) => r.obs),
    )
    console.log(`    ${name.padEnd(18)} ${String(sub.length).padStart(6)}`
      + `    ${f2(raw.rmse)}      ${f2(mos.rmse)}   ${f2(mos.bias).padStart(6)}  ${f2(piRmse(mos.rmse, raw.rmse)).padStart(6)}`)
  }
}

/** The ladder as a table — one row per candidate form. */
function printLadder(results: readonly FormResult[], indent = '    ') {
  console.log(`${indent}form            params    cv rmse   cv mae   cv bias   nEff`)
  for (const r of results) {
    if (r.refused) {
      console.log(`${indent}${r.type.padEnd(15)} ${String(r.params).padStart(6)}    REFUSED — ${r.refused}`)
      continue
    }
    console.log(`${indent}${r.type.padEnd(15)} ${String(r.params).padStart(6)}`
      + `    ${f2(r.cv.rmse)}     ${f2(r.cv.mae)}    ${f2(r.cv.bias).padStart(6)}  ${r.cv.nEff.toFixed(0).padStart(6)}`)
  }
}

/** Per held-out block, which the pooled figure hides. */
function printPerBlock(results: readonly FormResult[], indent = '      ') {
  const show = results.filter((r) => !r.refused && r.perBlock.length)
  if (!show.length) return
  console.log(`\n${indent.slice(2)}per held-out block (PI % against raw in that block):`)
  for (const r of show) {
    console.log(`${indent}${r.type.padEnd(15)} `
      + r.perBlock.map((b) => `${b.label} ${b.piRmse >= 0 ? '+' : ''}${b.piRmse.toFixed(1)}%`).join('  ')
      + (gainHoldsEveryBlock(r) ? '' : '   <- NOT every block'))
  }
}

/**
 * The raw error through the day, inside the season window and outside it.
 *
 * This is the evidence for or against a diurnal term, and it has to be read
 * SEASON BY SEASON. A thermal breeze is a swing that appears in the season row
 * and not in the other; a swing present in both is something else — a
 * stability or boundary-layer-scheme artefact that runs all year — and does
 * not justify restricting the fit to four months.
 */
function reportDiurnal(rows: readonly Pair[], months: readonly number[], label: string) {
  const want = new Set(months)
  console.log('\n  raw error (model - obs, kn) by venue-local hour:')
  console.log('    window       00-02 03-05 06-08 09-11 12-14 15-17 18-20 21-23    swing      n')
  const line = (name: string, sub: readonly Pair[]) => {
    const cells: string[] = []
    const vals: number[] = []
    for (let b = 0; b < 8; b++) {
      const g = sub.filter((r) => Math.floor(r.hour / 3) === b)
      if (g.length < 30) { cells.push('     -'); continue }
      const e = g.reduce((q, r) => q + (r.model - r.obs), 0) / g.length
      vals.push(e)
      cells.push(f2(e).padStart(6))
    }
    const swing = vals.length ? Math.max(...vals) - Math.min(...vals) : NaN
    console.log(`    ${name.padEnd(12)}${cells.join('')}   ${f2(swing).padStart(6)}  ${String(sub.length).padStart(6)}`)
  }
  line(label, rows.filter((r) => want.has(r.month ?? 0)))
  line('other months', rows.filter((r) => !want.has(r.month ?? 0)))
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const venue = VENUES.find((v) => v.key === VENUE_KEY)
  if (!venue) {
    console.error(`No venue "${VENUE_KEY}". Keys: ${VENUES.map((v) => v.key).join(', ')}`)
    process.exit(1)
  }
  const site = FROST_SITES.find((s) => s.id === STATION)
  if (!site) { console.error(`No station ${STATION} in FROST_SITES.`); process.exit(1) }

  const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
  const svc = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !svc) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local')
    process.exit(1)
  }
  const sb = createClient(url, svc, { auth: { persistSession: false } })

  const dNm = nmBetween(venue.lat, venue.lon, site.lat, site.lon)
  console.log(`\nMOS fit — ${venue.name}`)
  console.log(`  truth      ${site.id} ${site.name} at ${site.lat}, ${site.lon}`)
  console.log(`  venue      ${venue.lat}, ${venue.lon} — ${dNm.toFixed(2)} nm away`)
  console.log(`  window     ${FROM} to ${TO}`)
  console.log(`  fit height ${FIT_Z} m (applied BEFORE the lift to 30 m)`)
  console.log(`  models     ${MODELS.join(', ')}`)
  console.log(`  grid cell  cell_selection=${CELL} — 'land' is Open-Meteo's default and is wrong here`)
  console.log(`  bands      ${BANDS.map(([n, a, b]) => `${n} ${a}-${b}`).join(', ')}`)
  console.log('\n  The model is sampled AT THE STATION, so the pairing is physical. Applying')
  console.log(`  the result at the venue ${dNm.toFixed(2)} nm away is an ASSUMPTION — no published work`)
  console.log('  tests a transfer of that distance, in either direction.')

  console.log(`\nLoading observations for ${site.id}…`)
  const obs = await loadObs(sb, site.id)
  console.log(`  ${obs.size.toLocaleString('en-GB')} hourly observations`)
  if (obs.size < 2000) { console.error('  too few observations to fit anything honest.'); process.exit(1) }

  // The truth series' own autocorrelation, which sets the effective sample size.
  const obsSeries = Array.from(obs.keys()).sort((a, b) => a - b).map((k) => obs.get(k)!)
  const r1obs = lag1(obsSeries)
  console.log(`  lag-1 autocorrelation ${f3(r1obs)}, so nEff ≈ ${effectiveN(obs.size, r1obs).toFixed(0)}`
    + ` of ${obs.size.toLocaleString('en-GB')} (${(100 * effectiveN(obs.size, r1obs) / obs.size).toFixed(1)}%)`)

  const spec: Record<string, unknown> = {
    venue: venue.key,
    // Both are written: fit_height_m is what mos.js reads to choose the order,
    // target_height_m stays 30 because that is still what the app displays.
    fit_height_m: FIT_Z,
    target_height_m: 30,
    truth_station: `frost:${site.id}`,
    truth_station_name: site.name,
    truth_nm_from_venue: Number(dNm.toFixed(2)),
    fitted_from: FROM,
    fitted_to: TO,
    lead_time: 'short-lead stitched archive; NOT lead-time stratified (see report)',
    // PROVENANCE THAT MATTERS: a correction belongs to the grid cell it was
    // fitted against. Open-Meteo's default (`land`) returns a different cell —
    // several miles inland for the coarse models — and a spec fitted on one
    // applied to the other is a correction for a forecast nobody is looking at.
    // The app's own requests do NOT set this yet; see CLAUDE.md.
    cell_selection: CELL,
    bands: BANDS,
    models: {} as Record<string, unknown>,
  }
  // Filled only by models whose season-only fit BEAT the year-round one on the
  // same held-out hours. An empty object is not written at all, because
  // hasSeasonal() in mos.js would read it as a window that exists.
  const seasonalModels: Record<string, unknown> = {}

  for (const model of MODELS) {
    console.log(`\n${'─'.repeat(72)}\n${model}`)
    let mod: Map<number, { ws: number; twd: number | null }>
    try {
      const r = await loadModel(model, site.lat, site.lon)
      mod = r.rows
      reportCell(r.cell, site)
    } catch (e) {
      console.log(`  could not load: ${(e as Error).message}`)
      continue
    }
    const rows = pairUp(obs, mod)
    if (rows.length < 2000) {
      console.log(`  only ${rows.length} paired hours — refusing to fit.`)
        ; (spec.models as Record<string, unknown>)[model] = { type: 'raw', note: `only ${rows.length} paired hours` }
      continue
    }
    const first = new Date(rows[0].t).toISOString().slice(0, 10)
    const last = new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)
    console.log(`  ${rows.length.toLocaleString('en-GB')} paired hours, ${first} to ${last}`)

    const raw = score(rows.map((r) => r.model), rows.map((r) => r.obs))
    console.log(`  RAW     bias ${f2(raw.bias)}  mae ${f2(raw.mae)}  rmse ${f2(raw.rmse)}`
      + `  slope ${f3(raw.slope)}  sd-ratio ${f3(raw.varRatio)}`)

    // STEP DETECTION. A km-scale model is upgraded often and an upgrade moves
    // the bias, which breaks the stationarity a single fitted correction
    // assumes. There is no published changepoint test for this; the practical
    // one is to look at the yearly raw bias and see whether it steps.
    const years = Array.from(new Set(rows.map((r) => new Date(r.t).getUTCFullYear()))).sort()
    console.log('  raw bias by year — a STEP here means the archive is not one regime:')
    let prevBias: number | null = null
    for (const y of years) {
      const sub = rows.filter((r) => new Date(r.t).getUTCFullYear() === y)
      if (sub.length < 500) continue
      const sc = score(sub.map((r) => r.model), sub.map((r) => r.obs))
      const jump = prevBias != null && Math.abs(sc.bias - prevBias) > 0.5
      console.log(`    ${y}  n=${String(sub.length).padStart(5)}  bias ${f2(sc.bias).padStart(6)}`
        + `  rmse ${f2(sc.rmse)}  slope ${f3(sc.slope)}${jump ? '   <- STEP from the previous year' : ''}`)
      prevBias = sc.bias
    }

    const { blocks, results } = crossValidateForms(rows, BANDS, {
      bufferMs: BUFFER_H * 3600_000,
    })
    console.log(`\n  leave-one-year-out, ${blocks} blocks, ${BUFFER_H} h buffer`)
    printLadder(results)
    // Per-block, because the pooled figure hides a year where the correction
    // made things worse — and one such year means it is not stationary.
    printPerBlock(results)
    if (SEASON) reportDiurnal(rows, MONTHS, SEASON_LABEL)

    const best = selectForm(results, MAX_PARAMS)
    if (!best || best.type === 'raw') {
      console.log('\n  SELECTED: raw — no form beat the uncorrected model out of sample.')
        ; (spec.models as Record<string, unknown>)[model] = {
          type: 'raw', best: 'raw', raw_rmse: Number(raw.rmse.toFixed(3)),
          n: rows.length, n_eff: Math.round(raw.nEff), blocks,
        }
      continue
    }
    console.log(`\n  SELECTED: ${best.type} (${best.params} params) by the one-standard-error rule on nEff`)
    const holds = gainHoldsEveryBlock(best)
    console.log(`  gain holds in EVERY held-out block: ${holds ? 'yes' : 'NO — the correction is not stationary'}`)
    const cvPi = piRmse(best.cv.rmse, raw.rmse)
    const ship = holds && cvPi >= MIN_PI
    if (!ship) {
      console.log(`  NOT SHIPPED: written as raw. ${holds ? `${f2(cvPi)} % is below the ${MIN_PI} % bar`
        : 'the gain does not hold in every held-out year'}, so the`)
      console.log('               coefficients below are reported and not stored.')
    }

    // In-sample scores of the shipped coefficients, and the significance of
    // the improvement — on the PAIRED loss differential, HAC-corrected.
    const pred = rows.map((r) => predictSpecModel(best.spec, r.model, r.twd, r.hour, BANDS))
    const mos = score(pred, rows.map((r) => r.obs))
    const lossRaw = rows.map((r) => (r.model - r.obs) ** 2)
    const lossMos = rows.map((r, i) => (pred[i] - r.obs) ** 2)
    const d = lossRaw.map((x, i) => x - lossMos[i])
    const resid = rows.map((r, i) => pred[i] - r.obs)
    const r1res = lag1(resid)
    const bw = Math.max(6, Math.round(2 * (1 + r1res) / Math.max(1e-6, 1 - r1res)))
    const dm = dieboldMariano(d, bw)
    const ci = blockBootstrapCI(d, 24, 2000)
    const persist = persistenceRmse(rows)
    // Climatology as the reference: the long-run mean. Computed once, not
    // once per row — the first version nested the mean inside the reduce,
    // which is O(n^2) and would have crawled on 30,000 hours.
    const obsMean = rows.reduce((q, z) => q + z.obs, 0) / rows.length
    const climo = Math.sqrt(rows.reduce((q, r) => q + (r.obs - obsMean) ** 2, 0) / rows.length)

    console.log(`  MOS     bias ${f2(mos.bias)}  mae ${f2(mos.mae)}  rmse ${f2(mos.rmse)}`
      + `  slope ${f3(mos.slope)}  sd-ratio ${f3(mos.varRatio)}`)
    console.log(`  PI_RMSE vs raw            ${f2(piRmse(best.cv.rmse, raw.rmse))} %   (cross-validated)`)
    console.log(`  skill vs climatology      ${f3(skill(best.cv.rmse, climo))}`)
    console.log(`  skill vs persistence(1h)  ${f3(skill(best.cv.rmse, persist))}`)
    console.log(`  residual lag-1 ${f3(r1res)} -> HAC bandwidth ${bw} h`)
    console.log(`  Diebold-Mariano on squared-error differential: stat ${f2(dm.stat)}`
      + `  (|stat| > 2 is the usual bar)`)
    console.log(`  block bootstrap 95% CI on the mean gain: ${f3(ci.lo)} to ${f3(ci.hi)}`
      + `  ${ci.lo > 0 ? '(excludes zero)' : '(INCLUDES ZERO — not demonstrated)'}`)
    if (mos.varRatio < 0.95) {
      console.log(`  NOTE: sd-ratio ${f3(mos.varRatio)} — the fit has flattened the forecast's variance,`)
      console.log('        which is the OLS double-penalty mechanism. Expected, but worth seeing.')
    }

    reportConditional(rows, best.spec, model)

    // ── THE SEASON ARM ───────────────────────────────────────────────────
    // Sectorised offsets and a thermal-breeze harmonic are what paid off at
    // the Mediterranean venues, and those fits were summer-only by accident
    // of being fitted on regatta days. This asks the question properly: fit
    // the season on its own, hold out the same hours as the year-round arm,
    // and ship the seasonal coefficients only if they win there.
    if (SEASON) {
      const cmp = seasonComparison(rows, BANDS, MONTHS, {
        bufferMs: BUFFER_H * 3600_000, minRowsPerBlock: SEASON_MIN_ROWS,
      })
      const seasonRows = inMonths(rows, MONTHS)
      const seasonRaw = score(seasonRows.map((r) => r.model), seasonRows.map((r) => r.obs))
      console.log(`\n  ${model} — season window ${SEASON_LABEL} (months ${MONTHS.join(',')})`)
      console.log(`    ${cmp.nSeason.toLocaleString('en-GB')} of ${rows.length.toLocaleString('en-GB')} hours`
        + `  (${(100 * cmp.nSeason / rows.length).toFixed(0)}%), ${cmp.blocks} blocks`)
      console.log(`    raw on those hours: bias ${f2(seasonRaw.bias)}  rmse ${f2(seasonRaw.rmse)}`)
      if (cmp.blocks < 2) {
        console.log(`    only ${cmp.blocks} block — not enough season to cross-validate. Skipped.`)
      } else {
        console.log('\n    trained on WHOLE YEARS, scored on the season:')
        printLadder(cmp.yearRound, '      ')
        console.log('\n    trained on the SEASON ONLY, scored on the same hours:')
        printLadder(cmp.seasonal, '      ')
        printPerBlock(cmp.seasonal, '        ')
        const bYr = selectForm(cmp.yearRound, MAX_PARAMS)
        const bSe = selectForm(cmp.seasonal, MAX_PARAMS)
        if (!bYr || !bSe) {
          console.log('\n    one arm produced nothing selectable — no seasonal spec.')
        } else {
          // One standard error, the same rule used to choose a form: a
          // seasonal set costs most of the training data, so it has to beat
          // the year-round set by more than the noise, not merely tie with it.
          const se = bYr.cv.rmse / Math.sqrt(2 * Math.max(2, bYr.cv.nEff))
          const seasonPi = piRmse(bSe.cv.rmse, seasonRaw.rmse)
          // The same two bars as the year-round arm, plus beating it.
          const wins = bSe.cv.rmse < bYr.cv.rmse - se && seasonPi >= MIN_PI
          const holds = gainHoldsEveryBlock(bSe)
          console.log(`\n    year-round best   ${bYr.type.padEnd(15)} cv rmse ${f2(bYr.cv.rmse)}`
            + `   PI ${f2(piRmse(bYr.cv.rmse, seasonRaw.rmse))} % vs raw`)
          console.log(`    season-only best  ${bSe.type.padEnd(15)} cv rmse ${f2(bSe.cv.rmse)}`
            + `   PI ${f2(piRmse(bSe.cv.rmse, seasonRaw.rmse))} % vs raw`)
          console.log(`    one standard error on the year-round figure: ${f3(se)}`)
          console.log(`    gain holds in every season block: ${holds ? 'yes' : 'NO'}`)
          if (wins && holds) {
            console.log(`    VERDICT: ship the seasonal set for ${SEASON_LABEL} — it beats the`)
            console.log('             year-round coefficients on the same held-out hours by more')
            console.log('             than one standard error, and holds in every block.')
            seasonalModels[model] = {
              ...bSe.spec,
              best: bSe.type,
              cv_rmse: Number(bSe.cv.rmse.toFixed(3)),
              yearround_cv_rmse_on_season: Number(bYr.cv.rmse.toFixed(3)),
              raw_rmse_on_season: Number(seasonRaw.rmse.toFixed(3)),
              reduction_pct: Number(seasonPi.toFixed(1)),
              n: cmp.nSeason,
              n_eff: Math.round(bSe.cv.nEff),
              blocks: cmp.blocks,
              params: bSe.params,
            }
          } else if (seasonPi < MIN_PI) {
            console.log(`    VERDICT: no seasonal set — ${f2(seasonPi)} % is below the ${MIN_PI} % bar, so`)
            console.log('             there is nothing here worth having its own coefficients.')
          } else if (!wins) {
            console.log('    VERDICT: no seasonal set. The year-round coefficients are as good on')
            console.log('             the season as coefficients fitted only on it, so the extra')
            console.log('             training data is worth more than the extra specificity.')
          } else {
            console.log('    VERDICT: no seasonal set — the gain does not hold in every block.')
          }
        }
      }
    }

    // Does the correction transfer? The only available test.
    console.log(`\n  ${model} — spatial hold-out (fit at ${site.id}, applied elsewhere)`)
    for (const hid of HOLDOUTS) {
      const hs = FROST_SITES.find((s) => s.id === hid)
      if (!hs) { console.log(`    ${hid}: not in FROST_SITES`); continue }
      try {
        const hobs = await loadObs(sb, hid)
        const hmod = (await loadModel(model, hs.lat, hs.lon)).rows
        const hrows = pairUp(hobs, hmod)
        if (hrows.length < 1000) { console.log(`    ${hid}: only ${hrows.length} paired hours`); continue }
        const hraw = score(hrows.map((r) => r.model), hrows.map((r) => r.obs))
        const hp = hrows.map((r) => predictSpecModel(best.spec, r.model, r.twd, r.hour, BANDS))
        const hmos = score(hp, hrows.map((r) => r.obs))
        const km = nmBetween(site.lat, site.lon, hs.lat, hs.lon)
        console.log(`    ${hid} ${hs.name.padEnd(18)} ${km.toFixed(1).padStart(5)} nm  `
          + `raw ${f2(hraw.rmse)} -> mos ${f2(hmos.rmse)}  PI ${f2(piRmse(hmos.rmse, hraw.rmse))} %`
          + `${piRmse(hmos.rmse, hraw.rmse) > 0 ? '' : '   ← correction does NOT transfer'}`)
      } catch (e) {
        console.log(`    ${hid}: ${(e as Error).message}`)
      }
    }

    ;(spec.models as Record<string, unknown>)[model] = {
      ...(ship ? best.spec : { type: 'raw' }),
      best: ship ? best.type : 'raw',
      ...(ship ? {} : {
        not_shipped: best.type,
        why: holds ? `cross-validated gain ${cvPi.toFixed(1)} % is below the ${MIN_PI} % bar`
          : 'the gain did not hold in every held-out year',
      }),
      cv_rmse: Number(best.cv.rmse.toFixed(3)),
      cv_mae: Number(best.cv.mae.toFixed(3)),
      raw_rmse: Number(raw.rmse.toFixed(3)),
      reduction_pct: Number(piRmse(best.cv.rmse, raw.rmse).toFixed(1)),
      skill_vs_climatology: Number(skill(best.cv.rmse, climo).toFixed(3)),
      skill_vs_persistence: Number(skill(best.cv.rmse, persist).toFixed(3)),
      sd_ratio: Number(mos.varRatio.toFixed(3)),
      dm_stat: Number(dm.stat.toFixed(2)),
      boot_ci: [Number(ci.lo.toFixed(3)), Number(ci.hi.toFixed(3))],
      residual_lag1: Number(r1res.toFixed(3)),
      n: rows.length,
      n_eff: Math.round(best.cv.nEff),
      blocks,
      params: best.params,
    }
  }

  if (Object.keys(seasonalModels).length) {
    spec.seasonal = { months: MONTHS, label: SEASON_LABEL, models: seasonalModels }
  }

  const out = `src/components/weather/mos/mos_${venue.key.replace(/-/g, '_')}.json`
  if (!WRITE) {
    console.log(`\n${'─'.repeat(72)}`)
    console.log(`(dry run — add --write to save ${out})`)
    console.log('\nBefore shipping, read the numbers above against these bars, from the report:')
    console.log('  · the gain must hold in SIGN in every held-out year, not just on average')
    console.log('  · the bootstrap CI must exclude zero')
    console.log('  · published marine post-processing gains are 5-10 %, so a sub-2 % claim at')
    console.log('    one station should be treated as unproven')
    console.log('  · a correction that does not transfer to the hold-out lighthouses is a')
    console.log('    property of the rock it was fitted on, not of the model')
    console.log('\nMeasured on 27 Oct 2026, against SEA cells (see the CELL constant — the')
    console.log('land-cell default had been inflating all of this):')
    console.log('  · Gullholmen, metno_nordic: raw bias -1.36 kn, +10.8 %, holds in every year,')
    console.log('    DM 21, CI excludes zero. Transfers at -1.9 % to Stromtangen and -1.1 % to')
    console.log('    Faerder: near-neutral rather than harmful, but still not a gain elsewhere.')
    console.log('  · Svenner fyr, metno_nordic: raw bias +0.19 kn and +1.5 %, which does NOT')
    console.log('    hold in every year. The model is already unbiased at an exposed Skagerrak')
    console.log('    lighthouse, so there is nothing for a correction to remove. Ship raw.')
    console.log('  · The coarse models are a different story: icon_eu +25 % at Gullholmen and')
    console.log('    +34 % at Svenner, and icon_eu\'s correction TRANSFERS (+24 %, +8 %) because')
    console.log('    its bias is a property of the RESOLUTION, not of the rock. ecmwf_ifs025')
    console.log('    gains 39 % at Gullholmen and transfers at -158 %, which is the opposite.')
    console.log('  · No season window earned its place at either station.')
    return
  }
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`\nWrote ${out}`)
  console.log(`Register it in SPECS in src/components/weather/mos.js as '${venue.key}'.`)
  console.log(`fit_height_m is ${FIT_Z}, so correctedWind30() will correct BEFORE lifting to 30 m.`)
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
