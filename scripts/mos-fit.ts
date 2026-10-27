// Fit a MOS correction for a venue, to the method in
// reports/Mesoscale wind MOS post processing.md.
//
//   npx vite-node scripts/mos-fit.ts                              # Oslofjord, dry run
//   npx vite-node scripts/mos-fit.ts -- --write                   # writes the spec JSON
//   npx vite-node scripts/mos-fit.ts -- --model metno_nordic
//   npx vite-node scripts/mos-fit.ts -- --station SN29950          # fit elsewhere
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
// FOUR TO SIX PARAMETERS, hard ceiling, because that effective sample size is
// what the data can support. Forms are nested (raw -> a*x+b -> + diurnal ->
// + sector) and a step is kept only if it wins out of sample, chosen by the
// one-standard-error rule computed on nEff rather than n.
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
  gainHoldsEveryBlock,
  type Pair, type Band, type MosModelSpec,
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
// metno_nordic's raw bias at Gullholmen roughly TRIPLED between 2023 and 2024
// (-0.73 kn in 2023 against -1.94 in 2024, the step falling at the year
// boundary), which is the model-version non-stationarity the research names as
// the central risk for a km-scale archive. Fitting across the step produced a
// correction that was NEGATIVE in its earliest held-out block (-0.8 %) while
// gaining ~16 % in the three later ones; fitting from 2024 alone gains 16.2 %
// and holds in every year. The step report below prints the evidence each run,
// because the next upgrade will move it again.
const FROM = flag('from', '2024-01-01')!
const TO = flag('to', new Date().toISOString().slice(0, 10))!
const FIT_Z = 10
const TZ = flag('tz', 'Europe/Oslo')!
const MAX_PARAMS = Number(flag('max-params', '6'))
const BUFFER_H = Number(flag('buffer', '48'))

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

/** Local wall-clock hour at the venue, from a UTC instant. */
function localHour(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? NaN)
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0)
  return Number.isFinite(h) ? (h % 24) + m / 60 : NaN
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

/** Archived forecasts for one model at one position, a year at a time. */
async function loadModel(model: string, lat: number, lon: number) {
  const out = new Map<number, { ws: number; twd: number | null }>()
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
    const r = await fetch(url, { headers: { 'User-Agent': UA } })
    const body = await r.text()
    if (!r.ok) throw new Error(`${model} ${y}: HTTP ${r.status}: ${body.slice(0, 200)}`)
    const j = JSON.parse(body)
    if (j.error) throw new Error(`${model} ${y}: ${j.reason}`)
    const t: string[] = j.hourly?.time ?? []
    const sp: Array<number | null> = j.hourly?.wind_speed_10m ?? []
    const di: Array<number | null> = j.hourly?.wind_direction_10m ?? []
    for (let i = 0; i < t.length; i++) {
      const ms = Date.parse(`${t[i]}:00Z`)
      if (!Number.isFinite(ms) || sp[i] == null) continue
      out.set(ms, { ws: sp[i]! * KMH_TO_KN, twd: di[i] ?? null })
    }
  }
  return out
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
    rows.push({ t: ms, model: m.ws, obs: o, twd: m.twd, hour: localHour(ms, TZ) })
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
    bands: BANDS,
    models: {} as Record<string, unknown>,
  }

  for (const model of MODELS) {
    console.log(`\n${'─'.repeat(72)}\n${model}`)
    let mod: Map<number, { ws: number; twd: number | null }>
    try {
      mod = await loadModel(model, site.lat, site.lon)
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
    console.log('    form         params    cv rmse   cv mae   cv bias   nEff')
    for (const r of results) {
      if (r.refused) { console.log(`    ${r.type.padEnd(12)} ${String(r.params).padStart(6)}    REFUSED — ${r.refused}`); continue }
      console.log(`    ${r.type.padEnd(12)} ${String(r.params).padStart(6)}`
        + `    ${f2(r.cv.rmse)}     ${f2(r.cv.mae)}    ${f2(r.cv.bias).padStart(6)}  ${r.cv.nEff.toFixed(0).padStart(6)}`)
    }

    // Per-block, because the pooled figure hides a year where the correction
    // made things worse — and one such year means it is not stationary.
    const show = results.filter((r) => !r.refused && r.perBlock.length)
    if (show.length) {
      console.log('\n    per held-out block (PI % against raw in that block):')
      for (const r of show) {
        console.log(`      ${r.type.padEnd(12)} `
          + r.perBlock.map((b) => `${b.label} ${b.piRmse >= 0 ? '+' : ''}${b.piRmse.toFixed(1)}%`).join('  ')
          + (gainHoldsEveryBlock(r) ? '' : '   <- NOT every block'))
      }
    }

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

    // Does the correction transfer? The only available test.
    console.log(`\n  ${model} — spatial hold-out (fit at ${site.id}, applied elsewhere)`)
    for (const hid of HOLDOUTS) {
      const hs = FROST_SITES.find((s) => s.id === hid)
      if (!hs) { console.log(`    ${hid}: not in FROST_SITES`); continue }
      try {
        const hobs = await loadObs(sb, hid)
        const hmod = await loadModel(model, hs.lat, hs.lon)
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
      ...best.spec,
      best: best.type,
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
    console.log('\nMeasured on 27 Oct 2026, metno_nordic at Gullholmen passed the first three')
    console.log('and FAILED the fourth: +16.2 % at Gullholmen, -0.0 % at Stromtangen 16 nm away')
    console.log('and -9.2 % at Faerder at 24.6 nm, with the bias sign flipping at both. So the')
    console.log('correction is a property of Gullholmen. Whether it holds at the venue 3.13 nm')
    console.log('away is UNTESTED — there is no station there — and the 16 nm failure is reason')
    console.log('to doubt it rather than reason to assume it.')
    return
  }
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`\nWrote ${out}`)
  console.log(`Register it in SPECS in src/components/weather/mos.js as '${venue.key}'.`)
  console.log(`fit_height_m is ${FIT_Z}, so correctedWind30() will correct BEFORE lifting to 30 m.`)
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
