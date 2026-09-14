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
import { startAnalyses } from './startAnalysis'
import { seasonCurves, type ModeCurves, type SeasonRow } from './seasonCurves'

export interface FactTable { title: string; columns: string[]; rows: (string | number)[][] }

export type SectionKey = 'start' | 'upwind' | 'downwind' | 'reaching' | 'sailShape'
export const SECTION_ORDER: SectionKey[] = ['start', 'upwind', 'downwind', 'reaching', 'sailShape']
export const SECTION_TITLES: Record<SectionKey, string> = { start: 'Start', upwind: 'Upwind', downwind: 'Downwind', reaching: 'Reaching', sailShape: 'Sail shape' }

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
export interface StartFacts {
  starts: number
  about: string
  tables: FactTable[]
}
export interface HeadlineFacts {
  date: string
  boat: string | null
  venue: string | null
  polar: string | null
  logResolutionSeconds: number | null
  sections: { start?: StartFacts; upwind?: SectionFacts; downwind?: SectionFacts; reaching?: SectionFacts; sailShape?: SailShapeFacts }
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

// ── Tacks and season ─────────────────────────────────────────────────────────
// What the crew want first: which tack was quicker, and how the day stands against the season —
// "2% faster on port with VMG% 96, 1% better than the season average at this wind". The model
// never calculates, so the differences and their wording are worked out here. VMG% (%Pol when
// reaching) in whole numbers, and the differences between those whole numbers, so every number in
// a sentence matches the one next to it. The season is the boat's other stored days this year, each
// of today's phases matched to the season's median at its wind (1 kn bins, seasonCurves) — a light
// day is not judged against a season of 25 kn days.
export const MIN_SEASON_COVERAGE = 0.5

function tackSeasonFacts(own: PhaseStat[], mode: Mode, modeTitle: string, curves: ModeCurves | undefined): FactTable | null {
  const metric = mode === 'reach' ? 'bspPol' : 'vmgPct'
  const label = mode === 'reach' ? '%Pol' : 'VMG%'
  const curve = curves?.[mode]?.[metric] || []
  const seasonAt = (tws: number | null | undefined) => (tws == null ? null : curve.find(c => c.x === Math.round(tws))?.y ?? null)
  const avg = (ps: PhaseStat[], k: string) => {
    const xs = ps.map(p => p.mean[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return xs.length ? mean(xs) : null
  }
  const row = (tack: 'port' | 'stbd') => {
    const ps = own.filter(p => p.tack === tack)
    const other = own.filter(p => p.tack !== tack)
    const v = avg(ps, metric), ov = avg(other, metric), bsp = avg(ps, 'bsp')
    if (v == null) return null
    // Too few phases on a tack says nothing about it: 7 Sep reached on port for one 30 s phase, which
    // would have read "10% slower on port, 12% below the season" — and with its %Pol still in the row,
    // the text compared it anyway ("Stbd 92%Pol against port 82%Pol"). A thin tack shows its count only.
    const thin = ps.length < MIN_BAND_PHASES
    const vr = roundTo(v, 0)
    const d = ov == null || thin || other.length < MIN_BAND_PHASES ? null : vr - roundTo(ov, 0)
    const word = tack === 'port' ? 'port' : 'starboard'
    const matched = ps.filter(p => p.mean[metric] != null && seasonAt(p.mean.tws) != null)
    const season = !thin && matched.length && matched.length >= ps.length * MIN_SEASON_COVERAGE ? roundTo(mean(matched.map(p => seasonAt(p.mean.tws) as number)), 0) : null
    const sd = season == null ? null : vr - season
    return [
      tack === 'port' ? 'Port' : 'Stbd', ps.length, thin ? '' : vr, thin || bsp == null ? '' : roundTo(bsp, 2),
      d ?? '', d == null ? '' : d > 0 ? `${d}% faster on ${word}` : d < 0 ? `${-d}% slower on ${word}` : 'level with the other tack',
      season ?? '', sd ?? '',
      sd == null ? '' : sd > 0 ? `${sd}% better than the season average at this wind` : sd < 0 ? `${-sd}% below the season average at this wind` : 'level with the season average at this wind',
    ]
  }
  const rows = [row('port'), row('stbd')].filter((r): r is (string | number)[] => r != null)
  if (!rows.length) return null
  return {
    title: `${modeTitle}: Port vs Stbd, and against this season at the same wind`,
    columns: ['tack', 'phases', label, 'BSP (kn)', `vs other tack (${label} points)`, 'wording vs other tack',
      `season ${label} at this wind`, `vs season (${label} points)`, 'wording vs season'],
    rows,
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

// ── Start ─────────────────────────────────────────────────────────────────────
// From the Start subtab's analysis (lib/startAnalysis): one row per start gun — what the boat had
// at the gun and 30 s later — and each run-in's last two minutes every 10 s, so a claim about a
// start or its final minute is a row the model can quote.
export const RUN_IN_FROM_S = -120
const r1 = (v: number | null | undefined, d = 1): number | '' => (v == null ? '' : roundTo(v, d))

// Columns with no value for any start (a log without BSP_trg%, or a distance left out) are dropped, as the
// report tables do: an empty column only tempts the model to fill it — on 4 and 7 Sep it wrote "BSP_trg% 97"
// from the VMG% next to it in every start sentence, and the check had to drop them all.
function dropEmptyColumns(t: FactTable, keep: string[]): FactTable {
  const on = t.columns.map((c, i) => keep.includes(c) || t.rows.some(r => r[i] !== '' && r[i] != null))
  return { ...t, columns: t.columns.filter((_, i) => on[i]), rows: t.rows.map(r => r.filter((_, i) => on[i])) }
}

function startFacts(rows: { utc: number; [k: string]: unknown }[], xml: any, polar: any, tzMin: number): StartFacts | undefined {
  const starts = startAnalyses(rows, xml, polar).filter(s => s.atGun?.bsp != null)
  if (!starts.length) return undefined
  // Starts are numbered in order; the race number only when the event file has one (7 Sep's first
  // gun is "Race 0" — a practice start, not a race).
  // The crew's own words for the moment of the gun, so the text gets the direction right: a negative
  // burn at the gun is late, a positive distance is below the line. Percentages and burns are whole
  // numbers, the way a start is talked about ("late by 3 s … 80% VMG"), so the text quotes them exactly.
  const timing = (burn: number | '') => (burn === '' ? '' : burn < 0 ? `late by ${Math.abs(burn)} s` : burn > 0 ? `early by ${burn} s` : 'on time')
  const lineAt = (bl: number | '') => (bl === '' ? '' : bl < 0 ? `${Math.abs(bl)} BL over the line` : `${bl} BL below the line`)
  const overview: FactTable = {
    title: 'Starts — at the gun and 30 s later',
    columns: ['start', 'race', 'gun', 'sails', 'timing at gun', 'line at gun', 'TWS last minute (kn)', 'TWD last minute (deg)',
      'DistLn at gun (BL)', 'BSP at gun (kn)', 'BSP_trg% at gun', 'Burn at gun (s)', 'TWA at gun (deg)',
      'BSP at +30 s (kn)', 'BSP_trg% at +30 s', 'VMG% at +30 s'],
    rows: starts.map((s, i) => {
      const burn = r1(s.atGun?.burn, 0), dist = r1(s.atGun?.distLn)
      return [
        i + 1, s.raceNum || '', hm(s.gunUtc, tzMin), s.sails, timing(burn), lineAt(dist), r1(s.twsAtGun), r1(s.twdAtGun, 0),
        dist, r1(s.atGun?.bsp), r1(s.atGun?.bspTrgPct, 0), burn, r1(s.atGun?.twa, 0),
        r1(s.plus30?.bsp), r1(s.plus30?.bspTrgPct, 0), r1(s.plus30?.vmgPct, 0),
      ]
    }),
  }
  // Which start was best or worst is exactly the claim a number check can't verify — 7 Sep's text called the
  // start with 107% VMG after the gun the worst and a 96% one the best. Ranked here instead, by VMG% 30 s after
  // the gun, so the bottom line copies the first and last rows.
  const ranked = starts
    .map((s, i) => ({ label: s.raceNum ? `Race ${s.raceNum}` : `Start ${i + 1}`, vmg: r1(s.plus30?.vmgPct, 0), timing: timing(r1(s.atGun?.burn, 0)) }))
    .filter((x): x is { label: string; vmg: number; timing: string } => x.vmg !== '')
    .sort((a, b) => b.vmg - a.vmg)
  const ranking: FactTable | null = ranked.length >= 2
    ? {
      title: 'Starts ranked by VMG% 30 s after the gun (first row = highest, last row = lowest)',
      columns: ['rank', 'start', 'VMG% at +30 s', 'timing at gun'],
      rows: ranked.map((x, k) => [k + 1, x.label, x.vmg, x.timing]),
    }
    : null
  // VMG% only from the gun on: before it the boat is luffing, reaching and bearing away, and a
  // VMG% of 127 at −60 s (8 Sep) says nothing about the start.
  const runIns: FactTable[] = starts.map((s, i) => ({
    title: `Start ${i + 1}${s.raceNum ? ` (Race ${s.raceNum})` : ''} run-in, every 10 s (t = seconds to the gun)`,
    columns: ['t (s)', 'event', 'DistLn (BL)', 'BSP (kn)', 'BSP_trg%', 'TWA (deg)', 'Burn (s)', 'VMG% (from the gun)'],
    rows: s.samples
      .filter(x => x.t >= RUN_IN_FROM_S && x.t <= 30 && x.t % 10 === 0)
      .map(x => [x.t, x.event, r1(x.distLn), r1(x.bsp), r1(x.bspTrgPct, 0), r1(x.twa, 0), r1(x.burn, 0), r1(x.t >= 0 ? x.vmgPct : null, 0)]),
  }))
  return {
    starts: starts.length,
    about: 'DistLn = distance to the start line in boat lengths (BL), positive below the line, negative over it. Burn = time to burn at that moment: + early, − late. BSP_trg% = BSP against target. VMG% against the polar, only from the gun on. Percentages and burns are whole numbers. An empty cell is no value. Values from the log around each gun, at fixed times.',
    tables: [
      dropEmptyColumns(overview, ['start', 'race', 'gun', 'sails']),
      ...(ranking ? [ranking] : []),
      ...runIns.map(t => dropEmptyColumns(t, ['t (s)', 'event'])),
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
  xml?: any            // the event file (its sailsUpEvents tag the main; raceGuns / startLines for the start)
  rows?: { utc: number; [k: string]: unknown }[] | null   // the log, for the start section
  polar?: any          // prepared polar, for VMG% in the start section
  seasonRows?: SeasonRow[] | null   // the boat's stored days, for "against the season at this wind"
}): HeadlineFacts {
  const hasPolar = !!input.polarName
  const curves = input.seasonRows?.length
    ? seasonCurves(input.seasonRows, { exclude: [input.date] }).curves[input.date.slice(0, 4)]
    : undefined
  const MODE_TITLE: Record<Mode, string> = { up: 'Upwind', down: 'Downwind', reach: 'Reaching' }
  const section = (mode: Mode, specs: ReportSpec[], manoeuvres?: FactTable): SectionFacts | undefined => {
    const own = input.stats.filter(s => s.mode === mode)
    if (own.length < MIN_SECTION_PHASES) return undefined
    const tackSeason = tackSeasonFacts(own, mode, MODE_TITLE[mode], curves)
    return {
      phases: own.length,
      sailsInUse: sailsInUse(own, input.xml),
      tables: [
        ...(tackSeason ? [tackSeason] : []),
        ...specs.map(spec => buildTable(input.stats, spec, { hasPolar })).filter(t => t.rows.length).map(tableFacts).filter(t => t.rows.length),
      ],
      ...(manoeuvres ? { manoeuvres } : {}),
    }
  }
  const sections: HeadlineFacts['sections'] = {}
  const up = section('up', REPORTS.up, manoeuvreFacts('Tacks', input.manoeuvres.filter(m => m.kind === 'tack'), input.tzOffsetMin))
  const down = section('down', REPORTS.down, manoeuvreFacts('Gybes', input.manoeuvres.filter(m => m.kind === 'gybe'), input.tzOffsetMin))
  const reach = section('reach', REPORTS.reach)
  const shape = sailShapeFacts(input.stats, input.xml)
  const start = input.rows?.length ? startFacts(input.rows, input.xml, input.polar ?? null, input.tzOffsetMin) : undefined
  if (start) sections.start = start
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
  '   both numbers as given (e.g. "Port N %Pol against Stbd N", N = values from FACTS).',
  '2. Only state what the numbers show. No guesses about causes, no invented context.',
  '3. Sailing language, short plain sentences, at most 30 words each.',
  '4. Each section uses only its own facts: "start" = sections.start, "upwind" = sections.upwind (its',
  '   tables and the tacks), "downwind" = sections.downwind (its tables and the gybes), "reaching" =',
  '   sections.reaching, "sailShape" = sections.sailShape. A number from another section does not belong in it.',
  '5. 2 to 5 headlines per section, most important first: speed by tack and sails, the quickest wind /',
  '   TWA / heel bands, the tacks (upwind) or gybes (downwind).',
  '6. Sail tags: whenever a sentence is about a sail combination, a manoeuvre on certain sails or a',
  '   sail\'s shape, name the sails — headsails as written in the tables (e.g. "J4_A 2026"), and the main',
  '   from "sailsInUse" (e.g. "MAIN_B 2026") when one main was used with them.',
  '7. Prefer comparisons inside one table — Port against Stbd, one band against another — quoting',
  '   both numbers (e.g. "under N deg TWA gives VMG% N, N-N deg gives N").',
  '8. The "n" column is the number of 30 s phases behind a row. Rows with n under 6 are thin: do not',
  '   call them best or worst, and if you mention one, give its n.',
  '9. sailShape: each of its tables is ONE point of sail, sail and variable (its title, e.g. "Upwind MAIN_B',
  '   2026 Twist 50%"), with bands of the measured value and the VMG% and %Pol sailed in them, best VMG% first.',
  '   One table per sentence: quote that table\'s best band\'s VMG% against its lowest band\'s VMG%, naming the',
  '   sail, the point of sail and the variable as in the title (e.g. "MAIN_B 2026 upwind camber 25%: N-N gave',
  '   VMG% N, N-N gave N"). Never take a band or a VMG% from another table. You may add the best band\'s',
  '   measured and target values, and its n when under 6. Never advise moving the shape to the target: the',
  '   numbers only show which measured band sailed best. Its bottom line: 1 or 2 sentences, each naming one',
  '   table\'s best band with its VMG%.',
  '10. The AVERAGE row of the tacks or gybes covers every judged manoeuvre — never present it as one tack\'s.',
  '    A negative "distance lost" is distance gained.',
  '11. 1 or 2 bottom-line points per section: what sailed best or worst and is worth repeating or fixing, each',
  '    tied to a number from that section. Do not invent causes or settings ("trim for…", "replicate…").',
  '12. Keep each sentence\'s numbers to one table of the section; quote sail names as labels only. Write each',
  '    number right after its own metric ("VMG% N", "BSP_trg% N", "Burn N s", "N BL"), taken from that',
  '    metric\'s column — never a value from a neighbouring column.',
  '13. Write like the team\'s speed-team notes: short plain sentences in the team\'s own sailing jargon',
  '    (TEAM VOCABULARY below), not generic plain English. Give a sail its full code from the tables the first',
  '    time in a section (e.g. "J1.5_B 2026"), then its short name (e.g. "J1.5", "A2", "MH0").',
  '14. Keep the units the tables give (kn, deg, %, m, s). VMG%, %Pol, BSP and TWA are four different things —',
  '    never report one as another.',
  '15. start: write it as mostly plain text, the way the crew talk about a start — one short sentence per start,',
  '    made of these parts in this order, each ONLY when the Starts table has that column for the start: its',
  '    "timing at gun" wording ("late for the start by N s"), its "line at gun" wording ("N BL below the line at',
  '    the gun"), its VMG% at +30 s ("N% VMG 30 s after the gun"), and its sails. N = the values in the table —',
  '    never copy a number from an example in these rules, and never take a number from another start\'s row.',
  '    When the table has no "line at gun" column, or the start\'s cell is empty, say',
  '    nothing about the line (never "0 BL"). Call a start by its race ("Race N") or, when the race column is',
  '    empty, by its start number ("Start N"). A run-in table (every 10 s, t negative = before the gun) only adds',
  '    what changed in the last minute: a value, its time, and where it went. Bottom line: with two or more',
  '    starts, the highest and the lowest VMG% after the gun — the first and last rows of the ranking table —',
  '    quoting both (say "highest" and "lowest", not "best" and "worst"); with one start, its two most telling',
  '    numbers. Do not say who was right or wrong, and give no causes.',
  '16. An empty cell means there is no value: never write a number for it (not 0) and never compare on it.',
  '    Every sentence must quote at least one number from the tables — a comparison without numbers is dropped.',
  '17. upwind, downwind, reaching: open with one sentence on the tacks and one on the season, from the section\'s',
  '    first table, copying its wording columns for the direction — in the style of "N% faster on port (VMG% N',
  '    against N on starboard)" and "port N% better than the season average at this wind (N), starboard N%',
  '    below" (N = the values in the table; never copy a number from an example, and never repeat the table\'s',
  '    title). Name the faster tack once, and give each tack its own season wording when they differ. Reaching',
  '    uses %Pol instead of VMG%. Then the details behind it from the other tables: sails, wind, TWA and heel',
  '    bands, tacks or gybes. When the season columns are empty, say nothing about the season.',
  'Reply with JSON only, one key per section present in FACTS:',
  '{"start": {...}, "upwind": {"headlines": ["..."], "bottomLine": ["..."]}, "downwind": {...}, "reaching": {...}, "sailShape": {...}}.',
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

// A metric written right against its number ("BSP_trg% 70.2", "Burn −4 s", "103.4 VMG%", "0.4 BL")
// names the column that number must come from. 8 Sep's start summary called the VMG% at the gun
// (70.2) "BSP_trg% 70.2" — both in one run-in table, so the one-table rule alone let it through.
// A number followed by "-digits" is a band label ("TWS 11-13 kn"), not a value, and is skipped; so is
// a race or start number ("Race 5 BSP_trg% 70.2" is BSP_trg% 70.2, not BSP_trg% 5). A number is only
// ever taken whole — `(?!\d)(?![.,]\d)` — or backtracking would turn the band "11-13" into a value 1.
// Not metric values either: the label "time to 95% BSP" ("95% BSP 29 s" is a time), a sail code's year
// ("J4_A 2026 VMG% 96") and the upper end of a band ("6-7 VMG% 96.5").
// A number followed by "s" is a time ("89 VMG% 30 s after the gun" is not a VMG% of 30 — 11 Sep lost
// both start sentences to that), except after Burn, whose values are seconds; and "N VMG% points" is a
// difference between tacks, not a VMG% value.
const METRIC_THEN_NUMBER = /(?<!\d%\s)(BSP_trg%|VMG%|%Pol|DistLn|BSP|TWA|TWS|TWD|Heel)(?![A-Za-z_%])\s+[−+-]?(\d+(?:[.,]\d+)?)(?!\d)(?![.,]\d)(?!\s*-\s*\d)(?!\s*s\b)/g
const BURN_THEN_NUMBER = /(Burn)(?![A-Za-z_%])\s+[−+-]?(\d+(?:[.,]\d+)?)(?!\d)(?![.,]\d)/g
const NUMBER_THEN_METRIC = /(?<![A-Za-z0-9_.\-−])(?<!(?:[Rr]ace|[Ss]tart)\s+)[−+-]?(?!(?:19|20)\d\d(?![\d.,]))(\d+(?:[.,]\d+)?)(?!\d)(?![.,]\d)(?!\s*-\s*\d)\s*(?:kn\s+)?(BSP_trg%|VMG%|%Pol|BL)(?![A-Za-z_])(?!\s*points)/g
// "89% VMG" — how the crew write it — is a VMG% value too.
const PERCENT_VMG = /(?<![A-Za-z0-9_.\-−])(\d+(?:[.,]\d+)?)%\s*VMG(?![A-Za-z_%])(?!\s*points)/g

export function metricNumbers(sentence: string): [string, string][] {
  const s = sentence.replace(TIME, ' ')
  const pairs: [string, string][] = []
  for (const m of Array.from(s.matchAll(METRIC_THEN_NUMBER))) pairs.push([m[1], m[2].replace(',', '.')])
  for (const m of Array.from(s.matchAll(BURN_THEN_NUMBER))) pairs.push([m[1], m[2].replace(',', '.')])
  for (const m of Array.from(s.matchAll(NUMBER_THEN_METRIC))) pairs.push([m[2] === 'BL' ? 'DistLn' : m[2], m[1].replace(',', '.')])
  for (const m of Array.from(s.matchAll(PERCENT_VMG))) pairs.push(['VMG%', m[1].replace(',', '.')])
  return pairs
}

// Numbers per metric, from the cells of the columns headed by that metric ("VMG% at +30 s" → VMG%).
function columnNumbers(tables: FactTable[]): Map<string, Set<string>> {
  const byMetric = new Map<string, unknown[]>()
  for (const t of tables) {
    t.columns.forEach((label, i) => {
      const metric = label.split(' ')[0]
      byMetric.set(metric, [...(byMetric.get(metric) || []), ...t.rows.map(r => r[i]).filter(v => typeof v === 'number')])
    })
  }
  return new Map(Array.from(byMetric, ([k, vs]) => [k, factNumbers(vs)]))
}

// A start's own rows: its line in the Starts table, its ranking row and its run-in table, under each name
// the text may use for it ("Race 5", "Start 1").
function startRowTables(own: StartFacts): Map<string, FactTable[]> {
  const byName = new Map<string, FactTable[]>()
  const add = (name: string, t: FactTable) => byName.set(name, [...(byName.get(name) || []), t])
  for (const t of own.tables) {
    const runIn = t.title.match(/^Start (\d+)(?: \(Race (\d+)\))? run-in/)
    if (runIn) {
      add(`Start ${runIn[1]}`, t)
      if (runIn[2]) add(`Race ${runIn[2]}`, t)
      continue
    }
    const iStart = t.columns.indexOf('start'), iRace = t.columns.indexOf('race')
    for (const r of t.rows) {
      const one = { ...t, rows: [r] }
      if (iRace >= 0) {                       // the Starts table: start number + race number
        add(`Start ${r[iStart]}`, one)
        if (r[iRace] !== '') add(`Race ${r[iRace]}`, one)
      } else if (iStart >= 0) {               // the ranking table: the name as written
        add(String(r[iStart]), one)
      }
    }
  }
  return byName
}

// Sentences whose numbers fail `ok` are moved to `dropped`; at most `max` kept.
function checkSentences(list: unknown, max: number, ok: (nums: string[], sentence: string) => boolean, dropped: string[]): string[] {
  return (Array.isArray(list) ? list : [])
    .map(s => String(s ?? '').trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean)
    .filter(s => {
      const good = ok(numbersIn(s), s)
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
      'sailsInUse' in own ? own.sailsInUse : null,
      'phases' in own ? own.phases : 'lidarPhases' in own ? own.lidarPhases : own.starts,
      facts.polar, facts.boat, facts.venue,
    ])
    // …and it must quote at least one real value from a table: "Race 6 start closer to the line"
    // (11 Sep, when Race 6 had no distance at the gun) carries no number, so nothing could check it.
    const valueNumbers = factNumbers(tables.map(t => t.rows.flat().filter(v => typeof v === 'number')))
    const byColumn = columnNumbers(tables)
    // A start sentence that names one start must take its numbers from that start's rows — 11 Sep's text
    // gave Race 6 "1.2 BL below the line at the gun", Race 5's distance from the row above.
    const startRows = key === 'start' ? startRowTables(own as StartFacts) : null
    const ok = (nums: string[], sentence: string) => {
      if (!nums.some(n => inSet(valueNumbers, n))) return false
      for (const [metric, n] of metricNumbers(sentence)) {
        const col = byColumn.get(metric)
        if (!col || !inSet(col, n)) return false
      }
      let sets = tableNumbers
      if (startRows) {
        const named = Array.from(new Set(Array.from(sentence.matchAll(/\b(Race|Start)\s+(\d+)\b/g)).map(m => `${m[1]} ${m[2]}`)))
        if (named.length === 1) {
          const rowsOf = startRows.get(named[0])
          if (!rowsOf) return false
          sets = rowsOf.map(t => factNumbers(t))
        }
      }
      const measured = nums.filter(n => !inSet(labels, n))
      return !measured.length || sets.some(set => measured.every(n => inSet(set, n)))
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
