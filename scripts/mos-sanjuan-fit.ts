// Fit a MOS wind correction for the SAN JUAN ISLANDS, against the four public
// stations around the racing area.
//
//   npx vite-node scripts/mos-sanjuan-fit.ts                    # dry run, all stations
//   npx vite-node scripts/mos-sanjuan-fit.ts -- --write         # writes the spec JSON
//   npx vite-node scripts/mos-sanjuan-fit.ts -- --station ORS   # fit against a different truth
//   npx vite-node scripts/mos-sanjuan-fit.ts -- --from 2023-01-01
//
// WHY A SEPARATE SCRIPT FROM mos-fit.ts, which does the same job in Norway:
// only the OBSERVATIONS differ. mos-fit reads MET Norway Frost rows out of the
// `wind_observations` table, which the poller fills for venues it is watching;
// there is no San Juan history in it, and the four stations here are American
// and Canadian anyway. So this fetches the truth straight from the public
// archives — NDBC for the two marine stations, Iowa State's IEM mirror for the
// two aviation ones — and then hands it to the SAME src/lib/mosFit routines.
// The method is therefore identical by construction: leave-one-year-out with a
// buffer, the nested ladder raw -> bias_scale -> diurnal -> sector ->
// sector_diurnal, the one-standard-error rule on nEff, and the twenty
// effective-samples-per-parameter gate. Nothing about the statistics is
// re-implemented here, because a second copy of it would drift.
//
// ── THE HEIGHT PROBLEM, WHICH IS THE WHOLE DESIGN ──────────────────────────
//
// mos-fit's first principle is that both sides of the regression must be the
// same measured quantity at the same height, because manufacturing an
// observation with the very profile you are about to apply makes the
// correction absorb a one-signed profile error and report a small residual.
// At the Oslofjord that was easy: the truth was a 10 m lighthouse anemometer
// and the model has a native 10 m field.
//
// Here the four stations are at FOUR DIFFERENT HEIGHTS, measured off their own
// metadata pages on 28 Oct 2026:
//
//   Kelp Reefs      CWZO    10.0 m   marine, a rock in Haro Strait
//   Orcas Island    ORS     10.0 m   airport on Orcas Island, land exposure
//   Smith Island    SISW1   17.4 m   above a 0 m site, so 17.4 m above the sea
//   Se'lhaem        46118    2.97 m  a BUOY in Bellingham Bay
//
// Only the two 10 m stations can be a regression target for the model's native
// 10 m field without inventing a profile. So:
//
//   - the PRIMARY truth is Kelp Reefs. It is the closest analogue of the
//     Gullholmen lighthouse the Norwegian fit used: unobstructed marine
//     exposure on all sides, hourly, 10 m, and inside the 1 km domain.
//   - Orcas Island is fitted too and is the useful contrast, because it is the
//     same height over LAND. The difference between the two corrections is a
//     measure of how much of a "bias" is really exposure.
//   - Smith Island and Se'lhaem are reported but NEVER shipped. Their
//     coefficients would carry a height term — at 2.97 m the buoy reads
//     perhaps 15-20% under a 10 m wind in neutral air — and a spec fitted on
//     one and applied to the model's 10 m field would push the forecast down
//     by the height difference for ever. They are run because a correction
//     that is real should show up at all four, and because they are the only
//     two stations actually in the racing water.
//
// So `--write` emits the primary station's spec only, and the others are
// printed as corroboration. --allow-nonstandard-height overrides, and says so
// loudly in the spec, for anyone who wants to see what that would look like.
//
// ── WHICH MODELS, AND WHY NOT THE OTHERS ───────────────────────────────────
//
// Probed against the historical-forecast archive at 48.5765/-122.9506 on
// 28 Oct 2026, three days of hourly data each:
//
//   ecmwf_ifs025            72/72   cell 11.4 nm away
//   icon_global             72/72   cell  6.1 nm away
//   gfs_global              72/72   cell  1.5 nm away
//   gfs_hrrr                72/72   cell  1.6 nm away   (3 km CONUS HRRR)
//   gem_hrdps_continental   72/72   cell  1.2 nm away   (2.5 km, Canadian)
//   ncep_nam_conus           0/72   NO ARCHIVE -> excluded
//
// `best_match`, `icon_seamless`, `gfs_seamless` and `gem_seamless` are all
// excluded for the reason mos-fit gives for refusing metno_seamless: a splice
// is not a fittable target, because its error statistics change character at
// the seam and the correction would average two different models.
//
// icon_eu is NOT in the list and must not be: it does not reach the Pacific.
// The app's MODELS table maps its ICON entry to mosModel `icon_eu`, which is
// right in Europe and wrong here — see the note this prints at the end.
//
// CELL SELECTION IS `sea`, for the reason recorded in CLAUDE.md: Open-Meteo
// defaults to a LAND cell, and every MOS number this project measured before
// 27 Oct 2026 was against one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VENUES } from '../src/lib/venues'
import { nmBetween } from '../src/lib/obsDensity'
import {
  crossValidateForms, selectForm, score, lag1, effectiveN, assignSector,
  piRmse, persistenceRmse, gainHoldsEveryBlock,
  type Pair, type Band, type FormResult,
} from '../src/lib/mosFit'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const ALLOW_NONSTD = argv.includes('--allow-nonstandard-height')
// Bring a non-10 m station's observations to 10 m with a neutral log profile,
// so it can be a regression target for the model's native 10 m field. ON by
// default because the alternative — regressing the model's 10 m field on a
// 17.4 m observation — is simply wrong, and because the factor was measured
// rather than assumed (see heightFactor). --no-reduce-to-10m turns it off.
const REDUCE_10M = !argv.includes('--no-reduce-to-10m')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const VENUE_KEY = 'san-juan'
const TZ = flag('tz', 'America/Vancouver')!
const CELL = flag('cell-selection', 'sea')!
const FIT_Z = 10
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const KMH_TO_KN = 0.539957
const MS_TO_KN = 1.943844
const MAX_PARAMS = Number(flag('max-params', '7'))
const BUFFER_H = Number(flag('buffer', '48'))

