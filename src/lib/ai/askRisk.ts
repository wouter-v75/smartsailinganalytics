// src/lib/ai/askRisk.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which questions this thing is likely to get wrong, decided BEFORE it answers,
// and a narrower question offered instead.
//
// The reason it is deterministic and not a model self-assessment: a model asked
// "are you confident?" is answering a different question from the one it got
// wrong, and it is wrong about that too. Every signal here is a fact about the
// question and the data — no inference, so no second thing to hallucinate.
//
// Two moments:
//   • assessQuestion() runs before the model. A question about WHY, about WHO, or
//     about the boat next to us has no answer in a log of this boat's instruments.
//     Answering it anyway produces confident, plausible, invented sailing — the
//     exact failure that makes a coach stop trusting the tool after one reading.
//   • assessAnswer() runs after. Thin groups, dropped sentences, a comparison with
//     one row to compare, or an answer written without calling a tool at all.
//
// Cortex Analyst's pattern: an ambiguous question gets alternatives, not a guess.
// Ours go further — the alternatives are BUILT FROM THIS BOAT'S DATA (its sails,
// its races, its wind range), so every suggestion offered is one that can be
// answered. Suggesting a question that also fails is worse than saying nothing.
//
// Pure: no Supabase, no fetch, no React.
// ─────────────────────────────────────────────────────────────────────────────

import type { AskStep } from './askRun'
import type { VerifiedAnswer } from './askVerify'

export type RiskLevel = 'ok' | 'caution' | 'high'

export interface RiskFinding {
  code: string
  /** Shown to the person, in their words, not ours. */
  text: string
}

export interface RiskVerdict {
  level: RiskLevel
  findings: RiskFinding[]
  /** Questions this data can actually answer. Built from the context, never invented. */
  narrower: string[]
}

/** What the boat has, as the route already had to work out to build the prompt. */
export interface AskContext {
  date: string | null
  /** Days with stored phase stats, oldest first. */
  dates: string[]
  sailCombos: string[]
  races: number[]
  /** Metric keys with values on the open day. */
  channels: string[]
  phaseCount: number
  manoeuvreCount: number
  media: { photos: number; videos: number; scans: number; tags: number }
  twsRange: [number, number] | null
  hasSquadTracks?: boolean
}

// ── Signals ──────────────────────────────────────────────────────────────────
// Each is a plain fact about the wording. Word boundaries matter: "why" must not
// fire on "whys" inside another word, and "who" must not fire on "whole".

