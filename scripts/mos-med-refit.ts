// Refit the Mediterranean MOS specs, against the grid cell the app now asks for.
//
//   npx vite-node scripts/mos-med-refit.ts                          # all three, dry run
//   npx vite-node scripts/mos-med-refit.ts -- --venue porto_cervo
//   npx vite-node scripts/mos-med-refit.ts -- --cell nearest        # the old input
//   npx vite-node scripts/mos-med-refit.ts -- --write
//
// WHY. The three shipped specs were fitted in a separate project —
// ~/Documents/Claude/Projects/Smart Sailing Analytics/wind-verification — whose
// fetch asked Open-Meteo for `cell_selection=nearest`, while the app asked for
// nothing and therefore got the default, `land`. So the coefficients never
// described the forecast the app was feeding them, and the cell_selection=sea
// fix in openMeteo.js changes that input again. A spec belongs to the cell it
// was fitted against; this refits them against `sea`.
//
// THE TRUTH IS THAT PROJECT'S OWN obs_<venue>.csv — 261, 445 and 417
// ten-minute vector-averaged bins of calibrated 30 m logfile wind, over two to
// three regattas per venue, 2023 to 2026. That extraction is the expensive part
// and it is reused verbatim, read-only. Nothing here writes to that directory.
//
// WHAT IS REPRODUCED EXACTLY, because this is a refit and not a redesign:
// the 3x3 forecast lattice over each venue's bbox, bilinear interpolation in
// u/v to the boat's own position, the heel-reduced evaluation height
// (30 m * cos(heel)), the four forms, leave-one-REGATTA-out CV, the sector
// shrinkage toward the global residual (k = 8) and the 70 % sector-agreement
// guard. mos.py is the reference; the numbers below are comparable with the
// ones in the JSONs it wrote.
//
// WHAT IS DELIBERATELY NOT REPRODUCED, and this is the subtle half:
//
// 1. THE LEVEL LADDER IS THE APP'S, per model, not every level Open-Meteo
//    returns. The vertical step fits a power law to whatever levels it is
//    given, so a fit over 10/20/50/80/100 and an application over 10/80/120/180
//    are different functions of the same forecast.
//
// 2. A SINGLE-LEVEL MODEL IS LIFTED AS THE APP LIFTS IT — the self-consistent
//    neutral marine log law, not a 0.11 power law. On ICON-2I at 9 kn that is
//    1.088 against 1.128, so the old fit was handed 3.6 % more wind than the
//    app ever shows it.
//
// Both are the same mistake as the cell: fit what will be applied. See
// src/lib/mastWind.ts, which holds the interpolation and is tested against the
// app's own wind30().
//
// `gfs_seamless` is skipped: no MODELS entry claims it, so the app never asks
// applyMOS for it, and its coefficients in the old specs are dead weight.

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODELS } from '../src/components/weather/openMeteo'
import { interpToMast, bilinearUV, fromUV, type GridPoint } from '../src/lib/mastWind'
import {
  solveOls, score, tailStats, tailVerdict, tailPasses, pickTailBars,
  shrinkageFixedPoint, shrinkageAt, TAIL_WARN_KEEP, TAIL_TOP_SLACK,
  type Band, type TailBars, type TailStat, type MosModelSpec,
} from '../src/lib/mosFit'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const OBS_DIR = flag('obs-dir',
  '/Users/wouterverbraak/Documents/Claude/Projects/Smart Sailing Analytics/wind-verification')!
/**
 * THIS SEASON'S BINS, built by scripts/med-obs-phases.ts from Northstar 76's
 * own logfiles and her event files' SELECTED PHASES.
 *
 * Why they are a separate directory rather than appended to the files above:
 * that extraction belongs to another project and is reused read-only. And why
 * they matter — Porto Cervo cross-validated on TWO regattas, so "the gain
 * holds in every held-out regatta" rested on a single held-out block, and
 * 2026 is the breeziest of the three (14 of 76 bins over 20 kn, up to 26.3).
 * Missing means missing: without the directory the refit runs on 2024-2025 as
 * before and says so.
 */
const OBS_2026_DIR = flag('obs-2026-dir',
  '/Users/wouterverbraak/Documents/Claude/Projects/Smart Sailing Analytics/wind-verification-2026')!
const SKIP_2026 = argv.includes('--no-2026')
const CELL = flag('cell', 'sea')!
const ONLY = flag('venue')
const TARGET_Z = 30
/**
 * WHERE THE MODEL IS EVALUATED, and it is a real choice.
 *
 * `instrument` is the original pipeline's: the model is interpolated to the
 * masthead's own heel-reduced height, `mast * cos(heel)`, on the view that the
 * MOS is then a pure bias correction between two values of the same quantity
 * at the same height.
 *
 * `target` is the APP's: `correctedWind30()` hands the spec its 30 m value and
 * nothing else, so that is the input the coefficients will actually meet. The
 * predicted quantity is then the masthead wind, whatever height the masthead
 * is at — which is what a sailor wants anyway.
 *
 * The two coincided while every bin claimed a 30 m masthead. They stop
 * coinciding once the heights are the real 32 m and 35 m, so it was measured:
 * run with each and compare. See `--eval-at`.
 */
const EVAL_AT = flag('eval-at', 'instrument')!
if (!['instrument', 'target'].includes(EVAL_AT)) { console.error("--eval-at must be instrument|target"); process.exit(1) }
const SHRINK_K = 8          // mos.py's sector shrinkage toward the global bias
const AGREE_MIN = 0.70      // below this a sector correction is not trusted
// THE SAME TWO BARS mos-fit.ts enforces for the Oslofjord, because it would be
// incoherent to refuse a 1.5 % non-stationary gain at Svenner fyr and ship one
// here. The original method chose on POOLED leave-one-regatta-out RMSE alone,
// which lets a form that helps in one regatta and hurts in the other through:
// AROME at Porto Cervo gains 1.1 % pooled and is WORSE in 2024 (4.44 -> 4.45).
// A model that fails a bar is written as `raw` with the measurement beside it.
const MIN_PI = Number(flag('min-pi', '2'))
const LOCAL_OFFSET_H = 2    // CEST, as the original pipeline assumed
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

/** config.py's venue boxes and bands, transcribed. */
/**
 * A REGIME SPLIT, where a venue has one.
 *
 * config.py's regime_for() labels St Tropez's May-July regattas `seabreeze_jun`
 * and everything else `gradient_oct`, and never conditioned on the label —
 * mos.py fitted all three regattas together. The refit showed what that costs:
 * every model's raw rmse there is 3.0-3.6 kn in the June sea-breeze regatta
 * against 1.9-2.9 in the two October gradient ones, and one correction across
 * both helps one and hurts the other, which is why three of four models failed
 * the held-out-regatta bar.
 *
 * `months` are the in-season ones. They become the spec's `seasonal` block,
 * which applyMOS already honours; everything outside them stays in `models`,
 * so the nine months that include both October regattas are the default and
 * the sea-breeze weeks are the override.
 */