// The archive the historical-forecast API actually holds for these models
// starts in 2021-2022 depending on the model; 2022-01-01 is a safe floor that
// still leaves four year-blocks for leave-one-year-out.
const FROM = flag('from', '2022-01-01')!
const TO = flag('to', new Date().toISOString().slice(0, 10))!

// Four 90-degree bands. Narrower is spurious resolution for a direction field
// that is nearest-neighbour off a 2.5-13 km grid — mos-fit's reasoning, and it
// applies with more force to the coarse models here.
const BANDS: Band[] = [
  ['N', 315, 45],
  ['E', 45, 135],
  ['S', 135, 225],
  ['W', 225, 315],
]

const MODELS = (flag('models',
  'ecmwf_ifs025,icon_global,gfs_global,gfs_hrrr,gem_hrdps_continental')!)
  .split(',').map((s) => s.trim()).filter(Boolean)

interface Station {
  id: string
  name: string
  lat: number
  lon: number
  /** Anemometer height above the site, metres, off the operator's own metadata. */
  anemM: number
  source: 'ndbc' | 'iem'
  /** IEM network, for the aviation stations. */
  network?: string
  exposure: string
}

// Positions and anemometer heights read off the operators' own pages, 28 Oct
// 2026. The heights are the load-bearing column; see the header.
const STATIONS: Station[] = [
  {
    id: 'CWZO', name: 'Kelp Reefs', lat: 48.5476, lon: -123.2369, anemM: 10,
    source: 'iem', network: 'CA_BC_ASOS',
    exposure: 'marine — a rock in Haro Strait, open on every side',
  },
  {
    id: 'ORS', name: 'Eastsound / Orcas Island Airport', lat: 48.71, lon: -122.91, anemM: 10,
    source: 'iem', network: 'WA_ASOS',
    exposure: 'land — airport in a valley on Orcas Island',
  },
  {
    id: 'SISW1', name: 'Smith Island, WA', lat: 48.3183, lon: -122.8433, anemM: 17.4,
    source: 'ndbc',
    exposure: 'marine — low island in the eastern Strait of Juan de Fuca',
  },
  {
    id: '46118', name: "Se'lhaem, Bellingham Bay", lat: 48.7242, lon: -122.5758, anemM: 2.97,
    source: 'ndbc',
    exposure: 'marine — moored buoy',
  },
]

