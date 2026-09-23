// src/lib/ai/vocabulary.ts
// ─────────────────────────────────────────────────────────────────────────────
// The words a crew actually use, mapped to the things the database holds.
//
// Two jobs, and they are deliberately different in kind:
//
// 1. SAIL NAMES ARE MATCHED IN CODE, not by the model. "show me all sailscan
//    data of the J2 B 2026" found nothing, because the sail is stored as
//    "J2_B 2026" and `"j2_b 2026".includes("j2 b 2026")` is false. The inventory
//    is not even self-consistent — "J2_A_2026" all underscores, "J2_B 2026"
//    underscore then space — so "type it correctly" is not available as an
//    answer. Both sides are split into TOKENS instead — squashing them together
//    and doing a substring looks equivalent and is not: "J4_A 2026" squashes to
//    "j4a2026", which contains "a2", so asking for the A2 hands back the J4.
//
// 2. PHRASING IS EXPLAINED TO THE MODEL, not translated behind its back. "which
//    of pointing and footing mattered more" is a question about twa and bsp, but
//    silently rewriting the words would hide the assumption from the person who
//    asked. The vocabulary goes into the prompt as a table, the model maps the
//    words, and the search tokens show which channel it landed on — so a wrong
//    reading is visible and one tap from being fixed.
//
// The Dutch pairs are reused from debriefGlossary rather than copied: the crew
// speak the same Dutch to the recorder as they type into the Ask box, and two
// lists of the same words would drift.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_GLOSSARY, vocabForBoat, withOverride } from '../debriefGlossary'

// ── Sail names ───────────────────────────────────────────────────────────────

/**
 * The parts of a sail name, lower case: "J2_B 2026", "J2 B 2026" and "J2-b-2026"
 * all give ['j2', 'b', '2026'].
 */
export const sailTokens = (s: string | null | undefined): string[] =>
  (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** The tokens joined back up — for showing a normalised name, not for matching. */
export const sailKey = (s: string | null | undefined): string => sailTokens(s).join(' ')

/**
 * Does `candidate` (a stored sail, or a combination of two) match what was asked for?
 *
 * TOKENS, not a squashed substring. Deleting the separators and doing an
 * `includes` looks right and is not: "J4_A 2026" squashes to "j4a2026", which
 * CONTAINS "a2", so asking for the A2 would hand back the J4. The separators are
 * inconsistent in the inventory but they are not noise — they are where one part
 * of the name ends.
 *
 * A single-token query matches any part it starts ("J2" finds J2_A and J2_B, "J1"
 * does not reach into "J1.5" because that tokenises to j1 + 5). A multi-token
 * query must appear as a consecutive run, so "J2 B 2026" finds J2_B 2026 and not
 * J2_A_2026.
 */
export function matchesSail(candidate: string | null | undefined, query: string): boolean {
  const q = sailTokens(query)
  if (!q.length) return true
  const c = sailTokens(candidate)
  if (!c.length) return false
  if (q.length === 1) return c.some(t => t.startsWith(q[0]))
  for (let i = 0; i + q.length <= c.length; i++) {
    if (q.every((t, k) => c[i + k] === t)) return true
  }
  return false
}

// ── Phrasing → channels ──────────────────────────────────────────────────────
// Only entries where the mapping is genuinely unambiguous. A word that could
// mean two channels is left out: a wrong mapping asserted confidently is worse
// than the model asking, because the tokens then show a filter nobody meant.

export const CHANNEL_PHRASES: [string, string][] = [
  ['pointing, height, how high we were sailing', 'twa'],
  ['footing, sailing free', 'bsp with a wider twa'],
  ['how flat, stiff, heeled over, on its ear', 'heel'],
  // "bow down" is left out of BOTH: it means steering lower to a crew talking
  // about speed and a fore-and-aft attitude to a crew talking about trim. A word
  // that could mean two channels is worse in here than absent, because the search
  // tokens would then show a filter nobody meant.
  ['fore and aft trim, bow up, rake of the boat', 'trim'],
  ['forestay load, headstay load, sag, luff sag, rig tension', 'fsty'],
  ['helm, weather helm, rudder angle, fighting the wheel', 'rudder'],
  ['mainsheet load, sheet load on the main', 'mainsheet'],
  ['kicker', 'vang'],
  ['mast bend, deflection, how much the rig is bending', 'upDflct and lwDflct'],
  ['slip, the difference between speed through the water and over the ground', 'bspSog'],
  ['how close to target, target percentage, against the polar', 'vmgPct upwind and downwind, bspPol reaching'],
  ['camber, draft depth, how full the sail is', 'the lidar channels mnCa25, jibCa50 and so on'],
  ['draft position, where the draft sits', 'the lidar Dr channels, e.g. jibDr50'],
  ['twist, leech twist', 'the lidar Tw channels, e.g. mnTw75'],
]

/** Words that are NOT channels, and the answer the model should give instead. */
export const NOT_MEASURED: [string, string][] = [
  ['leeway', 'not logged — the closest is the gap between BSP and SOG (bspSog)'],
  ['current, tide', 'not logged'],
  ['sea state, waves, chop', 'not logged'],
  ['crew weight, hiking, stacking', 'not logged'],
  ['sail age, how many hours a sail has done', 'not logged'],
]

// ── The block that goes into the prompt ──────────────────────────────────────

/**
 * A compact vocabulary section for the system prompt. `sailNames` are the boat's
 * own, so the model can answer with the name as it is really stored rather than
 * the one somebody typed.
 */
export function vocabularyBlock(sailNames: string[], boatName?: string | null): string {
  const g = withOverride(vocabForBoat(boatName), DEFAULT_GLOSSARY)
  const lines: string[] = ['─── How this crew talk ───']

  lines.push('What they say → what to ask a tool for:')
  for (const [phrases, channel] of CHANNEL_PHRASES) lines.push(`  ${phrases} → ${channel}`)

  lines.push('Asked about, but NOT in this data — say so rather than substituting something else:')
  for (const [phrases, why] of NOT_MEASURED) lines.push(`  ${phrases} — ${why}`)

  if (g.aliases?.length) {
    lines.push(`Crew slang → the proper term: ${g.aliases.slice(0, 14).map(([a, b]) => `${a}→${b}`).join(', ')}.`)
  }
  if (g.dutch?.length) {
    lines.push(
      'Dutch is spoken on this boat and questions may arrive in it. '
      + `Translate, then answer in English: ${g.dutch.map(([nl, en]) => `${nl}→${en}`).join(', ')}.`,
    )
  }
  if (sailNames.length) {
    lines.push(
      `The boat's sails, named EXACTLY as stored: ${sailNames.join('; ')}. `
      + 'Pass the sail as the person wrote it — spaces, underscores and capitals are ignored when matching — but use the stored name in your answer.',
    )
  }
  return lines.join('\n')
}
