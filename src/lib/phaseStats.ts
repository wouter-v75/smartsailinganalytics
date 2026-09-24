// src/lib/phaseStats.ts
// ─────────────────────────────────────────────────────────────────────────────
// Phase-averaged performance stats — the data behind the KND-style X-Y plots,
// speed-vs-TWA charts and report tables. One PhaseStat per event-file <phase>
// (30 s steady-state segments written by the onboard assistant), holding the mean
// and max of every channel in CHANNELS over the log rows inside that phase.
//
// Validated against the KND SailingPerf "Phase report" for 2026-09-11 (Northstar 76):
// the 139 event-file phases ARE the report's phases, and the 6 s cloud log reproduces
// its group means (see __tests__/phaseStats.fixture.test.ts). Findings baked in here:
//   • <sailingmode> is NOT tack-specific on these files: 1 = upwind, 2 = reaching,
//     8 = downwind, on both tacks. Tack comes from the sign of the phase's mean TWA
//     (positive = starboard).
//   • KND's "Rud" is the port rudder on starboard tack and the NEGATED starboard
//     rudder on port tack (for boats logging RUDD_P / RUDD_S rather than one RUDDER).
//   • V1_WWD / V1_LWD are V1 S / V1 P swapped by tack (stbd tack: windward = S).
//   • BSPpol% / VMG% are computed from the POLAR, not the log's PolBsp% column.
//
// Pure — no React. Callers pass the day's log rows, parsed event XML and
// (optionally) a prepared polar from polarCalc.
// ─────────────────────────────────────────────────────────────────────────────

import { polarInterp, polarVMGTarget } from './polarCalc'
import { activeSailsAt, pointOfSail } from './scanEnrich'

export type Mode = 'up' | 'down' | 'reach'
export type Tack = 'port' | 'stbd'

export type LogRow = { utc: number } & Record<string, number | null | undefined>

export interface Phase { utc: number; endUtc: number; mode: number }

export interface ChannelCtx { tack: Tack; mode: Mode; polar: any }

export interface Channel {
  key: string
  label: string        // KND-style axis label
  unit: string
  decimals: number
  modes: Mode[]        // points of sail where the channel is charted
  needsPolar?: boolean
  lo?: number          // plausibility caps: samples outside [lo, hi] are ignored
  hi?: number
  minSamples?: number  // fewer valid samples in a phase → no value for it
  get: (r: LogRow, ctx: ChannelCtx) => number | null
}

