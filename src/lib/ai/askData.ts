// src/lib/ai/askData.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where the five tools actually get their numbers: the CLOUD, through the user's
// own Supabase session, so RLS decides what each person can ask about.
//
// It reads the cloud and not the browser's IndexedDB on purpose. Anything derived
// on the importing machine is blank for everyone else — that is how a whole week
// of Porto Cervo photos reached the team with no instruments on them (CLAUDE.md).
// An answer that only works for whoever imported the day is not an answer.
//
// Three deliberate divisions of labour:
//   • The MATHS is groupPhases()/CHANNELS, validated against the KND report. This
//     file filters and shapes; it never invents a statistic.
//   • The CLOCK is handled here and only here. Every timestamp out of this file is
//     already venue-local, because the model must never see a raw one: the log's
//     time column, EXIF and Drime's captured_at are all local wall-time whatever
//     they are called, and reading one as UTC moves the whole day (CLAUDE.md).
//   • The URLs never enter the prompt. Thumbnails and signed links go straight to
//     the screen, so a model that cannot see a link cannot invent one.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js'
import { CHANNELS, groupPhases, type GroupKey, type Mode, type PhaseStat } from '../phaseStats'
import { expandPhases, STATS_VERSION, type StoredPhase } from '../seasonCurves'
import { isJudged, manoeuvreAverages, manoeuvreNote, type Manoeuvre } from '../manoeuvres'
import { signBunnyUrl, bunnyConfigured } from '../bunny-signed-url'
import { linearTrend } from '../phasePlot'
import { rankDrivers } from './drivers'
import { matchesSail, vocabularyBlock } from './vocabulary'
import type {
  ComparePhasesArgs, DayTimeseriesArgs, FindMediaArgs, ListManoeuvresArgs,
  PhaseFilters, RankDriversArgs, ScatterPhasesArgs, SearchNotesArgs, ToolArgs, ToolName,
} from './askTools'
import type { AnswerColumn, AnswerTable, ChartSeries, ChartSpec, MediaItem, ToolResult } from './askTypes'
import { emptyResult } from './askTypes'
import type { AskContext } from './askRisk'

type SB = SupabaseClient<any, any, any>

const CH = new Map(CHANNELS.map(c => [c.key, c]))
const round = (v: number, d: number) => Number(v.toFixed(d))

/** Venue-local clock, from the day's stored tz offset. Never `new Date(x).toISOString()`. */
const hm = (utc: number, tzMin: number) => new Date(utc + tzMin * 60_000).toISOString().slice(11, 16)
const hms = (utc: number, tzMin: number) => new Date(utc + tzMin * 60_000).toISOString().slice(11, 19)

interface DayRow {
  date: string
  phases: StoredPhase[]
  manoeuvres: Manoeuvre[]
  polar_name: string | null
  resolution_s: number | null
}

