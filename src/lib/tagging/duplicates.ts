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
// It happens between PEOPLE too, and more often: the bow tags the rounding and
// so does the trimmer, because neither can see what the other pressed. Same
// double count, but a different question at the end of it — nobody's tag is
// authoritative, so the answer is whose to keep rather than machine-or-human.
//
// And it happens to ONE person: a glove on a wet screen, a press that did not
// look like it registered, so they press again. That one is the easiest of the
// three to answer and the easiest to miss, because both rows say the same
// thing in the same handwriting — which is exactly why it has to be pointed
// out rather than left to be noticed.
//
// All three go in one list because they are one problem to whoever is clearing
// it; the rows ask differently.
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

/**
 * 'crossed' — a person's tag against the machine's.
 * 'crew'    — two people, neither of whom could see what the other pressed.
 * 'self'    — one person, twice, seconds apart.
 */
export type DuplicateKind = 'crossed' | 'crew' | 'self'

export interface DuplicatePair {
  /** Stable across reloads: the two ids, in a fixed order. */
  key: string
  slug: string
  label: string
  kind: DuplicateKind
  /** 'crossed': always the HUMAN one. Otherwise the EARLIER of the two. */
  a: TagEvent
  /** 'crossed': always the DETECTION. Otherwise the LATER of the two. */
  b: TagEvent
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

/** Who placed a tag, for deciding whether two of them are two different people.
 *  A personal tag's owner IS its author; a detection has none. */
const authorOf = (t: TagEvent): string | null =>
  t.source === 'human' ? (t.createdByUserId || t.ownerUserId || null) : null

/**
 * Pairs of tags that look like one moment recorded twice.
 *
 * MATCHED GREEDILY BY GAP, closest first, each tag used once. A cluster of
 * three — the bow tagged it, the trimmer tagged it, and then the file arrived —
 * otherwise produces three pairs describing the same instant, and resolving one
 * would leave two stale rows offering to delete tags that are already gone.
 * Greedy over BOTH kinds together, so the closest pairing wins whichever kind
 * it is rather than one kind being matched first and taking the good partners.
 *
 * Three kinds, one list: a person against the machine, two people, and one
 * person twice. They are one problem to whoever is clearing them.
 */
export function findDuplicates(
  tags: readonly TagEvent[],
  windowMs: number = DUPLICATE_WINDOW_MS
): DuplicatePair[] {
  const live = (tags || []).filter((t) => t && !t.rejected && isNum(t.t0))
  if (live.length < 2) return []

  const candidates: { gap: number; a: TagEvent; b: TagEvent; kind: DuplicateKind }[] = []
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i]
      const y = live[j]
      if (x.slug !== y.slug) continue
      const gap = Math.abs(x.t0 - y.t0)
      if (gap > windowMs) continue
      if (isAccepted(x, y)) continue

      const xHuman = x.source === 'human'
      const yHuman = y.source === 'human'

      if (xHuman && yHuman) {
        const ax = authorOf(x)
        const ay = authorOf(y)
        // Two hand-placed tags nobody signed could be one person twice or two
        // people once, and the row has to say which. Guessing wrong means
        // offering to delete somebody's only record of a moment.
        if (!ax || !ay) continue
        const [a, b] = x.t0 <= y.t0 ? [x, y] : [y, x]
        candidates.push({ gap, a, b, kind: ax === ay ? 'self' : 'crew' })
      } else if (xHuman !== yHuman) {
        // A person against the machine. The human side is always `a`, so the
        // row can ask "keep mine / keep the file's" without re-deriving it.
        const [a, b] = xHuman ? [x, y] : [y, x]
        candidates.push({ gap, a, b, kind: 'crossed' })
      }
      // Two detections are the sync's problem, not a person's: they share a
      // detection_key and re-derivation reconciles them.
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
      // A crew member's own wording wins when they gave one; a definition's
      // default label is the same on both sides anyway.
      label: c.a.label || c.b.label,
      kind: c.kind,
      a: c.a,
      b: c.b,
      gapMs: c.gap,
    })
  }
  return out.sort((x, y) => Math.min(x.a.t0, x.b.t0) - Math.min(y.a.t0, y.b.t0))
}

/**
 * Where a tag came from, in words, for the row that asks which to keep.
 *
 * `nameOf` resolves an author id to a name. Without one — or for somebody whose
 * name cannot be read — a human tag says who it is NOT rather than inventing a
 * name: "You tagged it" against "Another crew member" is still a choice
 * somebody can make.
 */
export function sourceOf(
  tag: TagEvent,
  opts: { meId?: string | null; nameOf?: (id: string) => string | null } = {}
): string {
  if (tag.source === 'human') {
    const author = authorOf(tag)
    if (author && opts.meId && author === opts.meId) return 'You tagged it'
    const name = author && opts.nameOf ? opts.nameOf(author) : null
    if (name) return `${name} tagged it`
    return author ? 'Another crew member' : 'Tagged by hand'
  }
  switch (tag.producer) {
    case 'eventfile': return 'From the event file'
    case 'manoeuvres': return 'Found in the log'
    case 'startline': return 'From the start analysis'
    case 'log': return 'Derived from the log'
    default: return 'Detected'
  }
}
