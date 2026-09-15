// src/lib/tagging/snap.ts
// ─────────────────────────────────────────────────────────────────────────────
// The nudge: move a hand-placed tag onto the moment the data says it meant.
//
// The load-bearing idea is that PEOPLE PRESS LATE. They have to see the thing,
// recognise it, and find the button — and if they logged it on the water they
// did all that one-handed while sailing the boat. So the search window is
// ASYMMETRIC: generous backwards, barely anything forwards.
//
// This is not a detail. Snapping to the *nearest* detection in either direction
// routinely pairs a tag with an event that had not happened yet when the button
// was pressed — causally impossible, and it puts the clip in the wrong place.
// The patent literature on snap-to-event annotation is explicit about it: take
// the event "prior to and closest to" the signal from the annotating interface.
//
// Two entry points:
//
//   snapTag   one tag, greedily, with a REASON when it declines. A nudge that
//             silently does nothing teaches the crew the button is broken.
//   snapAll   a whole race at once, as a monotonic alignment rather than each
//             tag grabbing its own nearest candidate. Greedy per-tag snapping
//             can cross tags over each other and double-book one detection;
//             a global alignment cannot. (This is the forced-alignment idea from
//             speech, in its simplest useful form.)
//
// Pure — no React, no I/O. Returns instructions; merge.moveTag applies them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Detection } from './detect'

/** Which end of a detection's window to aim at. A "tack" wants the entry; a
 *  "recovered" or "back to speed" wants the exit. */
export type SnapAnchor = 'start' | 'middle' | 'end'

export interface SnapOptions {
  /** How far BACK to look. People press late, so this is the generous side. */
  backMs?: number
  /** How far FORWARD. Small — you only click early when scrubbing a recording. */
  fwdMs?: number
  anchor?: SnapAnchor
  /** Restrict candidates to these slugs. Default: whatever is compatible with
   *  the tag's own slug (see compatibleSlugs). */
  slugs?: string[] | null
  /** Only ever snap to an exact slug match. */
  strict?: boolean
}

export const DEFAULT_SNAP_OPTIONS: Required<Omit<SnapOptions, 'slugs'>> = {
  backMs: 30_000,
  fwdMs: 5_000,
  anchor: 'start',
  strict: false,
}

export interface SnapResult {
  detection: Detection
  fromT0: number
  toT0: number
  /** Apply with merge.moveTag(tag, deltaMs) — it shifts both endpoints. */
  deltaMs: number
  anchor: SnapAnchor
  score: number
}

export type SnapOutcome =
  | { ok: true; result: SnapResult }
  | { ok: false; reason: string }

/**
 * Which detections a tag may snap to.
 *
 * `null` means "anything" — that is right for the catch-all tags (review this,
 * incident), which mark a moment rather than name a manoeuvre and should land on
 * whatever the data says was happening.
 */
export function compatibleSlugs(tagSlug: string): string[] | null {
  switch (tagSlug) {
    case 'tack': return ['tack']
    case 'gybe': return ['gybe']
    case 'race-start': return ['race-start']
    case 'topmark': return ['topmark']
    case 'gate': return ['gate']
    case 'mark': return ['mark', 'topmark', 'gate']
    case 'sail-change': return ['sail-change']
    // Catch-alls and section tags: the crew marked a moment, not a manoeuvre.
    default: return null
  }
}

/** Exact match scores highest, family next, "anything" lowest but still usable. */
function kindScore(tagSlug: string, d: Detection, strict: boolean): number {
  if (d.slug === tagSlug) return 1
  if (strict) return -1
  const allowed = compatibleSlugs(tagSlug)
  if (allowed == null) return 0.4          // a catch-all tag, any detection
  return allowed.includes(d.slug) ? 0.7 : -1
}

const anchorTime = (d: Detection, anchor: SnapAnchor): number =>
  anchor === 'end' ? d.t1 : anchor === 'middle' ? (d.t0 + d.t1) / 2 : d.t0

/**
 * How good a candidate is, 0–1, or -1 for "not eligible".
 *
 * Judged against the detection's OWN START, not against the anchor. The anchor
 * decides where the tag ends up; eligibility is about whether this is the event
 * the person was reacting to when they pressed. Scoring the anchor instead makes
 * `anchor: 'end'` reject every long detection — which is backwards, since a long
 * manoeuvre is exactly when you want to aim at its exit.
 *
 * A tag that falls INSIDE a detection's window belongs to it outright: the crew
 * pressed the button while it was happening, which is as clear as intent gets.
 *
 * Otherwise proximity is normalised by the window on that SIDE, which is where
 * the asymmetry does its work with no special-casing: with a 30 s back window
 * and a 5 s forward one, a detection 4 s before the press scores 0.87 for
 * proximity while one 4 s after scores 0.2. Being earlier wins, as it should.
 */
export function candidateScore(
  tagT0: number,
  d: Detection,
  tagSlug: string,
  o: Required<Omit<SnapOptions, 'slugs'>>
): number {
  const k = kindScore(tagSlug, d, o.strict)
  if (k < 0) return -1

  let proximity: number
  if (tagT0 >= d.t0 && tagT0 <= d.t1) {
    proximity = 1
  } else {
    const dt = d.t0 - tagT0                  // negative = the detection came first
    if (dt < -o.backMs || dt > o.fwdMs) return -1
    const window = dt <= 0 ? o.backMs : o.fwdMs
    proximity = window > 0 ? 1 - Math.abs(dt) / window : 1
  }

  return 0.5 * k + 0.35 * proximity + 0.15 * (d.confidence ?? 0.5)
}

