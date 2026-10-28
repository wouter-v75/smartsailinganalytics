// Fit a MOS wind correction for LONG BEACH / SAN PEDRO, against the two NOAA
// CO-OPS PORTS stations in San Pedro Bay.
//
//   npx vite-node scripts/mos-longbeach-fit.ts                     # dry run, all stations
//   npx vite-node scripts/mos-longbeach-fit.ts -- --write          # writes the spec JSON
//   npx vite-node scripts/mos-longbeach-fit.ts -- --compare        # station-vs-station only
//   npx vite-node scripts/mos-longbeach-fit.ts -- --station 9410665
//   npx vite-node scripts/mos-longbeach-fit.ts -- --from 2023-01-01
//
// Third venue script, and for the same reason as the second: only the
// OBSERVATIONS differ. mos-fit.ts reads MET Norway Frost rows out of
// `wind_observations`; mos-sanjuan-fit.ts reads NDBC and Iowa State; this reads
// NOAA CO-OPS, because the two stations Wouter named are PORTS tide stations
// and are in neither of the other archives. Everything statistical is the SAME
// src/lib/mosFit routines — leave-one-year-out with a buffer, the nested ladder
// raw -> bias_scale -> diurnal -> sector -> sector_diurnal, the
// one-standard-error rule on nEff, the twenty-effective-samples-per-parameter
// gate. A second copy of the statistics would drift; a second copy of a CSV
// parser cannot.
//
// ── THE HEIGHT PROBLEM IS WORSE HERE THAN ANYWHERE ─────────────────────────
//
// Anemometer heights, read off NDBC's own station pages for the two CO-OPS
// stations on 28 Oct 2026:
//
//   9410647  Angels Gate        AGXC1   20.0 m above site elevation
//   9410665  Long Beach Pier J  PRJC1   30.5 m above site elevation
//
// NEITHER IS AT 10 M, so neither can regress against the model's native 10 m
// field without a manufactured height reduction. At the Oslofjord the truth was
// a 10 m lighthouse and no profile was needed; at San Juan one station was at
// 17.4 m and the reduction was 5 %. Here it is 6 % and 9 %.
//
// The size of the reduction is not in itself the worry. A log-profile reduction
// needs a roughness length, and over open water z0 = 0.0002 m is a sound
// mid-range value (CLAUDE.md records that halving or doubling it moves the
// ratio by 0.4 %). Over a container terminal it would be nothing of the kind.
// Reducing 30.5 m -> 10 m:
//
//   z0 = 0.0002 m  (open water)         factor 0.907
//   z0 = 0.1 m     (open industrial)    factor 0.805
//   z0 = 0.5 m     (low obstacles)      factor 0.729
//   z0 = 1.0 m     (stacked containers) factor 0.674
//
// 23 percentage points, 35 % relative. Pier J stands inside the Port of Long
// Beach with container stacks and gantry cranes on three sides, so this script
// was first written predicting that its reduction was badly wrong and that the
// station was unusable.
//
// THAT PREDICTION WAS MEASURED AND IT WAS WRONG. Over 16,303 matched hours,
// with BOTH stations reduced to 10 m by the open-water profile, Pier J /
// Angels Gate comes out at a median ratio of 1.008, sector spread 0.123. If
// Pier J's effective surface were z0 = 0.5 m the open-water reduction would
// under-correct it by about 24 % and that ratio would read ~1.24. It reads
// 1.008. At 30.5 m the anemometer is well above the stacks and its upwind
// fetch is largely harbour water, so open water is in fact the right end of
// the range for BOTH stations — the table above sizes the doubt and the
// station comparison is what resolves it.
//
// ANGELS GATE IS STILL THE PRIMARY, on the reasons that survived:
//   - 1.2 nm from the venue centre against 4.3 nm, and open ocean through the
//     southern half of the compass, which is what a race course looks like;
//   - the height reduction is 6 % rather than 9 %, so less is manufactured;
//   - its raw rmse is the lower of the two for the coarse models and its
//     fitted gains are larger across the board.
// What is NOT a reason any more is the roughness argument, and the tension it
// was invented to resolve is milder than it looked: if the racing is off
// Belmont Shore, Pier J is the closer station and the two agree to 0.8 %
// anyway, so the choice between them barely moves the height term.
//
// KLGB (Long Beach Airport) is fitted as the third station and never shipped.
// It is the only station here that needs NO manufactured height at all — a
// standard 10 m ASOS — so it is the control: if a correction is real it should
// appear there too, in the same direction, with nothing invented. It is 7 nm
// inland in the LA basin, so its MAGNITUDE means little; its SIGN means a lot.
// There is no clean 10 m MARINE station to be had. Checked on 28 Oct 2026:
// CDIP buoys 46222, 46253 and 46221 are wave-only (wind reads MM), 46025 is
// 33 nm offshore in the Santa Monica Basin on a ~4 m mast, and of the other
// CO-OPS stations in the bay only 9410670 Pier F has a wind sensor at all
// (9410660 Los Angeles, which sits at the venue centre, does not).
//
// ── WHICH MODELS, AND WHY NOT THE OTHERS ───────────────────────────────────
//
// Probed against the historical-forecast archive at Angels Gate on 28 Oct 2026:
//
//   gfs_hrrr                72/72   cell 0.74 nm   archive from <=2021
//   ncep_nam_conus          72/72   cell 0.74 nm   archive from ~2025-09 ONLY
//   gfs_global              72/72   cell 2.13 nm   archive from <=2022
//   icon_global             72/72   cell 5.45 nm   archive from ~2023-01
//   ecmwf_ifs025            72/72   cell 12.95 nm  archive from ~2024-02
//   gem_hrdps_continental   ERROR "No data is available for this location"
//
// Two things to carry away from that table, both of which cost a probe:
//
// 1. ncep_nam_conus HAS AN ARCHIVE HERE. It had none at San Juan (0/72), which
//    is why that script excluded it, and it would have been easy to inherit the
//    exclusion. Open-Meteo serves NAM and HRRR on the SAME output lattice, so
//    their `latitude`/`longitude` come back byte-identical and NAM looks like a
//    mirror of HRRR. It is not: over 48 hours only 1 of 48 speeds matched.
//    MODELS.NAM in openMeteo.js carries NO mosModel, so anything fitted for it
//    is inert until that is added — the exact trap mosWiring.test.ts exists for.
// 2. NAM's archive is ~14 months, which is two calendar blocks and no more.
//    Everything else gets 3 to 5. The effective window is therefore PER MODEL
//    and is printed per model, because a gain measured over 2.7 ECMWF years is
//    not comparable with one measured over 4.8 HRRR years and nothing else in
//    the output would say so.
//
// gem_hrdps_continental is absent from the app here too (its coverage box
// starts at 42 N), so that agrees. icon_eu is NOT in the list and must not be:
// it does not reach the Pacific — same note as San Juan, same consequence.
// `best_match` and the `_seamless` splices are excluded for mos-fit's reason:
// a splice's error statistics change character at the seam, so a correction
// fitted to one averages two different models.
//
// CELL SELECTION IS `sea` FOR THE TWO MARINE STATIONS, per CLAUDE.md: Open-Meteo
// defaults to a LAND cell and every MOS number this project measured before
// 27 Oct 2026 was against one. It is `land` for the LGB control, which is an
// inland airport — see `cellSel` on Station for why that is the same rule and
// not an exception to it.
//
// ── WHY interval=h AND NOT THE 6-MINUTE FEED ───────────────────────────────
//
// CO-OPS serves these stations at 6-minute resolution (31 days per request) and
// also hourly via `interval=h` (a whole year per request). Measured over March
// 2025 at Angels Gate before choosing: `interval=h` returns EXACTLY the
// on-the-hour 6-minute sample — 707 of 707 values identical, and it is not an
// hourly mean (it matched the mean of the hour on 45 of 653). Snapping the
// 6-minute feed to the nearest hour, as the San Juan script does for NDBC,
// recovers 741 hours instead of 707: +4.8 % at Angels Gate, +0.1 % at Pier J,
// and the recovered hours are the ones up to 30 minutes off the hour.
//
// So the 6-minute path buys 4.8 % more hours, each with more timing slack
// against an hourly model value, for fourteen times the requests. Not worth it
// on 45,000 hours. `--six-min` switches to it; the default is `interval=h`.
//
// One clock note, because CLAUDE.md warns that everything in this project which
// claims to be UTC is really venue-local: `time_zone=gmt` on this API MEANS
// GMT. It is the exception, and it is only safe to say so because the local
// alternative (`time_zone=lst_ldt`) returns visibly different timestamps.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VENUES } from '../src/lib/venues'
import { nmBetween } from '../src/lib/obsDensity'
import {
  crossValidateForms, selectForm, score, lag1, effectiveN, assignSector,
  piRmse, persistenceRmse, gainHoldsEveryBlock, predictSpecModel,
  yearBlocks, withBuffer, solveOls,
  type Pair, type Band, type FormResult, type MosType, type MosModelSpec,
} from '../src/lib/mosFit'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const SIX_MIN = argv.includes('--six-min')
const ALLOW_NONSTD = argv.includes('--allow-nonstandard-height')
// Bring a non-10 m station's observations to 10 m with a neutral log profile,
// so it can be a regression target for the model's native 10 m field. ON by
// default because the alternative — regressing a 10 m field on a 20 m
// observation — is simply wrong. See the header for why the z0 it assumes is
// defensible at Angels Gate and not at Pier J.
const REDUCE_10M = !argv.includes('--no-reduce-to-10m')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const VENUE_KEY = 'long-beach'
const TZ = flag('tz', 'America/Los_Angeles')!
const CELL = flag('cell-selection', 'sea')!
const FIT_Z = 10
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const KMH_TO_KN = 0.539957
const MS_TO_KN = 1.943844
const MAX_PARAMS = Number(flag('max-params', '7'))
const BUFFER_H = Number(flag('buffer', '48'))
// The tail bars. See applyBars for why these values rather than tuned ones.
const WARN_KEEP = Number(flag('warn-keep', '0.9'))  // keep >= 90 % of raw's detections
const TOP_SLACK = Number(flag('top-slack', '2'))    // kn of allowed degradation at the top bin
const MIN_GAIN_PCT = Number(flag('min-gain', '2'))