const VENUES: Record<string, {
  bbox: [number, number, number, number]
  models: string[]
  bands: Band[]
  regime?: { label: string; otherLabel: string; months: number[] }
}> = {
  sorrento: {
    bbox: [40.50, 40.72, 14.28, 14.55],
    models: ['italia_meteo_arpae_icon_2i', 'meteofrance_arpege_europe', 'icon_eu', 'ecmwf_ifs025'],
    bands: [['SW-W', 200, 270], ['N-NE', 0, 70], ['E-S', 80, 200]],
  },
  porto_cervo: {
    bbox: [41.02, 41.24, 9.40, 9.68],
    models: ['italia_meteo_arpae_icon_2i', 'meteofrance_arome_france_hd',
      'meteofrance_arpege_europe', 'icon_eu', 'ecmwf_ifs025'],
    bands: [['NW', 270, 340], ['SW-S', 180, 270], ['SE-E', 40, 180]],
  },
  st_tropez: {
    bbox: [43.16, 43.36, 6.50, 6.78],
    models: ['meteofrance_arome_france_hd', 'meteofrance_arpege_europe', 'icon_eu', 'ecmwf_ifs025'],
    bands: [['NW', 270, 330], ['S-W', 160, 260], ['E-SE', 30, 150]],
    regime: { label: 'seabreeze', otherLabel: 'gradient', months: [5, 6, 7] },
  },
}
const GRID_N = 3

function forecastPoints(bbox: [number, number, number, number]) {
  const [laMin, laMax, loMin, loMax] = bbox
  const lats = Array.from({ length: GRID_N }, (_, i) => Number((laMin + (laMax - laMin) * i / (GRID_N - 1)).toFixed(4)))
  const lons = Array.from({ length: GRID_N }, (_, j) => Number((loMin + (loMax - loMin) * j / (GRID_N - 1)).toFixed(4)))
  return lats.flatMap((la) => lons.map((lo) => [la, lo] as [number, number]))
}

function heightsFor(mosModel: string): number[] | null {
  for (const m of Object.values(MODELS) as Array<Record<string, unknown>>) {
    if (m.mosModel === mosModel) return (m.heights as number[]) ?? null
  }
  return null
}

// ── the obs contract ───────────────────────────────────────────────────────

interface Obs {
  regatta: string
  tMid: number
  lat: number
  lon: number
  tws: number
  twd: number
  zEff: number
  /** The masthead height itself, before the heel reduction. */
  mast: number
  localHour: number
  /** Venue-local, because a regime window is a statement about the weather. */
  localMonth: number
  localDay: string
}

/**
 * THE MASTHEAD HEIGHT THE OLD BINS CLAIM IS NOT A MEASUREMENT. Every row of
 * obs_<venue>.csv says `mast_height_m: 30.0`, which is extract_obs.py's
 * `--mast-height` DEFAULT, left in place for every regatta. Those regattas
 * were all sailed by Northstar 72, whose masthead is 32 m (Wouter, 28 Oct
 * 2026); Northstar 76's, which this season's bins carry themselves, is 35 m.
 *
 * It is the height the forecast is interpolated TO — `zEff = mast * cos(heel)`
 * — so a 30 m label on a 32 m instrument asks the model for less wind than the
 * instrument saw and books the difference as a model deficit. Over water that
 * is 0.55 % of wind, about 0.07 kn at 12 kn: small, and free to get right.
 * Narrow on purpose — ONLY the known default is replaced, and any other value
 * in a file is taken as given, so this cannot quietly override a real figure.
 */
const DEFAULT_MAST_M = 30.0
const N72_MAST_M = 32.0

function readObsFile(f: string): Obs[] {
  const lines = readFileSync(f, 'utf8').trim().split('\n')
  const head = lines[0].split(',')
  const col = (n: string) => head.indexOf(n)
  const out: Obs[] = []
  for (const line of lines.slice(1)) {
    const c = line.split(',')
    const t0 = Date.parse(c[col('t_start_utc')])
    const t1 = Date.parse(c[col('t_end_utc')])
    const tws = Number(c[col('tws_kn')])
    const twd = Number(c[col('twd_deg')])
    const declared = Number(c[col('mast_height_m')]) || TARGET_Z
    const mast = declared === DEFAULT_MAST_M ? N72_MAST_M : declared
    const heel = Number(c[col('mean_heel_deg')]) || 0
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(tws > 0) || !Number.isFinite(twd)) continue
    const tMid = t0 + (t1 - t0) / 2
    // The masthead is LOWER when the boat is heeled, and the model is asked
    // for the height the instrument is actually at. 26 degrees takes a 30 m
    // mast to 27 m, which is ~1.3 % of wind at a fitted alpha of 0.14.
    const zEff = mast * Math.cos((heel * Math.PI) / 180) || TARGET_Z
    out.push({
      regatta: c[col('regatta_id')],
      tMid,
      lat: Number(c[col('lat')]),
      lon: Number(c[col('lon')]),
      tws,
      twd,
      zEff,
      mast,
      localHour: new Date(tMid + LOCAL_OFFSET_H * 3600_000).getUTCHours(),
      localMonth: new Date(tMid + LOCAL_OFFSET_H * 3600_000).getUTCMonth() + 1,
      localDay: new Date(tMid + LOCAL_OFFSET_H * 3600_000).toISOString().slice(0, 10),
    })
  }
  return out
}

function readObs(venue: string): Obs[] {
  const f = join(OBS_DIR, `obs_${venue}.csv`)
  if (!existsSync(f)) throw new Error(`no obs file at ${f}`)
  const out = readObsFile(f)
  const extra = join(OBS_2026_DIR, `obs_${venue}_2026.csv`)
  if (!SKIP_2026 && existsSync(extra)) out.push(...readObsFile(extra))
  return out.sort((a, b) => a.tMid - b.tMid)
}

/** Near-consecutive days merged into regatta ranges, as fetch_forecast does. */
function coalesceDays(days: string[], gapDays = 4): Array<[string, string]> {
  const sorted = Array.from(new Set(days)).sort()
  if (!sorted.length) return []
  const d = (s: string) => Date.parse(`${s}T00:00:00Z`)
  const out: Array<[string, string]> = []
  let start = sorted[0]; let prev = sorted[0]
  for (const s of sorted.slice(1)) {
    if ((d(s) - d(prev)) / 86400_000 <= gapDays) prev = s
    else { out.push([start, prev]); start = s; prev = s }
  }
  out.push([start, prev])
  return out
}

// ── the forecast ───────────────────────────────────────────────────────────

const CACHE_DIR = join(tmpdir(), 'ssa-mos-med-cache')
const CACHE = !argv.includes('--no-cache')
function cacheGet(url: string) {
  if (!CACHE) return null
  const f = join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex')}.json`)
  if (!existsSync(f)) return null
  const body = readFileSync(f, 'utf8')
  // A TRUNCATED CACHE ENTRY IS WORSE THAN A MISS. One of these cost AROME at
  // Porto Cervo: the entry stopped mid-array, JSON.parse threw, and the only
  // symptom was `could not load` on one line of a 230-line report — a model
  // silently absent from the refit, with its old coefficients left standing.
  // So the entry is parsed here and a bad one is dropped and re-fetched.
  try { JSON.parse(body); return body } catch {
    console.log(`      (cached response was truncated — re-fetching)`)
    rmSync(f, { force: true })
    return null
  }
}
function cachePut(url: string, body: string) {
  if (!CACHE) return
  try { JSON.parse(body) } catch { return }   // never cache what will not parse
  mkdirSync(CACHE_DIR, { recursive: true })
  const f = join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex')}.json`)
  // Written beside and renamed, so an interrupted write cannot leave half a
  // response behind under the real name.
  const tmp = `${f}.${process.pid}.part`
  writeFileSync(tmp, body)
  renameSync(tmp, f)
}