export interface PhaseStat {
  utc: number
  endUtc: number
  mode: Mode
  tack: Tack
  sails: string[]
  sailCombo: string    // headsails/kites only, e.g. "A2+B 2026/J4_A 2026"
  race: number | null  // 1-based, from the event file's start guns; null before the first gun
  n: number            // log rows inside the phase
  mean: Record<string, number | null>
  max: Record<string, number | null>
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const abs = (v: unknown): number | null => {
  const n = num(v)
  return n == null ? null : Math.abs(n)
}
const rad = (deg: number) => (deg * Math.PI) / 180

const UP_DOWN: Mode[] = ['up', 'down']
const ALL: Mode[] = ['up', 'down', 'reach']

// Lidar sail shape (flatLogParse.lidarKeyOf keys): measured camber / draft / twist per
// stripe and the targets. KND's filters: samples outside CA 0–20 %, DR 20–80 %, TW 0–60°
// are ignored and a phase needs 5 valid samples — targets are taken as logged (the
// lidar tables drop phases whose target sits below its floor).
const LIDAR_VARS = [
  { v: 'Ca', label: 'CA', unit: '%', lo: 0, hi: 20 },
  { v: 'Dr', label: 'DR', unit: '%', lo: 20, hi: 80 },
  { v: 'Tw', label: 'TW', unit: '°', lo: 0, hi: 60 },
]
const LIDAR_CHANNELS: Channel[] = (['mn', 'jib', 'spi'] as const).flatMap(sail =>
  LIDAR_VARS.flatMap(({ v, label, unit, lo, hi }) =>
    [25, 50, 75].flatMap(h => {
      const key = `${sail}${v}${h}`
      const tKey = `t${sail.charAt(0).toUpperCase()}${sail.slice(1)}${v}${h}`
      const name = `${sail.toUpperCase()} ${label}${h}`
      return [
        { key, label: name, unit, decimals: 1, modes: ALL, lo, hi, minSamples: 5, get: (r: LogRow) => num(r[key]) },
        { key: tKey, label: `${name} target`, unit, decimals: 1, modes: ALL, minSamples: 5, get: (r: LogRow) => num(r[tKey]) },
      ]
    })))

// Order = chart order in the X-Y grids (matches the KND report).
export const CHANNELS: Channel[] = [
  { key: 'tws', label: 'TWS', unit: 'kn', decimals: 1, modes: ALL, get: r => num(r.tws) },
  { key: 'bsp', label: 'BSP', unit: 'kn', decimals: 2, modes: ALL, get: r => num(r.bsp) },
  { key: 'sog', label: '|SOG|', unit: 'kn', decimals: 2, modes: ALL, get: r => abs(r.sog) },
  { key: 'twa', label: '|TWA|', unit: '°', decimals: 1, modes: ALL, get: r => abs(r.twa) },
  { key: 'awa', label: '|AWA|', unit: '°', decimals: 1, modes: ALL, get: r => abs(r.awa) },
  { key: 'heel', label: '|HEEL|', unit: '°', decimals: 1, modes: ALL, get: r => abs(r.heel) },
  { key: 'trim', label: 'TRIM', unit: '°', decimals: 1, modes: ALL, get: r => num(r.trim) },
  // Forestay LOAD in tonnes: the pin load when the export has it, otherwise the
  // Forestay column (which on the N76 Sept 2026 export carries the load, 16 t upwind).
  { key: 'fsty', label: '|FORESTAY|', unit: 't', decimals: 2, modes: ALL, get: r => abs(r.fstyPin ?? r.forestay) },
  {
    key: 'rudder', label: 'RUDDER', unit: '°', decimals: 1, modes: ALL,
    get: (r, { tack }) => {
      const single = num(r.rudder)
      if (single != null) return single
      const v = tack === 'stbd' ? num(r.ruddP) : num(r.ruddS)
      return v == null ? null : tack === 'stbd' ? v : -v
    },
  },
  // TOE-IN — the angle between the two rudders on a twin-rudder boat, as the crew
  // define it: STARBOARD MINUS PORT. Not tack-dependent and deliberately NOT
  // absolute: the sign is the whole point, and flipping it by tack the way `rudder`
  // does would average two opposite conventions into nothing.
  //
  // On the Northstar 76 this sits around −1.2° through a day, swinging to ±15°
  // in a manoeuvre, so ±20° is a plausibility cap that rejects a dropout without
  // clipping anything real. It needs BOTH rudders: one alone says nothing about
  // the angle between them, and a phase logging only one gets no value rather
  // than half an answer.
  {
    key: 'toeIn', label: 'TOE-IN', unit: '°', decimals: 2, modes: ALL, lo: -20, hi: 20,
    get: r => {
      const port = num(r.ruddP), stbd = num(r.ruddS)
      return port == null || stbd == null ? null : stbd - port
    },
  },
  { key: 'jibTack', label: 'JibTack', unit: 't', decimals: 2, modes: ALL, get: r => num(r.jibTackLoad) },
  { key: 'vang', label: 'Vang', unit: 't', decimals: 2, modes: ALL, get: r => num(r.vang) },
  { key: 'cunningham', label: 'Cunningham', unit: 't', decimals: 2, modes: ALL, get: r => num(r.cunninghamLoad) },
  { key: 'mainsheet', label: 'Mainsheet', unit: 't', decimals: 2, modes: ALL, get: r => num(r.mainsheetLoad) },
  { key: 'bobstay', label: 'Bobstay', unit: 't', decimals: 2, modes: ['down', 'reach'], get: r => num(r.bobstay) },
  { key: 'upDflct', label: 'UpDfclt%', unit: '%', decimals: 1, modes: ['down'], get: r => num(r.upDflctPct) },
  { key: 'lwDflct', label: 'LwDfclt%', unit: '%', decimals: 1, modes: ['down'], get: r => num(r.lwDflctPct) },
  { key: 'v1wwd', label: 'V1_WWD', unit: 't', decimals: 2, modes: ALL, get: (r, { tack }) => num(tack === 'stbd' ? r.v1s : r.v1p) },
  { key: 'v1lwd', label: 'V1_LWD', unit: 't', decimals: 2, modes: ALL, get: (r, { tack }) => num(tack === 'stbd' ? r.v1p : r.v1s) },
  {
    key: 'bspPol', label: 'BSPpol%', unit: '%', decimals: 1, modes: ALL, needsPolar: true,
    get: (r, { polar }) => {
      const bsp = num(r.bsp), tws = num(r.tws), twa = abs(r.twa)
      if (!polar || bsp == null || tws == null || twa == null || bsp < 0.3) return null
      const target = polarInterp(polar, tws, twa)
      return target && target > 0.5 ? (100 * bsp) / target : null
    },
  },
  {
    key: 'vmgPct', label: 'VMG%', unit: '%', decimals: 1, modes: UP_DOWN, needsPolar: true,
    get: (r, { polar, mode }) => {
      const bsp = num(r.bsp), tws = num(r.tws), twa = abs(r.twa)
      if (!polar || mode === 'reach' || bsp == null || tws == null || twa == null) return null
      const t = polarVMGTarget(polar, tws)
      const target = mode === 'up' ? t.upVMG : t.downVMG
      const vmg = bsp * (mode === 'up' ? Math.cos(rad(twa)) : Math.cos(rad(180 - twa)))
      return target > 0.001 ? (100 * vmg) / target : null
    },
  },
  // Boat speed through the water over speed over ground, per sample — KND's "BSP/SOG %"
  // (11 Sep upwind port 103.5 vs KND 103.3). Off below 1 kn SOG, where the ratio blows up.
  {
    key: 'bspSog', label: 'BSP/SOG%', unit: '%', decimals: 1, modes: ALL,
    get: r => {
      const bsp = num(r.bsp), sog = abs(r.sog)
      return bsp == null || sog == null || sog < 1 ? null : (100 * bsp) / sog
    },
  },
  // The log's own performance columns — the fallback when no polar is loaded.
  { key: 'logPolPct', label: 'PolBsp% (log)', unit: '%', decimals: 1, modes: ALL, get: r => num(r.vsPerfPct) },
  { key: 'logTrgPct', label: 'BSP_trg% (log)', unit: '%', decimals: 1, modes: ALL, get: r => num(r.vsTargPct) },
  ...LIDAR_CHANNELS,
]

export const CHANNEL_BY_KEY: Record<string, Channel> =
  Object.fromEntries(CHANNELS.map(c => [c.key, c]))

// Event-file <sailingmode> codes seen on SailingPerformance files. Anything else
// falls back to the phase's mean |TWA|.
const MODE_CODES: Record<number, Mode> = { 1: 'up', 2: 'reach', 8: 'down' }

function modeFor(code: number, meanTwa: number): Mode {
  const m = MODE_CODES[code]
  if (m) return m
  const pos = pointOfSail(meanTwa)
  return pos === 'upwind' ? 'up' : pos === 'downwind' ? 'down' : 'reach'
}

export const isMainsail = (s: string) => /^main/i.test(s.trim())

// "A2+B 2026/J4_A 2026" — the non-main sails, sorted, the way KND labels its groups.
export function sailComboLabel(sails: string[]): string {
  const rest = sails.filter(s => !isMainsail(s)).map(s => s.trim()).sort()
  return rest.length ? rest.join('/') : sails.join('/')
}

// First index with rows[i].utc >= utc (rows sorted by utc).
function lowerBound(rows: LogRow[], utc: number): number {
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].utc < utc) lo = mid + 1
    else hi = mid
  }
  return lo
}

