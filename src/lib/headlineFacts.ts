// src/lib/headlineFacts.ts
// ─────────────────────────────────────────────────────────────────────────────
// Written headlines for a day's performance — the KND report's "Headlines /
// Bottom line", drafted by Mistral on Scaleway (EU) from numbers SSA computed,
// in sections: Upwind, Downwind, Reaching (when sailed) and Sail shape (lidar).
//
// The model never computes: it gets FACTS (the report tables, tack/gybe lists and
// lidar shape bands, already rounded) and must copy every number from them.
// validateSections() then checks each sentence against its own section's facts —
// one containing a number that is not there is dropped, so an invented, averaged or
// subtracted figure (or an upwind number quoted as a downwind one) never reaches the crew.
// Pure — the API route and scripts/headlines-backfill.ts call Mistral (headlineGenerate).
// ─────────────────────────────────────────────────────────────────────────────

import { REPORTS, buildTable, groupCellText, type ReportSpec, type ReportTable } from './reportTables'
import { isJudged, manoeuvreAverages, manoeuvreNote, type Manoeuvre } from './manoeuvres'
import type { Mode, PhaseStat } from './phaseStats'
import { LIDAR_SAILS, LIDAR_VARS, LIDAR_HEIGHTS, lidarGaps, phaseSailName, hasLidar } from './lidarTables'
import { DEFAULT_GLOSSARY, vocabForBoat, withOverride } from './debriefGlossary'

export interface FactTable { title: string; columns: string[]; rows: (string | number)[][] }

export type SectionKey = 'upwind' | 'downwind' | 'reaching' | 'sailShape'
export const SECTION_ORDER: SectionKey[] = ['upwind', 'downwind', 'reaching', 'sailShape']
export const SECTION_TITLES: Record<SectionKey, string> = { upwind: 'Upwind', downwind: 'Downwind', reaching: 'Reaching', sailShape: 'Sail shape' }

export interface SectionFacts {
  phases: number
  sailsInUse: FactTable
  tables: FactTable[]
  manoeuvres?: FactTable
}
export interface SailShapeFacts {
  lidarPhases: number
  about: string
  tables: FactTable[]
}
export interface HeadlineFacts {
  date: string
  boat: string | null
  venue: string | null
  polar: string | null
  logResolutionSeconds: number | null
  sections: { upwind?: SectionFacts; downwind?: SectionFacts; reaching?: SectionFacts; sailShape?: SailShapeFacts }
}

const roundTo = (v: number, d: number) => Number(v.toFixed(d))
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

// Band rows (TWS / TWA / heel bands, lidar shape bands) backed by fewer phases than this are
// left out of FACTS: the prompt asks the model not to call thin rows best or worst, but a number
// check can't see row sizes — on 11 Sep it still leaned on a 1-phase heel band. Rows the model
// never sees, it cannot cite. The on-screen tables keep every row.
export const MIN_BAND_PHASES = 3
// A point of sail needs this many 30 s phases for a section of its own (11 Sep: 1 reaching phase).
export const MIN_SECTION_PHASES = 6
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
    columns: ['time', 'from', 'to', 'sails', 'time to 95% BSP (s)', 'distance lost vs wind (m)', 'BSP before (kn)', 'BSP at +20 s (kn)', 'turn angle (deg)', 'target turn (deg)', 'note'],
    rows: [
      ...judged.map(m => [hm(m.utc, tzMin), m.from || '', m.to || '', m.sails || '', r(m.timeTo95, 0), r(m.distLost, 1), r(m.bspBefore, 2), r(m.bspAfter, 2), r(m.turnAngle, 1), m.target, manoeuvreNote(m)]),
      ['AVERAGE', '', '', '', r(avg.timeTo95, 0), r(avg.distLost, 1), r(avg.bspBefore, 2), r(avg.bspAfter, 2), r(avg.turnAngle, 1), judged[0]?.target ?? '', `${judged.length} judged`],
    ],
  }
}

