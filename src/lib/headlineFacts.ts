// src/lib/headlineFacts.ts
// ─────────────────────────────────────────────────────────────────────────────
// Written headlines for a day's performance — the KND report's "Headlines /
// Bottom line", drafted by Mistral on Scaleway (EU) from numbers SSA computed.
//
// The model never computes: it gets FACTS (the report tables and tack/gybe lists,
// already rounded) and must copy every number from them. validateHeadlines() then
// checks each sentence — one containing a number that is not in FACTS is dropped,
// so an invented, averaged or subtracted figure never reaches the crew.
// Pure — the API route calls Mistral; tests cover facts, prompt and validation.
// ─────────────────────────────────────────────────────────────────────────────

import { REPORTS, buildTable, groupCellText, type ReportTable } from './reportTables'
import { isJudged, manoeuvreAverages, manoeuvreNote, type Manoeuvre } from './manoeuvres'
import type { PhaseStat } from './phaseStats'

export interface FactTable { title: string; columns: string[]; rows: (string | number)[][] }

export interface HeadlineFacts {
  date: string
  boat: string | null
  venue: string | null
  polar: string | null
  logResolutionSeconds: number | null
  counts: { phases: number; upwindPhases: number; downwindPhases: number; tacks: number; gybes: number }
  tables: FactTable[]
  tacks: FactTable
  gybes: FactTable
}

const roundTo = (v: number, d: number) => Number(v.toFixed(d))

// Band rows (TWS / TWA / heel bands) backed by fewer phases than this are left out of
// FACTS: the prompt asks the model not to call thin rows best or worst, but a number check
// can't see row sizes — on 11 Sep it still leaned on a 1-phase heel band. Rows the model
// never sees, it cannot cite. The on-screen tables keep every row.
export const MIN_BAND_PHASES = 3
const BAND_KEYS = new Set(['twsBand', 'twaBand', 'heelBand'])

function tableFacts(t: ReportTable): FactTable {
  const banded = t.by.some(k => BAND_KEYS.has(k))
  return {
    title: t.title,
    columns: [...t.by.map(k => k), 'n', ...t.columns.map(c => c.label)],
    rows: t.rows.filter(r => !banded || r.n >= MIN_BAND_PHASES).map(r => [
      ...t.by.map(k => groupCellText(k, r.key[k])),
      r.n,
      ...r.values.map((v, i) => (v == null ? '' : roundTo(v, t.columns[i].decimals))),
    ]),
  }
}

const hm = (utc: number, tzMin: number) => new Date(utc + tzMin * 60_000).toISOString().slice(11, 19)

function manoeuvreFacts(title: string, list: Manoeuvre[], tzMin: number): FactTable {
  const judged = list.filter(isJudged)
  const avg = manoeuvreAverages(judged)
  const r = (v: number | null, d: number) => (v == null ? '' : roundTo(v, d))
  return {
    title,
    columns: ['time', 'from', 'to', 'time to 95% BSP (s)', 'distance lost vs wind (m)', 'BSP before (kn)', 'BSP at +20 s (kn)', 'turn angle (deg)', 'target turn (deg)', 'note'],
    rows: [
      ...judged.map(m => [hm(m.utc, tzMin), m.from || '', m.to || '', r(m.timeTo95, 0), r(m.distLost, 1), r(m.bspBefore, 2), r(m.bspAfter, 2), r(m.turnAngle, 1), m.target, manoeuvreNote(m)]),
      ['AVERAGE', '', '', r(avg.timeTo95, 0), r(avg.distLost, 1), r(avg.bspBefore, 2), r(avg.bspAfter, 2), r(avg.turnAngle, 1), judged[0]?.target ?? '', `${judged.length} judged`],
    ],
  }
}

