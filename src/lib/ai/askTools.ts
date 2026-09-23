// src/lib/ai/askTools.ts
// ─────────────────────────────────────────────────────────────────────────────
// The tool catalogue the model is allowed to call, and the validator that turns
// what it wrote into arguments the deterministic code can run.
//
// WHY typed tools and not SQL: raw text-to-SQL answers ~21 % of real questions;
// an agent over a governed layer reaches ~77 % (arXiv 2605.21027). SSA already HAS
// the governed layer — CHANNELS (metrics), GroupKey (dimensions), groupPhases()
// (aggregation), all validated against the KND report — so the model never writes
// analysis, it picks a function and fills arguments. See
// docs/ai-query-analysis-2026-09.md §1.
//
// The same paper's other finding is why validate() is strict: their weakest model
// produced 44 % EXECUTABLE calls and only 17 % CORRECT ones. A call that parses is
// not a call that answered the question — so an invalid enum comes back to the
// model as a readable error it can retry, and every resolved call is rendered as
// chips (describeCall) for a human to check on screen.
//
// Pure: no Supabase, no fetch, no React.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolSpec } from './scaleway'

export type ToolName = 'compare_phases' | 'day_timeseries' | 'list_manoeuvres' | 'find_media' | 'search_notes'
export const TOOL_NAMES: ToolName[] = ['compare_phases', 'day_timeseries', 'list_manoeuvres', 'find_media', 'search_notes']

export const MODES = ['up', 'down', 'reach'] as const
export const TACKS = ['port', 'stbd'] as const
export const GROUP_KEYS = ['mode', 'tack', 'sailCombo', 'race', 'twsBand', 'twaBand', 'heelBand', 'date'] as const
export const MEDIA_KINDS = ['photo', 'video', 'sailscan', 'tag'] as const
export const MANOEUVRE_KINDS = ['tack', 'gybe', 'all'] as const

// The metrics worth naming in the schema. Lidar sail-shape channels (mnCa25,
// jibTw50, spiDr75 …) are accepted too but not enumerated — 54 of them would
// crowd out everything else in the model's context for a rarely asked question.
export const CORE_METRICS = [
  'vmgPct', 'bspPol', 'bsp', 'tws', 'twa', 'awa', 'sog', 'heel', 'trim', 'rudder',
  'fsty', 'mainsheet', 'vang', 'cunningham', 'jibTack', 'bobstay', 'v1wwd', 'v1lwd',
  'upDflct', 'lwDflct', 'bspSog', 'logPolPct', 'logTrgPct',
] as const
const LIDAR_KEY = /^(mn|jib|spi)(Ca|Dr|Tw)(25|50|75)$/
const LIDAR_TARGET_KEY = /^t(Mn|Jib|Spi)(Ca|Dr|Tw)(25|50|75)$/
export const isMetricKey = (k: string) =>
  (CORE_METRICS as readonly string[]).includes(k) || LIDAR_KEY.test(k) || LIDAR_TARGET_KEY.test(k)

/** A band backed by fewer phases than this says nothing about the boat. Matches headlineFacts. */
export const DEFAULT_MIN_PHASES = 3

// ── Argument types ───────────────────────────────────────────────────────────

export interface PhaseFilters {
  modes?: ('up' | 'down' | 'reach')[]
  tack?: 'port' | 'stbd'
  race?: number
  sailCombo?: string
  twsMin?: number
  twsMax?: number
  twaMin?: number
  twaMax?: number
  heelMin?: number
  heelMax?: number
}

export interface ComparePhasesArgs extends PhaseFilters {
  by: string[]
  metrics: string[]
  dateFrom?: string
  dateTo?: string
  minPhases: number
}

export interface DayTimeseriesArgs {
  channels: string[]
  date?: string
  fromLocal?: string
  toLocal?: string
  maxPoints: number
}

export interface ListManoeuvresArgs {
  kind: 'tack' | 'gybe' | 'all'
  date?: string
  race?: number
}

export interface FindMediaArgs extends PhaseFilters {
  kinds: ('photo' | 'video' | 'sailscan' | 'tag')[]
  dateFrom?: string
  dateTo?: string
  sail?: string
  text?: string
  limit: number
}

export interface SearchNotesArgs {
  text: string
  dateFrom?: string
  dateTo?: string
  limit: number
}

