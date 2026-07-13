// src/lib/sailCodeMatch.ts
// ─────────────────────────────────────────────────────────────────────────────
// Match a SailScan report's sail to the boat's inventory, so an imported scan is
// tagged automatically instead of landing untagged.
//
// Why this matters beyond convenience: an UNTAGGED scan has no sail, so the detail
// view can't resolve its design target and falls back to guessing — which handed a
// main scan a jib's design curve, and jib designs stop at the 75% stripe, so the
// main's 87% design row silently disappeared. The report knows the sail ("Code:
// MN A 26"); we just weren't reading it.
//
// Matching is deliberately CONSERVATIVE. A wrong auto-tag is worse than none — it
// would attach the scan to the wrong sail's design curve and let a Northstar edit
// save onto the wrong sail. So we only tag on an unambiguous single match, and the
// sail's kind must agree with the report's own main/headsail classification.
// ─────────────────────────────────────────────────────────────────────────────

import { designCodeOf } from './designInterp'

// "MN A 26" → "MN A"; "MAIN_A_2026" → "MAIN A"; "J1.5 A 26" → "J1.5 A".
// Uppercase, punctuation → space, collapse, then drop a trailing year token
// ('26' or '2026') — the sailmaker stamps the year on the code but the inventory
// category usually doesn't carry it.
export function normSailCode(s: string | null | undefined): string {
  if (!s) return ''
  const up = String(s).toUpperCase().replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ').trim()
  return up.replace(/\s+(?:20)?\d{2}$/, '').trim()
}

const kindOf = (sail: any): 'main' | 'headsail' | null => {
  if (sail?.kind === 'mainsail') return 'main'
  if (sail?.kind === 'headsail' || sail?.kind === 'jib') return 'headsail'
  const c = designCodeOf(sail?.category || sail?.name)
  if (c === 'MN') return 'main'
  return c ? 'headsail' : null
}

/**
 * Resolve the inventory sail a scan belongs to.
 *   sailCode  — the report's "Code:" (e.g. "MN A 26")
 *   sailName  — the report's "Sail:" line, used as a fallback
 *   sailType  — the report's own classification ('main' | 'headsail')
 * Returns the matching sail's id, or null when there's no unambiguous match.
 */
export function matchSailToInventory(
  sails: any[],
  sailCode: string | null,
  sailName: string | null,
  sailType: string | null
): string | null {
  const list = (sails || []).filter((s) => s?.id)
  if (!list.length) return null

  // Only consider sails whose kind agrees with the report. This alone prevents the
  // failure mode that started all this — a main scan matching a jib.
  const typed = sailType ? list.filter((s) => kindOf(s) === sailType) : list
  const pool = typed.length ? typed : list

  const wanted = normSailCode(sailCode) || normSailCode(sailName)
  if (!wanted) {
    // No code at all: if the boat has exactly ONE sail of this type, it's that one.
    return sailType && typed.length === 1 ? typed[0].id : null
  }

  // 1. Exact match on the normalised category or name ("MN A 26" ⇒ "MN A").
  const exact = pool.filter(
    (s) => normSailCode(s.category) === wanted || normSailCode(s.name) === wanted
  )
  if (exact.length === 1) return exact[0].id

  // 2. Design-code match ("MN A 26" ⇒ MN; "J1.5 A" ⇒ J1.5). Enough to pick the
  //    mainsail (a boat has one), and enough for a jib when only one carries the code.
  const want = designCodeOf(wanted)
  if (want) {
    const byCode = pool.filter((s) => designCodeOf(s.category || s.name) === want)
    if (byCode.length === 1) return byCode[0].id
  }

  // 3. Single sail of that type on the boat — the main, typically.
  if (sailType === 'main' && typed.length === 1) return typed[0].id

  // Ambiguous → leave untagged rather than guess wrong.
  return null
}