/**
 * The bars for one arm. They are PER ARM because the venue's wind is a
 * different animal in the racing season, and a bar set on the year-round
 * distribution is vacuous inside it.
 *
 * Measured at Angels Gate, 10 m, 2022-2026 (`--dist`):
 *
 *            median   p90    p99    max    >=12kn   >=14kn  >=18kn  >=24kn
 *   all        5.7   11.7   16.8   30.5     8.5%     3.0%    0.73%   0.10%
 *   Jun-Sep    6.0   11.9   14.6   18.6     9.7%     1.8%    0.01%   0.00%
 *
 * So the racing season NEVER reaches 20 kn in five years of record and reaches
 * 18 kn once. An 18 kn warning bar inside that window is measured on one hour
 * and a 24 kn error bin on none — which is why the first run of the season arm
 * printed "1 hrs only" and could not judge the thing the bar exists for. The
 * season bars are therefore set at 12 kn (9.7 %, the level at which a day is
 * properly breezy for racing) and 14 kn (1.8 %, 217 hours, the top of the
 * season's range). Both are well populated, and neither is tuned: they are
 * read off the distribution, not off the results.
 */
interface Bars {
  label: string
  threshold: number    // "it will blow this hard" — the warning rate
  topBin: number       // the strong end, whose mean error must not collapse
  minPerBand: number   // hours a sector needs before it earns an offset
}
const YEAR_BARS: Bars = {
  label: 'year-round',
  threshold: Number(flag('threshold', '18')),
  topBin: Number(flag('top-bin', '24')),
  minPerBand: Number(flag('min-per-band', '400')),
}
// N is 3.8 % of season hours against 15.6 % year-round — the summer wind
// collapses onto the sea-breeze quadrant (W 58 %, S 27 %). So the season's
// per-band floor is scaled down with the arm, or the sector term the brief
// asked for is refused outright for want of a northerly. Per-band counts are
// printed so a thinly-supported offset is visible rather than implied.
const SEASON_BARS: Bars = {
  label: 'racing-season',
  threshold: Number(flag('season-threshold', '12')),
  topBin: Number(flag('season-top-bin', '14')),
  minPerBand: Number(flag('season-min-per-band', '150')),
}
// THE RACING SEASON. Olympic sailing 2028 and the Transpac start are June to
// September, so that window is fitted as its own arm and compared with the
// year-round one ON THE SAME HELD-OUT HOURS — mos-fit.ts's rule, and it must
// beat it by more than one standard error to be stored.
const SEASON_MONTHS = (flag('months', '6,7,8,9')!).split(',').map(Number).filter(Number.isFinite)
const SEASON_LABEL = flag('season-label', 'racing-season')!

// 2022-01-01 keeps parity with the San Juan fit. The models' own archives start
// anywhere from 2021 to 2025-09 (see the header), so the EFFECTIVE window is
// per model and is reported as such.
const FROM = flag('from', '2022-01-01')!
const TO = flag('to', new Date().toISOString().slice(0, 10))!

// Four 90-degree bands, as everywhere else in this project: narrower is
// spurious resolution for a direction field read nearest-neighbour off a
// 3-25 km grid.
const BANDS: Band[] = [
  ['N', 315, 45],
  ['E', 45, 135],
  ['S', 135, 225],
  ['W', 225, 315],
]

const MODELS = (flag('models',
  'gfs_hrrr,ncep_nam_conus,gfs_global,icon_global,ecmwf_ifs025')!)
  .split(',').map((s) => s.trim()).filter(Boolean)

interface Station {
  id: string
  name: string
  lat: number
  lon: number
  /** Anemometer height above the site, metres, off the operator's own metadata. */
  anemM: number
  source: 'coops' | 'iem'
  /** IEM network, for the aviation station. */
  network?: string
  /**
   * Roughness length, metres, of the surface the anemometer actually stands
   * over. The height reduction's honesty rests entirely on this, so it is a
   * declared field rather than a constant: see `heightFactor`.
   */
  siteZ0: number
  exposure: string
  /** False for a station that is fitted for corroboration and never shipped. */
  shippable: boolean
  /**
   * Open-Meteo `cell_selection` for THIS station, and it is not one setting for
   * the venue.
   *
   * CLAUDE.md's rule is `sea`, because the default `land` picks a cell on land
   * for a marine point and every MOS number this project measured before
   * 27 Oct 2026 was against one. That rule is about a point ON THE WATER. LGB
   * is an airport 7 nm inland, and asking for its nearest SEA cell fetches a
   * cell 8 nm (gfs_global) to 19 nm (ecmwf_ifs025) offshore — which is how the
   * first run of this script produced a 46 % "gain" at the control station and
   * +2.5 kn biases that were mostly the cell being in the wrong place. A
   * control that is confounded by the fetch cannot corroborate anything, so
   * the land station asks for a land cell. Same principle, opposite answer:
   * fetch the cell that represents the station.
   */
  cellSel: 'sea' | 'land'
}

// Positions off the operators' metadata APIs; anemometer heights off NDBC's
// station pages for the same stations (the CO-OPS sensors.json returns
// `elevation: null` for all of them, so it cannot be the source). 28 Oct 2026.
const STATIONS: Station[] = [
  {
    id: '9410647', name: 'Angels Gate', lat: 33.71583, lon: -118.24611, anemM: 20,
    source: 'coops', siteZ0: 0.0002, shippable: true, cellSel: 'sea',
    exposure: 'marine — San Pedro breakwater light at the harbour entrance, '
      + 'open ocean through the southern half of the compass',
  },
  {
    // siteZ0 is 0.0002 and NOT 0.5, which is where it started. The siting says
    // 0.5 — container stacks on three sides — but the measurement says
    // otherwise: reduced to 10 m by the open-water profile this station agrees
    // with Angels Gate to 0.8 % over 16,303 hours, which a 0.5 m surface could
    // not do. 30.5 m is above the roughness. See the header.
    id: '9410665', name: 'Long Beach Pier J', lat: 33.733, lon: -118.18569, anemM: 30.5,
    source: 'coops', siteZ0: 0.0002, shippable: false, cellSel: 'sea',
    exposure: 'port — inside the Port of Long Beach, container stacks and '
      + 'gantry cranes on three sides, but the anemometer is 30.5 m up and '
      + 'behaves like open water (measured)',
  },
  {
    id: 'LGB', name: 'Long Beach Airport', lat: 33.8118, lon: -118.1472, anemM: 10,
    source: 'iem', network: 'CA_ASOS', siteZ0: 0.03, shippable: false, cellSel: 'land',
    exposure: 'land — airport 7 nm inland in the LA basin; the 10 m CONTROL, '
      + 'fitted with no height adjustment of any kind',
  },
]

const PRIMARY = flag('station', '9410647')!

// ── caching ────────────────────────────────────────────────────────────────
// Five years of hourly obs for three stations and five models' archives at
// three positions, and Open-Meteo bills PER LOCATION, so nothing is fetched
// twice. Cache lives in TMPDIR, like the other two fitting scripts'.
const CACHE = join(process.env.TMPDIR || tmpdir(), 'ssa-mos-longbeach-cache')
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  const p = join(CACHE, `${key.replace(/[^\w.-]/g, '_')}.txt`)
  if (existsSync(p)) return readFileSync(p, 'utf8')
  const body = await fetcher()
  writeFileSync(p, body)
  return body
}

async function get(url: string, tries = 3): Promise<string> {
  let last: Error | null = null
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.text()
    } catch (e) {
      // The CO-OPS datagetter truncates mid-body often enough to matter — a
      // year request died with `IncompleteRead(261490 bytes read, 17651 more
      // expected)` while this script was being written. A truncated body must
      // never reach the cache, so the retry lives below the cache, not above
      // it, and a parse that silently loses the tail of a year would be
      // indistinguishable from a quiet month.
      last = e as Error
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)))
    }
  }
  throw new Error(`${last?.message} for ${url.slice(0, 110)}`)
}

/** One observation: speed in knots at the station's own anemometer height. */
interface Obs { kn: number; dir: number | null }

/** Errors the CO-OPS datagetter returns deterministically for a bad range. */
const COOPS_EMPTY = /No data was found|Wrong Date|Range Limit Exceeded|No Wind data was found/i

/**
 * NOAA CO-OPS PORTS wind, a year at a time via `interval=h`.
 *
 * `units=metric` gives SPEED IN M/S — checked against `units=english` on the
 * same three samples (5.6 -> 10.89, ratio 1.944), because the API documents
 * neither and a silent knots/metres mix-up is a 2x error that looks like a
 * terrible model rather than a unit bug.
 *
 * Columns: `Date Time, Speed, Direction, Direction, Gust, X, R`. X and R are
 * the max-expected-value and rate-of-change flags; both were 0 on every row of
 * every probe, but a flagged row is dropped rather than trusted.
 */