const RX = {
  causal: /\b(why|because|what caused|the cause of|reason(s)? (for|why)|due to|explain why)\b/i,
  people: /\b(who|whose|trimmer|helm(sman)?|bowman|pit|grinder|tactician|navigator|driver|crew work|the crew('s)? (performance|work)|which of us)\b/i,
  opposition: /\b(other boats?|competitor|competition|rival|opponent|the fleet|against (them|the others)|versus the|beat (them|us)|our competitors)\b/i,
  future: /\b(will we|should we|predict|forecast|tomorrow|next (race|day|week|regatta|event)|expect(ed)? to|what if|would we)\b/i,
  feel: /\b(felt|feel|feeling|comfortable|confidence|morale|happy|nervous|tired|fatigue)\b/i,
  environment: /\b(current|tide|tidal|wave|waves|sea state|swell|chop|gust front|cloud|weather)\b/i,
  broad: /\b(everything|anything (interesting|notable|useful)|overall|in general|how did we do|summari[sz]e|tell me about the day|what stood out)\b/i,
  compound: /\band also\b|\bas well as\b.*\?|\?.*\?/i,
}

// A question that names nothing the boat measures cannot be grounded. The list
// has to be GENEROUS: a false "we cannot answer that" on a good question is the
// fastest way to make the warning worth ignoring, and then it is not a warning.
// It is matched loosely (no word boundary at the end) so upwind/downwind,
// tacking, gybed, faster and pointing all count.
const MEASURABLE = new RegExp([
  // what is measured
  'vmg', 'bsp', 'polar', 'speed', 'quick', 'fast', 'slow', 'heel', 'trim', 'rudder',
  'forestay', 'backstay', 'load', 'sheet', 'vang', 'cunningham', 'angle', 'twa', 'tws',
  'awa', 'wind', 'breeze', 'puff', 'gust', 'lull', 'height', 'point', 'groove', 'target',
  // where on the course
  'upwind', 'downwind', 'reach', 'beat', 'run', 'leg', 'lap', 'mark', 'start', 'finish',
  'race', 'port', 'starboard', 'stbd', 'tack', 'gyb',
  // what is up
  'sail', 'jib', 'main', 'kite', 'spinnaker', 'genoa', 'code', 'camber', 'draft', 'twist',
  'rig', 'mast', 'lidar', 'shape',
  // what was recorded about it
  'manoeuvre', 'maneuver', 'photo', 'clip', 'video', 'scan', 'note', 'tag', 'debrief',
  'session', 'day', 'today', 'season',
].join('|'), 'i')

const FINDING_TEXT: Record<string, string> = {
  causal: 'You have asked why. The log records what the boat did, not the reason — anything it offers as a cause would be the model guessing.',
  people: 'You have asked about a person or a role. Nothing in this data is tied to an individual crew member, so any name it gives you would be invented.',
  opposition: 'You have asked about other boats. This day holds only your own instruments — there is nothing here about anyone else.',
  future: 'You have asked about what comes next. This is a record of what happened; it holds no prediction.',
  feel: 'You have asked how something felt. That is not a recorded channel.',
  environment: 'You have asked about the water or the weather beyond the boat\'s own wind instruments. Current, sea state and cloud are not logged.',
  broad: 'The question is broad. A broad question gets a broad answer, and a broad answer is the easiest kind to get quietly wrong.',
  compound: 'That is more than one question. Asked together they tend to come back half-answered.',
  noStats: 'This day has no stored performance data yet, so there is nothing to read.',
  noMeasurable: 'Nothing in the question names something the boat measures, so it is not clear which numbers would answer it.',
  thinDay: 'This day has very few steady-state phases, so any comparison drawn from it rests on a handful of moments.',
}

// ── The narrower questions ───────────────────────────────────────────────────
// Templates filled from the context, so each one is known-answerable.

function buildNarrower(ctx: AskContext, codes: Set<string>): string[] {
  const day = ctx.date ? ` on ${ctx.date}` : ''
  const out: string[] = []
  const has = (m: string) => ctx.channels.includes(m)
  const perf = has('vmgPct') ? 'VMG%' : has('bspPol') ? '%Pol' : 'boat speed'

  if (ctx.phaseCount > 0) {
    out.push(`Was ${perf} better on port or starboard upwind${day}?`)
    if (ctx.sailCombos.length >= 2) {
      out.push(`Which was quicker upwind${day}, ${ctx.sailCombos[0]} or ${ctx.sailCombos[1]}?`)
    }
    if (ctx.twsRange) {
      const [lo, hi] = ctx.twsRange
      if (hi - lo >= 4) out.push(`How did ${perf} change between ${Math.round(lo)} and ${Math.round(hi)} kn upwind${day}?`)
    }
    if (ctx.races.length >= 2) {
      out.push(`Compare ${perf} upwind between race ${ctx.races[0]} and race ${ctx.races[1]}${day}.`)
    }
    if (ctx.dates.length >= 3) {
      out.push(`How does ${day.trim() || 'this day'} compare with the rest of the season upwind?`)
    }
  }
  if (ctx.manoeuvreCount >= 3) out.push(`Which tacks cost the most distance${day}?`)
  if (ctx.media.photos > 0) out.push(`Show me the photos from the strongest wind${day}.`)
  if (ctx.media.scans > 0) out.push(`What do the sail scans${day} say about jib camber?`)
  if (ctx.media.tags > 0 && codes.has('causal')) out.push(`What did we tag or write down${day}?`)

  // A "why" question is best redirected at what the data CAN separate; a "who"
  // question at the tack or the manoeuvre, which is as close to a person as this
  // data legitimately gets.
  const priority = codes.has('people') || codes.has('causal')
    ? out.sort((a, b) => Number(b.startsWith('Which tacks')) - Number(a.startsWith('Which tacks')))
    : out
  return Array.from(new Set(priority)).slice(0, 3)
}

/**
 * Before the model runs. `high` means the answer would be invented, and the UI
 * makes the person confirm; `caution` means it is answerable but easy to
 * over-read, and the answer carries the note.
 */
export function assessQuestion(question: string, ctx: AskContext): RiskVerdict {
  const q = (question || '').trim()
  const codes = new Set<string>()

  if (!ctx.dates.length || ctx.phaseCount === 0) codes.add('noStats')
  for (const [code, rx] of Object.entries(RX)) {
    if (code === 'opposition' && ctx.hasSquadTracks) continue   // squad tracks DO hold other boats
    if (rx.test(q)) codes.add(code)
  }
  if (q.length > 12 && !MEASURABLE.test(q)) codes.add('noMeasurable')
  if (ctx.phaseCount > 0 && ctx.phaseCount < 12) codes.add('thinDay')

  // Absent data outranks an awkward question: no amount of rewording puts another
  // boat, a crew member's name or tomorrow's breeze into this log.
  const ABSENT = ['noStats', 'people', 'opposition', 'future', 'feel']
  const level: RiskLevel = ABSENT.some(c => codes.has(c)) ? 'high'
    : codes.size ? 'caution' : 'ok'

  const order = ['noStats', 'people', 'opposition', 'future', 'feel', 'environment', 'causal', 'noMeasurable', 'compound', 'broad', 'thinDay']
  const findings = order.filter(c => codes.has(c)).map(code => ({ code, text: FINDING_TEXT[code] }))

  return { level, findings, narrower: level === 'ok' ? [] : buildNarrower(ctx, codes) }
}

/** One line for the prompt, so the model behaves the way the warning promises. */
export function riskNote(v: RiskVerdict): string {
  if (v.level === 'ok') return ''
  return [
    'Be careful with this question. ' + v.findings.map(f => f.text).join(' '),
    'Say plainly what the data cannot show rather than filling the gap, and put better questions in "suggestions".',
  ].join(' ')
}

// ── After the answer ─────────────────────────────────────────────────────────

/** A group backed by fewer phases than this is a hint, not a finding. */
export const THIN_GROUP = 6

export function assessAnswer(steps: AskStep[], answer: VerifiedAnswer): RiskFinding[] {
  const out: RiskFinding[] = []

  if (!steps.length) {
    out.push({
      code: 'noTools',
      text: 'This was written without reading any of the boat\'s data. Treat it as a suggestion, not a finding.',
    })
  }

  let thin = 0, groups = 0
  for (const s of steps) {
    for (const t of s.result.tables) {
      const ni = t.columns.findIndex(c => c.key === 'n')
      if (ni < 0) continue
      for (const r of t.rows) {
        const n = r[ni]
        if (typeof n === 'number') { groups++; if (n < THIN_GROUP) thin++ }
      }
    }
  }
  if (thin && groups) {
    out.push({
      code: 'thinGroups',
      text: `${thin} of ${groups} group${groups === 1 ? '' : 's'} rest${thin === 1 ? 's' : ''} on fewer than ${THIN_GROUP} phases — about ${THIN_GROUP / 2} minutes of sailing. Narrow the question or widen the wind band.`,
    })
  }

  const oneRow = steps.filter(s => s.tool === 'compare_phases' && s.result.tables.some(t => t.rows.length === 1))
  if (oneRow.length) {
    out.push({
      code: 'noComparison',
      text: 'One of the comparisons came back with a single row, so nothing was actually compared. The filter is probably too tight.',
    })
  }

  if (answer.dropped.length) {
    out.push({
      code: 'dropped',
      text: `${answer.dropped.length} sentence${answer.dropped.length === 1 ? '' : 's'} ${answer.dropped.length === 1 ? 'was' : 'were'} removed: ${answer.dropped.length === 1 ? 'it carried a number' : 'they carried numbers'} that ${answer.dropped.length === 1 ? 'is' : 'are'} not in the tables below.`,
    })
  }

  return out
}
