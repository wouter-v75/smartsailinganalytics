// src/lib/tagging/autoPhases.ts
// ─────────────────────────────────────────────────────────────────────────────
// Point of sail, and the row/mode/tack vocabulary the leg detector speaks.
//
// This file once held a whole phase builder as well — 30 s slices, filtered on
// coverage, motion, manoeuvre-freedom, single-mode and steadiness. It was written
// in the first tagger commit and never called from anywhere, by any commit since.
// src/lib/buildPhases.ts is the implementation that actually ships, and it makes
// better choices than the one here did: it cuts on event boundaries BEFORE tiling
// so no block straddles a manoeuvre, judges a block on drift (end vs start) rather
// than on spread, and reads point of sail from AWA so a wind shift under a
// wind-mode autopilot does not read as a change of sailing. Keeping a second,
// worse, unreachable answer to the same question next to it helped nobody.
//
// What survives is what detectLegs.ts imports: the TWA bands and the three types.
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export type PhaseMode = 'up' | 'down' | 'reach'
export type PhaseTack = 'port' | 'stbd'

export type PhaseLogRow = { utc: number } & Record<string, number | null | undefined>

/** Point of sail from |TWA| — the same bands computeAutoTags uses. */
export function modeOfTwa(twa: number): PhaseMode {
  const a = Math.abs(twa)
  return a < 60 ? 'up' : a < 110 ? 'reach' : 'down'
}