async function loadCoops(st: Station): Promise<Map<number, Obs>> {
  const out = new Map<number, Obs>()
  const samples: Array<{ ms: number; kn: number; dir: number | null }> = []
  const y0 = Number(FROM.slice(0, 4))
  const y1 = Number(TO.slice(0, 4))
  for (let y = y0; y <= y1; y++) {
    const start = (y === y0 ? FROM : `${y}-01-01`).replace(/-/g, '')
    const end = (y === y1 ? TO : `${y}-12-31`).replace(/-/g, '')
    // 6-minute data is capped at 31 days per request; hourly is not.
    const chunks: Array<[string, string]> = SIX_MIN
      ? monthChunks(y === y0 ? FROM : `${y}-01-01`, y === y1 ? TO : `${y}-12-31`)
      : [[start, end]]
    for (const [a, b] of chunks) {
      const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
        + `?product=wind&station=${st.id}&begin_date=${a}&end_date=${b}`
        + `&time_zone=gmt&units=metric&format=csv${SIX_MIN ? '' : '&interval=h'}`
      const body = await cached(`coops_${st.id}_${a}_${b}${SIX_MIN ? '_6min' : ''}`, async () => {
        const t = await get(url)
        if (!t.startsWith('Date Time') && !COOPS_EMPTY.test(t)) {
          // Not a header and not a known refusal: something new, and caching
          // it would make the mystery permanent.
          throw new Error(`unrecognised CO-OPS body: ${t.slice(0, 120).replace(/\s+/g, ' ')}`)
        }
        return t
      })
      if (!body.startsWith('Date Time')) continue
      for (const line of body.split('\n')) {
        if (!line || line.startsWith('Date Time')) continue
        const c = line.split(',')
        if (c.length < 7) continue
        const sp = Number(c[1])
        if (!Number.isFinite(sp) || !c[1].trim()) continue
        if (c[5].trim() === '1' || c[6].trim() === '1') continue        // flagged
        const ms = Date.parse(`${c[0].trim().replace(' ', 'T')}:00Z`)   // time_zone=gmt
        if (!Number.isFinite(ms)) continue
        const d = Number(c[2])
        samples.push({ ms, kn: sp * MS_TO_KN, dir: Number.isFinite(d) ? d : null })
      }
    }
  }
  if (SIX_MIN) return snapHourly(samples)
  for (const s of samples) {
    if (s.kn < 0 || s.kn > 150) continue
    out.set(s.ms, { kn: s.kn, dir: s.dir })
  }
  return out
}

/** 31-day windows covering [a, b], for the --six-min path. */
function monthChunks(a: string, b: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let cur = Date.parse(`${a}T00:00:00Z`)
  const end = Date.parse(`${b}T00:00:00Z`)
  while (cur <= end) {
    const stop = Math.min(cur + 30 * 86400_000, end)
    const f = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')
    out.push([f(cur), f(stop)])
    cur = stop + 86400_000
  }
  return out
}

/**
 * Snap sub-hourly reports onto the hour: nearest report within +-30 min, the
 * closest to the hour winning. Only used by --six-min; the default
 * `interval=h` path already is the on-the-hour sample. Identical rule to the
 * San Juan script's, so the two venues' observations mean the same thing.
 */
function snapHourly(samples: Array<{ ms: number; kn: number; dir: number | null }>): Map<number, Obs> {
  const best = new Map<number, { o: Obs; off: number }>()
  for (const s of samples) {
    if (!Number.isFinite(s.ms) || !Number.isFinite(s.kn) || s.kn < 0 || s.kn > 150) continue
    const hour = Math.round(s.ms / 3600_000) * 3600_000
    const off = Math.abs(s.ms - hour)
    if (off > 30 * 60_000) continue
    const cur = best.get(hour)
    if (!cur || off < cur.off) best.set(hour, { o: { kn: s.kn, dir: s.dir }, off })
  }
  return new Map(Array.from(best.entries()).map(([k, v]) => [k, v.o]))
}

/** IEM mirror of the ASOS/AWOS archives. Speeds already in knots. */
async function loadIem(st: Station): Promise<Map<number, Obs>> {
  const samples: Array<{ ms: number; kn: number; dir: number | null }> = []
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
      if (c.length < 4) continue
      const kn = Number(c[2])
      if (!Number.isFinite(kn)) continue                 // 'M' -> NaN, dropped
      const d = Number(c[3])
      samples.push({ ms: Date.parse(`${c[1].replace(' ', 'T')}:00Z`), kn, dir: Number.isFinite(d) ? d : null })
    }
  }
  return snapHourly(samples)
}

/**
 * Observations for one station, CLIPPED TO THE FIT WINDOW and reduced to 10 m.
 *
 * The clip matters for the same reason it did at San Juan: the archives are
 * published in whole years, so without it the printed counts and the
 * lag-1/nEff line — which is the number the parameter gate is argued from —
 * would describe a different span from the one that was fitted.
 */
async function loadObs(st: Station): Promise<Map<number, Obs>> {
  const all = st.source === 'coops' ? await loadCoops(st) : await loadIem(st)
  const lo = Date.parse(`${FROM}T00:00:00Z`)
  const hi = Date.parse(`${TO}T23:59:59Z`)
  const win = new Map(Array.from(all.entries()).filter(([ms]) => ms >= lo && ms <= hi))
  if (!REDUCE_10M || st.anemM === FIT_Z) return win
  const f = heightFactor(st.anemM, WATER_Z0)
  return new Map(Array.from(win.entries()).map(([ms, o]) => [ms, { kn: o.kn * f, dir: o.dir }]))
}

/**
 * Neutral log-profile factor from a station's anemometer height to 10 m.
 *
 * THIS MANUFACTURES AN OBSERVATION, which mos-fit's header refuses to do, and
 * the reason it is tolerable here is the same as at San Juan and no stronger:
 * the adjustment is small and one-signed, and the alternative — regressing a
 * 10 m model field on a 20 m anemometer — bakes the whole height difference
 * into the correction instead.
 *
 * `WATER_Z0` is what the REDUCTION uses, for every station, because an
 * open-water profile is the only one with a defensible single value. The
 * station's own `siteZ0` is NOT used to reduce it — it is used to SIZE THE
 * DOUBT, printed as a sensitivity table. The table is only half the argument,
 * and on its own it pointed the wrong way: it says the choice of z0 could move
 * Pier J by 23 percentage points, which is why this script first refused that
 * station outright. `--compare` is the other half, and it showed the two
 * stations agree to 0.8 % under the open-water reduction, so open water is the
 * right end of the range for both. Size the doubt, then measure it.
 */
const WATER_Z0 = 0.0002
function heightFactor(anemM: number, z0: number): number {
  return Math.log(FIT_Z / z0) / Math.log(anemM / z0)
}

// ── THE CONSTRAINED LADDER: SECTOR AND DIURNAL AT UNIT SLOPE ───────────────
//
// Why there is a second ladder at all, when mosFit's is the house method.
//
// The standard forms all fit `a·x + b` and put the sector or diurnal offsets
// on its residual. OLS chooses `a = cov(x,y)/var(x)`, so the weaker a model's
// correlation with the station, the harder it pulls the forecast toward the
// mean — and because rmse is minimised by exactly that shrinkage, the ladder
// REWARDS it. At Long Beach that is not a rounding effect:
//
//   model            a      30 kn raw becomes     gain the ladder reports
//   gfs_hrrr       0.769          26.5 kn                13.4 %
//   ncep_nam       0.755          27.6 kn                24.0 %
//   gfs_global     0.573          21.2 kn                17.8 %
//   icon_global    0.529          21.0 kn                22.3 %
//   ecmwf_ifs025   0.400          18.0 kn                29.9 %
//
// Measured at Angels Gate over the hours the station really had >= 18 kn, the
// corrected forecast warns on FEWER of them than the raw one in every case:
// 50 % -> 29 % (hrrr), 28 % -> 11 % (nam), 75 % -> 24 % (gfs), 70 % -> 16 %
// (icon) and 66 % -> ZERO (ecmwf, 0 of 130). Mean error in the 24 kn+ bin goes
// from roughly unbiased raw (+1.7, +0.5, -2.2 for the three coarse models) to
// -8.0, -8.8 and -12.6 kn corrected.
//
// So rmse and "holds in every block" are not sufficient bars for a SAILING
// forecast. Being 3 kn out on a 12 kn afternoon is a nuisance; failing to say
// it will blow 25 is a decision about whether to leave the dock. A correction
// that cannot produce a strong wind is worse than no correction, whatever its
// rmse says.
//
// The fix is the standard one in the post-processing literature and it is not
// exotic: stop fitting the slope. Pin a = 1 and fit ONLY the offsets — the
// bias, the four-band SECTOR offsets and the 24 h DIURNAL harmonic. The
// forecast's range is then preserved by construction, and what the fit can
// still do is move it around in time and direction, which at a sea-breeze
// venue is most of what was wrong with it anyway.
//
// NOTHING IN THE APP CHANGES. predictSpecModel computes
// `base = (m.a ?? 1)·ws + (m.b ?? 0)`, and applyMOS in mos.js mirrors it term
// for term, so a spec carrying `a: 1` with an ordinary `sector_diurnal` type is
// applied correctly by code that already exists. That is deliberate: inventing
// a new `type` string would mean mos.js had to learn it, and a type it did not
// know would fall through to raw SILENTLY — the exact class of failure this
// project keeps paying for. The constrained forms exist in the FITTING only
// and are written out as the existing types with the slope pinned.
//
// The statistics are mosFit's own primitives — yearBlocks, withBuffer,
// solveOls, score, piRmse, effectiveN — so the protocol is identical to the
// standard ladder: leave one year out with a 48 h buffer, pooled out-of-sample
// scores, per-block gains, the one-standard-error rule and twenty effective
// samples per parameter. Only the design matrix and the bars differ.

/** Constrained forms. Each is written out as an ORDINARY type with a = 1. */
type ConstrainedType = 'offset' | 'offset_diurnal' | 'offset_sector' | 'offset_sector_diurnal'

const CONSTRAINED_LADDER: ConstrainedType[] = [
  'offset', 'offset_diurnal', 'offset_sector', 'offset_sector_diurnal',
]

const STORED_AS: Record<ConstrainedType, MosType> = {
  offset: 'bias_scale',
  offset_diurnal: 'diurnal',
  offset_sector: 'sector',
  offset_sector_diurnal: 'sector_diurnal',
}

const SEC_NAMES = BANDS.map(([n]) => n)
// The LAST band is the reference and keeps delta 0, matching what mosFit's own
// sector fit emits (every shipped spec shows `"W": 0`). Choosing a different
// reference changes only how b and the deltas split, not the prediction, but
// agreeing with the house convention makes the two ladders comparable by eye.
const REF_SEC = SEC_NAMES[SEC_NAMES.length - 1]

const hasDiurnal = (f: ConstrainedType) => f === 'offset_diurnal' || f === 'offset_sector_diurnal'
const hasSector = (f: ConstrainedType) => f === 'offset_sector' || f === 'offset_sector_diurnal'

function constrainedParams(f: ConstrainedType): number {
  return 1 + (hasDiurnal(f) ? 2 : 0) + (hasSector(f) ? Math.max(0, BANDS.length - 1) : 0)
}

