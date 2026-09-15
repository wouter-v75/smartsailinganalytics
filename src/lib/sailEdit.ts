// src/lib/sailEdit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Editing a sail's identity by hand.
//
// Kind, sail type, group and weight used to arrive only from an event file's
// <saillist>, which meant a boat whose inventory was typed in could never say
// which sail was the mainsail. Two things downstream depend on knowing:
//
//   the BATTEN CARD    hangs off a mainsail (migration 0065). No kind, no card.
//   the WEIGHT ABOARD  totals what is on the boat at a sail change, from
//                      specs.weight_kg. No weights, no total.
//
// The fiddly parts are here rather than in the form, because they are decisions
// rather than markup: what an unparseable weight means, what happens to the
// `source` marker when a human edits an imported row, and — the one that can
// actually destroy data — that a spec patch MERGES.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

/** Whatever else lives in sails.specs, untouched by this form. */
export type SailSpecs = Record<string, unknown>

export interface SailDraft {
  name: string
  category: string
  buildDate: string
  kind: string
  sailType: string
  /** M / H / S, as the event file spells it. */
  group: string
  /** As typed — "24,5" and "24.5" both mean the same thing on a European keyboard. */
  weight: string
}

export interface SailPatch {
  name: string
  category: string | null
  build_date: string | null
  kind: string
  specs: SailSpecs
}

/** A weight as typed, or null. Never NaN: JSONB accepts it and every later
 *  reader then has to defend against a number that is not a number. */
export function parseWeightKg(text: string): number | null {
  const n = parseFloat(String(text ?? '').trim().replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  // A tenth is what a weigh-in sheet records and what the sail lists carry.
  return Math.round(n * 10) / 10
}

/**
 * How a hand edit marks a row that came from an event file.
 *
 * The import keys off `source` to decide what it may overwrite, so a row a
 * person has corrected must not still claim to be exactly what the file said —
 * otherwise the next import silently undoes the correction and nobody sees it
 * happen.
 */
export function nextSource(current: unknown): string {
  const s = typeof current === 'string' ? current : ''
  if (s === 'event-file') return 'event-file-edited'
  return s || 'manual'
}

/** What the form sends. Only the keys it edits — the rest is merged server-side. */
export function sailPatchFrom(draft: SailDraft, existing: SailSpecs = {}): SailPatch {
  return {
    name: draft.name.trim(),
    category: draft.category.trim() || null,
    build_date: draft.buildDate || null,
    kind: draft.kind,
    specs: {
      sail_type: draft.sailType.trim() || null,
      sail_group: draft.group.trim().toUpperCase() || null,
      weight_kg: parseWeightKg(draft.weight),
      source: nextSource(existing.source),
    },
  }
}

/**
 * Merge a spec patch into what is already stored.
 *
 * `specs` is a JSONB bag several unrelated things write into: the event-file
 * import puts sail_type / sail_group / weight_kg there, and the North
 * design-shape import puts `design_shapes` there — which is large. A patch that
 * REPLACED the bag would make every edit a read-modify-write race: saving a
 * weight from a row loaded before an import would delete the shapes, silently
 * and permanently.
 *
 * Shallow, deliberately. A deep merge could never clear a nested value, and
 * nothing in here nests in a way that wants merging.
 */
export function mergeSpecs(current: unknown, patch: SailSpecs): SailSpecs {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? (current as SailSpecs)
    : {}
  return { ...base, ...patch }
}
