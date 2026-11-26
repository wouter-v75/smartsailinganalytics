// src/lib/sailchart/match.ts
// ─────────────────────────────────────────────────────────────────────────────
// Chart shape ↔ inventory sail matching.
//
// A chart shape is a sail TYPE ("J3"); the inventory holds physical sails
// ("J3-A", "J3+A 2026", "BR0_A 2026"). One shape usually stands for several
// sails, so a match is a LIST, and the file's own <alias> list (J3-A;J3-B…) is
// the strongest evidence after an exact name.
//
// The rule that matters is the CODE boundary: "J1" must never take "J1.5", and
// "J3" must never take "J3+" — on the chart in the brief those are separate
// shapes with different ranges. So a sail name is reduced to its leading code
// (letters, digits, an optional ".5", an optional "+") and codes are compared
// whole. A trailing letter O is read as zero (MHO = MH0, BRO = BR0): Northstar's
// own sail list spells it both ways.
//
// Strength, best first:  exact name › alias › code of name › code of category.
// Only the best tier that finds anything is used, so an exact "J3" never comes
// back padded with every J3 variant. Retired sails are matched but ranked last
// and not auto-linked — a chart should not quietly point at a sail in the loft.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChartSail } from './model'

export interface InventorySail {
  id: string
  name: string
  category?: string | null
  kind?: string | null
  retired?: boolean
}

export type MatchHow = 'name' | 'alias' | 'code' | 'category'
export interface SailMatch { sailIds: string[]; how: MatchHow | null; retiredOnly: boolean }

const squash = (s: string) => (s || '').toUpperCase().replace(/[\s_\-]+/g, '')
  .replace(/([A-Z])O(?=\+?$)/, '$10')

/** The leading sail code of a name: "J3+A 2026" → "J3+", "BR0_A 2026" → "BR0". */
export function sailCode(name: string): string {
  const s = (name || '').toUpperCase().trim()
  const m = /^([A-Z]+)(\d+(?:\.\d+)?)?(\+)?/.exec(s) // digits must touch: "GS 2024" is GS, built 2024
  if (!m) return ''
  let letters = m[1], digits = m[2] || ''
  // "BRO", "MHO" — a trailing O with no digits is a zero.
  if (!digits && letters.length >= 2 && letters.endsWith('O')) { letters = letters.slice(0, -1); digits = '0' }
  // a single letter suffix after a code-less run is a variant ("GS-A"), not part of the code
  return letters + digits + (m[3] || '')
}

export function matchSail(shape: Pick<ChartSail, 'name' | 'alias'>, inventory: InventorySail[]): SailMatch {
  const tiers: [MatchHow, (s: InventorySail) => boolean][] = [
    ['name', s => squash(s.name) === squash(shape.name)],
    ['alias', s => shape.alias.some(a => squash(a) === squash(s.name))],
    ['code', s => !!sailCode(shape.name) && sailCode(s.name) === sailCode(shape.name)],
    ['category', s => !!s.category && !!sailCode(shape.name) && sailCode(s.category) === sailCode(shape.name)],
  ]
  for (const [how, ok] of tiers) {
    const hits = inventory.filter(ok)
    if (!hits.length) continue
    const active = hits.filter(s => !s.retired)
    return {
      sailIds: active.map(s => s.id),
      how,
      retiredOnly: active.length === 0,
    }
  }
  return { sailIds: [], how: null, retiredOnly: false }
}

export interface MatchRow {
  shapeId: string
  match: SailMatch
}

/**
 * Proposals for every shape that has no link yet. Shapes already linked are
 * left alone: a link someone made by hand outranks anything inferred here.
 */
export function proposeLinks(shapes: ChartSail[], inventory: InventorySail[]): MatchRow[] {
  return shapes
    .filter(s => !s.sailIds.length)
    .map(s => ({ shapeId: s.id, match: matchSail(s, inventory) }))
}

/** Apply every confident proposal (anything matched to an active sail). */
export function autoLink(shapes: ChartSail[], inventory: InventorySail[]): { sails: ChartSail[]; linked: number; unmatched: string[] } {
  let linked = 0
  const unmatched: string[] = []
  const sails = shapes.map(s => {
    if (s.sailIds.length) return s
    const m = matchSail(s, inventory)
    if (m.sailIds.length) { linked++; return { ...s, sailIds: m.sailIds } }
    unmatched.push(s.id)
    return s
  })
  return { sails, linked, unmatched }
}