/** One row of the design matrix, or null when this row cannot inform this form. */
function designRow(f: ConstrainedType, r: Pair): number[] | null {
  const cols: number[] = [1]
  if (hasDiurnal(f)) {
    if (r.hour == null || !Number.isFinite(r.hour)) return null
    const ang = (2 * Math.PI * r.hour) / 24
    cols.push(Math.sin(ang), Math.cos(ang))
  }
  if (hasSector(f)) {
    if (r.twd == null || !Number.isFinite(r.twd)) return null
    const sec = assignSector(r.twd, BANDS)
    for (const n of SEC_NAMES) { if (n !== REF_SEC) cols.push(sec === n ? 1 : 0) }
  }
  return cols
}

/** Turn solved coefficients into a spec of an EXISTING type, slope pinned to 1. */
function buildConstrainedSpec(f: ConstrainedType, coef: readonly number[]): MosModelSpec {
  let i = 0
  const b = coef[i++]
  let c1 = 0; let c2 = 0
  if (hasDiurnal(f)) { c1 = coef[i++]; c2 = coef[i++] }
  const delta: Record<string, number> = {}
  if (hasSector(f)) for (const n of SEC_NAMES) delta[n] = n === REF_SEC ? 0 : coef[i++]
  const spec: MosModelSpec = { type: STORED_AS[f], a: 1, b }
  if (hasDiurnal(f)) { spec.c0 = 0; spec.c1 = c1; spec.c2 = c2 }
  if (hasSector(f)) { spec.delta = delta; spec.global = 0 }
  return spec
}

/** Fit one constrained form: regress (obs - model) on the offsets, slope 1. */
function fitConstrained(f: ConstrainedType, rows: readonly Pair[], bars: Bars): MosModelSpec | null {
  const X: number[][] = []; const y: number[] = []
  for (const r of rows) {
    const d = designRow(f, r)
    if (!d) continue
    X.push(d); y.push(r.obs - r.model)      // the slope IS 1, so this is the target
  }
  if (X.length < 200) return null
  if (hasSector(f)) {
    // A band with almost nothing in it gives an offset fitted on noise and then
    // applies it to every future forecast from that direction.
    const per = new Map<string, number>()
    for (const r of rows) {
      if (r.twd == null) continue
      const s = assignSector(r.twd, BANDS)
      per.set(s, (per.get(s) ?? 0) + 1)
    }
    for (const n of SEC_NAMES) if ((per.get(n) ?? 0) < bars.minPerBand) return null
  }
  const coef = solveOls(X, y)
  return coef ? buildConstrainedSpec(f, coef) : null
}

interface TailStat {
  nAbove: number; warnRaw: number; warnCor: number
  topN: number; topRaw: number; topCor: number
}

/**
 * Tail statistics on OUT-OF-SAMPLE predictions.
 *
 * `warn` counts the hours the station really had >= bars.threshold where the
 * forecast also said so. A hit count, not a skill score, on purpose:
 * the operational question is how many of the windy hours you were told about,
 * and rmse is blind to it.
 */
function tailStats(
  obs: readonly number[], raw: readonly number[], cor: readonly number[], bars: Bars,
): TailStat {
  let nAbove = 0; let warnRaw = 0; let warnCor = 0
  let topN = 0; let topRaw = 0; let topCor = 0
  for (let i = 0; i < obs.length; i++) {
    if (obs[i] >= bars.threshold) {
      nAbove++
      if (raw[i] >= bars.threshold) warnRaw++
      if (cor[i] >= bars.threshold) warnCor++
    }
    if (obs[i] >= bars.topBin) { topN++; topRaw += raw[i] - obs[i]; topCor += cor[i] - obs[i] }
  }
  return {
    nAbove, warnRaw, warnCor, topN,
    topRaw: topN ? topRaw / topN : NaN,
    topCor: topN ? topCor / topN : NaN,
  }
}

/** Pooled out-of-sample predictions, kept so an arm can be re-scored on a subset. */
interface Pooled { t: number[]; month: number[]; obs: number[]; raw: number[]; cor: number[] }

interface ConstrainedResult {
  type: ConstrainedType
  storedType: MosType
  spec: MosModelSpec
  cv: ReturnType<typeof score> & { nEff: number }
  params: number
  perBlock: Array<{ label: string; n: number; rmse: number; rawRmse: number; piRmse: number }>
  tail: TailStat
  pooled: Pooled
  refused?: string
}

const emptyPooled = (): Pooled => ({ t: [], month: [], obs: [], raw: [], cor: [] })

/** Leave-one-year-out CV of the constrained ladder, mirroring mosFit's protocol. */
function cvConstrained(
  rows: readonly Pair[], bars: Bars,
): { blocks: number; results: ConstrainedResult[] } {
  const blocks = yearBlocks(rows, 2000)
  if (blocks.length < 2) return { blocks: blocks.length, results: [] }
  const results: ConstrainedResult[] = []
  for (const f of CONSTRAINED_LADDER) {
    const pooled = emptyPooled()
    const perBlock: ConstrainedResult['perBlock'] = []
    let failed: string | null = null
    for (let bi = 0; bi < blocks.length; bi++) {
      const test = blocks[bi]
      const testT = new Set(test.map((r: Pair) => r.t))
      const pool = rows.filter((r: Pair) => !testT.has(r.t))
      const train = withBuffer(pool, test, BUFFER_H * 3600_000)
      const spec = fitConstrained(f, train, bars)
      if (!spec) {
        failed = `block ${bi + 1}: a sector had fewer than ${bars.minPerBand} hours in training`
        break
      }
      for (const r of test) {
        const p = predictSpecModel(spec, r.model, r.twd, r.hour, BANDS)
        pooled.t.push(r.t); pooled.month.push(r.month ?? NaN)
        pooled.obs.push(r.obs); pooled.raw.push(r.model)
        pooled.cor.push(Number.isFinite(p) ? p : r.model)
      }
      const cor = test.map((r: Pair) => {
        const p = predictSpecModel(spec, r.model, r.twd, r.hour, BANDS)
        return Number.isFinite(p) ? p : r.model
      })
      const obs = test.map((r: Pair) => r.obs); const raw = test.map((r: Pair) => r.model)
      const sc = score(cor, obs); const rawSc = score(raw, obs)
      perBlock.push({
        label: `${new Date(test[0].t).getUTCFullYear()}`,
        n: test.length, rmse: sc.rmse, rawRmse: rawSc.rmse, piRmse: piRmse(sc.rmse, rawSc.rmse),
      })
    }
    const params = constrainedParams(f)
    if (failed) {
      results.push({
        type: f, storedType: STORED_AS[f], spec: { type: STORED_AS[f] }, params,
        cv: { ...score([0, 1], [0, 1]), nEff: 0 }, perBlock: [],
        tail: tailStats([], [], [], bars), pooled: emptyPooled(), refused: failed,
      })
      continue
    }
    const sc = score(pooled.cor, pooled.obs)
    const r1 = lag1(pooled.cor.map((v, i) => v - pooled.obs[i]))
    // The spec that SHIPS is fitted on the whole series; CV only chooses the form.
    const full = fitConstrained(f, rows, bars)
    results.push({
      type: f, storedType: STORED_AS[f], params,
      spec: full ?? { type: STORED_AS[f] },
      cv: { ...sc, nEff: effectiveN(pooled.cor.length, r1) },
      perBlock, pooled,
      tail: tailStats(pooled.obs, pooled.raw, pooled.cor, bars),
      refused: full ? undefined : 'could not be fitted on the full series',
    })
  }
  return { blocks: blocks.length, results }
}

/**
 * The bars, applied in order. Returns the chosen form, or null for raw.
 *
 * 1. GAIN: pooled out-of-sample rmse must beat raw by MIN_GAIN_PCT — the same
 *    bar mos-fit.ts enforces, and for the same reason: a 1 % gain is not worth
 *    a stored coefficient.
 * 2. STATIONARITY: the gain must hold in EVERY held-out block, not on average.
 * 3. SAMPLE: twenty effective samples per parameter, measured on nEff.
 * 4. THE TAIL, which is new and is what disqualifies every slope-fitting form
 *    at this venue: the form must keep at least WARN_KEEP of the strong-wind
 *    hours raw caught, and must not worsen the bars.topBin+ mean error by more
 *    than TOP_SLACK knots. The thresholds sit where the measurement leaves a
 *    wide margin rather than being tuned to it — the constrained forms land at
 *    0.97-1.29 of raw's warning count and the OLS forms at 0.00-0.64, so 0.90
 *    separates them with nothing close to the line.
 */
function applyBars(
  results: readonly ConstrainedResult[], rawRmse: number,
): ConstrainedResult | null {
  const usable = results.filter((r) => !r.refused && Number.isFinite(r.cv.rmse))
  const passing = usable.filter((r) => {
    if (piRmse(r.cv.rmse, rawRmse) < MIN_GAIN_PCT) return false
    if (!r.perBlock.length || r.perBlock.some((b) => b.piRmse <= 0)) return false
    if (r.params > 0 && r.cv.nEff / r.params < 20) return false
    const t = r.tail
    if (t.nAbove >= 20 && t.warnCor < WARN_KEEP * t.warnRaw) return false
    if (t.topN >= 10 && Number.isFinite(t.topCor) && t.topCor < t.topRaw - TOP_SLACK) return false
    return true
  })
  if (!passing.length) return null
  const best = passing.reduce((p, q) => (q.cv.rmse < p.cv.rmse ? q : p))
  const se = best.cv.rmse / Math.sqrt(2 * Math.max(2, best.cv.nEff))
  const within = passing.filter((r) => r.cv.rmse <= best.cv.rmse + se)
  return within.reduce((p, q) => (q.params < p.params ? q : p))
}

