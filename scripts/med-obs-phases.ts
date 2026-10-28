// Build 2026 Mediterranean wind observations from Northstar 76's own logfiles,
// using ONLY THE SELECTED PHASES, so the MOS refit can hold out this season.
//
//   npx vite-node scripts/med-obs-phases.ts                 # dry run, reports
//   npx vite-node scripts/med-obs-phases.ts -- --write      # write the obs CSVs
//   npx vite-node scripts/med-obs-phases.ts -- --date 2026-09-10 --verbose
//
// WHY THIS EXISTS. The three shipped Mediterranean MOS specs were fitted on the
// wind-verification project's obs_<venue>.csv — 261, 445 and 417 ten-minute
// bins over 2023-2026. Sorrento's 2026 regatta is in there (Northstar 72, May
// 2026); PORTO CERVO'S AND ST TROPEZ'S 2026 REGATTAS ARE NOT, because they were
// sailed by Northstar 76 in September and October 2026, after that extraction.
// That matters most at Porto Cervo, which cross-validates on TWO regattas, so
// "the gain holds in every held-out regatta" rests on a single held-out block.
//
// WHAT THE SELECTED PHASES ARE, and why they are the right window. The event
// file carries a <phase> per on-board selected 30-second window, each with its
// own sailing mode, race and leg. They are the steady-state stretches the boat
// marked as worth measuring — no manoeuvres, no reaching between legs, no
// motoring out. The alternative, which the original extraction used, is the
// whole DayStart..DayStop window minus a 60 s buffer around each tack and mark
// rounding; that keeps everything in between, including the milling about. The
// phases are a tighter and better-defined truth, and they are the same windows
// SSA's own phase statistics use, so the two cannot disagree about what a
// phase is: this parses them with the app's own `parseXmlEvents`.
//
// THREE THINGS MEASURED RATHER THAN ASSUMED, each of which would have been
// wrong to guess:
//
// 1. THE FILE CLOCK IS VENUE-LOCAL. The log's `Datetime` column has no zone and
//    is not UTC. Checked by POSITION against the same day's cloud session,
//    which SSA parsed independently: at a +2 h shift the two records' tracks
//    agree to 0 m over 5,224 and 5,047 rows, and at every other half-hour
//    shift they are 1.5 to 14 km apart. The event file's own
//    <utc_offset><log_file hours="2"> says the same, and the two agreeing is
//    what makes it safe. Read as UTC, every bin would be filed two hours and
//    sometimes one calendar day out.
//
// 2. GROUND WIND, NOT WATER-REFERENCED. The obs contract uses GWD/GWS because
//    the forecast is earth-referenced, and the difference is not cosmetic: on
//    these days GWS runs 1.8 to 2.0 kn ABOVE the water-referenced TWS. The
//    cloud copy of the log carries only `tws`/`twd`, so taking the convenient
//    source would have biased this season's block ~2 kn against the 2024 and
//    2025 bins — a bias indistinguishable from a model error, in the blocks
//    that decide whether a correction holds.
//
// 3. DIRECTIONS ARE MAGNETIC. The event file carries <magvar val="3.5" />, in
//    the 1-6 E range the original extraction accepts for the Med, so it is
//    applied as that extraction applies it. Direction only picks the sector
//    band, so this moves a handful of bins near a band edge; it is here
//    because leaving it out silently would have been a different datum from
//    the rest of the file.
//
// WHAT IS DELIBERATELY THE SAME as the original extraction, so the new bins can
// sit in the same table as the old: clock-aligned 10-minute bins, scalar-mean
// speed, vector-mean direction, max as the gust proxy and a 60 kn despike.
//
// WHAT IS DELIBERATELY NOT THE SAME: THE MASTHEAD HEIGHT. Every existing bin
// says `mast_height_m: 30.0`, which is not a measurement of anything — it is
// extract_obs.py's `--mast-height` DEFAULT, left at 30 for every regatta.
// Northstar 72's masthead is 32 m and Northstar 76's is 35 m (Wouter, 28 Oct
// 2026). It is the height the forecast is interpolated TO — `zEff = mast *
// cos(heel)` — so a 30 m label on a 35 m instrument asks the model for less
// wind than the instrument saw and books the difference as a model deficit.
// These bins therefore carry 35.0, their own true height, and the refit
// script corrects the older bins' 30.0 to 32.0 on the way in rather than
// editing another project's read-only files. The size of it: 35 m against
// 30 m is 1.3 % of wind over water, 32 m against 30 m is 0.55 % — small, and
// free to get right.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseXmlEvents } from '../src/lib/xmlEventParse'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const VERBOSE = argv.includes('--verbose')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const LOG_DIR = flag('dir', join(homedir(), 'Downloads'))!
const OUT_DIR = flag('out',
  join(homedir(), 'Documents/Claude/Projects/Smart Sailing Analytics/wind-verification-2026'))!
