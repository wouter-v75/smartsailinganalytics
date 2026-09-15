// src/lib/tagging/notes.ts
// ─────────────────────────────────────────────────────────────────────────────
// Personal notes and team comments.
//
// Deliberately NOT their own table. A note is free text pinned to a moment, and
// a tag event is already free text pinned to a moment — so a personal note is a
// tag with scope='personal' (which RLS keeps private to its owner) and a team
// comment is a general-scoped one whose definition is gated at TL2.
//
// Modelling them as tags means they inherit the whole apparatus for nothing: the
// day's segments, the track, the snap, filtering, the review queue, export
// rules. And it means a note can be promoted to a proper tag, or nominated for
// the debrief, without moving between tables.
//
// The Campaign → Day tab reads them back through here.
// ─────────────────────────────────────────────────────────────────────────────

import { segmentAt, type DaySegment } from './segments'
import type { TagEvent } from './types'

export const PERSONAL_NOTE_SLUG = 'note'
export const TEAM_NOTE_SLUG = 'team-note'

export const isPersonalNote = (t: TagEvent): boolean =>
  t.scope === 'personal' && !!(t.note && t.note.trim())

export const isTeamNote = (t: TagEvent): boolean =>
  t.slug === TEAM_NOTE_SLUG && t.scope !== 'personal' && !!(t.note && t.note.trim())

export interface DayNote {
  id: string
  text: string
  t0: number
  /** Which part of the day it belongs to — "Race 2", "Between races 1–2". */
  segmentLabel: string | null
  authorId: string | null
  /** The tag it hangs off, for jumping to it on the track. */
  tag: TagEvent
}

function toNote(t: TagEvent, segments: DaySegment[]): DayNote {
  const seg = segments.length ? segmentAt(segments, t0Of(t)) : null
  return {
    id: t.id,
    text: String(t.note || '').trim(),
    t0: t.t0,
    segmentLabel: seg?.label ?? null,
    authorId: t.createdByUserId,
    tag: t,
  }
}
const t0Of = (t: TagEvent) => t.t0

/**
 * A user's own notes for the day, in time order.
 *
 * Takes `userId` rather than trusting scope alone: RLS already hides other
 * people's personal tags, but a coach reading the day through an admin path
 * should still only see their OWN under "Personal notes".
 */
export function personalNotes(
  tags: TagEvent[],
  userId: string,
  segments: DaySegment[] = []
): DayNote[] {
  return tags
    .filter((t) => isPersonalNote(t) && t.ownerUserId === userId && !t.rejected)
    .sort((a, b) => a.t0 - b.t0)
    .map((t) => toNote(t, segments))
}

/** The crew's shared running commentary on the day. */
export function teamNotes(tags: TagEvent[], segments: DaySegment[] = []): DayNote[] {
  return tags
    .filter((t) => isTeamNote(t) && !t.rejected)
    .sort((a, b) => a.t0 - b.t0)
    .map((t) => toNote(t, segments))
}

/** Group notes under their part of the day, dropping empty parts. The shape the
 *  Campaign → Day tab renders: a heading per race, notes beneath. */
export function notesBySegment(
  notes: DayNote[],
  segments: DaySegment[]
): { label: string; notes: DayNote[] }[] {
  if (!segments.length) return notes.length ? [{ label: 'Day', notes }] : []
  return segments
    .map((s) => ({ label: s.label, notes: notes.filter((n) => n.segmentLabel === s.label) }))
    .filter((g) => g.notes.length)
}