export interface AskDeps {
  supabase: SB
  teamId: string
  boatId: string
  /** The day open on screen — the default for every tool that does not name one. */
  openDate: string
  /** Venue offset in minutes per date. */
  tzByDate: Map<string, number>
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadDays(d: AskDeps, from: string, to: string): Promise<DayRow[]> {
  const { data, error } = await d.supabase
    .from('session_phase_stats')
    .select('date, phases, manoeuvres, polar_name, resolution_s')
    .eq('team_id', d.teamId)
    .eq('boat_id', d.boatId)
    .eq('stats_version', STATS_VERSION)
    .gte('date', from)
    .lte('date', to)
    .order('date')
  if (error) throw new Error(error.message)
  return (data || []) as DayRow[]
}

/** Phases across a range, each carrying the day it came from. */
async function loadPhases(d: AskDeps, from: string, to: string): Promise<(PhaseStat & { date: string })[]> {
  const days = await loadDays(d, from, to)
  return days.flatMap(day => expandPhases(day.phases).map(p => ({ ...p, date: day.date })))
}

const tzOf = (d: AskDeps, date: string) => d.tzByDate.get(date) ?? 0

// ── Filtering ────────────────────────────────────────────────────────────────

const within = (v: number | null | undefined, lo?: number, hi?: number) => {
  if (lo == null && hi == null) return true
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  if (lo != null && v < lo) return false
  if (hi != null && v > hi) return false
  return true
}

/** Pure — the one place a filter is applied, so the chips and the numbers cannot drift apart. */
export function filterPhases<T extends PhaseStat>(stats: T[], f: PhaseFilters): T[] {
  return stats.filter(s => {
    if (f.modes?.length && !f.modes.includes(s.mode)) return false
    if (f.tack && s.tack !== f.tack) return false
    if (f.race != null && s.race !== f.race) return false
    // Squashed match, not a literal one: the inventory holds "J2_A_2026" next to
    // "J2_B 2026", so a literal substring makes the filter a spelling test.
    if (f.sailCombo && !matchesSail(s.sailCombo, f.sailCombo)) return false
    if (!within(s.mean.tws, f.twsMin, f.twsMax)) return false
    if (!within(s.mean.twa, f.twaMin, f.twaMax)) return false
    if (!within(s.mean.heel, f.heelMin, f.heelMax)) return false
    return true
  })
}

// ── compare_phases ───────────────────────────────────────────────────────────

const GROUP_LABEL: Record<string, string> = {
  mode: 'Point of sail', tack: 'Tack', sailCombo: 'Sails', race: 'Race',
  twsBand: 'TWS band (kn)', twaBand: 'TWA band (°)', heelBand: 'Heel band (°)', date: 'Day',
}
const MODE_LABEL: Record<string, string> = { up: 'Upwind', down: 'Downwind', reach: 'Reaching' }
const TACK_LABEL: Record<string, string> = { port: 'Port', stbd: 'Stbd' }
const cellText = (key: string, v: string | undefined) =>
  v == null ? '' : key === 'tack' ? TACK_LABEL[v] || v : key === 'mode' ? MODE_LABEL[v] || v : v

export function buildCompareTable(
  phases: (PhaseStat & { date: string })[],
  args: ComparePhasesArgs,
): AnswerTable {
  const byDate = args.by.includes('date')
  const rest = args.by.filter(k => k !== 'date') as GroupKey[]

  const columns: AnswerColumn[] = [
    ...args.by.map(k => ({ key: k, label: GROUP_LABEL[k] || k, group: true })),
    { key: 'n', label: 'n' },
    ...args.metrics.map(m => {
      const c = CH.get(m)
      return { key: m, label: c?.label || m, unit: c?.unit || '', decimals: c?.decimals ?? 2 }
    }),
  ]

  const rows: (string | number | null)[][] = []
  let droppedThin = 0

  const partitions: [string | null, (PhaseStat & { date: string })[]][] = byDate
    ? Array.from(new Set(phases.map(p => p.date))).sort().map(d => [d, phases.filter(p => p.date === d)])
    : [[null, phases]]

  for (const [date, part] of partitions) {
    // groupPhases with no keys is not a grouping — one row for the whole partition.
    const groups = rest.length
      ? groupPhases(part, rest)
      : part.length
        ? [{ key: {} as Partial<Record<GroupKey, string>>, phases: part, n: part.length, mean: meanOf(part), max: {} }]
        : []
    for (const g of groups) {
      if (g.n < args.minPhases) { droppedThin++; continue }
      rows.push([
        ...args.by.map(k => (k === 'date' ? (date ?? '') : cellText(k, g.key[k as GroupKey]))),
        g.n,
        ...args.metrics.map(m => {
          const v = g.mean[m]
          return typeof v === 'number' && Number.isFinite(v) ? round(v, CH.get(m)?.decimals ?? 2) : null
        }),
      ])
    }
  }

  return {
    title: `${args.metrics.map(m => CH.get(m)?.label || m).join(', ')} by ${args.by.map(k => (GROUP_LABEL[k] || k).toLowerCase()).join(' × ')}`,
    columns,
    rows,
    ...(droppedThin ? { droppedThin } : {}),
  }
}

// ── scatter_phases ───────────────────────────────────────────────────────────
// The KND X-Y plot: one dot per phase, coloured by tack, with a least-squares
// line and R² through each colour. The app has drawn this for a long time
// (PhaseXYPlot); it simply was not reachable by asking, so the first person to
// ask for "a scatter of BSP against SOG" got two traces against the clock.
//
// The dots go in the CHART. The model is given the summary table only — n, the
// means, the slope and R² per series. Hundreds of coordinate pairs would tell it
// nothing it can put in a sentence, and would crowd out everything that does.

const SPLIT_LABEL: Record<string, string> = {
  tack: 'Tack', sailCombo: 'Sails', mode: 'Point of sail', date: 'Day', none: 'All phases',
}

const seriesKeyOf = (p: PhaseStat & { date: string }, splitBy: string): string => {
  if (splitBy === 'tack') return TACK_LABEL[p.tack] || p.tack
  if (splitBy === 'mode') return MODE_LABEL[p.mode] || p.mode
  if (splitBy === 'sailCombo') return p.sailCombo || '—'
  if (splitBy === 'date') return p.date
  return 'All phases'
}

export function buildScatter(
  phases: (PhaseStat & { date: string })[],
  a: ScatterPhasesArgs,
  from: string,
  to: string,
): ToolResult {
  const xCh = CH.get(a.x), yCh = CH.get(a.y)
  const xd = xCh?.decimals ?? 2, yd = yCh?.decimals ?? 2

  // One point per phase that HAS both values. A phase missing either is not a
  // dot at the origin; it is not a dot.
  const pts = phases
    .map(p => ({ p, x: p.mean[a.x], y: p.mean[a.y] }))
    .filter((q): q is { p: PhaseStat & { date: string }; x: number; y: number } =>
      typeof q.x === 'number' && Number.isFinite(q.x) && typeof q.y === 'number' && Number.isFinite(q.y))
  if (!pts.length) {
    return emptyResult('', `No phase between ${from} and ${to} has both ${xCh?.label || a.x} and ${yCh?.label || a.y}.`)
  }

  const keys: string[] = []
  for (const q of pts) {
    const k = seriesKeyOf(q.p, a.splitBy)
    if (!keys.includes(k)) keys.push(k)
  }
  keys.sort()

  // Thin evenly across the whole range when there are more dots than asked for,
  // so the shape of the cloud survives — never take the first N, which would
  // quietly crop the chart to the start of the season.
  const step = Math.max(1, Math.ceil(pts.length / a.maxPoints))

  const series: ChartSeries[] = []
  const rows: (string | number | null)[][] = []
  for (const k of keys) {
    const own = pts.filter(q => seriesKeyOf(q.p, a.splitBy) === k)
    const drawn = step > 1 ? own.filter((_, i) => i % step === 0) : own
    // The trend is fitted to EVERY point, not to the thinned ones drawn: the line
    // and its R² describe the data, not the sample that fitted on screen.
    const trend = a.trend ? linearTrend(own) : null
    series.push({
      label: k,
      points: drawn.map(q => ({ x: round(q.x, xd), y: round(q.y, yd) })),
      trend,
      n: own.length,
    })
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
    rows.push([
      k, own.length,
      round(mean(own.map(q => q.x)), xd),
      round(mean(own.map(q => q.y)), yd),
      trend ? round(trend.slope, 3) : null,
      trend ? round(trend.r2, 2) : null,
    ])
  }

  const columns: AnswerColumn[] = [
    { key: 'series', label: SPLIT_LABEL[a.splitBy] || 'Series', group: true },
    { key: 'n', label: 'n' },
    { key: 'meanX', label: `mean ${xCh?.label || a.x}`, unit: xCh?.unit || '', decimals: xd },
    { key: 'meanY', label: `mean ${yCh?.label || a.y}`, unit: yCh?.unit || '', decimals: yd },
    { key: 'slope', label: 'trend slope', decimals: 3 },
    { key: 'r2', label: 'R²', decimals: 2 },
  ]

  const chart: ChartSpec = {
    kind: 'scatter',
    title: `${yCh?.label || a.y} vs ${xCh?.label || a.x}`,
    xType: 'number',
    xLabel: xCh?.label || a.x,
    yLabel: yCh?.label || a.y,
    unit: yCh?.unit || '',
    xUnit: xCh?.unit || '',
    series,
  }

  const span = from === to ? from : `${from} to ${to}`
  const thinned = step > 1 ? `, ${series.reduce((n, s) => n + s.points.length, 0)} of them drawn` : ''
  return {
    summary: `${pts.length} phases with both channels over ${span}${thinned}. Trend slope and R² are fitted to every phase, not just the drawn ones.`,
    tables: [{ title: `${yCh?.label || a.y} vs ${xCh?.label || a.x}, ${span}`, columns, rows }],
    media: [],
    charts: [chart],
  }
}

// ── rank_drivers ─────────────────────────────────────────────────────────────
// "What is the dominant parameter to get right for optimum VMG% in 12-14 kn?"
//
// The maths is in ./drivers — banded, so a channel with an OPTIMUM (heel: slow
// below it and slow above it) is found rather than scored at zero by a
// correlation. What this file adds is the vocabulary: which channels are worth
// testing, and which must never be, because they are the target wearing a hat.

// Ranking bsp against vmgPct discovers that going fast makes you go fast. These
// are the same quantity restated, and they would top every ranking forever.
const TAUTOLOGIES: Record<string, string[]> = {
  vmgPct: ['bsp', 'sog', 'bspPol', 'logPolPct', 'logTrgPct', 'bspSog'],
  bspPol: ['bsp', 'sog', 'vmgPct', 'logPolPct', 'logTrgPct', 'bspSog'],
  bsp: ['sog', 'bspPol', 'vmgPct', 'logPolPct', 'logTrgPct', 'bspSog'],
}
// What a crew can actually go and change, plus the things that describe how the
// boat is sitting. TWS is excluded as a candidate — it is the conditions, and it
// is what the confound check measures everything else against.
const DEFAULT_CANDIDATES = [
  'heel', 'trim', 'twa', 'awa', 'rudder', 'fsty', 'mainsheet', 'vang', 'cunningham',
  'jibTack', 'bobstay', 'v1wwd', 'v1lwd', 'upDflct', 'lwDflct',
]

export function buildDrivers(
  phases: (PhaseStat & { date: string })[],
  a: RankDriversArgs,
  from: string,
  to: string,
): ToolResult {
  const banned = new Set([a.target, 'tws', ...(TAUTOLOGIES[a.target] || [])])
  const candidates = (a.candidates?.length ? a.candidates : DEFAULT_CANDIDATES).filter(k => !banned.has(k))
  if (!candidates.length) {
    return emptyResult('', 'Every channel asked for is either the target itself or the same quantity under another name.')
  }

  const rows = phases
    .map(p => ({ values: p.mean, target: p.mean[a.target] }))
    .filter((r): r is { values: Record<string, number | null>; target: number } =>
      typeof r.target === 'number' && Number.isFinite(r.target))
  if (rows.length < 12) {
    return emptyResult('', `Only ${rows.length} phases have ${CH.get(a.target)?.label || a.target} — too few to rank anything.`)
  }

  const { ranked, caveats } = rankDrivers({
    rows, candidates, conditionsKey: 'tws', bands: a.bands, minPerBand: a.minPerBand,
  })
  if (!ranked.length) {
    return emptyResult('', `No channel had enough phases spread across enough of its range to rank, in ${rows.length} phases.`)
  }

  const tLabel = CH.get(a.target)?.label || a.target
  const tDec = CH.get(a.target)?.decimals ?? 1
  const lbl = (k: string) => CH.get(k)?.label || k
  const unit = (k: string) => CH.get(k)?.unit || ''
  const dec = (k: string) => CH.get(k)?.decimals ?? 1

  // Ranked, with the share of variation each accounts for and what it is worth in
  // the target's own units — a share with no size attached persuades nobody.
  const rankTable: AnswerTable = {
    title: `What moves ${tLabel} most, ${from === to ? from : `${from} to ${to}`}`,
    columns: [
      { key: 'channel', label: 'Channel', group: true },
      { key: 'n', label: 'n' },
      { key: 'share', label: 'share of variation', unit: '%', decimals: 0 },
      { key: 'spread', label: `best band − worst`, unit: CH.get(a.target)?.unit || '', decimals: tDec },
      { key: 'bestFrom', label: 'fastest band from', decimals: 1 },
      { key: 'bestTo', label: 'to', decimals: 1 },
      { key: 'confound', label: 'moves with wind?' },
    ],
    rows: ranked.map(dr => [
      lbl(dr.key), dr.n, round(dr.eta2 * 100, 0), round(dr.spread, tDec),
      round(dr.best.lo, dec(dr.key)), round(dr.best.hi, dec(dr.key)),
      dr.rWithConditions >= 0.5 ? 'yes' : '',
    ]),
  }

  // The winner, band by band: this is the row a trimmer can act on.
  const top = ranked[0]
  const bandTable: AnswerTable = {
    title: `${tLabel} by ${lbl(top.key)}${unit(top.key) ? ` (${unit(top.key)})` : ''} band`,
    columns: [
      { key: 'band', label: `${lbl(top.key)} band`, group: true },
      { key: 'n', label: 'n' },
      { key: 'target', label: tLabel, unit: CH.get(a.target)?.unit || '', decimals: tDec },
    ],
    rows: top.bands.map(b => [
      `${round(b.lo, dec(top.key))}–${round(b.hi, dec(top.key))}`, b.n, round(b.mean, tDec),
    ]),
  }

  const chart: ChartSpec = {
    kind: 'bar',
    title: `${tLabel} by ${lbl(top.key)} band`,
    xType: 'category',
    xLabel: `${lbl(top.key)}${unit(top.key) ? ` (${unit(top.key)})` : ''}`,
    yLabel: tLabel,
    unit: CH.get(a.target)?.unit || '',
    series: [{
      label: tLabel,
      points: top.bands.map(b => ({ x: `${round(b.lo, dec(top.key))}–${round(b.hi, dec(top.key))}`, y: round(b.mean, tDec) })),
    }],
  }

  return {
    summary: [
      `${rows.length} phases, ${candidates.length} channels tested.`,
      `${lbl(top.key)} accounts for the most: ${round(top.eta2 * 100, 0)}% of the variation in ${tLabel}, worth ${round(top.spread, tDec)} between its best and worst band, fastest at ${round(top.best.lo, dec(top.key))}–${round(top.best.hi, dec(top.key))}${unit(top.key) ? ` ${unit(top.key)}` : ''}.`,
      'YOU MUST RELAY THESE CAVEATS:',
      ...caveats.map(c => `• ${c}`),
    ].join(' '),
    tables: [rankTable, bandTable],
    media: [],
    charts: [chart],
  }
}

function meanOf(part: PhaseStat[]): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const ch of CHANNELS) {
    let s = 0, k = 0
    for (const p of part) {
      const v = p.mean[ch.key]
      if (typeof v === 'number' && Number.isFinite(v)) { s += v; k++ }
    }
    out[ch.key] = k ? s / k : null
  }
  return out
}

