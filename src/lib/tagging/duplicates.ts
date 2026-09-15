// src/lib/tagging/duplicates.ts
// ─────────────────────────────────────────────────────────────────────────────
// The same moment, tagged twice, by two different things.
//
// The crew tag a top mark as they round it. That evening the event file is
// uploaded, the detector runs, and it finds the same rounding — so the day now
// carries two "Top mark" tags eleven seconds apart. Neither is wrong. Both are
// real. And every count, every export and every debrief reel downstream now has
// a rounding in it that never happened.
//
// This CANNOT be prevented at sync time, and it is worth being clear why: the
// sync's job is to reconcile detections against the rows it has already
// created, which it does by `detection_key`. A hand-placed tag has no key —
// that is what makes it hand-placed — so there is nothing for the sync to match
// it against, and a sync that guessed would silently swallow a crew member's
// own tag the first time the detector disagreed with them by a second.
//
// So it is not prevented. It is FOUND, and a person decides. Which is the same
// principle the review queue runs on: semi-automatic beats automatic when the
// machine cannot tell the two cases apart.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import type { TagEvent } from './types'

/**
 * How close two tags of the same kind have to be to be the same moment.
 *
 * Thirty seconds. A crew member presses a rounding late — that is the premise
 * the whole lead/lag model is built on — and the detector puts it on the
 * instant the boat's heading crossed. Half a minute covers that gap without
 * reaching the next mark of any course anybody sails.
 */
export const DUPLICATE_WINDOW_MS = 30_000

export interface DuplicatePair {
  /** Stable across reloads: the two ids, in a fixed order. */
  key: string
  slug: string
  label: string
  /** The one a person put there. */
  mine: TagEvent
  /** The one the event file or the detector brought. */
  theirs: TagEvent
  /** How far apart they are, in ms. Always >= 0. */
  gapMs: number
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A pair somebody has already looked at and said "these are both real". */
export function isAccepted(a: TagEvent, b: TagEvent): boolean {
  const ok = (t: TagEvent, other: TagEvent) => {
    const raw = (t.meta as Record<string, unknown> | null)?.dupOkWith
    return Array.isArray(raw) && raw.some((id) => String(id) === other.id)
  }
  return ok(a, b) || ok(b, a)
}

/** The id list to store on a tag when a pair is accepted as two real moments. */
export function acceptedWith(tag: TagEvent, otherId: string): string[] {
  const raw = (tag.meta as Record<string, unknown> | null)?.dupOkWith
  const have = Array.isArray(raw) ? raw.map(String) : []
  return have.includes(otherId) ? have : [...have, otherId]
}

/**
 * Pairs of tags that look like one moment recorded twice.
 *
 * MATCHED GREEDILY BY GAP, closest first, each tag used once. A cluster of
 * three — the bow tagged it, the trimmer tagged it, and then the file arrived —
 * otherwise produces three pairs describing the same instant, and resolving one
 * would leave two stale rows offering to delete tags that are already gone.
 *
 * Only ACROSS sources: a person's tag against a machine's. Two crew members
 * both pressing the same rounding is a different problem with a different
 * answer (they are both right, and one of them should be a note), and putting
 * it in the same list would make the list mean two things.
 */
export function findDuplicates(
  tags: readonly TagEvent[],
  windowMs: number = DUPLICATE_WINDOW_MS
): DuplicatePair[] {
  const live = (tags || []).filter((t) => t && !t.rejected && isNum(t.t0))
  const mine = live.filter((t) => t.source === 'human')
  const theirs = live.filter((t) => t.source !== 'human')
  if (!mine.length || !theirs.length) return []

  // Every candidate pairing, then take the closest ones first.
  const candidates: { gap: number; a: TagEvent; b: TagEvent }[] = []
  for (const a of mine) {
    for (const b of theirs) {
      if (a.slug !== b.slug) continue
      const gap = Math.abs(a.t0 - b.t0)
      if (gap > windowMs) continue
      if (isAccepted(a, b)) continue
      candidates.push({ gap, a, b })
    }
  }
  candidates.sort((x, y) => x.gap - y.gap || x.a.t0 - y.a.t0 || x.a.id.localeCompare(y.a.id))

  const used = new Set<string>()
  const out: DuplicatePair[] = []
  for (const c of candidates) {
    if (used.has(c.a.id) || used.has(c.b.id)) continue
    used.add(c.a.id); used.add(c.b.id)
    out.push({
      key: [c.a.id, c.b.id].sort().join('~'),
      slug: c.a.slug,
      // The crew's own wording wins when they gave one; a definition's default
      // label is the same on both sides anyway.
      label: c.a.label || c.b.label,
      mine: c.a,
      theirs: c.b,
      gapMs: c.gap,
    })
  }
  return out.sort((x, y) => Math.min(x.mine.t0, x.theirs.t0) - Math.min(y.mine.t0, y.theirs.t0))
}

/** Where a tag came from, in words, for the row that asks which to keep. */
export function sourceOf(tag: TagEvent): string {
  if (tag.source === 'human') return 'You tagged it'
  switch (tag.producer) {
    case 'eventfile': return 'From the event file'
    case 'manoeuvres': return 'Found in the log'
    case 'startline': return 'From the start analysis'
    case 'log': return 'Derived from the log'
    default: return 'Detected'
  }
}