// Sail tags: which main was up with which headsails, and for how many phases. Stored phases carry
// no sail list, so the main comes from the event file's sail changes.
function sailsInUse(phases: PhaseStat[], xml: any): FactTable {
  const counts = new Map<string, { main: string; headsails: string; n: number }>()
  for (const p of phases) {
    const main = phaseSailName(p, 'mn', xml) ?? ''
    const k = `${main}|${p.sailCombo}`
    const c = counts.get(k) || { main, headsails: p.sailCombo, n: 0 }
    c.n++
    counts.set(k, c)
  }
  return {
    title: 'Sails in use (main with the headsails of the tables)',
    columns: ['main', 'headsails', 'n'],
    rows: Array.from(counts.values()).sort((a, b) => b.n - a.n).map(c => [c.main, c.headsails, c.n]),
  }
}

// ── Sail shape ────────────────────────────────────────────────────────────────
// Per point of sail and sail: phases (after the lidar tables' filters) grouped into bands of
// measured camber (1 %), draft (5 %) and twist (5°), each with the VMG% and %Pol sailed in it,
// best VMG% first — so "the best shape" is a row the model can quote, not a number it works out.
const SHAPE_BAND: Record<string, number> = { Ca: 1, Dr: 5, Tw: 5 }
const SHAPE_MODES: [Mode, string][] = [['up', 'Upwind'], ['down', 'Downwind']]

// Only steady sailing says which shape is quick. Lidar logged around the starts (6 Sep's 4 Hz
// start logs) is mostly accelerating, luffing and bearing away: VMG% 53 with %Pol 191 there
// ranks shapes by how the boat was being manoeuvred, not by how fast the sail was.
export const STEADY_MIN = 70
export const STEADY_MAX = 130
const steady = (p: PhaseStat) => {
  const vmg = p.mean.vmgPct, pol = p.mean.bspPol
  return vmg != null && vmg >= STEADY_MIN && vmg <= STEADY_MAX && (pol == null || (pol >= STEADY_MIN && pol <= STEADY_MAX))
}