export function buildHeadlineFacts(input: {
  date: string
  stats: PhaseStat[]
  manoeuvres: Manoeuvre[]
  tzOffsetMin: number
  polarName: string | null
  resolutionSeconds: number | null
  boat?: string | null
  venue?: string | null
}): HeadlineFacts {
  const hasPolar = !!input.polarName
  const tables = [...REPORTS.up, ...REPORTS.down]
    .map(spec => buildTable(input.stats, spec, { hasPolar }))
    .filter(t => t.rows.length)
    .map(tableFacts)
  const judged = input.manoeuvres.filter(isJudged)
  return {
    date: input.date,
    boat: input.boat ?? null,
    venue: input.venue ?? null,
    polar: input.polarName,
    logResolutionSeconds: input.resolutionSeconds,
    counts: {
      phases: input.stats.length,
      upwindPhases: input.stats.filter(s => s.mode === 'up').length,
      downwindPhases: input.stats.filter(s => s.mode === 'down').length,
      tacks: judged.filter(m => m.kind === 'tack').length,
      gybes: judged.filter(m => m.kind === 'gybe').length,
    },
    tables,
    tacks: manoeuvreFacts('Tacks', input.manoeuvres.filter(m => m.kind === 'tack'), input.tzOffsetMin),
    gybes: manoeuvreFacts('Gybes', input.manoeuvres.filter(m => m.kind === 'gybe'), input.tzOffsetMin),
  }
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM = [
  'You are the performance analyst of a racing yacht. From FACTS (JSON) you write the',
  '"Headlines" and "Bottom line" of the daily performance report for the crew and coaches.',
  'Rules:',
  '1. Every number you write must be copied exactly from FACTS. Never calculate, round,',
  '   average, subtract or compare numbers into a new number. If a comparison matters, quote',
  '   both numbers as given (e.g. "Port 98.2 %Pol against Stbd 98.0").',
  '2. Only state what the numbers show. No guesses about causes, no invented context.',
  '3. Sailing language, short plain sentences, at most 30 words each.',
  '4. 4 to 8 headlines, most important first: upwind and downwind speed by tack and sails,',
  '   what wind / TWA / heel bands were quickest, tacks and gybes.',
  '5. Prefer comparisons inside one table — Port against Stbd, one band against another — quoting',
  '   both numbers (e.g. "under 38 deg TWA gives VMG% 97.6, 42-44 deg gives 92.3").',
  '6. The "n" column is the number of 30 s phases behind a row. Rows with n under 6 are thin: do not',
  '   call them best or worst, and if you mention one, give its n.',
  '7. 1 to 3 bottom-line points: what to work on next, each tied to a number from FACTS.',
  'Reply with JSON only: {"headlines": ["..."], "bottomLine": ["..."]}.',
].join('\n')

export function buildHeadlineMessages(facts: HeadlineFacts) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `FACTS:\n${JSON.stringify(facts)}` },
  ]
}

// ── Validation ──────────────────────────────────────────────────────────────

// Times (12:23 / 12:23:19) and letter-attached tokens (J4_A, A2, V1, MAIN_B) are labels.
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g
const NUMBER = /(?<![A-Za-z0-9_+.])-?\d+(?:[.,]\d+)?(?![A-Za-z_+]|\.\d)/g

export function numbersIn(text: string): string[] {
  return (text.replace(TIME, ' ').match(NUMBER) || []).map(s => s.replace(',', '.'))
}

// Every number in FACTS — also as written with fewer decimals (98.20 → 98.2) and without
// its sign (a loss of -4.7 m is "4.7 m" in a sentence) — plus numbers inside its labels.
export function factNumbers(facts: unknown): Set<string> {
  const known = new Set<string>()
  const addNum = (v: number) => {
    for (const x of [v, Math.abs(v)]) {
      known.add(String(x))
      known.add(String(Number(x.toFixed(2))))
      known.add(String(Number(x.toFixed(1))))
      if (Number.isInteger(x)) known.add(x.toFixed(1))
    }
  }
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) addNum(v)
    else if (typeof v === 'string') for (const n of numbersIn(v)) addNum(Number(n))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(facts)
  return known
}

export interface ValidatedHeadlines { headlines: string[]; bottomLine: string[]; dropped: string[] }

// The prompt's limits, enforced: the model does not keep to them reliably (11 Sep: 9 headlines).
export const MAX_HEADLINES = 8
export const MAX_BOTTOM_LINE = 3

export function validateHeadlines(raw: { headlines?: unknown; bottomLine?: unknown }, facts: unknown): ValidatedHeadlines {
  const known = factNumbers(facts)
  const dropped: string[] = []
  const clean = (list: unknown, max: number) =>
    (Array.isArray(list) ? list : [])
      .map(s => String(s ?? '').trim().replace(/^[-•]\s*/, ''))
      .filter(Boolean)
      .filter(s => {
        const bad = numbersIn(s).filter(n => !known.has(String(Number(n))) && !known.has(n))
        if (bad.length) dropped.push(s)
        return !bad.length
      })
      .slice(0, max)
  return { headlines: clean(raw.headlines, MAX_HEADLINES), bottomLine: clean(raw.bottomLine, MAX_BOTTOM_LINE), dropped }
}