// The start sequence belongs to the race it is a sequence FOR. A phase five minutes
// before the gun is the approach, the line-up and the final tuning run — the part of a
// race people argue about most — and counting it as "no race", or worse as the tail of
// the previous one, hides it from every question asked about that race.
//
// Five minutes because that is the warning signal in this fleet (the same
// DEFAULT_WARNING_LEAD_SEC the day segmenter uses); a class sailing a 3- or 10-minute
// sequence would want its own number.
export const WARNING_LEAD_MS = 300_000

export interface PhaseStatsOpts {
  polar?: any
  minSamples?: number  // phases with fewer log rows are skipped (default 3)
}

export function computePhaseStats(
  rows: LogRow[] | null | undefined,
  xml: any,
  opts: PhaseStatsOpts = {}
): PhaseStat[] {
  const phases: Phase[] = xml?.phases || []
  if (!rows?.length || !phases.length) return []
  const minSamples = opts.minSamples ?? 3
  const polar = opts.polar ?? null
  const sorted = [...phases].sort((a, b) => a.utc - b.utc)
  const guns: number[] = (xml?.raceGuns || [])
    .map((g: any) => g?.utc)
    .filter((u: unknown): u is number => typeof u === 'number' && Number.isFinite(u))
    .sort((a: number, b: number) => a - b)
  const out: PhaseStat[] = []

  for (const p of sorted) {
    const i0 = lowerBound(rows, p.utc)
    const i1 = lowerBound(rows, p.endUtc)
    const inside = rows.slice(i0, i1)
    if (inside.length < minSamples) continue

    let twaSum = 0, twaN = 0
    for (const r of inside) {
      const t = num(r.twa)
      if (t != null) { twaSum += t; twaN++ }
    }
    if (!twaN) continue
    const meanTwa = twaSum / twaN
    const tack: Tack = meanTwa >= 0 ? 'stbd' : 'port'
    const mode = modeFor(p.mode, meanTwa)
    const ctx: ChannelCtx = { tack, mode, polar }

    const mean: Record<string, number | null> = {}
    const max: Record<string, number | null> = {}
    for (const ch of CHANNELS) {
      let s = 0, k = 0, mx = -Infinity
      for (const r of inside) {
        const v = ch.get(r, ctx)
        if (v == null || (ch.lo != null && v < ch.lo) || (ch.hi != null && v > ch.hi)) continue
        s += v; k++
        if (v > mx) mx = v
      }
      const enough = k > 0 && k >= (ch.minSamples ?? 1)
      mean[ch.key] = enough ? s / k : null
      max[ch.key] = enough ? mx : null
    }

    const sails = activeSailsAt(xml, (p.utc + p.endUtc) / 2)
    // The race under way, or — inside the last five minutes before a gun — the race
    // about to start.
    //
    // With one guard: the phase must be NEARER the coming gun than the last one. Two
    // classes can start three minutes apart, and then a phase two minutes before the
    // second gun is one minute into the first race — it is being raced, not prepared
    // for, and calling it the next race's approach would be wrong.
    let race = guns.filter(g => g <= p.utc).length
    const next = guns.findIndex(g => g > p.utc)
    if (next >= 0 && guns[next] - p.utc <= WARNING_LEAD_MS) {
      const prev = next > 0 ? guns[next - 1] : null
      if (prev == null || guns[next] - p.utc < p.utc - prev) race = next + 1
    }
    out.push({
      utc: p.utc, endUtc: p.endUtc, mode, tack, sails,
      sailCombo: sailComboLabel(sails), race: race || null, n: inside.length, mean, max,
    })
  }
  return out
}