const BOAT = flag('boat', 'Northstar 76')!
const ONLY_DATE = flag('date')
const BIN_MIN = Number(flag('bin', '10'))
// A 10-minute bin built from 30-second phases is rarely full, so a floor is
// needed or a bin holding four seconds of one phase becomes an "observation"
// with the same weight as a full ten minutes. Two minutes is the floor; the
// distribution is printed so a thin bin is visible rather than implied.
const MIN_SAMPLES = Number(flag('min-samples', '120'))
// And a floor on the DAY. 9 Sept's event file holds one selected phase, which
// makes one 122-sample bin — a single two-minute window, out of a day, from the
// one file here whose offset had to come from <event_file> because it has no
// <log_file>. The weakest provenance in the set contributing one point to a
// regatta block is not worth having, so a day has to produce a few bins or
// none.
const MIN_BINS_PER_DAY = Number(flag('min-bins-per-day', '3'))
const MAX_SPEED_KN = 60
const MAGVAR_DEFAULT = 3.4      // the original extraction's Med fallback
// Northstar 76's masthead, stated by Wouter 28 Oct 2026. NOT the 30.0 default
// the original extraction left in place for every boat. See the header.
const MAST_M = Number(flag('mast', '35'))

/** config.py's venue boxes, transcribed, and the names the event file uses. */
const VENUES: Record<string, { bbox: [number, number, number, number]; regatta: (d: string) => string }> = {
  sorrento: { bbox: [40.50, 40.72, 14.28, 14.55], regatta: (d) => `sorrento_${d.slice(0, 4)}` },
  porto_cervo: { bbox: [41.02, 41.24, 9.40, 9.68], regatta: (d) => `porto_cervo_${d.slice(0, 4)}` },
  // St Tropez's existing ids carry the month because its June and October
  // regattas are different regimes and must never land in one block.
  st_tropez: {
    bbox: [43.16, 43.36, 6.50, 6.78],
    regatta: (d) => `st_tropez_${d.slice(0, 4)}_${Number(d.slice(5, 7)) >= 8 ? 'oct' : 'jun'}`,
  },
}
const LOCATION_TO_VENUE: Record<string, string> = {
  sorrento: 'sorrento',
  'porto cervo': 'porto_cervo', 'porto rotondo': 'porto_cervo',
  'st tropez': 'st_tropez', 'saint tropez': 'st_tropez', 'st-tropez': 'st_tropez',
  'st. tropez': 'st_tropez',
}

interface Sample {
  utc: number; lat: number; lon: number
  gws: number; gwd: number; heel: number
}

interface Bin {
  venue: string; regatta: string
  t0: number; t1: number
  lat: number; lon: number
  tws: number; twd: number; gust: number
  heel: number; n: number
}

/**
 * One day's log. The export is OppositeTack's 1 Hz `1s_clean` variant, which
 * is NOT the Expedition `perf` format the original extraction parsed — it has
 * one `Datetime` column instead of separate date/time, decimal Lat/Lon instead
 * of NMEA `Pos[dddmm.mm]`, and no MagVar channel. Columns are taken BY NAME,
 * because the one thing every variant of these exports has in common is that
 * the column order moves.
 */