/** hour (epoch ms) -> the nine points' wind at each requested level. */
type Field = Map<number, Map<number, GridPoint[]>>

async function fetchField(
  model: string, heights: number[], points: Array<[number, number]>,
  ranges: Array<[string, string]>,
): Promise<Field> {
  const field: Field = new Map()
  const vars = heights.flatMap((h) => [`wind_speed_${h}m`, `wind_direction_${h}m`])
  for (const [from, to] of ranges) {
    const url = 'https://historical-forecast-api.open-meteo.com/v1/forecast'
      + `?latitude=${points.map((p) => p[0]).join(',')}`
      + `&longitude=${points.map((p) => p[1]).join(',')}`
      + `&start_date=${from}&end_date=${to}`
      + `&hourly=${vars.join(',')}&models=${encodeURIComponent(model)}`
      + `&wind_speed_unit=kn&timezone=UTC&cell_selection=${CELL}`
    let body = cacheGet(url)
    if (body == null) {
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) })
        body = await r.text()
        if (!r.ok) throw new Error(`${model} ${from}: HTTP ${r.status}: ${body.slice(0, 160)}`)
        try { JSON.parse(body); break } catch (e) {
          if (attempt >= 3) throw new Error(`${model} ${from}: unparseable after ${attempt} tries: ${(e as Error).message}`)
        }
      }
      cachePut(url, body)
    }
    const parsed = JSON.parse(body)
    // A multi-location request answers with an ARRAY, one entry per point, in
    // the order asked. A single location answers with an object, so a venue
    // reduced to one point would silently pair every bin against nothing.
    const list: Array<Record<string, any>> = Array.isArray(parsed) ? parsed : [parsed]
    if (list.length !== points.length) {
      throw new Error(`${model}: asked for ${points.length} points, got ${list.length}`)
    }
    list.forEach((j, idx) => {
      if (j.error) throw new Error(`${model}: ${j.reason}`)
      const times: string[] = j.hourly?.time ?? []
      for (let i = 0; i < times.length; i++) {
        const t = Date.parse(`${times[i]}:00Z`)
        let perLevel = field.get(t)
        if (!perLevel) { perLevel = new Map(); field.set(t, perLevel) }
        for (const h of heights) {
          const sp = j.hourly?.[`wind_speed_${h}m`]?.[i]
          const di = j.hourly?.[`wind_direction_${h}m`]?.[i]
          if (sp == null || di == null) continue
          const arr = perLevel.get(h) ?? []
          // The point's OWN lat/lon as asked for, not the cell's: the lattice
          // has to stay rectangular for a bilinear weighting, and cell
          // selection can snap two neighbours to the same cell.
          arr.push({ lat: points[idx][0], lon: points[idx][1], speed: sp, dir: di })
          perLevel.set(h, arr)
        }
      }
    })
  }
  return field
}

// ── the forms, as mos.py fits them ─────────────────────────────────────────

interface Row {
  ws: number; wd: number; obs: number; obsTwd: number
  hour: number; month: number; day: string; regatta: string
}
type Spec = Record<string, any>

function assignSector(twd: number, bands: readonly Band[]): string {
  const t = ((twd % 360) + 360) % 360
  for (const [name, lo, hi] of bands) {
    if (lo <= hi) { if (t >= lo && t <= hi) return name } else if (t >= lo || t <= hi) return name
  }
  return 'other'
}

const SIN = (h: number) => Math.sin((2 * Math.PI * h) / 24)
const COS = (h: number) => Math.cos((2 * Math.PI * h) / 24)

/**
 * THE LADDER IS RUN TWICE, and the second half of it is new.
 *
 * `bias_scale` / `diurnal` / `sector` are the original pipeline's forms, with
 * the slope fitted by least squares. `c_bias_scale` / `c_diurnal` /
 * `c_sector` are the same three with the slope PINNED AT 1 — bias, harmonic
 * and band offsets only, so the forecast's range is preserved by construction.
 *
 * Why there is a second half at all: an rmse-optimal slope is a shrinkage
 * toward the climatological mean, and at Long Beach it bought a 30 % rmse gain
 * by making a strong-wind forecast impossible. See the tail section of
 * src/lib/mosFit. A constrained form is stored as its ORDINARY type with
 * a = 1, so the app needs no change and a new type string cannot fall through
 * to raw unnoticed.
 *
 * Each form shares a bias+scale base; diurnal and sector add a term fitted on
 * the RESIDUAL of that base, which is why the shipped specs carry both `b` and
 * a non-zero `c0` — a joint fit cannot produce that pair, and reading the JSON
 * alone it looks singular. It is a two-stage fit.
 */
function fit(kind: string, rows: readonly Row[], bands: readonly Band[]): Spec {
  if (kind === 'raw' || !rows.length) return { type: 'raw' }
  const constrained = kind.startsWith('c_')
  const form = constrained ? kind.slice(2) : kind
  let a: number; let b: number
  if (constrained) {
    // The slope is not estimated. b is then just the mean residual of the
    // forecast itself, which is the least-squares answer with a held at 1.
    a = 1
    b = rows.reduce((q, r) => q + (r.obs - r.ws), 0) / rows.length
  } else {
    const beta = solveOls(rows.map((r) => [1, r.ws]), rows.map((r) => r.obs))
    if (!beta) return { type: 'raw' }
    ;[b, a] = beta
  }
  let resid = rows.map((r) => r.obs - (a * r.ws + b))
  if (form === 'bias_scale') return { type: 'bias_scale', a, b }

  // THE DIURNAL TERM, on the residual of the base.
  let c: number[] | null = null
  if (form === 'diurnal' || form === 'sector_diurnal') {
    c = solveOls(rows.map((r) => [1, SIN(r.hour), COS(r.hour)]), resid)
    if (!c) return { type: 'bias_scale', a, b }
    if (form === 'diurnal') return { type: 'diurnal', a, b, c0: c[0], c1: c[1], c2: c[2] }
    // SEQUENTIALLY, not jointly, and that is deliberate: the band offsets are
    // then fitted on what the harmonic leaves behind, so a sector that happens
    // to blow at one time of day does not absorb the time-of-day signal and
    // claim it as its own. applyMOS sums the two terms, which is exactly what
    // this produces.
    resid = rows.map((r, i) => resid[i] - (c![0] + c![1] * SIN(r.hour) + c![2] * COS(r.hour)))
  }

  // The band offsets: each band's mean residual, shrunk toward the global mean
  // residual so a band with four cases cannot carry its own offset at full
  // weight. That shrinkage is what lets a venue whose newest regatta sat in one
  // sector all week keep the other bands' offsets from the years that have
  // them, rather than refusing a band or trusting a handful of bins.
  const glob = resid.reduce((q, x) => q + x, 0) / resid.length
  const delta: Record<string, number> = {}
  const seen = new Map<string, number[]>()
  rows.forEach((r, i) => {
    const sec = assignSector(r.wd, bands)
    const acc = seen.get(sec) ?? []
    acc.push(resid[i])
    seen.set(sec, acc)
  })
  for (const [sec, rs] of Array.from(seen.entries())) {
    delta[sec] = (rs.reduce((q, x) => q + x, 0) + SHRINK_K * glob) / (rs.length + SHRINK_K)
  }
  if (form === 'sector') return { type: 'sector', a, b, delta, global: glob }
  return { type: 'sector_diurnal', a, b, c0: c![0], c1: c![1], c2: c![2], delta, global: glob }
}