// ── Media ────────────────────────────────────────────────────────────────────

const fastThumb = (path: string | null): string | null => {
  if (!path || !bunnyConfigured()) return null
  return signBunnyUrl({ path: path.replace(/\.jpe?g$/i, '_thumb.jpg'), ttlSec: 6 * 3600 })?.url || null
}
const signedOriginal = (path: string | null): string | null =>
  path && bunnyConfigured() ? signBunnyUrl({ path, ttlSec: 6 * 3600 })?.url || null : null

const instLine = (inst: Record<string, number | null> | null | undefined): string | null => {
  if (!inst) return null
  const bits: string[] = []
  const add = (k: string, label: string, unit: string, d: number) => {
    const v = inst[k]
    if (typeof v === 'number' && Number.isFinite(v)) bits.push(`${label} ${round(Math.abs(v), d)} ${unit}`)
  }
  add('tws', 'TWS', 'kn', 1); add('twa', 'TWA', '°', 0); add('bsp', 'BSP', 'kn', 2); add('heel', 'Heel', '°', 0)
  return bits.length ? bits.join(' · ') : null
}

/** A phase that overlaps [a, b] and passes the filters — how a clip or a tag gets conditions. */
const overlapping = (phases: PhaseStat[], a: number, b: number) =>
  phases.filter(p => p.endUtc >= a && p.utc <= b)