/** Why a slope-fitting form was refused, in the same vocabulary as the bars. */
function tailVerdict(t: TailStat, bars: Bars): string {
  if (t.nAbove < 20) return `too few hours >= ${bars.threshold} kn (${t.nAbove}) to judge the tail`
  const keep = t.warnRaw ? t.warnCor / t.warnRaw : NaN
  const ok = keep >= WARN_KEEP && (t.topN < 10 || t.topCor >= t.topRaw - TOP_SLACK)
  return `${ok ? 'PASSES' : 'FAILS'} the tail bar — keeps ${(100 * keep).toFixed(0)}% of raw's`
    + ` >=${bars.threshold} kn hits (${t.warnCor}/${t.warnRaw})`
    + (t.topN >= 10 ? `, ${bars.topBin}+ err ${t.topCor.toFixed(1)} vs raw ${t.topRaw.toFixed(1)} kn` : '')
}

function printConstrained(
  results: readonly ConstrainedResult[], rawRmse: number, bars: Bars, indent = '    ',
) {
  console.log(`${indent}CONSTRAINED (a = 1) — bias, SECTOR and DIURNAL offsets, range preserved`)
  console.log(`${indent}form                    params  cv rmse    gain  every-blk`
    + `      warn>=${bars.threshold}kn   ${bars.topBin}+ err (raw)`)
  for (const r of results) {
    if (r.refused) {
      console.log(`${indent}${r.type.padEnd(23)} ${String(r.params).padStart(6)}  REFUSED — ${r.refused}`)
      continue
    }
    const gain = piRmse(r.cv.rmse, rawRmse)
    const holds = r.perBlock.length > 0 && r.perBlock.every((b) => b.piRmse > 0)
    const t = r.tail
    const warn = t.nAbove >= 20
      ? `${t.warnCor}/${t.warnRaw} of ${t.nAbove}`.padStart(17)
      : `${t.nAbove} hrs only`.padStart(17)
    const top = t.topN >= 10 ? `${t.topCor.toFixed(1)} (${t.topRaw.toFixed(1)})` : '—'
    console.log(`${indent}${r.type.padEnd(23)} ${String(r.params).padStart(6)}`
      + `  ${f2(r.cv.rmse)}  ${gain.toFixed(1).padStart(5)}%     ${holds ? 'yes' : ' NO'}`
      + `  ${warn}   ${top}`)
  }
}

/** Re-score an arm's pooled out-of-sample predictions on a subset of months. */
function scoreOnMonths(p: Pooled, months: readonly number[], bars: Bars) {
  const idx: number[] = []
  for (let i = 0; i < p.month.length; i++) if (months.includes(p.month[i])) idx.push(i)
  if (idx.length < 200) return null
  const obs = idx.map((i) => p.obs[i]); const cor = idx.map((i) => p.cor[i])
  const raw = idx.map((i) => p.raw[i])
  const sc = score(cor, obs)
  const r1 = lag1(cor.map((v, k) => v - obs[k]))
  return {
    n: idx.length, rmse: sc.rmse, rawRmse: score(raw, obs).rmse,
    nEff: effectiveN(idx.length, r1), tail: tailStats(obs, raw, cor, bars),
  }
}

interface Cell { lat: number; lon: number }

/** Archived forecasts for one model at one position, a year at a time. */
async function loadModel(model: string, lat: number, lon: number, cellSel: string = CELL) {
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
      + `&models=${encodeURIComponent(model)}&cell_selection=${encodeURIComponent(cellSel)}`
    // cellSel is IN THE CACHE KEY. It changes which cell comes back, so a
    // cached body from the other setting is a different measurement.
    const body = await cached(
      `om_${model}_${lat.toFixed(4)}_${lon.toFixed(4)}_${y}_${cellSel}`, () => get(url))
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

/**
 * Pair obs with model on the hour.
 *
 * `twd` on the Pair is the MODEL's direction, not the observed one, even though
 * CO-OPS gives both. That is deliberate and it is not a shortcut: the sector a
 * correction is looked up by has to be knowable at forecast time, and at
 * forecast time there is no observation. The observed direction is used only
 * in --compare, where the question is about the sites rather than the forecast.
 */
function pairUp(obs: Map<number, Obs>, mod: Map<number, { ws: number; twd: number | null }>): Pair[] {
  const rows: Pair[] = []
  for (const [ms, o] of Array.from(obs.entries())) {
    const m = mod.get(ms)
    if (!m) continue
    if (!(o.kn >= 0) || !(m.ws >= 0)) continue
    const lp = localParts(ms, TZ)
    rows.push({ t: ms, model: m.ws, obs: o.kn, twd: m.twd, hour: lp.hour, month: lp.month })
  }
  return rows.sort((a, b) => a.t - b.t)
}

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '   -')
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '    -')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function printLadder(results: readonly FormResult[], indent = '    ') {
  const raw = results.find((r) => r.type === 'raw')
  console.log(`${indent}form            params    cv rmse   cv bias     nEff   gain   every-block`)
  for (const r of results) {
    if (r.refused) {
      console.log(`${indent}${r.type.padEnd(15)} ${String(r.params).padStart(6)}    REFUSED — ${r.refused}`)
      continue
    }
    // piRmse ALREADY returns a percentage.
    const gain = raw ? piRmse(r.cv.rmse, raw.cv.rmse) : NaN
    console.log(`${indent}${r.type.padEnd(15)} ${String(r.params).padStart(6)}`
      + `    ${f2(r.cv.rmse)}    ${f2(r.cv.bias).padStart(6)}  ${r.cv.nEff.toFixed(0).padStart(7)}`
      + `  ${gain.toFixed(1).padStart(5)}%   ${r.type === 'raw' ? '-' : gainHoldsEveryBlock(r) ? 'yes' : 'NO'}`)
  }
}

/** What the height reduction would be under four plausible roughness lengths. */
function printZ0Sensitivity() {
  const z0s: Array<[string, number]> = [
    ['open water   0.0002', 0.0002],
    ['open industrial 0.1', 0.1],
    ['low obstacles   0.5', 0.5],
    ['containers      1.0', 1.0],
  ]
  console.log('\nHEIGHT REDUCTION SENSITIVITY TO z0 — the reason Angels Gate ships and Pier J does not')
  console.log(`  ${'surface'.padEnd(22)}${STATIONS.filter((s) => s.anemM !== FIT_Z)
    .map((s) => `${s.id} (${s.anemM} m)`.padStart(20)).join('')}`)
  for (const [label, z0] of z0s) {
    console.log(`  ${label.padEnd(22)}${STATIONS.filter((s) => s.anemM !== FIT_Z)
      .map((s) => heightFactor(s.anemM, z0).toFixed(3).padStart(20)).join('')}`)
  }
  const spread = (anemM: number) => Math.abs(heightFactor(anemM, 1.0) - heightFactor(anemM, 0.0002))
  console.log(`  ${'spread over that range'.padEnd(22)}${STATIONS.filter((s) => s.anemM !== FIT_Z)
    .map((s) => `${(100 * spread(s.anemM)).toFixed(0)} %`.padStart(20)).join('')}`)
  console.log('  Only the FIRST row is applied. The rest size the DOUBT; the station-vs-station')
  console.log('  ratio under --compare is what RESOLVES it, and it says open water is right for')
  console.log('  both: reduced to 10 m the two agree to 0.8 %, where a 0.5 m surface at Pier J')
  console.log('  would have left them 24 % apart.')
}

/**
 * Station against station, on matched hours — the measurement that separates
 * HEIGHT from EXPOSURE, and here also from ROUGHNESS.
 *
 * A pure height difference is a roughly CONSTANT RATIO across sectors, because
 * the log profile scales. An exposure or roughness difference is DIRECTIONAL.
 * So the ratio is printed per sector and the SPREAD is the diagnostic.
 *
 * Direction here is the OBSERVED direction at the reference station, which the
 * CO-OPS feed supplies — the San Juan version had to borrow a model's, because
 * neither NDBC nor IEM gave it for those stations.
 */
async function compareStations() {
  const obs = new Map<string, Map<number, Obs>>()
  for (const st of STATIONS) {
    try { obs.set(st.id, await loadObs(st)) } catch (e) {
      console.log(`  ${st.id}: obs failed — ${(e as Error).message}`)
    }
  }
  console.log(`\n${'='.repeat(78)}\nSTATION vs STATION — matched hours, ratio of observed speeds`)
  console.log('  Both series are already reduced to 10 m, so a ratio near 1.000 means the')
  console.log('  reduction reconciled them and a departure is site, not height.')
  console.log('  Direction is the OBSERVED direction at the first station of each pair.\n')
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
        // Below 4 kn a ratio is dominated by the instruments' own starting
        // threshold and by calms that are not the same calm at two sites.
        if (!b || a.kn < 4 || b.kn < 4) continue
        const r = b.kn / a.kn
        all.push(r)
        if (a.dir != null) {
          const sec = assignSector(a.dir, BANDS)
          if (!bySec.has(sec)) bySec.set(sec, [])
          bySec.get(sec)!.push(r)
        }
      }
      if (all.length < 500) {
        console.log(`  ${sb.id}/${sa.id}: only ${all.length} matched hours above 4 kn — skipped.`)
        continue
      }
      const med = (x: number[]) => { const q = [...x].sort((m, n) => m - n); return q[Math.floor(q.length / 2)] }
      const secs = BANDS.map(([n]) => n)
      const vals = secs.map((n) => ((bySec.get(n)?.length ?? 0) >= 200 ? med(bySec.get(n)!) : NaN))
      const fin = vals.filter(Number.isFinite)
      const spread = fin.length >= 2 ? Math.max(...fin) - Math.min(...fin) : NaN
      console.log(`  ${sb.id}/${sa.id}  (${sb.anemM} m / ${sa.anemM} m, both reduced to 10 m)`
        + `   n=${all.length.toLocaleString('en-GB')}   median ratio ${med(all).toFixed(3)}`)
      console.log(`      by sector  ${secs.map((n, k) => `${n} ${Number.isFinite(vals[k]) ? vals[k].toFixed(3) : '  -  '}`).join('   ')}`
        + `   spread ${Number.isFinite(spread) ? spread.toFixed(3) : '-'}`)
    }
  }
  printZ0Sensitivity()
}


