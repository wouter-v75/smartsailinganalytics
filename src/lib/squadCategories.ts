// src/lib/squadCategories.ts
// ─────────────────────────────────────────────────────────────────────────────
// What a team can contribute to a squad, and what each choice actually means.
//
// THE TWO-LEVEL MODEL. A category says THIS TEAM CONTRIBUTES THIS KIND OF
// THING AT ALL; a session's own flag says WHICH DAYS. Both must be true for
// anything to be visible. So a team can join a squad wholeheartedly and still
// hold back the day the mast came down, and it never has to leave a category
// to hide one bad afternoon.
//
// The descriptions here are the ONLY place the meaning is written for a human,
// and they are deliberately concrete about who sees what. A team ticking these
// boxes is making a privacy decision about rivals; "share tags" tells them
// nothing, and a vague label is how a feature ends up unused or regretted.
// ─────────────────────────────────────────────────────────────────────────────

export type TagVisibility = 'none' | 'race' | 'all'

export interface SquadShares {
  tracks: boolean
  logdata: boolean
  videos: boolean
  photos: boolean
  sailscans: boolean
  comments: boolean
  notes: boolean
  tags: TagVisibility
}

/** Joining shares nothing. Every category starts off. */
export const NO_SHARES: SquadShares = {
  tracks: false, logdata: false, videos: false, photos: false,
  sailscans: false, comments: false, notes: false, tags: 'none',
}

export interface CategoryDef {
  key: Exclude<keyof SquadShares, 'tags'>
  label: string
  detail: string
  /** Ticking this without `tracks` achieves nothing — see requires(). */
  needsTracks?: boolean
}

export const SQUAD_CATEGORIES: CategoryDef[] = [
  {
    key: 'tracks',
    label: 'Tracks',
    detail: 'Where your boat went, and how fast. Positions thinned to one point every few seconds.',
  },
  {
    key: 'logdata',
    label: 'All logfile data',
    detail: 'The full log rather than just the track — every channel your instruments recorded, at full rate.',
    needsTracks: true,
  },
  {
    key: 'videos',
    label: 'Videos',
    detail: 'Clips from a shared day. Onboard footage with crew audio is worth thinking about before ticking this.',
  },
  {
    key: 'photos',
    label: 'Photos',
    detail: 'Stills from a shared day, including drone shots.',
  },
  {
    key: 'sailscans',
    label: 'Sail scans',
    detail: 'Sail shape captures taken on a shared day. Not your tuning numbers.',
  },
  {
    key: 'comments',
    label: 'Squad comments',
    detail: 'Lets squad coaches write comments on your tagged moments — and lets you write on theirs. They can never edit your tags.',
  },
  {
    key: 'notes',
    label: 'Notes',
    detail: 'The written parts of a shared day: speed-team meeting, debrief, timings and plan. Never your private notebook.',
  },
]

export const TAG_OPTIONS: Array<{ value: TagVisibility; label: string; detail: string }> = [
  { value: 'none', label: 'No tags', detail: 'Nothing tagged is shared.' },
  { value: 'race', label: 'Race tags only', detail: 'Starts, marks, finishes — what happened in a race. Training tags stay private.' },
  { value: 'all', label: 'All tags', detail: 'Every tag on a shared day, including what your coach flagged in training.' },
]

/** Normalise whatever the server sent into a complete, valid shape. */
export function toShares(raw: unknown): SquadShares {
  const r = (raw || {}) as Record<string, unknown>
  const bool = (k: string) => r[k] === true
  const tags = r.tags
  return {
    tracks: bool('tracks'), logdata: bool('logdata'), videos: bool('videos'),
    photos: bool('photos'), sailscans: bool('sailscans'),
    comments: bool('comments'), notes: bool('notes'),
    tags: tags === 'race' || tags === 'all' ? tags : 'none',
  }
}

/**
 * Categories that hang off a session and therefore do nothing on their own.
 *
 * Notes, scans and tags are all attached to a DAY, and a day is only visible
 * when its session is shared — which needs `tracks`. Ticking "notes" with
 * tracks off is not dangerous, it is simply inert, and a box that silently
 * does nothing is worse than one that says so.
 */
export function inertWithoutTracks(s: SquadShares): string[] {
  if (s.tracks) return []
  const out: string[] = []
  if (s.logdata) out.push('All logfile data')
  if (s.sailscans) out.push('Sail scans')
  if (s.notes) out.push('Notes')
  if (s.tags !== 'none') out.push('Tags')
  return out
}

/** One line describing what this team currently gives the squad. */
export function sharesSummary(s: SquadShares): string {
  const on = SQUAD_CATEGORIES.filter((c) => s[c.key]).map((c) => c.label.toLowerCase())
  if (s.tags === 'race') on.push('race tags')
  if (s.tags === 'all') on.push('all tags')
  if (!on.length) return 'Contributing nothing yet.'
  const list = on.length > 1
    ? `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}`
    : on[0]
  return `Contributing ${list}.`
}