// SMITH ISLAND, not Kelp Reefs, and this was measured on 28 Oct 2026 after
// starting with Kelp Reefs for its 10 m anemometer.
//
// Reduced to 10 m, FOUR OF FIVE independent models are essentially unbiased at
// Smith Island: ecmwf -0.08, gfs_global -0.02, gfs_hrrr +0.02, gem_hrdps -0.43
// kn. At Kelp Reefs the same five read -0.45, -4.34, -3.35, -1.76, -1.82, and
// four of them need a SECTOR correction rather than a plain offset.
//
// Five forecasting centres with different physics do not conspire to
// under-forecast one rock by 1.8-4.3 kn while agreeing to within half a knot
// ten miles away. The site is the odd one out: Kelp Reefs is a small rock in
// Haro Strait, a 3-5 km channel, and it accelerates. A MOS fitted there would
// encode that acceleration as "the model is too slow" and apply it across the
// whole archipelago — the representativeness trap this project keeps paying
// for. gfs_hrrr at Smith Island is also the only model/station pair in the
// study that beats 1 h persistence (rmse 2.79 against 3.00).
const PRIMARY = flag('station', 'SISW1')!

// ── caching ────────────────────────────────────────────────────────────────
// The obs archives are tens of megabytes across four stations and four years,
// and Open-Meteo bills PER LOCATION, so nothing is fetched twice. Cache lives
// in TMPDIR, like mos-med-refit's.
const CACHE = join(process.env.TMPDIR || tmpdir(), 'ssa-mos-sanjuan-cache')
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  const p = join(CACHE, `${key.replace(/[^\w.-]/g, '_')}.txt`)
  if (existsSync(p)) return readFileSync(p, 'utf8')
  const body = await fetcher()
  writeFileSync(p, body)
  return body
}

