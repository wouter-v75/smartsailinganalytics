// src/lib/rigModelMerge.ts
// ─────────────────────────────────────────────────────────────────────────────
// Merging two rig models: which of two numbers for the same dimension to believe.
//
// It lived inside scripts/rig-model-seed.ts, where it could not be tested — and
// it is the piece that failed SILENTLY. The designer's wheel depth (-7392, a
// 26 % correction on a -10 000 guess) lost every merge as a tie, because a scale
// reference carries two independent facts under one provenance stamp: the
// LENGTH, which really was tape-measured, and the DEPTH, which was a guess
// wearing the same word. Nothing said so. The seeded model kept the old value,
// the audit compared old against old, and eleven frames reported "ok".
//
// A merge rule that quietly does nothing is worse than one that refuses, so this
// is out here with tests around it.
//
// SUPERSEDE exists because provenance stops working when one side over-claims.
// The tab stamps `source: 'designer'` on whatever is TYPED into a depth box, so
// Northstar's -10 000 guess wore the same badge as the designer's real -7392 and
// won the tie on "stored was put there on purpose". Nothing in the data can tell
// those two apart, so it takes a deliberate instruction rather than a cleverer
// rule: with `supersede`, an equal claim goes to the incoming model — the
// curated one in rigModel.ts, whose provenance is written down beside it.
// ─────────────────────────────────────────────────────────────────────────────

import { deriveBaselines, MERGE_RANK, type RigModel, type ScaleRef } from './rigModel'
import type { SailWidths } from './sailTwist'

/**
 * Which of two numbers for the same dimension to believe.
 *
 * A certificate and a dockside measurement each know things the other does not:
 * the certificate has P and J to the centimetre and cannot see the wheels at
 * all, while a tape has the wheels and mast-to-stern and says nothing about the
 * rig. Merging keeps the better of each rather than letting whichever arrived
 * last win. Ties go to what is already stored: somebody put it there on purpose.
 */
export const better = <T extends { mm: number; source: string }>(
  a: T | undefined, b: T | undefined, supersede = false,
): T | undefined => {
  if (!a || !(a.mm > 0)) return b
  if (!b || !(b.mm > 0)) return a
  const rb = MERGE_RANK[b.source] ?? 0, ra = MERGE_RANK[a.source] ?? 0
  return rb > ra || (supersede && rb === ra) ? b : a
}

/** A depth may be attested quite differently from the length it rides with. */
export const depthRank = (r: ScaleRef) => MERGE_RANK[r.depthSource ?? r.source] ?? 0

/** Decide a scale reference's LENGTH and its DEPTH separately. */
export const betterRef = (a: ScaleRef | undefined, b: ScaleRef | undefined, supersede = false): ScaleRef => {
  const base = better(a, b, supersede)!
  if (!a || !b) return base
  const db = depthRank(b), da = depthRank(a)
  const src = db > da || (supersede && db === da) ? b : a
  return { ...base, depthMm: src.depthMm, depthSource: src.depthSource ?? src.source }
}

/** Keep the better-attested value for every dimension, field by field. */
export function mergeModels(current: RigModel, incoming: RigModel, supersede = false): RigModel {
  const out: RigModel = { ...current, ...incoming }
  out.scaleRefs = incoming.scaleRefs.map((r) => betterRef(current.scaleRefs.find((x) => x.key === r.key), r, supersede))
  // A stored reference the incoming model has never heard of is KEPT, superseding
  // or not: this decides disagreements, it does not delete knowledge.
  for (const r of current.scaleRefs) if (!out.scaleRefs.some((x) => x.key === r.key)) out.scaleRefs.push(r)
  out.baselines = incoming.baselines.map((b) => better(current.baselines.find((x) => x.key === b.key), b, supersede)!)
  for (const b of current.baselines) if (!out.baselines.some((x) => x.key === b.key)) out.baselines.push(b)
  out.depths = { ...current.depths }
  for (const k of Object.keys(incoming.depths) as (keyof RigModel['depths'])[]) {
    out.depths[k] = better(current.depths[k], incoming.depths[k], supersede)!
  }
  // PER FIELD, not per sail. This used to be
  //     { ...(incoming.widths || {}), ...(current.widths || {}) }
  // which merges at the {main, jib} level, so a stored sail's widths object
  // replaced the incoming one ENTIRE — and any field the stored one predates
  // was dropped on every merge, for ever. That is how Ryujin went in with no
  // `luffRakeDeg` twice from a file that had it: the first seed stored widths
  // without the field, and `--merge` then kept that object whole.
  //
  // It is the same trap as the one CLAUDE.md records about --merge itself ("a
  // boat that already has a stored model is left alone, so a new measurement
  // never lands"), one level further down, and it bites exactly when the shape
  // GAINS a field — which is the only time anyone would not be looking.
  //
  // The rule is unchanged where both have a value: the stored number wins,
  // because it is the boat's own measurement. Incoming fills only what the
  // stored sail has nothing for.
  const mergeWidths = (cur?: SailWidths, inc?: SailWidths): SailWidths | undefined => {
    if (!cur) return inc
    if (!inc) return cur
    const merged: SailWidths = { ...inc, ...cur }
    for (const k of Object.keys(inc) as (keyof SailWidths)[]) {
      // An explicit null in the stored sail is an absence, not a measurement.
      if (cur[k] == null && inc[k] != null) (merged as unknown as Record<string, unknown>)[k] = inc[k]
    }
    return merged
  }
  out.widths = {
    main: mergeWidths(current.widths?.main, incoming.widths?.main),
    jib: mergeWidths(current.widths?.jib, incoming.widths?.jib),
  }
  out.notes = [current.notes, incoming.notes].filter(Boolean).join(' · ')
  return deriveBaselines(out)
}