function predict(m: Spec, r: Row, bands: readonly Band[]): number {
  const t = m.type || 'raw'
  if (t === 'raw') return r.ws
  const base = m.a * r.ws + m.b
  if (t === 'bias_scale') return base
  if (t === 'diurnal') return base + m.c0 + m.c1 * SIN(r.hour) + m.c2 * COS(r.hour)
  if (t === 'sector') {
    const s = assignSector(r.wd, bands)
    return base + (s in m.delta ? m.delta[s] : m.global)
  }
  if (t === 'sector_diurnal') {
    const s = assignSector(r.wd, bands)
    return base + (s in m.delta ? m.delta[s] : m.global)
      + m.c0 + m.c1 * SIN(r.hour) + m.c2 * COS(r.hour)
  }
  return r.ws
}

/**
 * Blocked CV where the training POOL and the test rows can differ.
 *
 * That separation is the whole point: it lets a regime-only fit and the pooled
 * fit be scored on THE SAME held-out blocks, which is the only comparison that
 * answers "does splitting the regimes pay?". Both arms exclude the same block
 * from training, so the comparison is fair even where the absolute numbers are
 * optimistic — and for a single-regatta regime, blocked by DAY, they are.
 */
function cvOn(
  trainPool: readonly Row[], testRows: readonly Row[],
  blockOf: (r: Row) => string, kind: string, bands: readonly Band[],
) {
  const blocks = Array.from(new Set(testRows.map(blockOf))).sort()
  const rawE: number[] = []; const adjE: number[] = []
  // The held-out predictions themselves, not just their errors, because the
  // tail check counts how many strong-wind cases each side CALLED.
  const obsP: number[] = []; const rawP: number[] = []; const corP: number[] = []
  const perFold: Array<{ g: string; n: number; raw: number; adj: number }> = []
  const rms = (e: number[]) => Math.sqrt(e.reduce((q, x) => q + x * x, 0) / e.length)
  for (const b of blocks) {
    const te = testRows.filter((r) => blockOf(r) === b)
    const tr = trainPool.filter((r) => blockOf(r) !== b)
    if (!te.length || tr.length < 6) continue
    const m = fit(kind, tr, bands)
    const a: number[] = []; const z: number[] = []
    for (const r of te) {
      const c = predict(m, r, bands)
      a.push(c - r.obs); z.push(r.ws - r.obs)
      obsP.push(r.obs); rawP.push(r.ws); corP.push(c)
    }
    adjE.push(...a); rawE.push(...z)
    perFold.push({ g: b, n: te.length, raw: rms(z), adj: rms(a) })
  }
  if (!adjE.length) return null
  return {
    raw: rms(rawE), adj: rms(adjE), n: adjE.length, perFold, folds: blocks.length,
    obs: obsP, rawP, corP,
  }
}

/** Leave-one-regatta-out, with the per-fold figures kept. */
function cv(rows: readonly Row[], kind: string, bands: readonly Band[]) {
  const groups = Array.from(new Set(rows.map((r) => r.regatta))).sort()
  const rawE: number[] = []; const adjE: number[] = []
  const perFold: Array<{ g: string; n: number; raw: number; adj: number }> = []
  for (const g of groups) {
    const te = rows.filter((r) => r.regatta === g)
    const tr = rows.filter((r) => r.regatta !== g)
    if (!te.length || tr.length < 6) continue
    const m = fit(kind, tr, bands)
    const a: number[] = []; const b: number[] = []
    for (const r of te) { a.push(predict(m, r, bands) - r.obs); b.push(r.ws - r.obs) }
    adjE.push(...a); rawE.push(...b)
    const rms = (e: number[]) => Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length)
    perFold.push({ g, n: te.length, raw: rms(b), adj: rms(a) })
  }
  if (!adjE.length) return null
  const rms = (e: number[]) => Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length)
  return { raw: rms(rawE), adj: rms(adjE), n: adjE.length, perFold, folds: groups.length }
}


/** What a ladder + CV + the bars decided, for one arm of the data. */
interface Decision {
  best: string
  rawRmse: number
  cvRmse: number
  pi: number
  holds: boolean
  ship: boolean
  folds: number
  perFold: Array<{ g: string; n: number; raw: number; adj: number }>
  guarded: string
  table: string
  agree: number
  n: number
  /** Measured on the held-out predictions of the chosen form. */
  tail: TailStat
  tailOk: boolean
  /** True when the chosen form's slope was pinned at 1. */
  constrained: boolean
  /** Every ladder rung's held-out rmse, for "what did this form buy?". */
  rmseByForm: Record<string, number>
}

/**
 * Run the ladder on one arm and apply every rule: the original's choice of the
 * best form that beats raw, its 70 % sector-agreement guard, and the two bars
 * mos-fit.ts enforces (the gain must hold in EVERY held-out block and clear
 * MIN_PI %).
 *
 * `trainPool` and `testRows` are separate so the same held-out blocks can score
 * a pooled fit and a regime-only fit against each other.
 */
// EVERY MOS CARRIES BOTH A SECTOR AND A DIURNAL TERM as a candidate. The
// original pipeline's ladder offered one or the other and never both, so a
// venue whose error depends on direction AND on time of day could only ever be
// given half a correction — and the two are not alternatives, they are
// different axes. `sector_diurnal` is the form mos.js has always been able to
// apply; it simply was never fitted here.
const OLS_LADDER = ['bias_scale', 'diurnal', 'sector', 'sector_diurnal']
const CONSTRAINED_LADDER = ['c_bias_scale', 'c_diurnal', 'c_sector', 'c_sector_diurnal']
const hasSectorTerm = (kind: string) => kind.endsWith('sector') || kind.endsWith('sector_diurnal')