/**
 * Snap one tag to the detection it most likely meant.
 *
 * Declines with a reason rather than silently doing nothing — "no tack within
 * 30 s" is information; a dead button is not.
 */
export function snapTag(
  tag: { t0: number; t1: number; slug: string },
  detections: Detection[],
  options: SnapOptions = {}
): SnapOutcome {
  const o = { ...DEFAULT_SNAP_OPTIONS, ...options }
  if (!Number.isFinite(tag?.t0)) return { ok: false, reason: 'This tag has no position' }

  const allowed = options.slugs ?? compatibleSlugs(tag.slug)
  const pool = allowed == null ? detections : detections.filter((d) => allowed.includes(d.slug))
  if (!pool.length) {
    const what = allowed == null ? 'detections' : allowed.join(' or ')
    return { ok: false, reason: `No ${what} detected on this day` }
  }

  let best: Detection | null = null
  let bestScore = -1
  for (const d of pool) {
    const s = candidateScore(tag.t0, d, tag.slug, o)
    if (s > bestScore) { bestScore = s; best = d }
  }

  if (!best || bestScore < 0) {
    const secs = Math.round(o.backMs / 1000)
    const what = allowed == null ? 'nothing detected' : `no ${allowed.join(' or ')}`
    return { ok: false, reason: `${what} within ${secs}s before this tag` }
  }

  const to = anchorTime(best, o.anchor)
  return {
    ok: true,
    result: {
      detection: best,
      fromT0: tag.t0,
      toT0: to,
      deltaMs: to - tag.t0,
      anchor: o.anchor,
      score: Math.round(bestScore * 1000) / 1000,
    },
  }
}

export interface SnapAllEntry<T> {
  tag: T
  /** null when this tag found nothing it could sensibly move to. */
  result: SnapResult | null
  reason?: string
}

/**
 * Snap a whole set of tags at once, as a MONOTONIC alignment.
 *
 * Greedy per-tag snapping is fine one at a time and wrong in bulk: two tags can
 * grab the same detection, or the second tag can snap to a detection earlier
 * than the first tag's, crossing them over. Neither can happen here, because the
 * assignment is computed as a whole — tags and detections are both in time
 * order, and the alignment is required to preserve that order.
 *
 * Standard edit-distance shaped dynamic programme: each tag may take the next
 * unused detection, or be left alone; each detection may be skipped.
 */
export function snapAll<T extends { t0: number; t1: number; slug: string }>(
  tags: T[],
  detections: Detection[],
  options: SnapOptions = {}
): SnapAllEntry<T>[] {
  const o = { ...DEFAULT_SNAP_OPTIONS, ...options }
  const ts = tags.slice().sort((a, b) => a.t0 - b.t0)
  const ds = detections.slice().sort((a, b) => a.t0 - b.t0)
  const n = ts.length
  const m = ds.length
  if (!n) return []
  if (!m) return ts.map((tag) => ({ tag, result: null, reason: 'Nothing detected on this day' }))

  const score = (i: number, j: number): number => {
    const allowed = options.slugs ?? compatibleSlugs(ts[i].slug)
    if (allowed != null && !allowed.includes(ds[j].slug)) return -1
    return candidateScore(ts[i].t0, ds[j], ts[i].slug, o)
  }

  // dp[i][j] — best total score pairing the first i tags with the first j
  // detections. choice[i][j] records how we got there so the assignment can be
  // read back: 'skip-tag' | 'skip-det' | 'pair'.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  const choice: string[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill('skip-tag'))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      // Leaving a tag unsnapped costs nothing — an unmatched tag is a normal
      // outcome, not a failure, so there is no penalty term here.
      let bestVal = dp[i - 1][j]
      let bestWhy = 'skip-tag'

      if (dp[i][j - 1] > bestVal) { bestVal = dp[i][j - 1]; bestWhy = 'skip-det' }

      const s = score(i - 1, j - 1)
      if (s >= 0 && dp[i - 1][j - 1] + s > bestVal) {
        bestVal = dp[i - 1][j - 1] + s
        bestWhy = 'pair'
      }
      dp[i][j] = bestVal
      choice[i][j] = bestWhy
    }
  }

  const paired = new Map<number, number>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const why = choice[i][j]
    if (why === 'pair') { paired.set(i - 1, j - 1); i--; j-- }
    else if (why === 'skip-det') j--
    else i--
  }

  return ts.map((tag, idx) => {
    const dIdx = paired.get(idx)
    if (dIdx == null) {
      const single = snapTag(tag, detections, options)
      return { tag, result: null, reason: single.ok ? 'Taken by a neighbouring tag' : single.reason }
    }
    const d = ds[dIdx]
    const to = anchorTime(d, o.anchor)
    return {
      tag,
      result: {
        detection: d, fromT0: tag.t0, toT0: to, deltaMs: to - tag.t0,
        anchor: o.anchor, score: Math.round(candidateScore(tag.t0, d, tag.slug, o) * 1000) / 1000,
      },
    }
  })
}

/** Walk to the next/previous detection from a cursor — "tab to transient",
 *  which is how editors have let people navigate detected features for decades. */
export function nextDetection(
  detections: Detection[],
  fromUtc: number,
  direction: 1 | -1 = 1,
  slugs?: string[] | null
): Detection | null {
  const pool = slugs ? detections.filter((d) => slugs.includes(d.slug)) : detections
  const ordered = pool.slice().sort((a, b) => a.t0 - b.t0)
  if (direction === 1) return ordered.find((d) => d.t0 > fromUtc) || null
  for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i].t0 < fromUtc) return ordered[i]
  return null
}