async function get(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 110)}`)
  return r.text()
}

/**
 * Snap sub-hourly reports onto the hour.
 *
 * ASOS/AWOS routine reports land at :53 and the specials wherever they like;
 * NDBC writes every 10 minutes. Both are matched to the NEAREST hour within
 * +-30 min and the closest report to the hour wins, so a :53 observation
 * becomes the following hour's. That is the ordinary convention and it is
 * stated here because the alternative — taking whatever report is first in the
 * hour — quietly introduces up to an hour of lag against the model, which a
 * bias fit would then absorb as if it were a bias.
 */
function snapHourly(samples: Array<{ ms: number; kn: number }>): Map<number, number> {
  const best = new Map<number, { kn: number; off: number }>()
  for (const s of samples) {
    if (!Number.isFinite(s.ms) || !Number.isFinite(s.kn) || s.kn < 0 || s.kn > 150) continue
    const hour = Math.round(s.ms / 3600_000) * 3600_000
    const off = Math.abs(s.ms - hour)
    if (off > 30 * 60_000) continue
    const cur = best.get(hour)
    if (!cur || off < cur.off) best.set(hour, { kn: s.kn, off })
  }
  return new Map(Array.from(best.entries()).map(([k, v]) => [k, v.kn]))
}

/** IEM mirror of the ASOS/AWOS archives (US and Canadian). Speeds in knots. */
async function loadIem(st: Station): Promise<Map<number, number>> {
  const samples: Array<{ ms: number; kn: number }> = []
  const y0 = Number(FROM.slice(0, 4))
  const y1 = Number(TO.slice(0, 4))
  for (let y = y0; y <= y1; y++) {
    const start = y === y0 ? FROM : `${y}-01-01`
    const end = y === y1 ? TO : `${y}-12-31`
    const [sy, sm, sd] = start.split('-')
    const [ey, em, ed] = end.split('-')
    const url = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'
      + `?station=${st.id}&network=${st.network}&data=sknt&data=drct`
      + `&year1=${sy}&month1=${Number(sm)}&day1=${Number(sd)}`
      + `&year2=${ey}&month2=${Number(em)}&day2=${Number(ed)}`
      + '&tz=Etc%2FUTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no'
      + '&report_type=3&report_type=4'
    const body = await cached(`iem_${st.id}_${y}`, () => get(url))
    for (const line of body.split('\n')) {
      if (!line || line.startsWith('station')) continue
      const c = line.split(',')
      if (c.length < 3) continue
      const kn = Number(c[2])
      if (!Number.isFinite(kn)) continue           // 'M' -> NaN, dropped
      const ms = Date.parse(`${c[1].replace(' ', 'T')}:00Z`)
      samples.push({ ms, kn })
    }
  }
  return snapHourly(samples)
}

/**
 * NDBC standard meteorological archives. Speeds are m/s; 99/999 are missing.
 *
 * The yearly historical files stop a year or two back for some stations, so
 * the current year comes from realtime2, whose columns are the same but whose
 * header carries units on a second line.
 */
async function loadNdbc(st: Station): Promise<Map<number, number>> {
  const samples: Array<{ ms: number; kn: number }> = []
  const yNow = new Date().getUTCFullYear()
  const y0 = Number(FROM.slice(0, 4))
  const sources: Array<[string, string]> = []
  for (let y = y0; y < yNow; y++) {
    sources.push([`ndbc_${st.id}_${y}`,
      `https://www.ndbc.noaa.gov/view_text_file.php?filename=${st.id.toLowerCase()}h${y}.txt.gz`
      + '&dir=data/historical/stdmet/'])
  }
  sources.push([`ndbc_${st.id}_rt`, `https://www.ndbc.noaa.gov/data/realtime2/${st.id.toUpperCase()}.txt`])
  for (const [key, url] of sources) {
    let body: string
    try { body = await cached(key, () => get(url)) } catch { continue }   // a year with no file
    for (const line of body.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const c = line.trim().split(/\s+/)
      if (c.length < 7) continue
      const [Y, M, D, h, mi] = c.slice(0, 5).map(Number)
      const ws = Number(c[6])                       // WSPD, m/s
      if (!Number.isFinite(ws) || ws >= 90) continue  // 99.0 = missing
      const yr = Y < 100 ? 1900 + Y : Y
      const ms = Date.UTC(yr, M - 1, D, h, mi || 0)
      samples.push({ ms, kn: ws * MS_TO_KN })
    }
  }
  return snapHourly(samples)
}

/**
 * Observations for one station, CLIPPED TO THE FIT WINDOW.
 *
 * The clip is not cosmetic. loadNdbc pulls whole calendar years plus the
 * realtime tail, because that is how the archive is published, so without it
 * the obs map runs past both ends of --from/--to. Pairing would still be
 * correct — pairUp keeps only hours the model also has — but the counts and
 * the lag-1/nEff line printed below would describe a different span from the
 * one that was fitted, and nEff is the number the parameter gate is argued
 * from. A statistic quoted over the wrong window is worse than none.
 */
async function loadObs(st: Station): Promise<Map<number, number>> {
  const all = st.source === 'iem' ? await loadIem(st) : await loadNdbc(st)
  const lo = Date.parse(`${FROM}T00:00:00Z`)
  const hi = Date.parse(`${TO}T23:59:59Z`)
  const win = new Map(Array.from(all.entries()).filter(([ms]) => ms >= lo && ms <= hi))
  if (!REDUCE_10M || st.anemM === FIT_Z) return win
  const f = heightFactor(st.anemM)
  return new Map(Array.from(win.entries()).map(([ms, kn]) => [ms, kn * f]))
}