// ── The executor ─────────────────────────────────────────────────────────────

export function makeExecutor(d: AskDeps) {
  const dayRange = (from?: string, to?: string): [string, string] => [from || to || d.openDate, to || from || d.openDate]

  return async function execute(name: ToolName, args: ToolArgs): Promise<ToolResult> {
    if (name === 'compare_phases') {
      const a = args as ComparePhasesArgs
      const [from, to] = dayRange(a.dateFrom, a.dateTo)
      const all = await loadPhases(d, from, to)
      if (!all.length) {
        return emptyResult('', from === to
          ? `No stored performance data for ${from}. Someone needs to open that day's Performance charts once so its phases are computed.`
          : `No stored performance data between ${from} and ${to}.`)
      }
      const kept = filterPhases(all, a)
      if (!kept.length) {
        return emptyResult('', `Nothing matched that filter — ${all.length} phases in range, none of them inside it. Widen the wind band or drop a filter.`)
      }
      const table = buildCompareTable(kept, a)
      if (!table.rows.length) {
        return emptyResult('', `Every group had fewer than ${a.minPhases} phases, so none is worth reporting. Widen the filter or lower minPhases.`)
      }
      return {
        summary: `${kept.length} phases of ${all.length}, in ${table.rows.length} group${table.rows.length === 1 ? '' : 's'}${table.droppedThin ? `; ${table.droppedThin} group(s) left out for having fewer than ${a.minPhases} phases` : ''}.`,
        tables: [table],
        media: [],
      }
    }

    if (name === 'rank_drivers') {
      const a = args as RankDriversArgs
      const [from, to] = dayRange(a.dateFrom, a.dateTo)
      const all = await loadPhases(d, from, to)
      if (!all.length) return emptyResult('', `No stored performance data between ${from} and ${to}.`)
      const kept = filterPhases(all, a)
      if (kept.length < 12) {
        return emptyResult('', `Only ${kept.length} phases match that filter — far too few to say what matters. Widen the wind band or the date range.`)
      }
      return buildDrivers(kept, a, from, to)
    }

    if (name === 'scatter_phases') {
      const a = args as ScatterPhasesArgs
      const [from, to] = dayRange(a.dateFrom, a.dateTo)
      const all = await loadPhases(d, from, to)
      if (!all.length) {
        return emptyResult('', from === to
          ? `No stored performance data for ${from}. Someone needs to open that day's Performance charts once so its phases are computed.`
          : `No stored performance data between ${from} and ${to}.`)
      }
      const kept = filterPhases(all, a)
      if (!kept.length) {
        return emptyResult('', `Nothing matched that filter — ${all.length} phases in range, none inside it.`)
      }
      return buildScatter(kept, a, from, to)
    }

    if (name === 'day_timeseries') {
      const a = args as DayTimeseriesArgs
      const date = a.date || d.openDate
      const tz = tzOf(d, date)
      const { data, error } = await d.supabase
        .from('sessions')
        .select('rows:log_data->rows')
        .eq('team_id', d.teamId).eq('boat_id', d.boatId).eq('date', date)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const rows = ((data as { rows?: Record<string, number>[] } | null)?.rows || [])
      if (!rows.length) return emptyResult('', `No log for ${date}.`)

      // A clock window arrives as venue-local HH:MM. Written out longhand on
      // purpose: this is the conversion CLAUDE.md records as having cost a day
      // more than once, and it is not the place to be clever.
      const bound = (clock?: string): number | null => {
        if (!clock) return null
        const [y, mo, dd] = date.split('-').map(Number)
        const [h, mi] = clock.split(':').map(Number)
        if (![y, mo, dd, h, mi].every(Number.isFinite)) return null
        return Date.UTC(y, mo - 1, dd, h, mi) - tz * 60_000
      }
      const lo = bound(a.fromLocal), hi = bound(a.toLocal)
      const win = rows.filter(r => (lo == null || r.utc >= lo) && (hi == null || r.utc <= hi))
      if (!win.length) return emptyResult('', `No log rows between ${a.fromLocal || 'start'} and ${a.toLocal || 'end'} on ${date}.`)

      const step = Math.max(1, Math.ceil(win.length / a.maxPoints))
      const columns: AnswerColumn[] = [
        { key: 'utc', label: 'Time', group: true },
        ...a.channels.map(c => {
          const ch = CH.get(c)
          return { key: c, label: ch?.label || c, unit: ch?.unit || '', decimals: ch?.decimals ?? 2 }
        }),
      ]
      const out: (string | number | null)[][] = []
      for (let i = 0; i < win.length; i += step) {
        const r = win[i]
        out.push([r.utc, ...a.channels.map(c => {
          const v = r[c] ?? r[c.toLowerCase()]
          return typeof v === 'number' && Number.isFinite(v) ? round(v, CH.get(c)?.decimals ?? 2) : null
        })])
      }
      return {
        summary: `${date}, ${hms(win[0].utc, tz)} to ${hms(win[win.length - 1].utc, tz)} local, ${out.length} points from ${win.length} rows.`,
        tables: [{ title: `${a.channels.join(', ')} through ${date}`, columns, rows: out, tzOffsetMin: tz }],
        media: [],
      }
    }

    if (name === 'list_manoeuvres') {
      const a = args as ListManoeuvresArgs
      const date = a.date || d.openDate
      const tz = tzOf(d, date)
      const days = await loadDays(d, date, date)
      const list = (days[0]?.manoeuvres || []).filter(m =>
        (a.kind === 'all' || m.kind === a.kind) && (a.race == null || m.race === a.race))
      const judged = list.filter(isJudged)
      if (!judged.length) {
        return emptyResult('', `No judged ${a.kind === 'all' ? 'manoeuvres' : `${a.kind}s`} on ${date}${a.race != null ? ` in race ${a.race}` : ''}.`)
      }
      const avg = manoeuvreAverages(judged)
      const r = (v: number | null, dec: number) => (v == null ? null : round(v, dec))
      const columns: AnswerColumn[] = [
        { key: 'time', label: 'Time', group: true },
        { key: 'kind', label: 'Kind', group: true },
        { key: 'race', label: 'Race' },
        { key: 'timeTo95', label: 'Time to 95% BSP', unit: 's', decimals: 0 },
        { key: 'distLost', label: 'Distance lost', unit: 'm', decimals: 1 },
        { key: 'turnAngle', label: 'Turn angle', unit: '°', decimals: 1 },
        { key: 'note', label: 'Note' },
      ]
      const rows: (string | number | null)[][] = judged.map(m => [
        hm(m.utc, tz), m.kind, m.race, r(m.timeTo95, 0), r(m.distLost, 1), r(m.turnAngle, 1), manoeuvreNote(m) || '',
      ])
      rows.push(['AVERAGE', a.kind, null, r(avg.timeTo95, 0), r(avg.distLost, 1), r(avg.turnAngle, 1), `${judged.length} judged`])
      return {
        summary: `${judged.length} judged of ${list.length} on ${date}. Times are venue-local.`,
        tables: [{ title: `Manoeuvres on ${date}`, columns, rows }],
        media: [],
      }
    }

    if (name === 'find_media') return findMedia(d, args as FindMediaArgs, dayRange)
    return searchNotes(d, args as SearchNotesArgs, dayRange)
  }
}