export type ToolArgs = ComparePhasesArgs | DayTimeseriesArgs | ListManoeuvresArgs | FindMediaArgs | SearchNotesArgs

export type Validated =
  | { ok: true; name: ToolName; args: ToolArgs }
  | { ok: false; error: string }

// ── The catalogue ────────────────────────────────────────────────────────────

const ISO_DATE = { type: 'string', description: 'A day as YYYY-MM-DD. Omit for the day that is open.' }

const FILTER_PROPS = {
  modes: { type: 'array', items: { type: 'string', enum: [...MODES] }, description: 'Points of sail: up = upwind, down = downwind, reach = reaching.' },
  tack: { type: 'string', enum: [...TACKS], description: 'Keep one tack only.' },
  race: { type: 'integer', description: 'Keep one race, 1-based.' },
  sailCombo: { type: 'string', description: 'Keep one sail combination, exactly as it is named in the context (e.g. "J4_A 2026").' },
  twsMin: { type: 'number', description: 'Lowest true wind speed in knots.' },
  twsMax: { type: 'number', description: 'Highest true wind speed in knots.' },
  twaMin: { type: 'number', description: 'Lowest absolute true wind angle in degrees.' },
  twaMax: { type: 'number', description: 'Highest absolute true wind angle in degrees.' },
  heelMin: { type: 'number', description: 'Lowest absolute heel in degrees.' },
  heelMax: { type: 'number', description: 'Highest absolute heel in degrees.' },
}

export const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'compare_phases',
      description:
        'The main tool. Averages the boat\'s 30 s steady-state phases and splits them by whatever you group on, '
        + 'returning one row per group with its phase count n and the mean of each metric you ask for. '
        + 'Use it for anything of the form "was A better than B": port vs starboard, one sail combination vs another, '
        + 'one wind band vs another, one race vs another, this day vs other days (group by "date" and give a date range). '
        + 'Prefer vmgPct upwind and downwind and bspPol when reaching — both are percentages of the polar target, '
        + 'so they compare fairly across different wind strengths, which raw bsp does not.',
      parameters: {
        type: 'object',
        properties: {
          by: {
            type: 'array',
            items: { type: 'string', enum: [...GROUP_KEYS] },
            description: 'How to split the phases. One or two keys. "tack" for port vs starboard, "sailCombo" for sails, "twsBand" for wind bands, "date" to compare days.',
          },
          metrics: {
            type: 'array',
            items: { type: 'string' },
            description: `What to average per group. Use these: ${CORE_METRICS.join(', ')}. Lidar sail shape is also available as mnCa25, jibDr50, spiTw75 and so on (sail mn/jib/spi + Ca camber / Dr draft / Tw twist + stripe height 25/50/75).`,
          },
          dateFrom: ISO_DATE,
          dateTo: ISO_DATE,
          minPhases: { type: 'integer', description: `Drop groups with fewer phases than this. Default ${DEFAULT_MIN_PHASES}; never go below it for wind or angle bands.` },
          ...FILTER_PROPS,
        },
        required: ['by', 'metrics'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'day_timeseries',
      description:
        'The day\'s instruments through time, thinned to a drawable number of points. '
        + 'Use it for "when did X happen", "how did the breeze move", "show heel through the day" — not for comparisons, which compare_phases does better.',
      parameters: {
        type: 'object',
        properties: {
          channels: { type: 'array', items: { type: 'string' }, description: `Channels to plot, e.g. ${CORE_METRICS.slice(0, 6).join(', ')}.` },
          date: ISO_DATE,
          fromLocal: { type: 'string', description: 'Start as local clock time HH:MM at the venue. Omit for the whole day.' },
          toLocal: { type: 'string', description: 'End as local clock time HH:MM at the venue.' },
          maxPoints: { type: 'integer', description: 'At most this many points per channel. Default 400.' },
        },
        required: ['channels'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_manoeuvres',
      description:
        'Every judged tack or gybe of a day with how long it took to get back to 95 % of boat speed and how much distance it cost against the wind. '
        + 'Use it for "which tacks cost us most", "how were the gybes", "were the manoeuvres better in race 2".',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...MANOEUVRE_KINDS], description: 'tack, gybe, or all.' },
          date: ISO_DATE,
          race: { type: 'integer', description: 'Keep one race, 1-based.' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_media',
      description:
        'Photos, video clips, sail scans and the crew\'s own tags, filtered by the conditions they were taken in. '
        + 'Every photo carries the instruments at the moment of the shutter, so "show me the jib in the breeze" is a real query. '
        + 'ALWAYS call this when the question asks to see something, and call it after a comparison whenever a picture would show what the numbers say.',
      parameters: {
        type: 'object',
        properties: {
          kinds: { type: 'array', items: { type: 'string', enum: [...MEDIA_KINDS] }, description: 'What to look for.' },
          dateFrom: ISO_DATE,
          dateTo: ISO_DATE,
          sail: { type: 'string', description: 'Only items with this sail up — match on part of the name, e.g. "J4" or "A2".' },
          text: { type: 'string', description: 'Only items whose title, note or label contains this.' },
          limit: { type: 'integer', description: 'At most this many, newest first. Default 6, cap 12.' },
          ...FILTER_PROPS,
        },
        required: ['kinds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        'What people wrote down: the day notes, the notes on tags, and debrief summaries. '
        + 'Use it for "what did we say about…", "did we note anything about the rig", or to check whether the crew already explained a number.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Words to look for.' },
          dateFrom: ISO_DATE,
          dateTo: ISO_DATE,
          limit: { type: 'integer', description: 'At most this many. Default 8.' },
        },
        required: ['text'],
      },
    },
  },
]

