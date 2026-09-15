// src/lib/tagging/comments.ts
// ─────────────────────────────────────────────────────────────────────────────
// The crew's own words, pulled out of the day's tags.
//
// A comment is not a separate kind of thing in this schema, and it should not
// be: somebody presses "Team comment" and types, or they type a line onto the
// tack they just made a mess of. Both are a person saying something about a
// moment, and both should turn up on the timeline and in their own Day card.
// So a COMMENT is any hand-placed tag carrying text — which is a rule about the
// data rather than about which button was pressed, and therefore cannot be
// broken by adding a button.
//
// Detections are excluded. The detector writes `meta`, not notes, and a
// sentence the computer generated is not a crew member's comment.
//
// WHOSE it is matters twice over. On the timeline the first name is the whole
// point — "Sam: the kite was up early" is a different fact from "somebody said
// the kite was up early" — and in Campaign → Day the card is MINE, so it has to
// know which of the day's comments I wrote.
//
// Pure — no React, no I/O. Names are resolved server-side and passed in.
// ─────────────────────────────────────────────────────────────────────────────

import type { TagEvent } from './types'

export interface Comment {
  id: string
  /** When it is about, on the day's clock. */
  t0: number
  slug: string
  /** The tag's own label — "Team comment", but also "Tack" for a note on one. */
  label: string
  color: string
  /** What they wrote. Never empty: an empty one is not a comment. */
  text: string
  /** Private to its author (a Personal note), as opposed to the crew's. */
  personal: boolean
  authorId: string | null
  /** Resolved server-side from public.users; null when the row has no author. */
  authorName: string | null
}

/** The text a comment carries, trimmed, or '' when it carries none. */
export const textOf = (tag: TagEvent): string => String(tag.note ?? '').trim()

/**
 * Is this tag somebody saying something?
 *
 * Hand-placed and carrying text. A rejected tag is not — it is a tombstone, and
 * a comment on a moment the crew decided never happened should not outlive it.
 */
export function isComment(tag: TagEvent): boolean {
  return !tag.rejected && tag.source === 'human' && textOf(tag).length > 0
}

/** Who wrote it. A personal tag's owner IS its author; everything else records
 *  the author separately, and a row imported from an event file has none. */
export const authorOf = (tag: TagEvent): string | null =>
  tag.createdByUserId || (tag.scope === 'personal' ? tag.ownerUserId : null) || null

export function toComment(tag: TagEvent, nameOf: (id: string) => string | null = () => null): Comment {
  const authorId = authorOf(tag)
  return {
    id: tag.id,
    t0: tag.t0,
    slug: tag.slug,
    label: tag.label,
    color: tag.color,
    text: textOf(tag),
    personal: tag.scope === 'personal',
    authorId,
    authorName: authorId ? nameOf(authorId) : null,
  }
}

/** Every comment in a day, oldest first — the order they were said in. */
export function commentsOf(
  tags: readonly TagEvent[],
  nameOf: (id: string) => string | null = () => null
): Comment[] {
  return tags.filter(isComment).map((t) => toComment(t, nameOf)).sort((a, b) => a.t0 - b.t0)
}

/**
 * What the crew said, as opposed to what one person noted to themselves.
 *
 * A personal note is already invisible to everyone else (0062's RLS), so this
 * is not a security boundary — it is an editorial one. My own scratch note
 * appearing in a column headed by other people's names would read as though I
 * had said it to the team.
 */
export const teamComments = (comments: readonly Comment[]): Comment[] =>
  comments.filter((c) => !c.personal)

/** Mine — both the ones I said to the crew and the ones I kept to myself. */
export const myComments = (comments: readonly Comment[], userId: string | null | undefined): Comment[] =>
  userId ? comments.filter((c) => c.authorId === userId) : []

/**
 * A first name, for a timeline card that has room for one word.
 *
 * Surnames are what a crew list uses and what nobody says out loud. Falls back
 * to the local part of an email, because a member who has never set a name is
 * still somebody, and finally to 'Crew' rather than to an empty card.
 */
export function firstName(name: string | null | undefined): string {
  const s = String(name ?? '').trim()
  if (!s) return 'Crew'
  // "van Dam, Wouter" — a surname-first crew list. The given name follows.
  if (s.includes(',')) {
    const after = s.split(',')[1]?.trim()
    if (after) return after.split(/\s+/)[0]
  }
  const head = s.split(/\s+/)[0]
  if (head.includes('@')) return head.split('@')[0] || 'Crew'
  return head
}

/**
 * Shortened for a card face, ending on a word.
 *
 * Cutting mid-word reads as a rendering fault rather than as a summary, and the
 * whole comment is a click away, so the clipped form only has to be honest
 * about being clipped.
 */
export function clip(text: string, max = 48): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

/** "Sam: the kite was up early" — the timeline's one-line form. */
export const commentLine = (c: Comment, max = 48): string =>
  `${firstName(c.authorName)}: ${clip(c.text, max)}`