function readLog(path: string, offsetMin: number): Sample[] | { skip: string } {
  const lines = readFileSync(path, 'utf8').split('\n')
  const head = lines[0].replace(/^﻿/, '').trim().split(',')
  const ix = (...names: string[]) => {
    for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i }
    return -1
  }
  const cDt = ix('Datetime')
  const cLat = ix('Lat'); const cLon = ix('Lon')
  const cGwd = ix('GWD'); const cGws = ix('GWS')
  const cHeel = ix('Heel')
  // THE LSB EXPORT IS A DIFFERENT ANIMAL and must not be pressed into service.
  // It starts `UtcDate,UtcTime,Lat,Lon,MagVar,…`, carries the lidar channels,
  // and has TWD/TWS but NO GWD/GWS — water-referenced wind only. On these days
  // ground wind runs ~1.9 kn ABOVE water-referenced, so taking TWS here would
  // put one day into a ground-wind table 2 kn light, which is a bias no
  // cross-validation can tell from a model error. So a day that exists only as
  // an LSB export is skipped, not substituted.
  if (cGwd < 0 || cGws < 0) {
    return { skip: 'no GWD/GWS — this is the LSB export shape, water-referenced wind only' }
  }
  if (cDt < 0) return { skip: `no Datetime column (header starts ${head.slice(0, 3).join(',')})` }
  for (const [n, c] of [['Lat', cLat], ['Lon', cLon], ['Heel', cHeel]] as Array<[string, number]>) {
    if (c < 0) return { skip: `no ${n} column` }
  }
  const out: Sample[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const c = line.split(',')
    // The file clock is venue-local (see the header): parsed as UTC and then
    // shifted back by the event file's own offset.
    const t = Date.parse(`${c[cDt].trim().replace(' ', 'T')}Z`)
    const lat = Number(c[cLat]); const lon = Number(c[cLon])
    const gws = Number(c[cGws]); const gwd = Number(c[cGwd])
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (!Number.isFinite(gws) || !Number.isFinite(gwd)) continue
    out.push({
      utc: t - offsetMin * 60_000,
      lat, lon, gws, gwd, heel: Number(c[cHeel]) || 0,
    })
  }
  return out.sort((a, b) => a.utc - b.utc)
}

/**
 * The log offset the event file declares, in minutes.
 *
 * <utc_offset> holds a separate figure for the log and the event file, and
 * they can differ — that is why it holds two. The log's is what shifts the
 * samples. Some files (the pre-race `_0` skeletons) carry only the event
 * file's; it is used in that case and SAID, because a silent substitution of
 * one clock for the other is how a day ends up an hour out.
 */
function logOffsetMin(xml: string): { min: number; from: string } | null {
  const block = xml.match(/<utc_offset\b[\s\S]*?<\/utc_offset>/i)?.[0]
  const lf = block?.match(/<log_file\b[^>]*\bhours="([-\d.]+)"/i)?.[1]
  if (lf != null) return { min: Math.round(Number(lf) * 60), from: 'log_file' }
  const ef = block?.match(/<event_file\b[^>]*\bhours="([-\d.]+)"/i)?.[1]
  if (ef != null) return { min: Math.round(Number(ef) * 60), from: 'event_file (no log_file in the file)' }
  return null
}

/** The magnetic variation, taken only when it is plausible for the Med. */
function magvarOf(xml: string): { value: number; from: string } {
  const v = Number(xml.match(/<magvar\b[^>]*\bval="([-\d.]+)"/i)?.[1])
  if (Number.isFinite(v) && v >= 1 && v <= 6) return { value: v, from: 'event file' }
  return {
    value: MAGVAR_DEFAULT,
    from: Number.isFinite(v) ? `implausible ${v} in the event file, so the Med default` : 'Med default',
  }
}