// ── Validation ───────────────────────────────────────────────────────────────

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const asStrings = (v: unknown): string[] => asArray(v).filter((x): x is string => typeof x === 'string' && !!x.trim()).map(s => s.trim())
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const int = (v: unknown): number | undefined => {
  const n = num(v)
  return n == null ? undefined : Math.round(n)
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const date = (v: unknown): string | undefined => (typeof v === 'string' && DATE_RE.test(v.trim()) ? v.trim() : undefined)
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const hm = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, 5)
  return HM_RE.test(t) ? t : undefined
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v.trim()) ? (v.trim() as T) : undefined
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function filters(o: Record<string, unknown>): PhaseFilters {
  const f: PhaseFilters = {}
  const modes = asStrings(o.modes).map(m => oneOf(m, MODES)).filter((m): m is 'up' | 'down' | 'reach' => !!m)
  // A lone `mode: "up"` is the mistake the model makes most; take it as one-of-modes.
  const single = oneOf(o.mode, MODES)
  const all = Array.from(new Set(single ? [...modes, single] : modes))
  if (all.length) f.modes = all
  const tack = oneOf(o.tack, TACKS)
  if (tack) f.tack = tack
  const race = int(o.race)
  if (race != null && race > 0) f.race = race
  if (typeof o.sailCombo === 'string' && o.sailCombo.trim()) f.sailCombo = o.sailCombo.trim()
  for (const k of ['twsMin', 'twsMax', 'twaMin', 'twaMax', 'heelMin', 'heelMax'] as const) {
    const v = num(o[k])
    if (v != null) f[k] = v
  }
  // A model that writes twsMin 20, twsMax 12 means the band between them.
  for (const [lo, hi] of [['twsMin', 'twsMax'], ['twaMin', 'twaMax'], ['heelMin', 'heelMax']] as const) {
    if (f[lo] != null && f[hi] != null && f[lo]! > f[hi]!) { const t = f[lo]!; f[lo] = f[hi]; f[hi] = t }
  }
  return f
}

/**
 * Turn one raw tool call into arguments the executors can run, or into an error
 * sentence written for the MODEL to read and retry — never a thrown exception.
 */