function sailShapeFacts(stats: PhaseStat[], xml: any): SailShapeFacts | undefined {
  const tables: FactTable[] = []
  const used = new Set<number>()
  for (const [mode, modeLabel] of SHAPE_MODES) {
    const modePhases = stats.filter(p => p.mode === mode && steady(p))
    modePhases.filter(p => LIDAR_SAILS.some(s => hasLidar([p], s.sail))).forEach(p => used.add(p.utc))
    for (const { sail, label } of LIDAR_SAILS) {
      if (!hasLidar(modePhases, sail)) continue
      const names = Array.from(new Set(modePhases.map(p => phaseSailName(p, sail, xml) ?? ''))).sort()
      for (const name of names) {
        const own = modePhases.filter(p => (phaseSailName(p, sail, xml) ?? '') === name)
        for (const variable of LIDAR_VARS) {
          const w = SHAPE_BAND[variable.v]
          for (const h of LIDAR_HEIGHTS) {
            const valid = lidarGaps(own, sail, variable, h).valid.filter(g => g.phase.mean.vmgPct != null)
            const bands = new Map<number, typeof valid>()
            for (const g of valid) {
              const lo = Math.floor(g.meas / w) * w
              bands.set(lo, [...(bands.get(lo) || []), g])
            }
            const kept = Array.from(bands).filter(([, gs]) => gs.length >= MIN_BAND_PHASES)
            if (kept.length < 2) continue   // one band says nothing about which shape is quicker
            // One table per point of sail, sail and variable: validateSections keeps a sentence only
            // when all its numbers sit in ONE table, so a band and its VMG% can't be borrowed from
            // another sail's or another height's rows (11 Sep: a J4 twist band quoted as the main's).
            tables.push({
              title: `${modeLabel} ${name || label} ${variable.label} ${h}% — shape bands by VMG%`,
              columns: ['band', 'n', 'VMG%', '%Pol', 'measured', 'target'],
              rows: kept
                .map(([lo, gs]) => ({
                  lo, n: gs.length,
                  vmg: mean(gs.map(g => g.phase.mean.vmgPct as number)),
                  pol: gs.some(g => g.phase.mean.bspPol != null) ? mean(gs.filter(g => g.phase.mean.bspPol != null).map(g => g.phase.mean.bspPol as number)) : null,
                  meas: mean(gs.map(g => g.meas)),
                  tgt: mean(gs.map(g => g.tgt)),
                }))
                .sort((a, b) => b.vmg - a.vmg)
                .map(b => [`${b.lo}-${b.lo + w}`, b.n, roundTo(b.vmg, 1), b.pol == null ? '' : roundTo(b.pol, 1), roundTo(b.meas, 1), roundTo(b.tgt, 1)]),
            })
          }
        }
      }
    }
  }
  if (!tables.length) return undefined
  return {
    lidarPhases: used.size,
    about: 'Lidar sail shape, steady sailing only (VMG% and %Pol between 70 and 130): camber and draft in % of chord, twist in degrees, at 25/50/75 % height. Rows sorted best VMG% first within each variable.',
    tables,
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
  xml?: any            // the event file (its sailsUpEvents tag the main)
}): HeadlineFacts {
  const hasPolar = !!input.polarName
  const section = (mode: Mode, specs: ReportSpec[], manoeuvres?: FactTable): SectionFacts | undefined => {
    const own = input.stats.filter(s => s.mode === mode)
    if (own.length < MIN_SECTION_PHASES) return undefined
    return {
      phases: own.length,
      sailsInUse: sailsInUse(own, input.xml),
      tables: specs.map(spec => buildTable(input.stats, spec, { hasPolar })).filter(t => t.rows.length).map(tableFacts).filter(t => t.rows.length),
      ...(manoeuvres ? { manoeuvres } : {}),
    }
  }
  const sections: HeadlineFacts['sections'] = {}
  const up = section('up', REPORTS.up, manoeuvreFacts('Tacks', input.manoeuvres.filter(m => m.kind === 'tack'), input.tzOffsetMin))
  const down = section('down', REPORTS.down, manoeuvreFacts('Gybes', input.manoeuvres.filter(m => m.kind === 'gybe'), input.tzOffsetMin))
  const reach = section('reach', REPORTS.reach)
  const shape = sailShapeFacts(input.stats, input.xml)
  if (up) sections.upwind = up
  if (down) sections.downwind = down
  if (reach) sections.reaching = reach
  if (shape) sections.sailShape = shape
  return {
    date: input.date,
    boat: input.boat ?? null,
    venue: input.venue ?? null,
    polar: input.polarName,
    logResolutionSeconds: input.resolutionSeconds,
    sections,
  }
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM = [
  'You are the performance analyst of a racing yacht. From FACTS (JSON) you write the daily performance',
  'report for the crew and coaches: for every section present in FACTS.sections, "headlines" and a "bottomLine".',
  'Rules:',
  '1. Every number you write must be copied exactly from FACTS. Never calculate, round,',
  '   average, subtract or compare numbers into a new number. If a comparison matters, quote',
  '   both numbers as given (e.g. "Port 98.2 %Pol against Stbd 98.0").',
  '2. Only state what the numbers show. No guesses about causes, no invented context.',
  '3. Sailing language, short plain sentences, at most 30 words each.',
  '4. Each section uses only its own facts: "upwind" = sections.upwind (its tables and the tacks),',
  '   "downwind" = sections.downwind (its tables and the gybes), "reaching" = sections.reaching,',
  '   "sailShape" = sections.sailShape. A number from another section does not belong in it.',
  '5. 2 to 5 headlines per section, most important first: speed by tack and sails, the quickest wind /',
  '   TWA / heel bands, the tacks (upwind) or gybes (downwind).',
  '6. Sail tags: whenever a sentence is about a sail combination, a manoeuvre on certain sails or a',
  '   sail\'s shape, name the sails — headsails as written in the tables (e.g. "J4_A 2026"), and the main',
  '   from "sailsInUse" (e.g. "MAIN_B 2026") when one main was used with them.',
  '7. Prefer comparisons inside one table — Port against Stbd, one band against another — quoting',
  '   both numbers (e.g. "under 38 deg TWA gives VMG% 97.6, 42-44 deg gives 92.3").',
  '8. The "n" column is the number of 30 s phases behind a row. Rows with n under 6 are thin: do not',
  '   call them best or worst, and if you mention one, give its n.',
  '9. sailShape: each of its tables is ONE point of sail, sail and variable (its title, e.g. "Upwind MAIN_B',
  '   2026 Twist 50%"), with bands of the measured value and the VMG% and %Pol sailed in them, best VMG% first.',
  '   One table per sentence: quote that table\'s best band\'s VMG% against its lowest band\'s VMG%, naming the',
  '   sail, the point of sail and the variable as in the title (e.g. "MAIN_B 2026 upwind camber 25%: 7-8 gave',
  '   VMG% 97.1, 9-10 gave 94.2"). Never take a band or a VMG% from another table. You may add the best band\'s',
  '   measured and target values, and its n when under 6. Never advise moving the shape to the target: the',
  '   numbers only show which measured band sailed best. Its bottom line: 1 or 2 sentences, each naming one',
  '   table\'s best band with its VMG%.',
  '10. The AVERAGE row of the tacks or gybes covers every judged manoeuvre — never present it as one tack\'s.',
  '    A negative "distance lost" is distance gained.',
  '11. 1 or 2 bottom-line points per section: what sailed best or worst and is worth repeating or fixing, each',
  '    tied to a number from that section. Do not invent causes or settings ("trim for…", "replicate…").',
  '12. Keep each sentence\'s numbers to one table of the section; quote sail names as labels only.',
  '13. Write like the team\'s speed-team notes: terse working-note bullets in the team\'s own sailing jargon',
  '    (TEAM VOCABULARY below), not generic plain English. Give a sail its full code from the tables the first',
  '    time in a section (e.g. "J1.5_B 2026"), then its short name (e.g. "J1.5", "A2", "MH0").',
  '14. Keep the units the tables give (kn, deg, %, m, s). VMG%, %Pol, BSP and TWA are four different things —',
  '    never report one as another.',
  'Reply with JSON only, one key per section present in FACTS:',
  '{"upwind": {"headlines": ["..."], "bottomLine": ["..."]}, "downwind": {...}, "reaching": {...}, "sailShape": {...}}.',
].join('\n')

// The team's own words for sails, manoeuvres and gear — the glossary the debrief and speed-team
// summaries are written with (lib/debriefGlossary, incl. the boat's squad vocabulary) — so the
// headlines read like the rest of the day's notes. Crew and rival names are left out on purpose:
// headlines are about numbers, never about people.
export function teamVocabulary(boat: string | null): string {
  const g = withOverride(vocabForBoat(boat), DEFAULT_GLOSSARY)
  return [
    'TEAM VOCABULARY (the words this team uses in its debriefs and speed-team notes — write with them):',
    `- Sails: ${g.sails.join(', ')}`,
    `- Manoeuvres: ${g.manoeuvres.join(', ')}`,
    `- Parts & systems: ${g.parts.join(', ')}`,
    `- Team slang = meaning: ${g.aliases.map(([a, b]) => `${a} = ${b}`).join(', ')}`,
  ].join('\n')
}

export function buildHeadlineMessages(facts: HeadlineFacts) {
  return [
    { role: 'system', content: `${SYSTEM}\n\n${teamVocabulary(facts.boat)}` },
    { role: 'user', content: `FACTS:\n${JSON.stringify(facts)}` },
  ]
}

// ── Validation ──────────────────────────────────────────────────────────────

// Times (12:23 / 12:23:19) and letter-attached tokens (J4_A, A2, V1, MAIN_B, J1.5, MH0) are
// labels, and so is the one sail name the team writes with a space before its digit: "Code 0".
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g
const SAIL_WITH_SPACE = /\bcode\s+0\b/gi
const NUMBER = /(?<![A-Za-z0-9_+.])-?\d+(?:[.,]\d+)?(?![A-Za-z_+]|\.\d)/g

export function numbersIn(text: string): string[] {
  return (text.replace(TIME, ' ').replace(SAIL_WITH_SPACE, ' ').match(NUMBER) || []).map(s => s.replace(',', '.'))
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

const inSet = (set: Set<string>, n: string) => set.has(String(Number(n))) || set.has(n)

// Sentences whose numbers fail `ok` are moved to `dropped`; at most `max` kept.
function checkSentences(list: unknown, max: number, ok: (nums: string[]) => boolean, dropped: string[]): string[] {
  return (Array.isArray(list) ? list : [])
    .map(s => String(s ?? '').trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean)
    .filter(s => {
      const good = ok(numbersIn(s))
      if (!good) dropped.push(s)
      return good
    })
    .slice(0, max)
}

// Single-list headlines (written before the sections, still stored on older days).
export interface ValidatedHeadlines { headlines: string[]; bottomLine: string[]; dropped: string[] }

export const MAX_HEADLINES = 8
export const MAX_BOTTOM_LINE = 3

export function validateHeadlines(raw: { headlines?: unknown; bottomLine?: unknown }, facts: unknown): ValidatedHeadlines {
  const known = factNumbers(facts)
  const dropped: string[] = []
  const ok = (nums: string[]) => nums.every(n => inSet(known, n))
  return { headlines: checkSentences(raw.headlines, MAX_HEADLINES, ok, dropped), bottomLine: checkSentences(raw.bottomLine, MAX_BOTTOM_LINE, ok, dropped), dropped }
}

// Sectioned headlines — what is written and stored now.
export interface SectionText { headlines: string[]; bottomLine: string[] }
export interface ValidatedSections { version: 2; sections: Partial<Record<SectionKey, SectionText>>; dropped: string[] }

// The prompt's limits, enforced: the model does not keep to them reliably (11 Sep: 9 headlines for "4 to 8").
export const MAX_SECTION_HEADLINES = 5
export const MAX_SECTION_BOTTOM_LINE = 2

export function validateSections(raw: Record<string, unknown> | null | undefined, facts: HeadlineFacts): ValidatedSections {
  const dropped: string[] = []
  const sections: ValidatedSections['sections'] = {}
  for (const key of SECTION_ORDER) {
    const own = facts.sections[key]
    if (!own) continue
    // A sentence's numbers must all come from ONE table of its own section — so figures from
    // different tables (a band's VMG% with the tacks' distance lost) are never stitched into one
    // claim. Label numbers don't count: sail names ("MAIN_B 2026"), phase counts, polar / boat / venue.
    const tables: FactTable[] = [...own.tables, ...('manoeuvres' in own && own.manoeuvres ? [own.manoeuvres] : [])]
    const tableNumbers = tables.map(t => factNumbers(t))
    const labels = factNumbers([
      'sailsInUse' in own ? own.sailsInUse : null, 'phases' in own ? own.phases : own.lidarPhases,
      facts.polar, facts.boat, facts.venue,
    ])
    const ok = (nums: string[]) => {
      const measured = nums.filter(n => !inSet(labels, n))
      return !measured.length || tableNumbers.some(set => measured.every(n => inSet(set, n)))
    }
    const s = (raw?.[key] || {}) as { headlines?: unknown; bottomLine?: unknown }
    const text = {
      headlines: checkSentences(s.headlines, MAX_SECTION_HEADLINES, ok, dropped),
      bottomLine: checkSentences(s.bottomLine, MAX_SECTION_BOTTOM_LINE, ok, dropped),
    }
    if (text.headlines.length || text.bottomLine.length) sections[key] = text
  }
  return { version: 2, sections, dropped }
}
