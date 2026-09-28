// src/lib/tagging/raceWindow.ts
// ─────────────────────────────────────────────────────────────────────────────
// When did the race end?
//
// Expedition records a start gun and it records mark roundings. It does not
// record a finish, and without one there is no way to tell the race from the
// four hours of training either side of it — which on 28 September was the
// difference between 8 clips and 47.
//
// SSA's finish tag is the right answer when somebody pressed it. When nobody
// did, the event file still knows: a race that finishes at the windward end
// puts one more TOP-MARK rounding after the last gate, and that rounding is the
// finish. Reading it as a mark gives the crew a lap that never happened.
//
// A leeward finish cannot be told from a gate rounding this way, so it is not
// guessed — better to run to the end of the day and say so.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundingLike { utc: number; isTop?: boolean }
export interface GunLike { utc: number }

export interface InferredFinish {
  utc: number | null
  /** Why, in words, for the line the script prints. A guessed finish is worth
   *  knowing about. */
  how: string
}

export function inferFinish(
  guns: readonly GunLike[],
  roundings: readonly RoundingLike[],
  opts: { taggedUtc?: number | null; dayStopUtc?: number | null } = {}
): InferredFinish {
  if (opts.taggedUtc != null) return { utc: opts.taggedUtc, how: "SSA's finish tag" }

  const gun = guns.length ? Math.min(...guns.map((g) => g.utc)) : null
  if (gun == null) return { utc: null, how: 'no start gun — nothing to bound' }

  const after = roundings.filter((r) => r.utc > gun).sort((a, b) => a.utc - b.utc)
  const last = after[after.length - 1]
  if (last?.isTop) {
    return { utc: last.utc, how: 'the last top-mark rounding, read as the finish — no finish tag' }
  }
  return {
    utc: opts.dayStopUtc ?? null,
    how: 'no finish tag and no windward finish to read — running to the end of the day',
  }
}