/**
 * THE TAIL CHECK — is the correction still able to warn of strong wind?
 *
 * An rmse-optimal linear correction is a SHRINKAGE. `a` comes out as
 * cov(x,y)/var(x), so the weaker a model's correlation with the station, the
 * harder OLS pulls its forecast toward the mean — and lower rmse is exactly
 * what you get for doing that. At Long Beach that is not a small effect:
 * ecmwf_ifs025 fits a = 0.40, so a raw 30 kn forecast is corrected to 18 kn,
 * and gfs_global and icon_global land near 21 kn. Those three cannot forecast
 * a strong wind at all any more, whatever their rmse says.
 *
 * For a sailing forecast that is the wrong trade. Being 3 kn out on a 12 kn
 * afternoon is a nuisance; failing to say that it will blow 25 is a decision
 * about whether to leave the dock. So rmse and "holds in every block" are not
 * sufficient on their own, and this measures the third thing:
 *
 *   - mean error (model - obs) in bins of OBSERVED wind, raw against corrected.
 *     A shrunk correction reads well in the middle bins and collapses in the
 *     top one.
 *   - the WARNING RATE at a threshold: of the hours the station actually had
 *     >= threshold, how many did each version put at >= threshold. This is the
 *     number that matters operationally, and rmse is blind to it.
 *
 * It is deliberately IN-SAMPLE. The question is structural — shrinkage is a
 * property of the fitted slope, not of overfitting — so cross-validating it
 * would answer a different question and hide this one behind noise.
 */
async function tailCheck() {
  const thresh = Number(flag('threshold', '18'))
  const BINS: Array<[string, number, number]> = [
    ['0-6', 0, 6], ['6-12', 6, 12], ['12-18', 12, 18], ['18-24', 18, 24], ['24+', 24, 999],
  ]
  for (const st of STATIONS) {
    let obs: Map<number, Obs>
    try { obs = await loadObs(st) } catch { continue }
    if (obs.size < 2000) continue
    console.log(`\n${'='.repeat(78)}\nTAIL CHECK — ${st.id} ${st.name}`
      + `${st.shippable ? '' : '  (report only)'}`)
    console.log(`  mean error (model - observed), kn, by OBSERVED wind bin at ${FIT_Z} m`)
    for (const model of MODELS) {
      const specPath = `src/components/weather/mos/mos_${VENUE_KEY.replace(/-/g, '_')}.json`
      if (!existsSync(specPath)) { console.log('  no spec written yet — run --write first.'); return }
      const spec = JSON.parse(readFileSync(specPath, 'utf8'))
      const m = spec.models?.[model]
      if (!m || m.type === 'raw') { console.log(`\n  ${model}: shipped raw — nothing to check.`); continue }
      let mod: Awaited<ReturnType<typeof loadModel>>
      try { mod = await loadModel(model, st.lat, st.lon, st.cellSel) } catch { continue }
      const rows = pairUp(obs, mod.rows)
      if (rows.length < 2000) continue
      const binStat = BINS.map(([label, lo, hi]) => {
        const sel = rows.filter((r) => r.obs >= lo && r.obs < hi)
        if (!sel.length) return { label, n: 0, raw: NaN, cor: NaN }
        const raw = sel.reduce((a, r) => a + (r.model - r.obs), 0) / sel.length
        const cor = sel.reduce((a, r) => {
          const p = predictSpecModel(m, r.model, r.twd, r.hour, BANDS)
          return a + ((Number.isFinite(p) ? p : r.model) - r.obs)
        }, 0) / sel.length
        return { label, n: sel.length, raw, cor }
      })
      const hitRaw = rows.filter((r) => r.obs >= thresh && r.model >= thresh).length
      const hitCor = rows.filter((r) => {
        const p = predictSpecModel(m, r.model, r.twd, r.hour, BANDS)
        return r.obs >= thresh && (Number.isFinite(p) ? p : r.model) >= thresh
      }).length
      const nObs = rows.filter((r) => r.obs >= thresh).length
      console.log(`\n  ${model}   (${m.type}, a=${(m.a ?? NaN).toFixed(3)})`)
      console.log(`    bin        ${binStat.map((b) => b.label.padStart(9)).join('')}`)
      console.log(`    n          ${binStat.map((b) => String(b.n).padStart(9)).join('')}`)
      console.log(`    raw err    ${binStat.map((b) => (Number.isFinite(b.raw) ? b.raw.toFixed(1) : '—').padStart(9)).join('')}`)
      console.log(`    corr err   ${binStat.map((b) => (Number.isFinite(b.cor) ? b.cor.toFixed(1) : '—').padStart(9)).join('')}`)
      if (nObs >= 20) {
        console.log(`    of ${nObs} hours observed >= ${thresh} kn: raw warned ${hitRaw}`
          + ` (${(100 * hitRaw / nObs).toFixed(0)}%), corrected warned ${hitCor}`
          + ` (${(100 * hitCor / nObs).toFixed(0)}%)`)
      } else {
        console.log(`    only ${nObs} hours observed >= ${thresh} kn — warning rate not meaningful.`)
      }
    }
  }
}