/**
 * Neutral log-profile factor to bring a station's wind from its own anemometer
 * height to 10 m, over open water.
 *
 * THIS MANUFACTURES AN OBSERVATION, which is the thing mos-fit's header refuses
 * to do — so it is off by default and the spec records it when it is on. The
 * reason it is defensible HERE and not there is that it was MEASURED, not
 * assumed. mos-fit's objection is to inventing a 30 m observation from a 10 m
 * one with the very profile about to be applied: a large, unverified lift whose
 * error is one-signed, so the fit absorbs it and reports a small residual.
 *
 * This is the opposite case and two orders smaller. Smith Island against Kelp
 * Reefs, 21,818 matched hours (--compare): median ratio 1.089 against the 1.051
 * this function predicts for 17.4 m over 10 m with z0 = 0.0002 m. So the height
 * term is real, small, and the log law gets it right to about four per cent —
 * and that four per cent is site difference, not profile error.
 *
 * It does NOT rescue the buoy. 2.97 m gives 0.888, a 12 % correction on a
 * station with 619 usable hours, which is a large adjustment on nothing.
 */
const WATER_Z0 = 0.0002
function heightFactor(anemM: number): number {
  return Math.log(FIT_Z / WATER_Z0) / Math.log(anemM / WATER_Z0)
}

interface Cell { lat: number; lon: number }

/** Archived forecasts for one model at one position, a year at a time. */
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
      + `?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}`
      + '&hourly=wind_speed_10m,wind_direction_10m'
      + `&models=${encodeURIComponent(model)}&cell_selection=${encodeURIComponent(CELL)}`
    const body = await cached(`om_${model}_${lat.toFixed(4)}_${lon.toFixed(4)}_${y}`, () => get(url))
    const j = JSON.parse(body)
    if (j.error) throw new Error(`${model} ${y}: ${j.reason}`)
    if (!cell && Number.isFinite(j.latitude)) cell = { lat: j.latitude, lon: j.longitude }
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

function localParts(ms: number, tz: string): { hour: number; month: number } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', month: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? NaN)
  return { hour: g('hour') + g('minute') / 60, month: g('month') }
}

function pairUp(obs: Map<number, number>, mod: Map<number, { ws: number; twd: number | null }>): Pair[] {
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

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '   -')
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '    -')

function printLadder(results: readonly FormResult[], indent = '    ') {
  const raw = results.find((r) => r.type === 'raw')
  console.log(`${indent}form            params    cv rmse   cv bias     nEff   gain   every-block`)
  for (const r of results) {
    if (r.refused) {
      console.log(`${indent}${r.type.padEnd(15)} ${String(r.params).padStart(6)}    REFUSED — ${r.refused}`)
      continue
    }
    // piRmse ALREADY returns a percentage; multiplying again gave 751.9% for
    // a 7.5% gain, which is the kind of number that reads as a triumph.
    const gain = raw ? piRmse(r.cv.rmse, raw.cv.rmse) : NaN
    console.log(`${indent}${r.type.padEnd(15)} ${String(r.params).padStart(6)}`
      + `    ${f2(r.cv.rmse)}    ${f2(r.cv.bias).padStart(6)}  ${r.cv.nEff.toFixed(0).padStart(7)}`
      + `  ${gain.toFixed(1).padStart(5)}%   ${r.type === 'raw' ? '-' : gainHoldsEveryBlock(r) ? 'yes' : 'NO'}`)
  }
}

/**
 * Station against station, on matched hours — the measurement that separates
 * HEIGHT from EXPOSURE.
 *
 * Both are read as "that station is windier", and a single number cannot tell
 * them apart. But their signatures differ: a pure height difference is a
 * roughly CONSTANT RATIO, the same in every direction, because the log profile
 * scales. A difference in exposure is DIRECTIONAL — a channelled site loses
 * wind across the channel and keeps it along, a sheltered one loses it from
 * the sheltered quadrant only. So the ratio is printed per sector as well as
 * overall, and the spread across sectors is the diagnostic.
 */