// ── find_media ───────────────────────────────────────────────────────────────

async function findMedia(
  d: AskDeps,
  a: FindMediaArgs,
  dayRange: (f?: string, t?: string) => [string, string],
): Promise<ToolResult> {
  const [from, to] = dayRange(a.dateFrom, a.dateTo)
  const hasConditions = [a.twsMin, a.twsMax, a.twaMin, a.twaMax, a.heelMin, a.heelMax].some(v => v != null)
    || !!a.modes?.length || !!a.tack || a.race != null

  // Sessions in range give us id → date, which is how every media row finds its day.
  const { data: sessionRows } = await d.supabase
    .from('sessions')
    .select('id, date')
    .eq('team_id', d.teamId).eq('boat_id', d.boatId)
    .gte('date', from).lte('date', to)
  const dateOf = new Map<string, string>((sessionRows || []).map((s: { id: string; date: string }) => [s.id, s.date]))
  const sessionIds = Array.from(dateOf.keys())

  // Phases only when a condition filter needs them — they are what a clip or a tag
  // is matched against, since neither carries instruments of its own.
  const phasesByDate = new Map<string, PhaseStat[]>()
  if (hasConditions) {
    for (const day of await loadDays(d, from, to)) {
      phasesByDate.set(day.date, filterPhases(expandPhases(day.phases), a))
    }
  }
  const matchesWindow = (date: string | null, t0: number, t1: number) => {
    if (!hasConditions) return true
    if (!date) return false
    return overlapping(phasesByDate.get(date) || [], t0, t1).length > 0
  }

  const items: MediaItem[] = []
  const wantsText = (s: string | null | undefined) =>
    !a.text || (s || '').toLowerCase().includes(a.text.toLowerCase())

  if (a.kinds.includes('photo') && sessionIds.length) {
    const { data } = await d.supabase
      .from('photos')
      .select('id, session_id, taken_utc, thumbnail_url, bunny_storage_path, analysis_data')
      .in('session_id', sessionIds)
      .order('taken_utc', { ascending: false })
      .limit(400)
    for (const p of (data || []) as any[]) {
      const date = dateOf.get(p.session_id) || null
      const utc = p.taken_utc ? new Date(p.taken_utc).getTime() : null
      const inst = p.analysis_data?.inst || null
      const sails: string[] = p.analysis_data?.sails || []
      if (a.sail && !sails.some(s => matchesSail(s, a.sail!))) continue
      // A photo carries its own instruments, so it is judged on those, not on a phase.
      if (hasConditions) {
        if (!within(inst?.tws, a.twsMin, a.twsMax)) continue
        if (!within(inst?.twa == null ? null : Math.abs(inst.twa), a.twaMin, a.twaMax)) continue
        if (!within(inst?.heel == null ? null : Math.abs(inst.heel), a.heelMin, a.heelMax)) continue
      }
      const tz = date ? d.tzByDate.get(date) ?? 0 : 0
      items.push({
        kind: 'photo', id: p.id, title: sails.join(' + ') || 'Photo',
        atLocal: utc == null ? null : hm(utc, tz), utc, date,
        thumbUrl: fastThumb(p.bunny_storage_path) || p.thumbnail_url || null,
        fullUrl: signedOriginal(p.bunny_storage_path),
        conditions: instLine(inst), note: null,
      })
    }
  }

  if (a.kinds.includes('video') && sessionIds.length) {
    const { data } = await d.supabase
      .from('videos')
      .select('id, session_id, title, start_utc, duration_ms, thumbnail_url, bunny_stream_id')
      .in('session_id', sessionIds)
      .order('start_utc', { ascending: false })
      .limit(200)
    for (const v of (data || []) as any[]) {
      if (!wantsText(v.title)) continue
      const date = dateOf.get(v.session_id) || null
      const utc = v.start_utc ? new Date(v.start_utc).getTime() : null
      if (utc != null && !matchesWindow(date, utc, utc + (v.duration_ms || 0))) continue
      if (utc == null && hasConditions) continue
      const tz = date ? d.tzByDate.get(date) ?? 0 : 0
      const phase = utc != null && date ? overlapping(phasesByDate.get(date) || [], utc, utc + (v.duration_ms || 0))[0] : null
      items.push({
        kind: 'video', id: v.id, title: v.title || 'Clip',
        atLocal: utc == null ? null : hm(utc, tz), utc, date,
        thumbUrl: v.thumbnail_url || null, fullUrl: null,
        conditions: phase ? instLine(phase.mean) : null, note: null,
        streamId: v.bunny_stream_id || null, durationMs: v.duration_ms ?? null,
      })
    }
  }

  // Scans carry no session_id at all (0 of 58 on this boat), so their only date is
  // captured_at — and a scan can sit outside every sailing day's range. Counting
  // the ones just outside turns "nothing found" into something actionable.
  let outsideRange = 0
  const outsideDates: string[] = []

  if (a.kinds.includes('sailscan')) {
    const { data, error } = await d.supabase
      .from('sail_scans')
      .select('id, captured_at, tws_kn, twa_deg, summary, notes, photo_id, session_id, sails:sail_id(name)')
      .eq('team_id', d.teamId).eq('boat_id', d.boatId)
      .order('captured_at', { ascending: false })
      .limit(200)
    // A failed query read as an empty one is the worst kind of wrong: it looks
    // exactly like "your boat has none of those".
    if (error) throw new Error(`sail scans: ${error.message}`)
    for (const s of (data || []) as any[]) {
      const date = s.session_id ? dateOf.get(s.session_id) || null : null
      const utc = s.captured_at ? new Date(s.captured_at).getTime() : null
      const sailName: string | null = s.sails?.name || null
      // Sail and text first, so a scan rejected only for its DATE can be counted
      // and reported — "none in that range, but two in June" is an answer.
      if (a.sail && !matchesSail(sailName, a.sail)) continue
      if (!wantsText(s.notes)) continue
      const iso = date || (utc == null ? null : new Date(utc).toISOString().slice(0, 10))
      if (iso && (iso < from || iso > to)) { outsideRange++; outsideDates.push(iso); continue }
      if (hasConditions) {
        if (!within(s.tws_kn, a.twsMin, a.twsMax)) continue
        if (!within(s.twa_deg == null ? null : Math.abs(s.twa_deg), a.twaMin, a.twaMax)) continue
      }
      const tz = date ? d.tzByDate.get(date) ?? 0 : 0
      const cond = [
        s.tws_kn != null ? `TWS ${round(s.tws_kn, 1)} kn` : null,
        s.twa_deg != null ? `TWA ${round(Math.abs(s.twa_deg), 0)} °` : null,
      ].filter(Boolean).join(' · ')
      items.push({
        kind: 'sailscan', id: s.id, title: sailName ? `${sailName} scan` : 'Sail scan',
        atLocal: utc == null ? null : hm(utc, tz), utc, date: iso,
        thumbUrl: null, fullUrl: null, conditions: cond || null, note: s.notes || null,
      })
    }
  }

  if (a.kinds.includes('tag')) {
    let q = d.supabase
      .from('ssa_tag_events')
      .select('id, session_date, label, note, t0, t1, labels, target_kind')
      .eq('team_id', d.teamId).eq('boat_id', d.boatId)
      .gte('session_date', from).lte('session_date', to)
      .order('t0', { ascending: false })
      .limit(200)
    if (a.text) q = q.or(`note.ilike.%${a.text}%,label.ilike.%${a.text}%`)
    const { data } = await q
    for (const t of (data || []) as any[]) {
      const t0 = new Date(t.t0).getTime(), t1 = new Date(t.t1).getTime()
      if (!matchesWindow(t.session_date, t0, t1)) continue
      const tz = d.tzByDate.get(t.session_date) ?? 0
      const descriptors = Array.isArray(t.labels) ? t.labels.map((l: any) => l?.text).filter(Boolean).join(', ') : ''
      items.push({
        kind: 'tag', id: t.id, title: t.label || 'Tag',
        atLocal: hm(t0, tz), utc: t0, date: t.session_date,
        thumbUrl: null, fullUrl: null,
        conditions: descriptors || null, note: t.note || null,
      })
    }
  }

  if (!items.length) {
    const what = [a.sail ? `"${a.sail}"` : '', a.text ? `"${a.text}"` : ''].filter(Boolean).join(' and ')
    if (outsideRange) {
      const span = outsideDates.sort()
      return emptyResult('', `Nothing${what ? ` for ${what}` : ''} between ${from} and ${to} — but ${outsideRange} `
        + `${outsideRange === 1 ? 'item exists' : 'items exist'} outside that range, on ${span[0]}`
        + `${span.length > 1 ? ` to ${span[span.length - 1]}` : ''}. Widen the dates to include ${span.length > 1 ? 'them' : 'it'}.`)
    }
    return emptyResult('', `Nothing found between ${from} and ${to}${what ? ` matching ${what}` : ''}.`)
  }
  items.sort((x, y) => (y.utc ?? 0) - (x.utc ?? 0))
  const kept = items.slice(0, a.limit)
  return {
    summary: `${kept.length} of ${items.length} item${items.length === 1 ? '' : 's'}, newest first. Times are venue-local.`,
    tables: [],
    media: kept,
  }
}

