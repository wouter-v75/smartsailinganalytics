// src/lib/tagging/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// The tagger's shared vocabulary. Mirrors supabase/migrations/0062_ssa_tagger.sql.
//
// A TAG DEFINITION is vocabulary: a slug, a label, a colour, and who may apply
// it. A TAG EVENT is that definition put on the timeline at a time — the thing
// the crew actually creates, moves, edits and deletes, and the thing the .ssa
// event file serialises.
// ─────────────────────────────────────────────────────────────────────────────

/** general = the boat's shared vocabulary · section = one crew section's ·
 *  personal = private to one user. */
export type TagScope = 'general' | 'section' | 'personal'

/** A point tag marks an instant; a range tag spans a window you can drag. */
export type TagKind = 'point' | 'range'

export type TagSource = 'human' | 'auto' | 'ai'

/** What a tag is attached to. 'track' is the day's own time axis. */
export type TagTargetKind = 'track' | 'video' | 'photo' | 'scan' | 'phase'

export interface TagDef {
  id: string
  teamId: string
  boatId: string | null
  scope: TagScope
  section: string | null
  ownerUserId: string | null
  slug: string
  label: string
  color: string
  /** Lowest membership role that may APPLY this tag (see gating.ts). */
  minRole: string
  kind: TagKind
  builtin: boolean
  archived: boolean
  sort: number
}

export interface TagEvent {
  id: string
  teamId: string
  boatId: string
  sessionId: string | null
  sessionDate: string // YYYY-MM-DD
  tagDefId: string | null
  slug: string
  label: string
  color: string
  scope: TagScope
  section: string | null
  ownerUserId: string | null
  t0: number // UTC ms
  t1: number // UTC ms — point tags set t1 === t0
  targetKind: TagTargetKind
  targetId: string | null
  note: string | null
  source: TagSource
  createdByUserId: string | null
  meta?: Record<string, unknown> | null
}

export interface SsaPhase {
  id: string
  teamId: string
  boatId: string
  sessionId: string | null
  sessionDate: string
  batchId: string
  t0: number
  t1: number
  mode: 'up' | 'down' | 'reach' | null
  tack: 'port' | 'stbd' | null
  nSamples: number
  rejected: boolean
  rejectReason: string | null
  metrics?: Record<string, number | null> | null
  source: TagSource
}

/** Who is tagging: the active membership, plus the sections they sail in. */
export interface TaggerIdentity {
  userId: string
  teamId: string
  boatId: string | null
  /** Membership role — 'admin' for the global admin. */
  role: string
  /** Crew sections this user sails in (usually one). */
  sections: string[]
}

export const isPointTag = (t: Pick<TagEvent, 't0' | 't1'>): boolean => t.t1 <= t.t0
export const tagDurationMs = (t: Pick<TagEvent, 't0' | 't1'>): number => Math.max(0, t.t1 - t.t0)