function vectorMeanDir(speeds: readonly number[], dirs: readonly number[]): number {
  let u = 0; let v = 0
  for (let i = 0; i < speeds.length; i++) {
    const r = (dirs[i] * Math.PI) / 180
    u += speeds[i] * Math.sin(r); v += speeds[i] * Math.cos(r)
  }
  const d = (Math.atan2(u, v) * 180) / Math.PI
  return ((d % 360) + 360) % 360
}

function venueFor(location: string, lat: number, lon: number): { venue: string; agrees: boolean } | null {
  const named = LOCATION_TO_VENUE[location.trim().toLowerCase()] ?? null
  let boxed: string | null = null
  for (const [k, v] of Object.entries(VENUES)) {
    const [la0, la1, lo0, lo1] = v.bbox
    if (lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1) boxed = k
  }
  if (!named && !boxed) return null
  // The event file's <location> is typed by a human and the position is not,
  // so a disagreement is reported rather than resolved — a day filed under the
  // wrong venue is fitted against another venue's forecast lattice.
  return { venue: boxed ?? named!, agrees: !named || !boxed || named === boxed }
}

/** `oppositetack-log-<YYYYMMDD>-<hhmmss>...csv`, one file per date. */
function logFiles(): Map<string, string> {
  const byDate = new Map<string, string[]>()
  for (const f of readdirSync(LOG_DIR)) {
    if (!/^oppositetack-log-\d{8}-\d{6}.*\.csv$/i.test(f)) continue
    if (/\(\d+\)/.test(f)) continue                    // a duplicate download
    if (/start-4hz/i.test(f)) continue
    const d = f.slice(17, 25)
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    byDate.set(date, [...(byDate.get(date) ?? []), f])
  }
  const out = new Map<string, string>()
  for (const [date, fs] of Array.from(byDate.entries()).sort()) {
    // The plain `1s_clean` and the `_LSB` lidar variant hold the SAME wind —
    // the LSB file only adds lidar channels — so either will do and the plain
    // one is preferred. 26 Sept exists ONLY as an LSB export, which is why
    // this falls back rather than requiring the plain name.
    const plain = fs.find((f) => /\.1s_clean\.csv$/i.test(f))
    out.set(date, join(LOG_DIR, plain ?? fs.sort()[0]))
  }
  return out
}

/** `<boat>_<yymmdd>_<n>.ev.xml`, the richest one for the date. */
function eventFileFor(date: string): string | null {
  const stamp = date.slice(2).replace(/-/g, '')
  const cands = readdirSync(LOG_DIR).filter((f) =>
    f.startsWith(`${BOAT}_${stamp}_`) && /\.ev(\s*\(\d+\))?\.xml$/i.test(f) && !/\(\d+\)/.test(f))
  if (!cands.length) return null
  // `_0` files are the pre-race skeleton and carry no phases; `_1` is the
  // day's own. Pick by SIZE, which gets it right without relying on the digit.
  let best = cands[0]; let bestLen = -1
  for (const c of cands) {
    const len = readFileSync(join(LOG_DIR, c), 'utf8').length
    if (len > bestLen) { bestLen = len; best = c }
  }
  return join(LOG_DIR, best)
}