// ── search_notes ─────────────────────────────────────────────────────────────

async function searchNotes(
  d: AskDeps,
  a: SearchNotesArgs,
  dayRange: (f?: string, t?: string) => [string, string],
): Promise<ToolResult> {
  const [from, to] = dayRange(a.dateFrom, a.dateTo)
  const like = `%${a.text}%`
  const columns: AnswerColumn[] = [
    { key: 'date', label: 'Day', group: true },
    { key: 'source', label: 'Where', group: true },
    { key: 'text', label: 'What was written' },
  ]
  const rows: (string | number | null)[][] = []

  const [notes, tags, sessionRows] = await Promise.all([
    d.supabase.from('ssa_day_notes')
      .select('session_date, kind, body')
      .eq('team_id', d.teamId).eq('boat_id', d.boatId)
      .gte('session_date', from).lte('session_date', to)
      .ilike('body', like).limit(a.limit),
    d.supabase.from('ssa_tag_events')
      .select('session_date, label, note')
      .eq('team_id', d.teamId).eq('boat_id', d.boatId)
      .gte('session_date', from).lte('session_date', to)
      .ilike('note', like).limit(a.limit),
    d.supabase.from('sessions')
      .select('id, date').eq('team_id', d.teamId).eq('boat_id', d.boatId)
      .gte('date', from).lte('date', to),
  ])

  for (const n of (notes.data || []) as any[]) rows.push([n.session_date, `${n.kind} note`, trim(n.body)])
  for (const t of (tags.data || []) as any[]) rows.push([t.session_date, `tag “${t.label}”`, trim(t.note)])

  const dateOf = new Map<string, string>(((sessionRows.data || []) as any[]).map(s => [s.id, s.date]))
  if (dateOf.size) {
    const { data: debriefs } = await d.supabase
      .from('debriefs')
      .select('session_id, learnings, next_focus')
      .in('session_id', Array.from(dateOf.keys()))
    for (const b of (debriefs || []) as any[]) {
      for (const [field, text] of [['learnings', b.learnings], ['next focus', b.next_focus]] as const) {
        if (text && String(text).toLowerCase().includes(a.text.toLowerCase())) {
          rows.push([dateOf.get(b.session_id) || '', `debrief ${field}`, trim(String(text))])
        }
      }
    }
  }

  if (!rows.length) return emptyResult('', `Nobody wrote “${a.text}” between ${from} and ${to}.`)
  rows.sort((x, y) => String(y[0]).localeCompare(String(x[0])))
  return {
    summary: `${rows.length} mention${rows.length === 1 ? '' : 's'} of “${a.text}”.`,
    tables: [{ title: `Written about “${a.text}”`, columns, rows: rows.slice(0, a.limit) }],
    media: [],
  }
}