// ── Bands ───────────────────────────────────────────────────────────────────
// KND's report tables split phases into bands labelled "under 21", "21-23",
// "25 plus" (lower bound inclusive). Edges are either given, or placed on
// multiples of the band width across the middle 80 % of the day's values so the
// tails fold into the "under"/"plus" bands rather than one-phase slivers.

export type BandChannel = 'tws' | 'twa' | 'heel'

export interface Band { label: string; order: number }

// 2 kn TWS, 2° heel, 2° TWA upwind and 4° off the wind (the KND report's widths).
export function bandWidth(ch: BandChannel, mode?: Mode): number {
  return ch === 'twa' && mode && mode !== 'up' ? 4 : 2
}

// `offset` shifts the edges off the multiples: TWS bands use offset 1 (edges 21 · 23 · 25)
// so each 2 kn band is centred on an even wind speed — KND's upwind wind-band table on
// 11 Sep, and the same bands as the speed-vs-TWA charts (phasePlot.twsBands).
export function autoBandEdges(values: number[], width: number, offset = 0): number[] {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return []
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]
  const lo = Math.ceil((q(0.1) - offset) / width) * width + offset
  const hi = Math.floor((q(0.9) - offset) / width) * width + offset
  const edges: number[] = []
  for (let e = lo; e <= hi + 1e-9; e += width) edges.push(e)
  return edges.length ? edges : [Math.round((q(0.5) - offset) / width) * width + offset]
}