function chooseForm(
  trainPool: readonly Row[], testRows: readonly Row[],
  blockOf: (r: Row) => string, bands: readonly Band[], bars: TailBars,
  ladder: readonly string[] = OLS_LADDER,
): Decision | null {
  if (!testRows.length) return null
  const agree = testRows.filter((r) => assignSector(r.wd, bands) === assignSector(r.obsTwd, bands)).length / testRows.length
  const results: Record<string, ReturnType<typeof cvOn>> = {}
  let rawRmse = NaN
  for (const kind of ladder) {
    const r = cvOn(trainPool, testRows, blockOf, kind, bands)
    if (r) { results[kind] = r; rawRmse = r.raw }
  }
  if (!Number.isFinite(rawRmse)) return null

  let best = 'raw'; let cvRmse = rawRmse
  for (const [k, r] of Object.entries(results)) {
    if (r && r.adj < cvRmse - 1e-9) { best = k; cvRmse = r.adj }
  }
  let guarded = ''
  if (hasSectorTerm(best) && agree < AGREE_MIN) {
    const alt = Object.entries(results).filter(([k]) => !hasSectorTerm(k))
      .sort((p, q) => (p[1]!.adj - q[1]!.adj))[0]
    if (alt && alt[1]!.adj < rawRmse) {
      guarded = ` (sector best but agreement ${(100 * agree).toFixed(0)}% < 70% -> ${alt[0]})`
      best = alt[0]; cvRmse = alt[1]!.adj
    }
  }
  const chosen = results[best]
  const pi = 100 * (1 - cvRmse / rawRmse)
  const holds = chosen ? chosen.perFold.every((f) => f.adj < f.raw) : false
  const tail = chosen
    ? tailStats(chosen.obs, chosen.rawP, chosen.corP, bars)
    : tailStats([], [], [], bars)
  // THE THIRD BAR. An unjudgeable tail passes — a record with nine cases above
  // the threshold cannot refuse a form on them — and the printed verdict says
  // which of the two happened, so a pass on thin evidence is never silent.
  const tailOk = best === 'raw' || tailPasses(tail, bars)
  const cell = (k: string) => (results[k] ? f2(results[k]!.adj).padStart(8) : '       -')
  const pref = ladder[0].startsWith('c_') ? 'c_' : ''
  return {
    best, rawRmse, cvRmse, pi, holds,
    ship: best !== 'raw' && holds && pi >= MIN_PI && tailOk,
    folds: chosen?.folds ?? 0,
    perFold: chosen?.perFold ?? [],
    guarded,
    table: `${f2(rawRmse).padStart(5)}  ${cell(`${pref}bias_scale`)}  ${cell(`${pref}diurnal`)}`
      + `  ${cell(`${pref}sector`)}  ${cell(`${pref}sector_diurnal`)}`,
    agree,
    n: testRows.length,
    tail,
    tailOk,
    constrained: pref === 'c_',
    rmseByForm: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r!.adj])),
  }
}

/** The spec entry a decision produces, shipped or honestly not. */
function entryFor(
  d: Decision, trainPool: readonly Row[], bands: readonly Band[], blockName: string, bars: TailBars,
): Spec {
  const m = d.ship ? fit(d.best, trainPool, bands) : { type: 'raw' }
  const plain = d.best.replace(/^c_/, '')
  return {
    ...m,
    best: d.ship ? plain : 'raw',
    ...(d.ship && d.constrained ? {
      slope_constrained: true,
      form: `a = 1 pinned; ${plain === 'bias_scale' ? 'bias only'
        : plain === 'diurnal' ? 'bias + 24 h harmonic' : 'bias + band offsets'}`,
    } : {}),
    ...(d.ship || d.best === 'raw' ? {} : {
      not_shipped: plain,
      why: !d.tailOk ? `it ${tailVerdict(d.tail, bars)}`
        : d.holds ? `cross-validated gain ${d.pi.toFixed(1)} % is below the ${MIN_PI} % bar`
          : `the gain did not hold in every held-out ${blockName}`,
    }),
    cv_rmse: Number(d.cvRmse.toFixed(3)),
    raw_rmse: Number(d.rawRmse.toFixed(3)),
    reduction_pct: Number(d.pi.toFixed(1)),
    tail: {
      threshold_kn: bars.threshold,
      n_above: d.tail.nAbove,
      warn_raw: d.tail.warnRaw,
      warn_cor: d.tail.warnCor,
      top_bin_kn: bars.topBin,
      top_n: d.tail.topN,
      ...(d.tail.topN ? {
        top_err_raw_kn: Number(d.tail.topRaw.toFixed(2)),
        top_err_cor_kn: Number(d.tail.topCor.toFixed(2)),
      } : {}),
    },
    sector_agreement: Number(d.agree.toFixed(2)),
    n: d.n,
    folds: d.folds,
    blocked_by: blockName,
    [`holds_every_${blockName}`]: d.holds,
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '    -')
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '     -')