async function compareStations() {
  const obs = new Map<string, Map<number, number>>()
  for (const st of STATIONS) {
    try { obs.set(st.id, await loadObs(st)) } catch { /* reported in the main pass */ }
  }
  // Direction comes from a model, because none of these stations' direction is
  // in the obs feed this script reads. gfs_hrrr is the finest-grid model with a
  // full archive here, and its cell is 0.65-0.76 nm from both stations.
  const ref = STATIONS.find((s) => s.id === 'CWZO')!
  const { rows: dirSrc } = await loadModel('gfs_hrrr', ref.lat, ref.lon)
  console.log(`\n${'='.repeat(78)}\nSTATION vs STATION — matched hours, ratio of observed speeds`)
  console.log('  A pure HEIGHT difference is a constant ratio across sectors;')
  console.log('  an EXPOSURE difference is directional. The spread is the diagnostic.\n')
  const ids = STATIONS.map((s) => s.id)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = obs.get(ids[i]); const B = obs.get(ids[j])
      if (!A || !B) continue
      const sa = STATIONS[i]; const sb = STATIONS[j]
      const bySec = new Map<string, number[]>()
      const all: number[] = []
      for (const [ms, a] of Array.from(A.entries())) {
        const b = B.get(ms)
        // Below 4 kn a ratio is dominated by the instruments' own threshold
        // and by calms that are not the same calm at two sites 10 nm apart.
        if (b == null || a < 4 || b < 4) continue
        const r = b / a
        all.push(r)
        const d = dirSrc.get(ms)?.twd
        if (d != null) {
          const sec = assignSector(d, BANDS)
          if (!bySec.has(sec)) bySec.set(sec, [])
          bySec.get(sec)!.push(r)
        }
      }
      if (all.length < 500) continue
      const med = (x: number[]) => { const q = [...x].sort((m, n) => m - n); return q[Math.floor(q.length / 2)] }
      const secs = BANDS.map(([n]) => n)
      const vals = secs.map((n) => (bySec.get(n)?.length ?? 0) >= 200 ? med(bySec.get(n)!) : NaN)
      const fin = vals.filter(Number.isFinite)
      const spread = fin.length >= 2 ? Math.max(...fin) - Math.min(...fin) : NaN
      console.log(`  ${sb.id}/${sa.id}  (${sb.anemM} m / ${sa.anemM} m)   n=${all.length.toLocaleString('en-GB')}`
        + `   median ratio ${med(all).toFixed(3)}`)
      console.log(`      by sector  ${secs.map((n, k) => `${n} ${Number.isFinite(vals[k]) ? vals[k].toFixed(3) : '  -  '}`).join('   ')}`
        + `   spread ${Number.isFinite(spread) ? spread.toFixed(3) : '-'}`)
    }
  }
  // What a neutral log profile says the pure height term should be, for scale.
  const logRatio = (zb: number, za: number, z0: number) => Math.log(zb / z0) / Math.log(za / z0)
  console.log('\n  For scale, a NEUTRAL log profile over open water (z0 = 0.0002 m):')
  console.log(`      17.4 m / 10 m = ${logRatio(17.4, 10, 0.0002).toFixed(3)}`
    + `      2.97 m / 10 m = ${logRatio(2.97, 10, 0.0002).toFixed(3)}`)
  console.log('      Stability moves these by a few per cent either way; the point is the')
  console.log('      ORDER, not the third decimal.')
}