const trim = (s: string | null) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 400)

// ── The context pack ─────────────────────────────────────────────────────────
// What the model is told the boat HAS, before it is asked anything. Caching a
// static tool catalogue and field definitions cut the governed-API agent's
// latency 22 % and its input cost 64 %; this is the same idea — one cheap,
// deterministic block instead of the model discovering the day by calling tools.

export async function loadContext(d: AskDeps): Promise<{ ctx: AskContext; prompt: string }> {
  const [{ data: allDays }, { data: session }, days] = await Promise.all([
    d.supabase.from('session_phase_stats')
      .select('date').eq('team_id', d.teamId).eq('boat_id', d.boatId)
      .eq('stats_version', STATS_VERSION).order('date'),
    d.supabase.from('sessions')
      .select('tz_offset_minutes, meta:xml_data->meta, raceGuns:xml_data->raceGuns')
      .eq('team_id', d.teamId).eq('boat_id', d.boatId).eq('date', d.openDate).maybeSingle(),
    loadDays(d, d.openDate, d.openDate),
  ])

  const phases = expandPhases(days[0]?.phases || [])
  const meta = (session as any)?.meta || {}
  const sailCombos = Array.from(new Set(phases.map(p => p.sailCombo).filter(Boolean)))
  const races = Array.from(new Set(phases.map(p => p.race).filter((r): r is number => r != null))).sort((a, b) => a - b)
  const channels = CHANNELS.map(c => c.key).filter(k => phases.some(p => typeof p.mean[k] === 'number'))
  const tws = phases.map(p => p.mean.tws).filter((v): v is number => typeof v === 'number')
  const twsRange: [number, number] | null = tws.length ? [Math.min(...tws), Math.max(...tws)] : null
  const modes = Array.from(new Set(phases.map(p => p.mode))) as Mode[]

  const sessionIds = await d.supabase.from('sessions').select('id')
    .eq('team_id', d.teamId).eq('boat_id', d.boatId).eq('date', d.openDate)
  const ids = ((sessionIds.data || []) as { id: string }[]).map(s => s.id)
  const count = async (table: string, col: string) => {
    if (!ids.length && col === 'session_id') return 0
    let q = d.supabase.from(table).select('id', { count: 'exact', head: true })
    q = col === 'session_id' ? q.in('session_id', ids) : q.eq('team_id', d.teamId).eq('boat_id', d.boatId).eq('session_date', d.openDate)
    const { count: c } = await q
    return c || 0
  }
  const [photos, videos, tags] = await Promise.all([
    count('photos', 'session_id'), count('videos', 'session_id'), count('ssa_tag_events', 'session_date'),
  ])
  const { count: scans } = await d.supabase.from('sail_scans').select('id', { count: 'exact', head: true })
    .eq('team_id', d.teamId).eq('boat_id', d.boatId)

  const ctx: AskContext = {
    date: d.openDate,
    dates: ((allDays || []) as { date: string }[]).map(r => r.date),
    sailCombos, races, channels,
    phaseCount: phases.length,
    manoeuvreCount: (days[0]?.manoeuvres || []).filter(isJudged).length,
    media: { photos, videos, scans: scans || 0, tags },
    twsRange,
  }

  const lines = [
    `The day open on screen: ${d.openDate}${meta.location ? `, ${meta.location}` : ''}${meta.boat ? `, ${meta.boat}` : ''}.`,
    `It has ${phases.length} steady-state phases${modes.length ? ` (${modes.map(m => MODE_LABEL[m]).join(', ')})` : ''}${ctx.manoeuvreCount ? `, ${ctx.manoeuvreCount} judged manoeuvres` : ''}.`,
    twsRange ? `True wind across the day: ${round(twsRange[0], 1)} to ${round(twsRange[1], 1)} kn.` : 'No wind data on this day.',
    sailCombos.length ? `Sail combinations sailed: ${sailCombos.join('; ')}.` : 'No sail combinations recorded.',
    races.length ? `Races: ${races.join(', ')}.` : 'No races on this day.',
    `Media on this day: ${photos} photos, ${videos} clips, ${tags} tags. Sail scans for this boat: ${scans || 0}.`,
    // Spelled out, because the first live question about "the season" was answered
    // from a single day: the model has to be handed the range, not left to infer
    // that one exists.
    ctx.dates.length > 1
      ? `THE SEASON = every stored day: dateFrom ${ctx.dates[0]}, dateTo ${ctx.dates[ctx.dates.length - 1]} (${ctx.dates.length} days). `
        + 'When the question says "the season", "this year", "all of it" or "overall", pass exactly those two dates to compare_phases or scatter_phases. '
        + 'Do NOT answer a question about the season from the open day alone.'
      : 'This is the only day with stored data, so there is no season to compare against.',
    `Metrics with values on this day: ${channels.join(', ')}.`,
    days[0]?.polar_name ? `Polar in use: ${days[0].polar_name}.` : 'No polar is active, so VMG% and %Pol are unavailable.',
    'Dates are YYYY-MM-DD. Every clock time you are shown is already venue-local — never convert one.',
  ]

  // The boat's own sail inventory, so an answer can use the name as it is really
  // stored rather than the one somebody typed at it.
  const { data: sailRows } = await d.supabase
    .from('sails').select('name').eq('team_id', d.teamId).order('name')
  const sailNames = ((sailRows || []) as { name: string }[]).map(r => r.name).filter(Boolean)

  return { ctx, prompt: `${lines.join('\n')}\n\n${vocabularyBlock(sailNames, meta.boat ?? null)}` }
}
