// src/lib/tagging/markers.ts
// ─────────────────────────────────────────────────────────────────────────────
// How a tag looks, and what it says, as a dot on the track.
//
// Two decisions, both about attention, and both here rather than in the SVG so
// they can be tested and so the two drawing sites cannot drift apart.
//
// SIZE. A day has two or three sail changes and a hundred and forty tacks. Drawn
// the same size they are the same news, and the track turns into a bead
// necklace where the one thing worth finding is hidden among the routine. So a
// manoeuvre is drawn small — still there, still pickable, but clearly the
// background against which the start, the roundings and the sail changes stand
// out. Nothing is hidden; the hierarchy just matches the questions people ask.
//
// WHAT IT SAYS. Hovering a sail change answers the question that made somebody
// point at it: what were we carrying from here on. That is exactly what the tag
// stores — a sail-change tag records the WHOLE state after the change (see
// sailState.ts), so the answer needs no scanning backwards and no guessing.
//
// Pure — no React, no DOM, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { sessionClock } from './clock'
import { SAIL_CHANGE_SLUG, stateOf, stateIsEmpty, describeState, sailStateAt } from './sailState'
import type { TagEvent } from './types'

/** The routine turns. Everything else is a moment somebody navigates to. */
export const MANOEUVRE_SLUGS: ReadonlySet<string> = new Set(['tack', 'gybe'])

/**
 * The tags that do not get dragged: the routine turns.
 *
 * Not a permission — a judgement about what is worth doing. A day has a hundred
 * and forty tacks, they come from the log's own TWA trace rather than from
 * anybody's thumb, and a tack nudged by hand is one sample of one day quietly
 * disagreeing with the detector that produced every other one. If a tack is in
 * the wrong place the fix is in the detection.
 *
 * Everything else can be moved, including the racing moments. A start or a mark
 * rounding that landed on the wrong side of the mark is exactly the kind of
 * error a person can SEE on a track and cannot see on a clock — which is the
 * whole argument for dragging things here rather than typing a time.
 */
export const FIXED_SLUGS: ReadonlySet<string> = new Set(Array.from(MANOEUVRE_SLUGS))

/** May this KIND of tag be retimed by hand? Says nothing about who may do it —
 *  that is gating.canEditTagEvent, and both have to say yes. */
export const isRetimable = (slug: string): boolean => !FIXED_SLUGS.has(slug)

/** Radii in TRACK units at scale 1 — the drawing divides them back out so a dot
 *  stays the same size on screen however far in the view is zoomed. */
export const R_MANOEUVRE = 3.5
export const R_MOMENT = 6
export const STROKE_MANOEUVRE = 1.25
export const STROKE_MOMENT = 2

export interface MarkerStyle {
  r: number
  strokeWidth: number
}

/** Small for a turn, full size for a moment. */
export function markerStyle(slug: string): MarkerStyle {
  return MANOEUVRE_SLUGS.has(slug)
    ? { r: R_MANOEUVRE, strokeWidth: STROKE_MANOEUVRE }
    : { r: R_MOMENT, strokeWidth: STROKE_MOMENT }
}

export interface MarkerTip {
  /** The tag's own label. */
  title: string
  /** Session clock, never the device's. */
  clock: string
  /** What was flying from this point on. Only a sail change has one. */
  sails: string | null
  /** What was ON THE BOAT from this point on — the sails up plus the ones in
   *  the bag. Needs the whole day, because the deck is carried forward from
   *  wherever somebody last said what it was. */
  aboard: string | null
}

/**
 * What was up from this tag onwards, in one line.
 *
 * null for anything that is not a sail change — a tack tells you nothing about
 * the sails, and answering as though it did would be inventing a fact.
 *
 * A sail change whose state was never filled in says so. Falling back to the
 * PREVIOUS change would be worse than silence: the one thing certain about this
 * moment is that what was up before it is no longer what is up.
 */
export function sailsFrom(tag: TagEvent): string | null {
  if (tag.slug !== SAIL_CHANGE_SLUG) return null
  const state = stateOf(tag)
  if (!state || stateIsEmpty(state)) return 'Sails not recorded'
  return describeState(state)
}

/**
 * What is ON THE BOAT from this point on.
 *
 * Only shown when it says more than the sails up already do: on a boat with
 * nothing in the bag the two lists are identical, and printing both would be
 * printing the same fact twice.
 */
export function deckFrom(tag: TagEvent, day?: readonly TagEvent[]): string | null {
  if (tag.slug !== SAIL_CHANGE_SLUG || !day?.length) return null
  const state = sailStateAt(day, tag.t0)
  if (!state.onBoard.length) return null
  if (state.onBoard.length <= state.up.length) return null
  return state.onBoard.map((s) => s.name).join(' + ')
}

/** Everything the hover readout shows for one marker. `day` is the whole day's
 *  tags, needed for the carried deck; without it the deck is simply not shown. */
export function markerTip(
  tag: TagEvent,
  tzOffsetMin = 0,
  day?: readonly TagEvent[]
): MarkerTip {
  return {
    title: tag.label,
    clock: sessionClock(tag.t0, tzOffsetMin),
    sails: sailsFrom(tag),
    aboard: deckFrom(tag, day),
  }
}

/** The same thing as one string, for the accessible name of the shape. */
export function markerLabel(
  tag: TagEvent,
  tzOffsetMin = 0,
  day?: readonly TagEvent[]
): string {
  const tip = markerTip(tag, tzOffsetMin, day)
  const parts = [tip.title, tip.clock]
  if (tip.sails) parts.push(tip.sails)
  if (tip.aboard) parts.push(`aboard ${tip.aboard}`)
  return parts.join(' · ')
}