function main() {
  console.log('\n2026 Mediterranean obs from selected phases')
  console.log(`  logs      ${LOG_DIR}`)
  console.log(`  boat      ${BOAT}`)
  console.log(`  window    the event file's selected <phase> windows only`)
  console.log(`  bins      ${BIN_MIN} min, clock-aligned, at least ${MIN_SAMPLES} samples`)
  console.log(`  out       ${OUT_DIR}`)

  const byVenue = new Map<string, Bin[]>()
  const files = logFiles()
  console.log(`\n  ${files.size} log file(s) found${ONLY_DATE ? `, filtered to ${ONLY_DATE}` : ''}\n`)
  console.log('  date        rows   phases  phase s   kept   bins  venue        tws kn      twd')

  for (const [date, path] of Array.from(files.entries()).sort()) {
    if (ONLY_DATE && date !== ONLY_DATE) continue
    const evPath = eventFileFor(date)
    if (!evPath) { console.log(`  ${date}  no ${BOAT} event file — skipped (no phases, no offset, no venue)`); continue }
    const xml = readFileSync(evPath, 'utf8')
    const off = logOffsetMin(xml)
    if (off == null) {
      console.log(`  ${date}  event file declares no <utc_offset> at all — skipped rather than assumed`)
      continue
    }
    const offMin = off.min
    const ev = parseXmlEvents(xml, offMin)
    const phases: Array<{ utc: number; endUtc: number }> = ev.phases ?? []
    if (!phases.length) { console.log(`  ${date}  event file has no selected phases — skipped`); continue }

    const read = readLog(path, offMin)
    if (!Array.isArray(read)) { console.log(`  ${date}  ${path.split('/').pop()}: ${read.skip} — skipped`); continue }
    const all = read
    if (!all.length) { console.log(`  ${date}  log parsed to zero rows — skipped`); continue }

    // Rows inside any selected phase. The phases are sorted and short, so a
    // sweep is enough and an interval tree would be ceremony.
    const sorted = phases.slice().sort((a, b) => a.utc - b.utc)
    const kept: Sample[] = []
    let pi = 0
    for (const s of all) {
      while (pi < sorted.length && sorted[pi].endUtc <= s.utc) pi++
      if (pi < sorted.length && s.utc >= sorted[pi].utc && s.utc < sorted[pi].endUtc) kept.push(s)
    }
    const phaseSec = sorted.reduce((q, p) => q + (p.endUtc - p.utc) / 1000, 0)

    const clean = kept.filter((s) => s.gws > 0 && s.gws <= MAX_SPEED_KN)
    if (!clean.length) { console.log(`  ${date}  no samples survive the phases and the despike — skipped`); continue }

    const meanLat = clean.reduce((q, s) => q + s.lat, 0) / clean.length
    const meanLon = clean.reduce((q, s) => q + s.lon, 0) / clean.length
    const v = venueFor(ev.meta?.location ?? '', meanLat, meanLon)
    if (!v) {
      console.log(`  ${date}  position ${meanLat.toFixed(2)},${meanLon.toFixed(2)}`
        + ` and location "${ev.meta?.location ?? ''}" match no venue — skipped`)
      continue
    }
    if (!v.agrees) {
      console.log(`  ${date}  REFUSED: the event file says "${ev.meta?.location}" but the position`
        + ` ${meanLat.toFixed(3)},${meanLon.toFixed(3)} is in ${v.venue}'s box. Fix one of them.`)
      continue
    }
    const mv = magvarOf(xml)

    // Clock-aligned bins.
    const binMs = BIN_MIN * 60_000
    const groups = new Map<number, Sample[]>()
    for (const s of clean) {
      const b = Math.floor(s.utc / binMs) * binMs
      groups.set(b, [...(groups.get(b) ?? []), s])
    }
    const bins: Bin[] = []
    let thin = 0
    for (const [b, g] of Array.from(groups.entries()).sort((a, z) => a[0] - z[0])) {
      if (g.length < MIN_SAMPLES) { thin++; continue }
      const sp = g.map((s) => s.gws)
      const di = g.map((s) => ((s.gwd + mv.value) % 360 + 360) % 360)
      bins.push({
        venue: v.venue, regatta: VENUES[v.venue].regatta(date),
        t0: b, t1: b + binMs,
        lat: Number((g.reduce((q, s) => q + s.lat, 0) / g.length).toFixed(5)),
        lon: Number((g.reduce((q, s) => q + s.lon, 0) / g.length).toFixed(5)),
        tws: Number((sp.reduce((q, x) => q + x, 0) / sp.length).toFixed(2)),
        twd: Number(vectorMeanDir(sp, di).toFixed(1)),
        gust: Number(Math.max(...sp).toFixed(2)),
        heel: Number((g.reduce((q, s) => q + Math.abs(s.heel), 0) / g.length).toFixed(1)),
        n: g.length,
      })
    }
    if (bins.length < MIN_BINS_PER_DAY) {
      console.log(`  ${date}  only ${bins.length} bin(s) from ${phases.length} selected phase(s)`
        + ` — dropped (a day needs ${MIN_BINS_PER_DAY})`)
      continue
    }
    byVenue.set(v.venue, [...(byVenue.get(v.venue) ?? []), ...bins])
    const tws = bins.map((b) => b.tws)
    console.log(`  ${date}  ${String(all.length).padStart(6)}  ${String(phases.length).padStart(6)}`
      + `  ${String(Math.round(phaseSec)).padStart(7)}  ${String(clean.length).padStart(5)}`
      + `  ${String(bins.length).padStart(5)}  ${v.venue.padEnd(12)}`
      + `${tws.length ? `${Math.min(...tws).toFixed(1)}-${Math.max(...tws).toFixed(1)}` : '-'.padEnd(9)}`
      + `  ${bins.length ? `${Math.round(vectorMeanDir(bins.map((b) => b.tws), bins.map((b) => b.twd)))}°` : ''}`
      + `${thin ? `   (${thin} bin(s) under ${MIN_SAMPLES} samples dropped)` : ''}`)
    if (VERBOSE) {
      console.log(`      event ${evPath.split('/').pop()}  offset +${offMin / 60} h (${off.from})`
        + `  magvar +${mv.value} (${mv.from})  location "${ev.meta?.location}"`)
      console.log(`      phases ${new Date(sorted[0].utc).toISOString().slice(11, 19)}`
        + `..${new Date(sorted[sorted.length - 1].endUtc).toISOString().slice(11, 19)}Z`
        + `, log ${new Date(all[0].utc).toISOString().slice(11, 19)}`
        + `..${new Date(all[all.length - 1].utc).toISOString().slice(11, 19)}Z`)
    }
  }

  const HEAD = 'venue,regatta_id,t_start_utc,t_end_utc,lat,lon,tws_kn,twd_deg,gust_kn,'
    + 'mast_height_m,mean_heel_deg,ref_frame,calibration_version,n_samples'
  const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + 'Z'

  console.log(`\n${'─'.repeat(78)}`)
  for (const [venue, bins] of Array.from(byVenue.entries()).sort()) {
    bins.sort((a, b) => a.t0 - b.t0)
    const tws = bins.map((b) => b.tws).sort((a, b) => a - b)
    const q = (p: number) => tws[Math.min(tws.length - 1, Math.floor(p * tws.length))]
    const regattas = Array.from(new Set(bins.map((b) => b.regatta)))
    console.log(`\n${venue}: ${bins.length} bins, regatta id(s) ${regattas.join(', ')}`)
    console.log(`  tws  median ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  max ${tws[tws.length - 1].toFixed(1)} kn`)
    for (const t of [12, 16, 18, 20, 22]) {
      const c = bins.filter((b) => b.tws >= t).length
      if (c) console.log(`    >= ${t} kn: ${c} bins (${(100 * c / bins.length).toFixed(1)}%)`)
    }
    console.log(`  samples per bin: min ${Math.min(...bins.map((b) => b.n))},`
      + ` median ${bins.map((b) => b.n).sort((a, b) => a - b)[Math.floor(bins.length / 2)]},`
      + ` max ${Math.max(...bins.map((b) => b.n))} of ${BIN_MIN * 60}`)
    if (WRITE) {
      mkdirSync(OUT_DIR, { recursive: true })
      const f = join(OUT_DIR, `obs_${venue}_2026.csv`)
      const rows = bins.map((b) => [
        b.venue, b.regatta, iso(b.t0), iso(b.t1), b.lat, b.lon, b.tws, b.twd, b.gust,
        MAST_M.toFixed(1), b.heel, 'ground', 'oppositetack_phases', b.n,
      ].join(','))
      writeFileSync(f, `${HEAD}\n${rows.join('\n')}\n`)
      console.log(`  wrote ${f}`)
    }
  }
  if (!byVenue.size) console.log('\nNo bins produced.')
  else if (!WRITE) console.log(`\n${'─'.repeat(78)}\n(dry run — add --write to write the obs CSVs)`)
}

main()