export function validate(name: string, argumentsRaw: string): Validated {
  if (!(TOOL_NAMES as string[]).includes(name)) {
    return { ok: false, error: `There is no tool called "${name}". The tools are: ${TOOL_NAMES.join(', ')}.` }
  }
  let o: Record<string, unknown>
  try {
    const parsed = JSON.parse(argumentsRaw || '{}')
    o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { ok: false, error: `The arguments for ${name} were not valid JSON. Send them again as a JSON object.` }
  }

  if (name === 'compare_phases') {
    const by = asStrings(o.by).map(k => oneOf(k, GROUP_KEYS)).filter((k): k is typeof GROUP_KEYS[number] => !!k)
    if (!by.length) {
      return { ok: false, error: `compare_phases needs "by" with at least one of: ${GROUP_KEYS.join(', ')}.` }
    }
    const asked = asStrings(o.metrics)
    const metrics = Array.from(new Set(asked.filter(isMetricKey)))
    const unknownMetrics = asked.filter(m => !isMetricKey(m))
    if (!metrics.length) {
      return {
        ok: false,
        error: unknownMetrics.length
          ? `${unknownMetrics.join(', ')} ${unknownMetrics.length === 1 ? 'is not a metric' : 'are not metrics'}. Use metric keys from this list: ${CORE_METRICS.join(', ')}.`
          : `compare_phases needs "metrics" — one or more of: ${CORE_METRICS.join(', ')}.`,
      }
    }
    const args: ComparePhasesArgs = {
      by: Array.from(new Set(by)).slice(0, 2),
      metrics: metrics.slice(0, 6),
      minPhases: clamp(int(o.minPhases) ?? DEFAULT_MIN_PHASES, 1, 50),
      ...filters(o),
    }
    const from = date(o.dateFrom), to = date(o.dateTo)
    if (from) args.dateFrom = from
    if (to) args.dateTo = to
    if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) {
      const t = args.dateFrom; args.dateFrom = args.dateTo; args.dateTo = t
    }
    return { ok: true, name, args }
  }

  if (name === 'day_timeseries') {
    const channels = Array.from(new Set(asStrings(o.channels).filter(isMetricKey))).slice(0, 4)
    if (!channels.length) {
      return { ok: false, error: `day_timeseries needs "channels" — one or more of: ${CORE_METRICS.join(', ')}.` }
    }
    const args: DayTimeseriesArgs = { channels, maxPoints: clamp(int(o.maxPoints) ?? 400, 50, 600) }
    const d = date(o.date); if (d) args.date = d
    const f = hm(o.fromLocal), t = hm(o.toLocal)
    if (f) args.fromLocal = f
    if (t) args.toLocal = t
    if (args.fromLocal && args.toLocal && args.fromLocal > args.toLocal) {
      const x = args.fromLocal; args.fromLocal = args.toLocal; args.toLocal = x
    }
    return { ok: true, name, args }
  }

  if (name === 'list_manoeuvres') {
    const args: ListManoeuvresArgs = { kind: oneOf(o.kind, MANOEUVRE_KINDS) ?? 'all' }
    const d = date(o.date); if (d) args.date = d
    const race = int(o.race); if (race != null && race > 0) args.race = race
    return { ok: true, name, args }
  }

  if (name === 'find_media') {
    const kinds = Array.from(new Set(asStrings(o.kinds).map(k => oneOf(k, MEDIA_KINDS)).filter((k): k is typeof MEDIA_KINDS[number] => !!k)))
    if (!kinds.length) {
      return { ok: false, error: `find_media needs "kinds" — one or more of: ${MEDIA_KINDS.join(', ')}.` }
    }
    const args: FindMediaArgs = { kinds, limit: clamp(int(o.limit) ?? 6, 1, 12), ...filters(o) }
    const from = date(o.dateFrom), to = date(o.dateTo)
    if (from) args.dateFrom = from
    if (to) args.dateTo = to
    if (typeof o.sail === 'string' && o.sail.trim()) args.sail = o.sail.trim()
    if (typeof o.text === 'string' && o.text.trim()) args.text = o.text.trim()
    return { ok: true, name, args }
  }

  // search_notes
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (!text) return { ok: false, error: 'search_notes needs "text" — the words to look for.' }
  const args: SearchNotesArgs = { text: text.slice(0, 120), limit: clamp(int(o.limit) ?? 8, 1, 20) }
  const from = date(o.dateFrom), to = date(o.dateTo)
  if (from) args.dateFrom = from
  if (to) args.dateTo = to
  return { ok: true, name: 'search_notes', args }
}

// ── Search tokens: the resolved call, in words, that a human can EDIT ────────
// ThoughtSpot's search tokens, and the same reasoning: a crew member cannot
// audit a tool call, but can read "Upwind · TWS 14–18 kn · by tack" and see at
// once whether the machine understood them. That is the only defence against a
// call that is well-formed and wrong — 44 % of calls executable, 17 % correct
// (arXiv 2605.21027 §5).
//
// They are EDITABLE, which is the half that matters. When the model reads
// "in the breeze" as 14–18 kn and you meant over 20, retyping the question and
// hoping is a worse tool than dragging one number. Editing a token re-runs the
// TOOL only — deterministic, no model, no second opinion — so the table and the
// chart move and the prose stays honestly attributed to the question that was asked.

