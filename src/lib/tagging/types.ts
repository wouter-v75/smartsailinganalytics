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

/** Who put a tag here — drives the lane it draws in and the provenance line. */
export type TagProducer =
  | 'user'        // a person, by hand
  | 'eventfile'   // Expedition's own events
  | 'comment'     // an on-water comment, logged one-handed at speed
  | 'manoeuvres'  // src/lib/manoeuvres.ts
  | 'startline'   // src/lib/startAnalysis.ts
  | 'log'         // derived from the log directly

/** A descriptor: the "how" to a category's "what". Sportscode calls the pair
 *  code + label; Nacsport calls it category + descriptor. Same idea. */
export interface TagLabel {
  group: string
  text: string
}

/** The descriptors a definition allows, e.g. { group: 'Quality',
 *  options: ['good', 'slow', 'late'] }. */
export interface TagLabelGroup {
  group: string
  options: string[]
  /** More than one option may be picked from this group. */
  multi?: boolean
}

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
  /** Seconds BEFORE the press the tag starts. People press late, always. */
  leadSec: number
  /** Seconds after the press the tag keeps running. */
  lagSec: number
  /** The descriptors this tag may carry. */
  labelGroups: TagLabelGroup[]
  /** Timeline lane; null = derive from scope/section. */
  lane: string | null
  /** On the curated button bar (~8), as opposed to only in the picker. */
  onButtonBar: boolean
  /** Shared vocabulary whose every application is private to whoever applied
   *  it — how "Personal note" works without a definition per user. */
  privateByDefault: boolean
  builtin: boolean
  archived: boolean
  sort: number
  /** Whether THIS user may apply it. Decided server-side by canApplyTagDef and
   *  sent with every def; absent on the seed shapes used in tests and previews,
   *  which counts as allowed. */
  canApply?: boolean
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
  /** Applied descriptors. */
  labels: TagLabel[]
  source: TagSource
  producer: TagProducer

  // ── merge state (see supabase/migrations/0062_ssa_tagger.sql) ─────────────
  /** Ordinal identity of the detection this row IS, e.g. "b:2026-09-11:r2:tack:3".
   *  null for a hand-placed tag. Unique per (boat, day). */
  detectionKey: string | null
  /** Where the detector put it — kept forever, so the UI can offer to snap back. */
  autoT0: number | null
  autoT1: number | null
  /** 0–1, two decimals. Drives the review queue's ordering. */
  confidence: number | null
  /** Fields a human has changed; derivation writes a field only if absent here. */
  editedFields: string[]
  verifiedByUserId: string | null
  verifiedAt: number | null
  /** The tombstone: hidden from the track, and skipped by every later sync. */
  rejected: boolean
  rejectedReason: string | null
  /** Position in the day's debrief reel; null = not on the reel. */
  reelOrder: number | null

  createdByUserId: string | null
  meta?: Record<string, unknown> | null
}

// SsaPhase lives with the Phases tab (milestone M7), not here — see
// docs/tagger-architecture.md. src/lib/tagging/autoPhases.ts is its groundwork.
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

// ─────────────────────────────────────────────────────────────────────────────
// Requests — what the crew ask for once a moment is tagged.
// ─────────────────────────────────────────────────────────────────────────────

/** 'video' wants footage pulled and needs an approver; 'debrief' wants the
 *  moment discussed and needs none — nomination is open, and the coach's
 *  selection onto the reel IS the approval. */
export type RequestKind = 'video' | 'debrief'

export type RequestMediaKind = 'video' | 'photo' | 'drone'

export type RequestStatus = 'open' | 'approved' | 'declined' | 'fulfilled'

export interface TagRequest {
  id: string
  teamId: string
  boatId: string
  sessionDate: string
  tagEventId: string
  kind: RequestKind
  mediaKind: RequestMediaKind | null
  status: RequestStatus
  note: string | null
  requestedByUserId: string
  requestedAt: number
  decidedByUserId: string | null
  decidedAt: number | null
  decisionNote: string | null
  assetKind: string | null
  assetId: string | null
}

/** A tag with the requests hanging off it — what the shortlist renders. */
export interface TagWithRequests {
  tag: TagEvent
  requests: TagRequest[]
  /** How many people asked to debrief this. Several is the strongest signal a
   *  shortlist has, so it is counted rather than merely listed. */
  debriefVotes: number
  videoPending: number
}