export function bandOf(value: number | null | undefined, edges: number[]): Band | null {
  if (value == null || !Number.isFinite(value) || !edges.length) return null
  const f = (x: number) => String(Math.round(x * 10) / 10)
  if (value < edges[0]) return { label: `under ${f(edges[0])}`, order: 0 }
  for (let i = 1; i < edges.length; i++) {
    if (value < edges[i]) return { label: `${f(edges[i - 1])}-${f(edges[i])}`, order: i }
  }
  return { label: `${f(edges[edges.length - 1])} plus`, order: edges.length }
}

// ── Grouping ────────────────────────────────────────────────────────────────

export type GroupKey = 'mode' | 'tack' | 'sailCombo' | 'race' | 'twsBand' | 'twaBand' | 'heelBand'

const BAND_CHANNEL: Partial<Record<GroupKey, BandChannel>> = { twsBand: 'tws', twaBand: 'twa', heelBand: 'heel' }
const MODE_ORDER: Record<Mode, number> = { up: 0, reach: 1, down: 2 }
const TACK_ORDER: Record<Tack, number> = { port: 0, stbd: 1 }

export interface GroupOpts {
  edges?: Partial<Record<BandChannel, number[]>>  // inner band edges; automatic when absent
}

export interface PhaseGroup {
  key: Partial<Record<GroupKey, string>>
  phases: PhaseStat[]
  n: number
  mean: Record<string, number | null>   // mean of the per-phase means
  max: Record<string, number | null>    // max of the per-phase maxima
}

// Groups in a stable order: mode (up, reach, down), tack (port, stbd), race, bands
// ascending, sails alphabetical. Phases with no value for a key (no race yet, no
// TWS for a TWS band) are left out of that grouping.
export function groupPhases(stats: PhaseStat[], by: GroupKey[], opts: GroupOpts = {}): PhaseGroup[] {
  const modes = Array.from(new Set(stats.map(s => s.mode)))
  const edges: Partial<Record<BandChannel, number[]>> = {}
  for (const k of by) {
    const ch = BAND_CHANNEL[k]
    if (!ch || edges[ch]) continue
    const width = bandWidth(ch, modes.length === 1 ? modes[0] : undefined)
    edges[ch] = opts.edges?.[ch]
      ?? autoBandEdges(stats.map(s => s.mean[ch] ?? NaN), width, ch === 'tws' ? width / 2 : 0)
  }

  const part = (s: PhaseStat, k: GroupKey): Band | null => {
    const ch = BAND_CHANNEL[k]
    if (ch) return bandOf(s.mean[ch], edges[ch] || [])
    if (k === 'mode') return { label: s.mode, order: MODE_ORDER[s.mode] }
    if (k === 'tack') return { label: s.tack, order: TACK_ORDER[s.tack] }
    if (k === 'race') return s.race == null ? null : { label: String(s.race), order: s.race }
    return { label: s.sailCombo, order: 0 }
  }

  const buckets = new Map<string, { parts: Band[]; phases: PhaseStat[] }>()
  for (const s of stats) {
    const parts = by.map(k => part(s, k))
    if (parts.some(p => p == null)) continue
    const id = parts.map(p => p!.label).join('|')
    const b = buckets.get(id)
    if (b) b.phases.push(s)
    else buckets.set(id, { parts: parts as Band[], phases: [s] })
  }

  return Array.from(buckets.values())
    .sort((a, b) => {
      for (let i = 0; i < by.length; i++) {
        const d = a.parts[i].order - b.parts[i].order || a.parts[i].label.localeCompare(b.parts[i].label)
        if (d) return d
      }
      return 0
    })
    .map(({ parts, phases }) => {
      const mean: Record<string, number | null> = {}
      const max: Record<string, number | null> = {}
      for (const ch of CHANNELS) {
        let s = 0, k = 0, mx = -Infinity
        for (const p of phases) {
          const v = p.mean[ch.key]
          if (v != null) { s += v; k++ }
          const m = p.max[ch.key]
          if (m != null && m > mx) mx = m
        }
        mean[ch.key] = k ? s / k : null
        max[ch.key] = mx === -Infinity ? null : mx
      }
      const key = Object.fromEntries(by.map((k, i) => [k, parts[i].label])) as Partial<Record<GroupKey, string>>
      return { key, phases, n: phases.length, mean, max }
    })
}