/** One editable piece of a resolved call. `path` is the argument it writes back to. */
export interface Token {
  path: string
  label: string
  /** What is shown on the chip. */
  text: string
  kind: 'date' | 'daterange' | 'enum' | 'multi' | 'number' | 'text' | 'groups' | 'static'
  value?: string | number | string[] | null
  /** Choices for enum/multi/groups. */
  options?: { value: string; label: string }[]
  unit?: string
  editable: boolean
}

const MODE_WORD: Record<string, string> = { up: 'Upwind', down: 'Downwind', reach: 'Reaching' }
const TACK_WORD: Record<string, string> = { port: 'Port tack', stbd: 'Starboard tack' }
const BY_WORD: Record<string, string> = {
  mode: 'point of sail', tack: 'tack', sailCombo: 'sails', race: 'race',
  twsBand: 'wind band', twaBand: 'angle band', heelBand: 'heel band', date: 'day',
}
const KIND_WORD: Record<string, string> = { photo: 'photos', video: 'clips', sailscan: 'sail scans', tag: 'tags' }

const choices = <T extends string>(vals: readonly T[], words: Record<string, string>) =>
  vals.map(v => ({ value: v as string, label: words[v] || v }))
const metricChoices = () => (CORE_METRICS as readonly string[]).map(m => ({ value: m, label: m }))

function rangeToken(f: PhaseFilters, key: 'tws' | 'twa' | 'heel', label: string, unit: string): Token[] {
  const lo = f[`${key}Min` as keyof PhaseFilters] as number | undefined
  const hi = f[`${key}Max` as keyof PhaseFilters] as number | undefined
  if (lo == null && hi == null) return []
  const text = lo != null && hi != null ? `${label} ${lo}–${hi} ${unit}`
    : lo != null ? `${label} over ${lo} ${unit}` : `${label} under ${hi} ${unit}`
  return [{
    path: key, label, text, kind: 'number', unit,
    value: [lo == null ? '' : String(lo), hi == null ? '' : String(hi)],
    editable: true,
  }]
}

function filterTokens(f: PhaseFilters): Token[] {
  const out: Token[] = []
  if (f.modes?.length) {
    out.push({
      path: 'modes', label: 'Point of sail', text: f.modes.map(m => MODE_WORD[m]).join(' + '),
      kind: 'multi', value: f.modes, options: choices(MODES, MODE_WORD), editable: true,
    })
  }
  if (f.tack) {
    out.push({ path: 'tack', label: 'Tack', text: TACK_WORD[f.tack], kind: 'enum', value: f.tack, options: choices(TACKS, TACK_WORD), editable: true })
  }
  if (f.race != null) out.push({ path: 'race', label: 'Race', text: `Race ${f.race}`, kind: 'number', value: f.race, editable: true })
  if (f.sailCombo) out.push({ path: 'sailCombo', label: 'Sails', text: f.sailCombo, kind: 'text', value: f.sailCombo, editable: true })
  out.push(...rangeToken(f, 'tws', 'TWS', 'kn'))
  out.push(...rangeToken(f, 'twa', 'TWA', '°'))
  out.push(...rangeToken(f, 'heel', 'Heel', '°'))
  return out
}

function dateTokens(from: string | undefined, to: string | undefined, fallback?: string | null): Token[] {
  const text = from && to ? (from === to ? from : `${from} → ${to}`)
    : from ? `from ${from}` : to ? `up to ${to}` : fallback || ''
  if (!text) return []
  return [{
    path: 'dateRange', label: 'Days', text, kind: 'daterange',
    value: [from || fallback || '', to || fallback || ''], editable: true,
  }]
}

/**
 * The editable tokens for one resolved call. `openDate` labels a call that did
 * not name a day — the day that is open on screen.
 */