async function main() {
  const venue = VENUES.find((v) => v.key === VENUE_KEY)
  if (!venue) { console.error(`venue ${VENUE_KEY} not in VENUES`); process.exit(1) }

  console.log(`\nSAN JUAN ISLANDS MOS  —  venue centre ${venue.lat}, ${venue.lon}`)
  console.log(`  window ${FROM} .. ${TO}   tz ${TZ}   cell_selection=${CELL}   fit height ${FIT_Z} m`)
  console.log(`  models: ${MODELS.join(', ')}`)

  console.log('\nSTATIONS')
  for (const s of STATIONS) {
    const d = nmBetween(venue.lat, venue.lon, s.lat, s.lon)
    const ok = s.anemM === FIT_Z
    console.log(`  ${s.id.padEnd(6)} ${s.name.padEnd(34)} ${s.anemM.toFixed(2).padStart(5)} m`
      + `  ${d.toFixed(1).padStart(4)} nm   ${ok ? 'fittable' : 'REPORT ONLY'}   ${s.exposure}`)
  }

  if (argv.includes('--compare')) { await compareStations(); return }

  const results: Record<string, Record<string, FormResult[]>> = {}
  const chosen: Record<string, Record<string, unknown>> = {}

  for (const st of STATIONS) {
    console.log(`\n${'='.repeat(78)}\n${st.id} — ${st.name}  (${st.anemM} m, ${st.exposure})`)
    if (st.anemM !== FIT_Z) {
      if (REDUCE_10M) {
        console.log(`  obs reduced ${st.anemM} m -> ${FIT_Z} m by x${heightFactor(st.anemM).toFixed(4)}`
          + ` (neutral log profile, z0 ${WATER_Z0} m)`)
      } else {
        console.log(`  !! ${st.anemM} m is not the model's 10 m field. Reported for corroboration;`)
        console.log('     its coefficients carry a height term and are NOT shipped.')
      }
    }
    let obs: Map<number, number>
    try { obs = await loadObs(st) } catch (e) { console.log(`  obs failed: ${(e as Error).message}`); continue }
    console.log(`  ${obs.size.toLocaleString('en-GB')} hourly observations`)
    if (obs.size < 2000) { console.log('  too few to fit anything honest — skipped.'); continue }
    const series = Array.from(obs.keys()).sort((a, b) => a - b).map((k) => obs.get(k)!)
    const r1 = lag1(series)
    console.log(`  lag-1 ${f3(r1)} -> nEff ≈ ${effectiveN(obs.size, r1).toFixed(0)}`
      + ` of ${obs.size.toLocaleString('en-GB')} (${(100 * effectiveN(obs.size, r1) / obs.size).toFixed(1)}%)`)

    results[st.id] = {}
    chosen[st.id] = {}
    for (const model of MODELS) {
      let mod: Awaited<ReturnType<typeof loadModel>>
      try { mod = await loadModel(model, st.lat, st.lon) } catch (e) {
        console.log(`\n  ${model}: fetch failed — ${(e as Error).message}`); continue
      }
      const rows = pairUp(obs, mod.rows)
      const off = mod.cell ? nmBetween(st.lat, st.lon, mod.cell.lat, mod.cell.lon) : NaN
      console.log(`\n  ${model}   ${rows.length.toLocaleString('en-GB')} paired hours`
        + `   cell ${off.toFixed(2)} nm from the anemometer`)
      if (rows.length < 2000) { console.log('    too few paired hours — skipped.'); continue }
      const rawBias = rows.reduce((a, r) => a + (r.model - r.obs), 0) / rows.length
      const rawRmse = score(rows.map((r) => r.model), rows.map((r) => r.obs)).rmse
      const persist = persistenceRmse(rows)
      console.log(`    raw bias ${f2(rawBias)} kn   raw rmse ${f2(rawRmse)} kn`
        + `   persistence rmse ${f2(persist)} kn`)
      const { blocks, results: ladder } = crossValidateForms(rows, BANDS, {
        bufferMs: BUFFER_H * 3600_000,
      })
      if (blocks < 2 || !ladder.length) {
        console.log(`    only ${blocks} year-block(s) — cannot cross-validate; skipped.`); continue
      }
      console.log(`    ${blocks} held-out year blocks`)
      printLadder(ladder)
      const pick = selectForm(ladder, MAX_PARAMS)
      const rawCv = ladder.find((r) => r.type === 'raw')
      if (!pick || !rawCv) { console.log('    no form survived selection.'); continue }
      const gain = piRmse(pick.cv.rmse, rawCv.cv.rmse)
      const holds = gainHoldsEveryBlock(pick)
      console.log(`    -> ${pick.type}  ${gain.toFixed(1)}%`
        + `${pick.type === 'raw' ? '' : holds ? '' : '   (does NOT hold in every block)'}`)
      results[st.id][model] = ladder
      chosen[st.id][model] = { type: pick.type, gain, holds, rows: rows.length, cellNm: off, rawBias, rawRmse }
    }
  }

  // ── the summary that answers the question ───────────────────────────────
  console.log(`\n${'='.repeat(78)}\nSUMMARY — gain over raw, %, by station and model`)
  const hdr = ['station'.padEnd(8), ...MODELS.map((m) => m.slice(0, 13).padStart(14))].join('')
  console.log(`  ${hdr}`)
  for (const st of STATIONS) {
    const cells = MODELS.map((m) => {
      const c = chosen[st.id]?.[m] as { gain: number; type: string; holds: boolean } | undefined
      if (!c) return '           —  '
      const mark = c.type === 'raw' ? ' raw' : c.holds ? '' : ' *'
      return `${c.gain.toFixed(1)}%${mark}`.padStart(14)
    })
    console.log(`  ${st.id.padEnd(8)}${cells.join('')}${st.anemM === FIT_Z ? '' : '   (height — report only)'}`)
  }
  console.log('  * = the gain does not hold in every held-out year block.')

  console.log('\nNOTES')
  console.log('  - icon_eu does NOT reach the Pacific. MODELS.ICON in openMeteo.js maps to')
  console.log('    mosModel `icon_eu`, which is correct in Europe and wrong here; a San Juan')
  console.log('    spec must be keyed to a model that actually covers the venue.')
  console.log('  - ncep_nam_conus has no historical-forecast archive here (0 values returned)')
  console.log('    and is not fittable, whatever the app lists.')

  if (!WRITE) { console.log('\nDry run. Re-run with --write to emit the spec.\n'); return }

  const prim = STATIONS.find((s) => s.id === PRIMARY)
  if (!prim) { console.error(`\n--station ${PRIMARY} is not one of the four.`); process.exit(1) }
  if (prim.anemM !== FIT_Z && !REDUCE_10M && !ALLOW_NONSTD) {
    console.error(`\nRefusing to write: ${prim.id}'s anemometer is at ${prim.anemM} m, not ${FIT_Z} m.`)
    console.error('A correction fitted there carries a height term and would push the model\'s')
    console.error('10 m field down by it for ever. Use --station CWZO or --station ORS, or')
    console.error('--allow-nonstandard-height to write it anyway with that recorded in the spec.')
    process.exit(1)
  }
  const models: Record<string, unknown> = {}
  for (const model of MODELS) {
    const c = chosen[prim.id]?.[model] as { type: string; gain: number; holds: boolean } | undefined
    const ladder = results[prim.id]?.[model]
    if (!c || !ladder) continue
    const pick = ladder.find((r) => r.type === c.type)
    if (!pick) continue
    models[model] = c.type === 'raw'
      ? { type: 'raw', not_shipped: `best ladder gain ${c.gain.toFixed(1)}% did not clear the bars` }
      : { ...pick.spec, measured_gain_pct: Number(c.gain.toFixed(1)), holds_every_block: c.holds }
  }
  const spec = {
    venue: venue.key,
    fit_height_m: FIT_Z,
    target_height_m: 30,
    truth_station: `${prim.source}:${prim.id}`,
    truth_station_name: prim.name,
    truth_anemometer_m: prim.anemM,
    obs_height_adjustment: prim.anemM === FIT_Z ? null : REDUCE_10M
      ? {
        from_m: prim.anemM, to_m: FIT_Z, z0_m: WATER_Z0,
        factor: Number(heightFactor(prim.anemM).toFixed(4)),
        method: 'neutral log profile over open water',
        checked_against: 'SISW1/CWZO median ratio 1.089 over 21,818 matched hours vs 1.051 predicted',
      }
      : { applied: false, warning: 'coefficients carry a height term' },
    truth_exposure: prim.exposure,
    truth_nm_from_venue: Number(nmBetween(venue.lat, venue.lon, prim.lat, prim.lon).toFixed(2)),
    fitted_from: FROM,
    fitted_to: TO,
    cell_selection: CELL,
    lead_time: 'short-lead stitched archive; NOT lead-time stratified',
    bands: BANDS,
    corroborating_stations: STATIONS.filter((s) => s.id !== prim.id)
      .map((s) => ({ id: s.id, anemometer_m: s.anemM, shipped: false })),
    models,
  }
  const out = `src/components/weather/mos/mos_${venue.key.replace(/-/g, '_')}.json`
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`\nWrote ${out}`)
  console.log('  NOT SHIPPED until it is registered in SPECS in mos.js — writing the JSON')
  console.log('  does not turn it on.\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