async function main() {
  const venue = VENUES.find((v) => v.key === VENUE_KEY)
  if (!venue) { console.error(`venue ${VENUE_KEY} not in VENUES`); process.exit(1) }

  console.log(`\nLONG BEACH / SAN PEDRO MOS  —  venue centre ${venue.lat}, ${venue.lon}`)
  console.log(`  window ${FROM} .. ${TO}   tz ${TZ}   fit height ${FIT_Z} m`)
  console.log(`  cell_selection: per station — ${STATIONS.map((s) => `${s.id} ${s.cellSel}`).join(', ')}`)
  console.log(`  obs path: ${SIX_MIN ? '6-minute, snapped to the hour' : 'CO-OPS interval=h (on-the-hour sample)'}`)
  console.log(`  models: ${MODELS.join(', ')}`)

  console.log('\nSTATIONS')
  for (const s of STATIONS) {
    const d = nmBetween(venue.lat, venue.lon, s.lat, s.lon)
    console.log(`  ${s.id.padEnd(9)} ${s.name.padEnd(20)} ${s.anemM.toFixed(1).padStart(5)} m`
      + `  ${d.toFixed(1).padStart(4)} nm   ${s.shippable ? 'CAN SHIP   ' : 'report only'}`
      + `   cell_selection=${s.cellSel}`)
    console.log(`  ${' '.repeat(9)} ${s.exposure}`)
  }

  if (argv.includes('--compare')) { await compareStations(); return }
  if (argv.includes('--tail')) { await tailCheck(); return }

  const results: Record<string, Record<string, FormResult[]>> = {}
  const chosen: Record<string, Record<string, {
    type: string; gain: number; holds: boolean; rows: number; cellNm: number
    rawBias: number; rawRmse: number; span: string; blocks: number
    cell: Cell | null
    /** The OLS pick's tail verdict — why it is not what ships. */
    olsTail: string
    /** The constrained, range-preserving choice: this is what ships. */
    con: ConstrainedResult | null
    conGain: number
    /** The June-September arm, stored only if it beat the year-round one. */
    season: { res: ConstrainedResult; gain: number; beatsBy: number } | null
    /** How the SHIPPED year-round choice performs on racing-season hours. */
    seasonOfYearRound: { rmse: number; rawRmse: number; gain: number; n: number } | null
  }>> = {}

  for (const st of STATIONS) {
    console.log(`\n${'='.repeat(78)}\n${st.id} — ${st.name}  (${st.anemM} m, site z0 ~${st.siteZ0} m)`)
    console.log(`  ${st.exposure}`)
    if (st.anemM !== FIT_Z) {
      if (REDUCE_10M) {
        console.log(`  obs reduced ${st.anemM} m -> ${FIT_Z} m by x${heightFactor(st.anemM, WATER_Z0).toFixed(4)}`
          + ` (neutral log profile, z0 ${WATER_Z0} m)`)
        if (st.siteZ0 > 0.01) {   // only fires for a site measured to be rough
          console.log(`  !! that factor assumes OPEN WATER. Over this site's own z0 (~${st.siteZ0} m)`)
          console.log(`     it would be x${heightFactor(st.anemM, st.siteZ0).toFixed(4)}`
            + ` — ${(100 * Math.abs(heightFactor(st.anemM, st.siteZ0) - heightFactor(st.anemM, WATER_Z0))).toFixed(0)}`
            + ' percentage points away. Corroboration only.')
        }
      } else {
        console.log(`  !! ${st.anemM} m is not the model's 10 m field, and no reduction is applied.`)
      }
    } else {
      console.log('  10 m anemometer — NO height adjustment applied. This is the control.')
    }
    let obs: Map<number, Obs>
    try { obs = await loadObs(st) } catch (e) { console.log(`  obs failed: ${(e as Error).message}`); continue }
    console.log(`  ${obs.size.toLocaleString('en-GB')} hourly observations`)
    if (obs.size < 2000) { console.log('  too few to fit anything honest — skipped.'); continue }
    const keys = Array.from(obs.keys()).sort((a, b) => a - b)
    const series = keys.map((k) => obs.get(k)!.kn)
    const r1 = lag1(series)
    console.log(`  lag-1 ${f3(r1)} -> nEff ≈ ${effectiveN(obs.size, r1).toFixed(0)}`
      + ` of ${obs.size.toLocaleString('en-GB')} (${(100 * effectiveN(obs.size, r1) / obs.size).toFixed(1)}%)`)

    results[st.id] = {}
    chosen[st.id] = {}
    for (const model of MODELS) {
      let mod: Awaited<ReturnType<typeof loadModel>>
      try { mod = await loadModel(model, st.lat, st.lon, st.cellSel) } catch (e) {
        console.log(`\n  ${model}: fetch failed — ${(e as Error).message}`); continue
      }
      const rows = pairUp(obs, mod.rows)
      const off = mod.cell ? nmBetween(st.lat, st.lon, mod.cell.lat, mod.cell.lon) : NaN
      // THE EFFECTIVE WINDOW, per model. The archives start anywhere from 2021
      // to 2025-09 here, so a gain quoted without it is not comparable with the
      // model next to it.
      const span = rows.length ? `${day(rows[0].t)}..${day(rows[rows.length - 1].t)}` : '—'
      console.log(`\n  ${model}   ${rows.length.toLocaleString('en-GB')} paired hours`
        + `   ${span}   cell ${off.toFixed(2)} nm from the anemometer`)
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
      // The OLS pick's TAIL verdict. Printed next to its gain so the two are
      // never read apart again: at this venue every slope-fitting form posts a
      // large gain and fails the tail bar.
      const olsPooledTail = (() => {
        if (pick.type === 'raw') return 'raw — nothing to check'
        const obsA: number[] = []; const rawA: number[] = []; const corA: number[] = []
        for (const r of rows) {
          const q = predictSpecModel(pick.spec, r.model, r.twd, r.hour, BANDS)
          obsA.push(r.obs); rawA.push(r.model); corA.push(Number.isFinite(q) ? q : r.model)
        }
        return tailVerdict(tailStats(obsA, rawA, corA, YEAR_BARS), YEAR_BARS)
      })()
      console.log(`    ${olsPooledTail}`)

      // ── the constrained ladder, which is what can actually ship ──────────
      const { blocks: cBlocks, results: cLadder } = cvConstrained(rows, YEAR_BARS)
      let con: ConstrainedResult | null = null
      let conGain = NaN
      if (cBlocks >= 2 && cLadder.length) {
        printConstrained(cLadder, rawCv.cv.rmse, YEAR_BARS)
        con = applyBars(cLadder, rawCv.cv.rmse)
        conGain = con ? piRmse(con.cv.rmse, rawCv.cv.rmse) : NaN
        console.log(`    => SHIPS: ${con ? `${con.type} (stored as ${con.storedType}, a=1)`
          + `  ${conGain.toFixed(1)}%` : 'raw — no constrained form cleared the bars'}`)
      } else {
        console.log(`    constrained ladder: only ${cBlocks} block(s) — not cross-validated.`)
      }

      // ── the JUNE-SEPTEMBER arm ───────────────────────────────────────────
      // Fitted on racing-season hours alone and compared with the year-round
      // arm ON THE SAME HELD-OUT HOURS, which is the only comparison that
      // means anything: a season fit evaluated on its own season against a
      // year-round fit evaluated on twelve months would win by construction.
      let season: { res: ConstrainedResult; gain: number; beatsBy: number } | null = null
      let seasonOfYearRound: { rmse: number; rawRmse: number; gain: number; n: number } | null = null
      const seasonRows = rows.filter((r) => r.month != null && SEASON_MONTHS.includes(r.month))
      if (con) {
        const yrOnSeason = scoreOnMonths(con.pooled, SEASON_MONTHS, SEASON_BARS)
        if (yrOnSeason) {
          seasonOfYearRound = {
            rmse: yrOnSeason.rmse, rawRmse: yrOnSeason.rawRmse,
            gain: piRmse(yrOnSeason.rmse, yrOnSeason.rawRmse), n: yrOnSeason.n,
          }
          console.log(`    racing season (${SEASON_MONTHS.join(',')}) — the YEAR-ROUND choice on`
            + ` ${yrOnSeason.n.toLocaleString('en-GB')} held-out season hours:`
            + ` rmse ${f2(yrOnSeason.rmse)} vs raw ${f2(yrOnSeason.rawRmse)}`
            + ` = ${piRmse(yrOnSeason.rmse, yrOnSeason.rawRmse).toFixed(1)}%`)
          console.log(`      ${tailVerdict(yrOnSeason.tail, SEASON_BARS)}`)
        }
      }
      if (seasonRows.length >= 2000) {
        const { blocks: sBlocks, results: sLadder } = cvConstrained(seasonRows, SEASON_BARS)
        if (sBlocks >= 2 && sLadder.length) {
          const sRawRmse = score(seasonRows.map((r) => r.model), seasonRows.map((r) => r.obs)).rmse
          console.log(`    SEASON-ONLY fit — ${seasonRows.length.toLocaleString('en-GB')} hours,`
            + ` ${sBlocks} blocks, raw rmse ${f2(sRawRmse)}`)
          printConstrained(sLadder, sRawRmse, SEASON_BARS, '      ')
          const sPick = applyBars(sLadder, sRawRmse)
          if (sPick) console.log(`      ${tailVerdict(sPick.tail, SEASON_BARS)}`)
          if (sPick && seasonOfYearRound) {
            // One standard error of the YEAR-ROUND arm's season rmse is the bar,
            // exactly as mos-fit.ts does it for its --months window.
            const se = seasonOfYearRound.rmse / Math.sqrt(2 * Math.max(2, sPick.cv.nEff))
            const beatsBy = seasonOfYearRound.rmse - sPick.cv.rmse
            const stored = beatsBy > se
            console.log(`      season arm ${f2(sPick.cv.rmse)} vs year-round-on-season`
              + ` ${f2(seasonOfYearRound.rmse)} — better by ${beatsBy.toFixed(3)} kn,`
              + ` 1 SE = ${se.toFixed(3)} -> ${stored ? 'STORED as seasonal' : 'NOT stored'}`)
            if (stored) season = { res: sPick, gain: piRmse(sPick.cv.rmse, sRawRmse), beatsBy }
          } else if (!sPick) {
            console.log('      no season-only form cleared the bars.')
          }
        } else {
          console.log(`    season-only: ${sBlocks} block(s) — not cross-validated.`)
        }
      } else {
        console.log(`    season-only: ${seasonRows.length} hours — too few to fit.`)
      }

      results[st.id][model] = ladder
      chosen[st.id][model] = {
        type: pick.type, gain, holds, rows: rows.length, cellNm: off, rawBias, rawRmse, span, blocks,
        cell: mod.cell, olsTail: olsPooledTail, con, conGain, season, seasonOfYearRound,
      }
    }
  }

  // ── the summary that answers the question ───────────────────────────────
  console.log(`\n${'='.repeat(78)}\nSUMMARY A — the OLS ladder's gain, %, which is NOT what ships`)
  console.log('  Large, real in rmse, and bought by shrinking the slope. Kept in the output')
  console.log('  because it is what the house method would have selected on its own.')
  console.log(`  ${['station'.padEnd(10), ...MODELS.map((m) => m.slice(0, 13).padStart(14))].join('')}`)
  for (const st of STATIONS) {
    const cells = MODELS.map((m) => {
      const c = chosen[st.id]?.[m]
      if (!c) return '           —  '
      const mark = c.type === 'raw' ? ' raw' : c.holds ? '' : ' *'
      return `${c.gain.toFixed(1)}%${mark}`.padStart(14)
    })
    console.log(`  ${st.id.padEnd(10)}${cells.join('')}  ${st.shippable ? '' : '(report only)'}`)
  }
  console.log('  * = the gain does not hold in every held-out year block.')

  console.log(`\n${'='.repeat(78)}\nSUMMARY B — the CONSTRAINED choice (a = 1), which IS what ships`)
  console.log(`  ${['station'.padEnd(10), ...MODELS.map((m) => m.slice(0, 13).padStart(14))].join('')}`)
  for (const st of STATIONS) {
    const cells = MODELS.map((m) => {
      const c = chosen[st.id]?.[m]
      if (!c) return '           —  '
      if (!c.con) return '           raw'.padStart(14)
      return `${c.conGain.toFixed(1)}%`.padStart(14)
    })
    console.log(`  ${st.id.padEnd(10)}${cells.join('')}  ${st.shippable ? '' : '(report only)'}`)
  }
  console.log(`\n  form chosen, and the warning rate it keeps at >=${YEAR_BARS.threshold} kn`)
  for (const st of STATIONS) {
    for (const m of MODELS) {
      const c = chosen[st.id]?.[m]
      if (!c || !c.con) continue
      const t = c.con.tail
      console.log(`  ${st.id.padEnd(10)} ${m.padEnd(16)} ${c.con.type.padEnd(23)}`
        + ` keeps ${t.warnRaw ? (100 * t.warnCor / t.warnRaw).toFixed(0) : '—'}%`
        + ` (${t.warnCor}/${t.warnRaw} of ${t.nAbove})`)
    }
  }

  console.log(`\n${'='.repeat(78)}\nSUMMARY C — RACING SEASON, months ${SEASON_MONTHS.join(',')}`)
  console.log('  Olympic sailing 2028 and the Transpac start fall in this window, so this is')
  console.log('  the column that matters. "year-round on season" is the SHIPPED year-round')
  console.log('  correction scored on held-out season hours only.')
  console.log(`  ${'station/model'.padEnd(28)}${'yr-round on season'.padStart(20)}`
    + `${'season-only arm'.padStart(18)}${'  stored?'}`)
  for (const st of STATIONS) {
    for (const m of MODELS) {
      const c = chosen[st.id]?.[m]
      if (!c) continue
      const yr = c.seasonOfYearRound
        ? `${c.seasonOfYearRound.gain.toFixed(1)}% (n=${c.seasonOfYearRound.n})`.padStart(20)
        : '—'.padStart(20)
      const sn = c.season ? `${c.season.gain.toFixed(1)}%`.padStart(18) : 'not better'.padStart(18)
      console.log(`  ${`${st.id} ${m}`.padEnd(28)}${yr}${sn}`
        + `  ${c.season ? 'YES — seasonal' : 'no'}`)
    }
  }

  console.log('\nRAW BIAS — model minus observed, kn, at 10 m')
  console.log(`  ${['station'.padEnd(10), ...MODELS.map((m) => m.slice(0, 13).padStart(14))].join('')}`)
  for (const st of STATIONS) {
    const cells = MODELS.map((m) => {
      const c = chosen[st.id]?.[m]
      return c ? `${c.rawBias >= 0 ? '+' : ''}${c.rawBias.toFixed(2)}`.padStart(14) : '           —  '
    })
    console.log(`  ${st.id.padEnd(10)}${cells.join('')}`)
  }
  console.log('  Agreement ACROSS models at one station is the evidence that a bias is the')
  console.log('  model\'s; agreement across stations is the evidence that it is not the site.')

  printZ0Sensitivity()

  console.log('\nNOTES')
  console.log('  - MODELS.NAM in openMeteo.js has NO mosModel, so anything fitted for')
  console.log('    ncep_nam_conus is INERT until `mosModel: \'ncep_nam_conus\'` is added to it.')
  console.log('    mosWiring.test.ts fails on exactly this.')
  console.log('  - icon_eu does NOT reach the Pacific. MODELS.ICON maps to mosModel `icon_eu`,')
  console.log('    which is right in Europe and wrong here; the app fetches icon_seamless,')
  console.log('    which resolves to icon_global, so an icon_global key describes the right')
  console.log('    forecast but is never looked up.')
  console.log('  - gem_hrdps_continental has no data at this latitude, which agrees with the')
  console.log('    app: MODELS.HRDPS\'s coverage box starts at 42 N.')

  if (!WRITE) { console.log('\nDry run. Re-run with --write to emit the spec.\n'); return }

  const prim = STATIONS.find((s) => s.id === PRIMARY)
  if (!prim) { console.error(`\n--station ${PRIMARY} is not one of the three.`); process.exit(1) }
  if (!prim.shippable && !ALLOW_NONSTD) {
    console.error(`\nRefusing to write: ${prim.id} (${prim.name}) is marked report-only.`)
    if (prim.anemM === FIT_Z) {
      console.error('It is the 10 m CONTROL — 7 nm inland, and it reads 19 % below the marine')
      console.error('stations with a 0.17 sector spread, which is an exposure difference and not')
      console.error('a bias. Its job is to agree on the SIGN of a model error, not to supply one.')
    } else {
      console.error(`One station has to be primary, and it is 9410647: 1.2 nm from the venue centre`)
      console.error(`against ${nmBetween(33.72, -118.27, prim.lat, prim.lon).toFixed(1)} nm, a ${prim.anemM} m`
        + ` anemometer against 20 m so less is manufactured,`)
      console.error('and lower raw rmse for the coarse models. The two agree to 0.8 % once reduced,')
      console.error('so this is a choice between near-equivalent truths rather than a rejection.')
    }
    console.error('Use --station 9410647, or --allow-nonstandard-height to write this one anyway')
    console.error('with the choice recorded in the spec.')
    process.exit(1)
  }
  const models: Record<string, unknown> = {}
  const seasonalModels: Record<string, unknown> = {}
  for (const model of MODELS) {
    const c = chosen[prim.id]?.[model]
    const ladder = results[prim.id]?.[model]
    if (!c || !ladder) continue
    const pick = ladder.find((r) => r.type === c.type)
    if (!pick) continue
    // THE CELL IS RECORDED PER MODEL, because CLAUDE.md's rule is that a spec
    // belongs to the cell it was fitted against and that fact was lost once
    // already. Measured 28 Oct 2026: ecmwf_ifs025 returns the SAME cell at
    // Angels Gate, the venue centre and Belmont Shore, and icon_global,
    // gfs_global and ncep_nam_conus share a cell between Angels Gate and the
    // venue centre — so for those the correction is applied to exactly the
    // input it was fitted on. gfs_hrrr, at 3 km, resolves the bay into
    // separate cells: it was fitted on the cell at the anemometer and the
    // venue centre is served a neighbour ~2.3 km away.
    const cellNote = c.cell
      ? { fitted_cell: [Number(c.cell.lat.toFixed(4)), Number(c.cell.lon.toFixed(4))],
          fitted_cell_nm_from_truth: Number(c.cellNm.toFixed(2)) }
      : {}
    // WHAT SHIPS IS THE CONSTRAINED FORM, not the OLS pick. The OLS gain is
    // recorded beside it with the tail verdict that disqualified it, because
    // the next person to read this spec will otherwise refit it and get the
    // bigger number back.
    const olsNote = {
      ols_ladder_best: pick.type,
      ols_ladder_gain_pct: Number(c.gain.toFixed(1)),
      ols_ladder_slope: pick.spec.a == null ? null : Number(pick.spec.a.toFixed(3)),
      ols_rejected_because: c.olsTail,
    }
    models[model] = !c.con
      ? {
        type: 'raw',
        not_shipped: 'no range-preserving form cleared the bars',
        fitted_span: c.span, blocks: c.blocks, ...cellNote, ...olsNote,
      }
      : {
        ...c.con.spec,
        slope_constrained: true,
        slope_constrained_why: 'a is pinned to 1 so the forecast keeps its range; the '
          + 'rmse-optimal slope shrinks the strong-wind tail away. Only the bias, the '
          + 'sector offsets and the diurnal harmonic are fitted.',
        form: c.con.type,
        measured_gain_pct: Number(c.conGain.toFixed(1)),
        holds_every_block: c.con.perBlock.every((b) => b.piRmse > 0),
        warn_kept_pct: c.con.tail.warnRaw
          ? Number((100 * c.con.tail.warnCor / c.con.tail.warnRaw).toFixed(0)) : null,
        warn_threshold_kn: YEAR_BARS.threshold,
        top_bin_err_kn: Number.isFinite(c.con.tail.topCor)
          ? Number(c.con.tail.topCor.toFixed(1)) : null,
        top_bin_err_raw_kn: Number.isFinite(c.con.tail.topRaw)
          ? Number(c.con.tail.topRaw.toFixed(1)) : null,
        season_gain_pct: c.seasonOfYearRound ? Number(c.seasonOfYearRound.gain.toFixed(1)) : null,
        fitted_span: c.span,
        blocks: c.blocks,
        paired_hours: c.rows,
        ...cellNote,
        ...olsNote,
      }
    // THE SEASONAL SET IS SPARSE ON PURPOSE. modelForMonth falls back to
    // spec.models for any model the window does not name, so a model only
    // belongs here when its season-only arm actually beat the year-round one
    // on the same held-out hours. Naming a model here that did not is how
    // October's coefficients end up applied to a sea breeze.
    if (c.season) {
      seasonalModels[model] = {
        ...c.season.res.spec,
        slope_constrained: true,
        form: c.season.res.type,
        measured_gain_pct: Number(c.season.gain.toFixed(1)),
        beats_year_round_by_kn: Number(c.season.beatsBy.toFixed(3)),
        warn_kept_pct: c.season.res.tail.warnRaw
          ? Number((100 * c.season.res.tail.warnCor / c.season.res.tail.warnRaw).toFixed(0)) : null,
      }
    }
  }
  const spec = {
    venue: venue.key,
    fit_height_m: FIT_Z,
    target_height_m: 30,
    truth_station: `coops:${prim.id}`,
    truth_station_name: prim.name,
    truth_anemometer_m: prim.anemM,
    obs_height_adjustment: prim.anemM === FIT_Z ? null : {
      from_m: prim.anemM, to_m: FIT_Z, z0_m: WATER_Z0,
      factor: Number(heightFactor(prim.anemM, WATER_Z0).toFixed(4)),
      method: 'neutral log profile over open water',
      z0_sensitivity: `z0 1.0 m would give ${heightFactor(prim.anemM, 1.0).toFixed(3)}; `
        + 'the open-water value is used because this station\'s upwind fetch is water '
        + 'through the sectors that matter',
    },
    truth_exposure: prim.exposure,
    truth_nm_from_venue: Number(nmBetween(venue.lat, venue.lon, prim.lat, prim.lon).toFixed(2)),
    fitted_from: FROM,
    fitted_to: TO,
    obs_source: SIX_MIN
      ? 'NOAA CO-OPS 6-minute wind, snapped to the nearest hour'
      : 'NOAA CO-OPS hourly wind (interval=h — the on-the-hour 6-minute sample)',
    cell_selection: prim.cellSel,
    lead_time: 'short-lead stitched archive; NOT lead-time stratified',
    bands: BANDS,
    // KEYS THE APP CANNOT REACH, named so they are not mistaken for shipped.
    // applyMOS reads spec.models[MODELS[k].mosModel], so a key no model claims
    // is silently inert. mosWiring.test.ts asserts every other key IS reachable.
    models_not_applied: {
      icon_global:
        'MODELS.ICON.mosModel is `icon_eu`, which does not reach the Pacific. The app '
        + 'fetches icon_seamless here, which resolves to icon_global, so the coefficients '
        + 'describe the right forecast — but the lookup key does not match and the '
        + 'correction is NOT applied. Same situation as at san-juan.',
    },
    corroborating_stations: STATIONS.filter((s) => s.id !== prim.id).map((s) => ({
      id: s.id, name: s.name, anemometer_m: s.anemM, site_z0_m: s.siteZ0, shipped: false,
    })),
    // Every shipped correction here pins a = 1. Recorded at the top level too,
    // because it is a property of the whole venue's fit and not of one model.
    slope_policy: {
      constrained: true,
      threshold_kn: YEAR_BARS.threshold,
      warn_keep: WARN_KEEP,
      top_bin_kn: YEAR_BARS.topBin,
      top_slack_kn: TOP_SLACK,
      season_threshold_kn: SEASON_BARS.threshold,
      season_top_bin_kn: SEASON_BARS.topBin,
      why: 'The rmse-optimal slope at this venue is 0.40-0.77, which corrects a raw 30 kn '
        + 'forecast to 18-27 kn and drops the share of observed >=18 kn hours the forecast '
        + 'warns about from 50-75 % to 0-29 %. ecmwf_ifs025 warned on 0 of 130. A forecast '
        + 'that cannot produce a strong wind is worse than an uncorrected one however good '
        + 'its rmse, so the slope is pinned and only the offsets are fitted.',
    },
    models,
    ...(Object.keys(seasonalModels).length
      ? {
        seasonal: {
          months: SEASON_MONTHS,
          label: SEASON_LABEL,
          note: 'Olympic sailing 2028 and the Transpac start fall in June-September. '
            + 'applyMOS uses these coefficients inside the window and spec.models outside '
            + 'it; A MODEL ABSENT HERE KEEPS THE YEAR-ROUND SET INSIDE THE WINDOW TOO, '
            + 'which is only safe because every year-round correction here was validated '
            + 'across all five held-out years including their summers.',
          models: seasonalModels,
        },
      }
      : {}),
  }
  const out = `src/components/weather/mos/mos_${venue.key.replace(/-/g, '_')}.json`
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`\nWrote ${out}`)
  console.log('  NOT SHIPPED until it is registered in SPECS in mos.js — writing the JSON')
  console.log('  does not turn it on. ncep_nam_conus additionally needs a mosModel on')
  console.log('  MODELS.NAM, or its coefficients sit there doing nothing.\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