export function tokensFor(name: ToolName, args: ToolArgs, openDate?: string | null): Token[] {
  if (name === 'compare_phases') {
    const a = args as ComparePhasesArgs
    return [
      ...dateTokens(a.dateFrom, a.dateTo, openDate),
      ...filterTokens(a),
      {
        path: 'by', label: 'Split by', text: `by ${a.by.map(k => BY_WORD[k] || k).join(' × ')}`,
        kind: 'groups', value: a.by, options: choices(GROUP_KEYS, BY_WORD), editable: true,
      },
      { path: 'metrics', label: 'Metrics', text: a.metrics.join(', '), kind: 'multi', value: a.metrics, options: metricChoices(), editable: true },
      ...(a.minPhases > 1
        ? [{ path: 'minPhases', label: 'Minimum phases', text: `at least ${a.minPhases} phases`, kind: 'number' as const, value: a.minPhases, editable: true }]
        : []),
    ]
  }
  if (name === 'day_timeseries') {
    const a = args as DayTimeseriesArgs
    return [
      ...dateTokens(a.date, a.date, openDate),
      ...(a.fromLocal || a.toLocal
        ? [{ path: 'clock', label: 'Between', text: `${a.fromLocal || 'start'} → ${a.toLocal || 'end'}`, kind: 'text' as const, value: [a.fromLocal || '', a.toLocal || ''], editable: true }]
        : []),
      { path: 'channels', label: 'Channels', text: a.channels.join(', '), kind: 'multi', value: a.channels, options: metricChoices(), editable: true },
    ]
  }
  if (name === 'list_manoeuvres') {
    const a = args as ListManoeuvresArgs
    return [
      ...dateTokens(a.date, a.date, openDate),
      {
        path: 'kind', label: 'Manoeuvres', kind: 'enum', value: a.kind,
        text: a.kind === 'all' ? 'tacks and gybes' : a.kind === 'tack' ? 'tacks' : 'gybes',
        options: [{ value: 'tack', label: 'tacks' }, { value: 'gybe', label: 'gybes' }, { value: 'all', label: 'tacks and gybes' }],
        editable: true,
      },
      ...(a.race != null ? [{ path: 'race', label: 'Race', text: `Race ${a.race}`, kind: 'number' as const, value: a.race, editable: true }] : []),
    ]
  }
  if (name === 'find_media') {
    const a = args as FindMediaArgs
    return [
      ...dateTokens(a.dateFrom, a.dateTo, openDate),
      {
        path: 'kinds', label: 'Looking for', text: a.kinds.map(k => KIND_WORD[k]).join(', '),
        kind: 'multi', value: a.kinds, options: choices(MEDIA_KINDS, KIND_WORD), editable: true,
      },
      ...(a.sail ? [{ path: 'sail', label: 'Sail', text: a.sail, kind: 'text' as const, value: a.sail, editable: true }] : []),
      ...(a.text ? [{ path: 'text', label: 'Containing', text: `“${a.text}”`, kind: 'text' as const, value: a.text, editable: true }] : []),
      ...filterTokens(a),
    ]
  }
  const a = args as SearchNotesArgs
  return [
    ...dateTokens(a.dateFrom, a.dateTo, openDate),
    { path: 'text', label: 'Words', text: `“${a.text}”`, kind: 'text', value: a.text, editable: true },
  ]
}

/** The tokens as plain strings — for logs, tests and anywhere without a screen. */
export const describeCall = (name: ToolName, args: ToolArgs, openDate?: string | null): string[] =>
  tokensFor(name, args, openDate).map(t => t.text).filter(Boolean)

/**
 * Write an edited token back into the arguments, then re-validate. Editing is the
 * only way arguments change after the model has spoken, and it goes through exactly
 * the same validator — a person cannot steer the tool anywhere the model could not.
 */
export function applyTokenEdit(name: ToolName, args: ToolArgs, path: string, value: unknown): Validated {
  const next: Record<string, unknown> = { ...(args as unknown as Record<string, unknown>) }
  const pair = Array.isArray(value) ? value : null
  const numOrDrop = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : v
    if (s === '' || s == null) return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (path === 'dateRange' && pair) {
    next.dateFrom = pair[0] || undefined
    next.dateTo = pair[1] || undefined
    next.date = pair[0] || undefined
  } else if (path === 'clock' && pair) {
    next.fromLocal = pair[0] || undefined
    next.toLocal = pair[1] || undefined
  } else if ((path === 'tws' || path === 'twa' || path === 'heel') && pair) {
    next[`${path}Min`] = numOrDrop(pair[0])
    next[`${path}Max`] = numOrDrop(pair[1])
  } else if (path === 'race' || path === 'minPhases') {
    next[path] = numOrDrop(value)
  } else {
    next[path] = value === '' ? undefined : value
  }
  return validate(name, JSON.stringify(next))
}