async function main() {
  const venues = Object.keys(VENUES).filter((v) => !ONLY || v === ONLY)
  if (!venues.length) { console.error(`No venue ${ONLY}. One of: ${Object.keys(VENUES).join(', ')}`); process.exit(1) }
  console.log('\nMediterranean MOS refit')
  console.log(`  truth        ${OBS_DIR}/obs_<venue>.csv — 10-minute bins of calibrated masthead wind`)
  console.log(`  this season  ${SKIP_2026 ? '(--no-2026: excluded)' : `${OBS_2026_DIR}/obs_<venue>_2026.csv`}`)
  console.log(`               Northstar 76, SELECTED PHASES only (scripts/med-obs-phases.ts)`)
  console.log(`  masthead     32 m for the Northstar 72 regattas, 35 m for 2026's — the files' 30.0 is a default`)
  console.log(`  model read   at the ${EVAL_AT === 'target' ? `app's ${TARGET_Z} m target` : "instrument's own heel-reduced height"}`)
  console.log(`  grid cell    cell_selection=${CELL}  (the shipped specs were fitted on 'nearest';`)
  console.log("               the app was sending the default, 'land', and now sends 'sea')")
  console.log('  levels       the APP\'s ladder per model, and the app\'s single-level lift')
  console.log('  CV           leave-one-regatta-out, as the original')

  for (const venue of venues) {
    const cfg = VENUES[venue]
    const obs = readObs(venue)
    const days = obs.map((o) => new Date(o.tMid).toISOString().slice(0, 10))
    const ranges = coalesceDays(days)
    const points = forecastPoints(cfg.bbox)
    const regattas = Array.from(new Set(obs.map((o) => o.regatta))).sort()
    console.log(`\n${'─'.repeat(78)}\n${venue}`)
    const perReg = regattas.map((r) => {
      const rows = obs.filter((o) => o.regatta === r)
      // The masthead height, not zEff — zEff is that height reduced by heel
      // and so differs on every bin. Printed because the regattas are no
      // longer all one boat.
      const mast = Math.round(Math.max(...rows.map((o) => o.mast)))
      return `${r.replace(`${venue}_`, '')} ${rows.length}@${mast}m`
    })
    console.log(`  ${obs.length} bins, ${regattas.length} regattas (${perReg.join(', ')})`)
    console.log(`  ${ranges.length} date ranges: ${ranges.map(([a, b]) => (a === b ? a : `${a}..${b}`)).join('  ')}`)
    console.log(`  ${points.length}-point lattice over ${cfg.bbox.join(', ')}`)
    console.log(`  bands ${cfg.bands.map(([n]) => n).join(', ')}`)

    // THE TAIL BARS, read off this venue's own truth rather than chosen. The
    // three venues are different animals — Porto Cervo's median is 12.3 kn and
    // 10 % of its bins are over 20, Sorrento reaches 18 kn nine times in three
    // regattas — so a level that measures something at one is vacuous at the
    // other, and a hand-picked pair would be tuned to the answer.
    const bars = pickTailBars(obs.map((o) => o.tws), { label: venue })
      ?? { threshold: Infinity, topBin: Infinity }
    const above = (t: number) => obs.filter((o) => o.tws >= t).length
    console.log(`  tail bars: warning rate at ${bars.threshold} kn (${above(bars.threshold)} bins)`
      + `, mean error at ${bars.topBin}+ kn (${above(bars.topBin)} bins)`)

    const old: Spec = JSON.parse(readFileSync(`src/components/weather/mos/mos_${venue}.json`, 'utf8'))
    const spec: Spec = {
      venue,
      target_height_m: TARGET_Z,
      cell_selection: CELL,
      truth: `${obs.length} ten-minute bins of masthead wind, ${regattas.length} regattas`,
      truth_detail: perReg.join(', '),
      // The height is on the spec because it is the one number a reader would
      // otherwise take from `target_height_m` and get wrong: the predicted
      // quantity is the BOAT'S MASTHEAD wind, 32 m on the Northstar 72
      // regattas and 35 m on 2026's, not a 30 m wind. The files' own 30.0 is
      // extract_obs.py's default and was never a measurement.
      truth_masthead_m: Array.from(new Set(obs.map((o) => o.mast))).sort((x, y) => x - y),
      model_read_at: EVAL_AT === 'target' ? TARGET_Z : 'instrument height, heel-reduced',
      // WHICH HOURS THE DIURNAL TERM WAS FITTED ON, and it is not all of them:
      // a regatta is sailed in the middle of the day, so the 24 h harmonic is
      // constrained over this window and extrapolated outside it. It cannot
      // run away — a harmonic is bounded by sqrt(c1^2 + c2^2), 2.3 kn at the
      // largest here — but the phase outside the window is an extrapolation
      // and a reader should know it.
      fitted_hours_local: [
        Math.min(...obs.map((o) => o.localHour)),
        Math.max(...obs.map((o) => o.localHour)),
      ],
      refitted_on: new Date().toISOString().slice(0, 10),
      // The bar that is new as of this refit, and the reason three shipped
      // corrections are now raw. See the tail section of src/lib/mosFit.
      tail_bars: {
        threshold_kn: bars.threshold,
        top_bin_kn: bars.topBin,
        warn_keep: TAIL_WARN_KEEP,
        top_slack_kn: TAIL_TOP_SLACK,
        note: 'a form must keep this fraction of raw\'s strong-wind hits and not worsen the '
          + 'top bin\'s mean error by more than the slack; an rmse-optimal slope is a shrinkage '
          + 'toward the mean and rmse cannot see what it does to the tail',
      },
      bands: cfg.bands,
      models: {},
    }

    // Kept so the regime pass below can re-use the pairing rather than fetch
    // and interpolate it a second time.
    const rowsByModel: Record<string, Row[]> = {}

    console.log('\n  model                        n  agree    raw   bias_scale  diurnal   sector  sec+diur  ->  chosen')
    for (const mosId of cfg.models) {
      const heights = heightsFor(mosId)
      if (!heights) { console.log(`  ${mosId.padEnd(28)} no MODELS entry — skipped`); continue }
      let field: Field
      try {
        field = await fetchField(mosId, heights, points, ranges)
      } catch (e) {
        // A MODEL THAT FAILS TO LOAD MUST NOT BE WRITTEN OUT MISSING. The spec
        // is rebuilt from scratch each run, so a transient `fetch failed`
        // would drop that model's entry entirely — and applyMOS falls back to
        // raw for a model it cannot find, silently removing a correction that
        // was fine the run before. AROME at St Tropez did exactly this once.
        // Reporting it is enough for a dry run; writing on it is not allowed.
        console.log(`  ${mosId.padEnd(28)} could not load: ${(e as Error).message}`)
        if (WRITE) throw new Error(`${venue}: ${mosId} could not load, so the spec would be written`
          + ' without it and that model would fall back to raw. Re-run.')
        continue
      }
      const hours = Array.from(field.keys()).sort((a, b) => a - b)
      if (!hours.length) { console.log(`  ${mosId.padEnd(28)} out of domain — no data`); continue }

      const rows: Row[] = []
      for (const o of obs) {
        // Nearest forecast hour to the bin's midpoint, as the original paired.
        let t = hours[0]; let bd = Infinity
        for (const h of hours) { const d = Math.abs(h - o.tMid); if (d < bd) { bd = d; t = h } }
        if (bd > 3600_000) continue
        const perLevel = field.get(t)!
        const levels = new Map<number, { speed: number; dir: number }>()
        for (const h of heights) {
          const pts = perLevel.get(h)
          if (!pts?.length) continue
          const uv = bilinearUV(pts, o.lat, o.lon)
          if (!uv) continue
          const { speed, dir } = fromUV(uv.u, uv.v)
          if (speed > 0) levels.set(h, { speed, dir })
        }
        const m = interpToMast(levels, EVAL_AT === 'target' ? TARGET_Z : o.zEff)
        if (!m) continue
        rows.push({
          ws: m.speed, wd: m.dir, obs: o.tws, obsTwd: o.twd,
          hour: o.localHour, month: o.localMonth, day: o.localDay, regatta: o.regatta,
        })
      }
      if (rows.length < 20) { console.log(`  ${mosId.padEnd(28)} only ${rows.length} paired bins — skipped`); continue }
      rowsByModel[mosId] = rows

      // Sector agreement: how often the model puts the wind in the band the
      // boat was actually in. The observed direction is carried on the row —
      // an earlier version looked it up by matching tws values, which pairs
      // the wrong bin whenever two bins recorded the same speed.
      const byRegatta = (r: Row) => r.regatta
      let d = chooseForm(rows, rows, byRegatta, cfg.bands, bars)
      if (!d) {
        // One regatta only: nothing to hold out, so ship raw rather than an
        // in-sample fit. The old spec said the same for ICON-2I.
        const agree = rows.filter((r) => assignSector(r.wd, cfg.bands) === assignSector(r.obsTwd, cfg.bands)).length / rows.length
        const sc = score(rows.map((r) => r.ws), rows.map((r) => r.obs))
        console.log(`  ${mosId.padEnd(28)} ${String(rows.length).padStart(4)}  ${(100 * agree).toFixed(0)}%`
          + `   only one regatta — no CV, shipping raw (in-sample rmse ${f2(sc.rmse)})`)
        spec.models[mosId] = {
          type: 'raw', best: 'raw', sector_agreement: Number(agree.toFixed(2)),
          n: rows.length, note: 'insufficient regattas for CV',
        }
        continue
      }
      console.log(`  ${mosId.padEnd(28)} ${String(d.n).padStart(4)}  ${(100 * d.agree).toFixed(0)}%`
        + `  ${d.table}  ->  ${d.best} (${f2(d.cvRmse)})${d.guarded}`)
      if (d.perFold.length) {
        console.log(`      per regatta held out: ${d.perFold.map((f) => `${f.g.replace(`${venue}_`, '')} raw ${f2(f.raw)} -> ${f2(f.adj)}`).join('   ')}`)
      }
      const oldM = old.models?.[mosId]
      if (oldM) {
        console.log(`      was: ${oldM.best ?? oldM.type}`
          + `${oldM.a != null ? ` a ${f3(oldM.a)} b ${f3(oldM.b)}` : ''}`
          + `${oldM.reduction_pct != null ? ` (${oldM.reduction_pct}%)` : ''}`
          + `${oldM.not_shipped ? ` [voided: ${oldM.not_shipped}]` : ''}`)
      }
      if (d.best !== 'raw') {
        const m = fit(d.best, rows, cfg.bands) as MosModelSpec
        const x = shrinkageFixedPoint(m)
        console.log(`      slope a ${f3(m.a ?? 1)}, fixed point ${x == null ? 'none' : `${f2(x)} kn`}`
          + ` -> at ${bars.topBin} kn the slope and bias move the forecast`
          + ` ${shrinkageAt(m, bars.topBin) >= 0 ? '+' : ''}${f2(shrinkageAt(m, bars.topBin))} kn`)
        console.log(`      ${tailVerdict(d.tail, bars)}`)
        // A HARMONIC FITTED ON A RACING DAY IS EXTRAPOLATED TO THE REST OF IT.
        // Regattas are sailed in the middle of the day, so a 24 h harmonic is
        // constrained over seven or eight hours and guesses the other sixteen.
        // It cannot run away — the swing is bounded by sqrt(c1^2 + c2^2) — but
        // the morning forecast people actually plan on is outside the window,
        // so the size of the swing and what the form bought over the plain
        // bias are both printed. Shipped, not refused: the bars pass it, and
        // refusing a measured gain on a stated caveat is the user's call.
        if (m.c1 != null || m.c2 != null) {
          const amp = Math.hypot(m.c1 ?? 0, m.c2 ?? 0)
          const plain = d.rmseByForm[`${d.constrained ? 'c_' : ''}bias_scale`]
          const bought = plain ? 100 * (1 - d.cvRmse / plain) : NaN
          const lo = Math.min(...obs.map((o) => o.localHour))
          const hi = Math.max(...obs.map((o) => o.localHour))
          console.log(`      diurnal swing +/-${f2(amp)} kn, fitted on ${lo}-${hi} h local only`
            + ` and extrapolated outside it${Number.isFinite(bought)
              ? `; worth ${f2(bought)} % over the plain bias form` : ''}`)
        }
      }

      // ── THE CONSTRAINED LADDER ─────────────────────────────────────────
      // Only reached when the least-squares ladder's own pick fails the tail
      // bar. Pinning the slope costs rmse by construction, so it is the
      // fallback and not the default: where the fitted slope keeps the strong
      // wind, it is the better correction and stays.
      if (d.best !== 'raw' && !d.tailOk) {
        const c = chooseForm(rows, rows, byRegatta, cfg.bands, bars, CONSTRAINED_LADDER)
        if (c) {
          // Printed even when it picks raw. Pinning the slope costs rmse by
          // construction, so "no constrained form beat raw either" is the
          // answer in some cases and has to be visible, not inferred from a
          // missing line.
          console.log(`      CONSTRAINED (a = 1): ${c.table}  ->  ${c.best.replace('c_', '')}`
            + `${c.best === 'raw' ? ' — no constrained form beat raw' : ` (${f2(c.cvRmse)}, ${f2(c.pi)} %)`
              + `  holds ${c.holds ? 'yes' : 'NO'}${c.guarded}`}`)
          if (c.best !== 'raw') console.log(`      ${tailVerdict(c.tail, bars)}`)
        }
        if (c?.ship) {
          console.log('      -> shipping the constrained form: it keeps the tail and still beats raw')
          d = c
        }
      }

      if (d.best !== 'raw' && !d.ship) {
        console.log(`      NOT SHIPPED: written as raw. ${!d.tailOk ? 'it fails the tail bar'
          : d.holds ? `${f2(d.pi)} % is below the ${MIN_PI} % bar`
            : 'the gain does not hold in every held-out regatta'}.`)
      }
      spec.models[mosId] = entryFor(d, rows, cfg.bands, 'regatta', bars)
    }


    // ── WHICH SECTOR CAME FROM WHICH YEAR ─────────────────────────────────
    //
    // A regatta is a week, and a week of Mediterranean weather is often ONE
    // sector: St Tropez's 2026 regatta ran E-SE almost throughout. So a band's
    // offset is not evenly supported across the archive, and this says plainly
    // where each one's evidence comes from — the newest regatta cannot supply
    // the bands it never saw, and the band offsets for those come from the
    // earlier years, shrunk toward the global residual by their own sample
    // count. Printed rather than enforced: a thin band is visible here, and
    // the shrinkage is what keeps it from doing damage.
    // The table is per MODEL, because a band is assigned from the MODEL's own
    // direction and the models disagree about it — and because their archives
    // differ, so ICON-2I's two regattas would misrepresent a venue with three.
    // So it is built on the best-covered model and says which.
    const bandModel = Object.entries(rowsByModel)
      .sort((x, y) => y[1].length - x[1].length)[0]
    const bandSupport: Row[] | null = bandModel?.[1] ?? null
    if (bandSupport) {
      const bandNames = [...cfg.bands.map(([n]) => n), 'other']
      const regs = Array.from(new Set(bandSupport.map((r) => r.regatta))).sort()
      console.log(`\n  BAND SUPPORT — paired bins by direction and regatta, as ${bandModel[0]} sees it`)
      console.log(`  ${'regatta'.padEnd(14)}${bandNames.map((n) => n.padStart(9)).join('')}     total`)
      for (const g of regs) {
        const rs = bandSupport.filter((r) => r.regatta === g)
        const counts = bandNames.map((n) => rs.filter((r) => assignSector(r.wd, cfg.bands) === n).length)
        console.log(`  ${g.replace(`${venue}_`, '').padEnd(14)}`
          + `${counts.map((c) => String(c).padStart(9)).join('')}${String(rs.length).padStart(10)}`)
      }
      const totals = bandNames.map((n) => bandSupport!.filter((r) => assignSector(r.wd, cfg.bands) === n).length)
      console.log(`  ${'ALL'.padEnd(14)}${totals.map((c) => String(c).padStart(9)).join('')}`
        + `${String(bandSupport.length).padStart(10)}`)
      // Three times k: at n = k the offset is half the global residual, at 3k
      // it is three quarters its own. Below that a band is a handful of
      // independent cases — these are 10-minute bins off one boat, so 24 of
      // them is a few hours of one afternoon, not 24 observations.
      const THIN = 3 * SHRINK_K
      const thin = bandNames.filter((n, i) => totals[i] > 0 && totals[i] < THIN)
      for (const n of thin) {
        const i = bandNames.indexOf(n)
        const from = regs.filter((g) => bandSupport!.some((r) => r.regatta === g
          && assignSector(r.wd, cfg.bands) === n)).map((g) => g.replace(`${venue}_`, ''))
        console.log(`  ${n} has ${totals[i]} bins (< ${THIN}), all from ${from.join(' + ')}`
          + ` — that offset is shrunk ${(100 * SHRINK_K / (totals[i] + SHRINK_K)).toFixed(0)} %`
          + ' of the way to the global residual')
      }
      const absent = bandNames.filter((n, i) => totals[i] === 0)
      if (absent.length) console.log(`  ${absent.join(', ')} never occurred — no offset is fitted for ${absent.length > 1 ? 'them' : 'it'}`)
    }

    // ── THE REGIME SPLIT ───────────────────────────────────────────────────
    if (cfg.regime) {
      const { label, otherLabel, months } = cfg.regime
      const inRegime = (r: Row) => months.includes(r.month)
      console.log(`\n  REGIME SPLIT — ${label} (months ${months.join(',')}) against ${otherLabel} (the rest)`)
      console.log('  Both arms are scored on the SAME held-out blocks, one trained on the whole')
      console.log('  archive and one on its own regime, so the only question asked is whether')
      console.log('  fitting the regime apart does better on those blocks.')
      const seasonalModels: Record<string, Spec> = {}
      /** Models whose default entry came from the OTHER regime's own arm. */
      const fromOtherArm = new Set<string>()

      for (const [mosId, rows] of Object.entries(rowsByModel)) {
        for (const [armLabel, armRows, isSeasonal] of [
          [otherLabel, rows.filter((r) => !inRegime(r)), false],
          [label, rows.filter(inRegime), true],
        ] as Array<[string, Row[], boolean]>) {
          if (armRows.length < 40) {
            console.log(`\n  ${mosId} / ${armLabel}: only ${armRows.length} bins — skipped`)
            continue
          }
          const regattas = Array.from(new Set(armRows.map((r) => r.regatta)))
          const byDay = regattas.length < 2
          const blockOf = byDay ? (r: Row) => r.day : (r: Row) => r.regatta
          const blockName = byDay ? 'day' : 'regatta'
          const pooled = chooseForm(rows, armRows, blockOf, cfg.bands, bars)
          let armOnly = chooseForm(armRows, armRows, blockOf, cfg.bands, bars)
          console.log(`\n  ${mosId} / ${armLabel}: ${armRows.length} bins, ${regattas.length} regatta(s)`
            + `, blocked by ${blockName}${byDay ? ' — ONE regatta, so this is a weaker test than the others' : ''}`)
          if (!pooled || !armOnly) { console.log('      not enough blocks to cross-validate — arm skipped'); continue }
          console.log(`      pooled fit on these blocks   ${f2(pooled.rawRmse)} -> ${f2(pooled.cvRmse)}`
            + `  (${pooled.best})  holds ${pooled.holds ? 'yes' : 'NO'}`)
          console.log(`      ${armLabel}-only fit`.padEnd(35) + `${f2(armOnly.rawRmse)} -> ${f2(armOnly.cvRmse)}`
            + `  (${armOnly.best})  holds ${armOnly.holds ? 'yes' : 'NO'}${armOnly.guarded}`)
          console.log(`      per ${blockName} held out: ${armOnly.perFold.map((f) => `${f.g.replace(`${venue}_`, '')} ${f2(f.raw)} -> ${f2(f.adj)}`).join('  ')}`)

          if (armOnly.best !== 'raw') console.log(`      ${tailVerdict(armOnly.tail, bars)}`)
          // The same fallback as the year-round pass, for the same reason: a
          // regime arm that wins on rmse by flattening the regime's strong
          // wind has not earned anything.
          if (armOnly.best !== 'raw' && !armOnly.tailOk) {
            const c = chooseForm(armRows, armRows, blockOf, cfg.bands, bars, CONSTRAINED_LADDER)
            if (c && c.best !== 'raw') {
              console.log(`      CONSTRAINED (a = 1): ${f2(c.cvRmse)} (${f2(c.pi)} %),`
                + ` holds ${c.holds ? 'yes' : 'NO'} — ${tailVerdict(c.tail, bars)}`)
            }
            if (c?.ship) { console.log('      -> the constrained form is this arm\'s candidate'); armOnly = c }
          }

          const wins = armOnly.cvRmse < pooled.cvRmse
          if (!wins) {
            console.log(`      VERDICT: keep the pooled coefficients — the ${armLabel}-only fit is no better`)
            continue
          }
          if (!armOnly.ship) {
            console.log(`      VERDICT: the ${armLabel}-only fit beats the pooled one but fails a bar`
              + ` (${armOnly.holds ? `${f2(armOnly.pi)} % < ${MIN_PI} %` : `not every held-out ${blockName}`}) — raw`)
          } else {
            console.log(`      VERDICT: fit the ${armLabel} regime separately — ${armOnly.best},`
              + ` ${f2(armOnly.pi)} % against raw, holding in every held-out ${blockName}`)
          }
          const entry = entryFor(armOnly, armRows, cfg.bands, blockName, bars)
          entry.regime = armLabel
          if (isSeasonal) { if (armOnly.ship) seasonalModels[mosId] = entry }
          else { spec.models[mosId] = entry; fromOtherArm.add(mosId) }
        }

        // WHAT THE WINDOW GETS WHEN ITS OWN FIT DID NOT EARN COEFFICIENTS, and
        // this is the part that needs stating. applyMOS falls back to
        // spec.models outside the window AND for any model the window does not
        // name, so leaving a model out of `seasonal` means the default applies
        // inside the window too. That is right when the default came from the
        // POOLED fit, which had to hold in every regatta including this
        // regime's — icon_eu at St Tropez improves the June regatta 3.56 ->
        // 3.09, so it should keep doing that in June.
        //
        // It is WRONG when the default came from the other regime's own arm:
        // those coefficients were fitted on October and were never asked to
        // work in June. AROME is exactly that case. So the window gets an
        // explicit `raw` — which is a statement, not an absence.
        const def = spec.models[mosId]
        if (!seasonalModels[mosId] && fromOtherArm.has(mosId) && def && (def.type || 'raw') !== 'raw') {
          seasonalModels[mosId] = {
            type: 'raw',
            best: 'raw',
            regime: label,
            why: `the default coefficients were fitted on the ${otherLabel} regime alone and are not `
              + `validated here; the ${label}-only fit did not earn its own`,
          }
          console.log(`\n  ${mosId} / ${label}: the default now comes from the ${otherLabel} arm, which was`)
          console.log(`      never tested here — so the ${label} window is set to raw explicitly.`)
        }
      }

      if (Object.keys(seasonalModels).length) {
        spec.seasonal = {
          months,
          label,
          note: `${label} regime. applyMOS uses these inside the window and spec.models outside it; `
            + 'a model absent here keeps the default, which is only safe when the default was '
            + 'validated across every regatta including this regime\'s',
          models: seasonalModels,
        }
      } else {
        console.log(`\n  Nothing to say about the ${label} window that the defaults do not already`)
        console.log('  cover, so no seasonal block is written — an empty one would read as a')
        console.log('  window that exists.')
      }
    }

    if (WRITE) {
      const f = `src/components/weather/mos/mos_${venue}.json`
      writeFileSync(f, `${JSON.stringify(spec, null, 2)}\n`)
      console.log(`\n  wrote ${f}`)
    }
  }
  if (!WRITE) console.log(`\n${'─'.repeat(78)}\n(dry run — add --write to rewrite the spec JSONs)`)
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
