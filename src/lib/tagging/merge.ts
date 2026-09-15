// src/lib/tagging/merge.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where detections meet people.
//
// Derivation runs again every time the log, the event file or the detector
// changes. It must be IMPOSSIBLE for that to undo somebody's work — a tool that
// quietly reverts your edits is a tool the crew stop trusting, and SSA has been
// here before (see the `isAutoTag` comment in src/lib/localStore.js, where an
// over-eager auto-tagger wiped manual video tags on every enrich pass).
//
// Three columns carry the whole contract:
//
//   editedFields[]  the structured diff. A human who moves a tag appends 't0'
//                   and 't1'; derivation consults the list before writing each
//                   field, so an edit survives every later sync.
//   rejected        the tombstone. A detection the crew threw away does not come
//                   back. Kept ON the row rather than in a side table, so it can
//                   still be listed, explained and un-rejected.
//   autoT0/autoT1   where the detector put it, kept forever alongside where it
//                   now sits — so the UI can always say "the detector had this
//                   4 s earlier" and offer to snap back.
//
// planSync() is PURE: it reads the current rows and the current detections and
// returns what should happen. Nothing here touches a database, which is what
// makes the rules in §2.3 of docs/tagger-architecture.md testable one at a time.
// ─────────────────────────────────────────────────────────────────────────────

import type { Detection } from './detect'
import type { TagEvent, TagLabel } from './types'

/** Fields derivation may write when the human has not claimed them. */
export const DERIVED_FIELDS = ['t0', 't1', 'slug', 'label'] as const
export type DerivedField = (typeof DERIVED_FIELDS)[number]

/** A row the sync wants to create. No id — the database mints it. */
export type NewTagEvent = Omit<TagEvent, 'id'>

export interface TagEventPatch {
  id: string
  detectionKey: string | null
  patch: Partial<TagEvent>
  /** Why, for the sync preview: 'retimed' | 'relabelled' | 'rescored' | 'orphaned'. */
  reasons: string[]
}

export interface SyncPlan {
  insert: NewTagEvent[]
  update: TagEventPatch[]
  /** Row ids to delete — only ever unverified, unedited auto rows. */
  remove: string[]
  /** Detections deliberately not applied, and why. */
  skipped: { key: string; reason: 'rejected' }[]
  summary: {
    inserted: number
    updated: number
    removed: number
    skippedRejected: number
    orphaned: number
    unchanged: number
  }
}

export interface SyncContext {
  teamId: string
  boatId: string
  sessionId?: string | null
  sessionDate: string
  /** Colour + label for a slug, from the vocabulary. Falls back to the
   *  detection's own label and a neutral colour. */
  lookup?: (slug: string) => { label?: string; color?: string } | null
}

const DEFAULT_COLOR = '#06B6D4'
const has = (list: string[] | null | undefined, f: string) => !!list && list.includes(f)

/** A detection, as the row it would be if nobody had ever touched it. */
function rowFor(d: Detection, ctx: SyncContext): NewTagEvent {
  const v = ctx.lookup?.(d.slug) || null
  return {
    teamId: ctx.teamId,
    boatId: ctx.boatId,
    sessionId: ctx.sessionId ?? null,
    sessionDate: ctx.sessionDate,
    tagDefId: null,
    slug: d.slug,
    label: v?.label || d.label,
    color: v?.color || DEFAULT_COLOR,
    scope: 'general',
    section: null,
    ownerUserId: null,
    t0: d.t0,
    t1: d.t1,
    targetKind: 'track',
    targetId: null,
    note: null,
    labels: [],
    source: 'auto',
    producer: d.producer,
    detectionKey: d.key,
    autoT0: d.t0,
    autoT1: d.t1,
    confidence: d.confidence,
    editedFields: [],
    verifiedByUserId: null,
    verifiedAt: null,
    rejected: false,
    rejectedReason: null,
    reelOrder: null,
    createdByUserId: null,
    // The detector's measurements ride along in meta so the tag arrives WITH its
    // evidence — entry and exit speed, time to 95 %, turn angle, distance lost.
    // The review queue shows them, which is what lets somebody judge a detection
    // without opening another screen.
    meta: {
      segmentKey: d.segmentKey,
      raceNum: d.raceNum,
      metrics: d.metrics ?? null,
      ...(d.meta || {}),
    },
  }
}

/** Has a human touched this row in any way that should outlive the detector? */
export const isHumanTouched = (t: TagEvent): boolean =>
  (t.editedFields?.length ?? 0) > 0 ||
  t.verifiedAt != null ||
  t.rejected ||
  (t.labels?.length ?? 0) > 0 ||
  !!t.note ||
  t.reelOrder != null

/**
 * What a sync should do, given the rows that exist and the detections that were
 * just found. Pure — apply the plan yourself.
 *
 * The rules, in the order they fire:
 *
 *   detection with no row           → INSERT
 *   detection whose row is rejected → SKIP        (the tombstone holds)
 *   detection with a row            → UPDATE, field by field, skipping anything
 *                                     the human has claimed in editedFields
 *   auto row with no detection,
 *     verified or edited            → KEEP, flagged orphaned (a human vouched)
 *     otherwise                     → REMOVE      (the detector changed its mind)
 *
 * Hand-placed tags (detectionKey null) are never touched by any of this.
 */
export function planSync(
  existing: TagEvent[],
  detections: Detection[],
  ctx: SyncContext
): SyncPlan {
  const plan: SyncPlan = {
    insert: [], update: [], remove: [], skipped: [],
    summary: { inserted: 0, updated: 0, removed: 0, skippedRejected: 0, orphaned: 0, unchanged: 0 },
  }

  const byKey = new Map<string, TagEvent>()
  for (const row of existing) {
    if (row.detectionKey) byKey.set(row.detectionKey, row)
  }
  const seen = new Set<string>()

  for (const d of detections) {
    seen.add(d.key)
    const row = byKey.get(d.key)

    if (!row) {
      plan.insert.push(rowFor(d, ctx))
      continue
    }

    // The tombstone. Nothing below this line runs for a rejected detection —
    // that is the whole point of it.
    if (row.rejected) {
      plan.skipped.push({ key: d.key, reason: 'rejected' })
      continue
    }

    const patch: Partial<TagEvent> = {}
    const reasons: string[] = []

    // Always derived — the detector's own view of itself, which a human never
    // edits and which must stay current so "snap back" means something.
    if (row.autoT0 !== d.t0 || row.autoT1 !== d.t1) {
      patch.autoT0 = d.t0
      patch.autoT1 = d.t1
    }
    if (row.confidence !== d.confidence) {
      patch.confidence = d.confidence
      reasons.push('rescored')
    }
    if (row.producer !== d.producer) patch.producer = d.producer

    // Derived UNLESS the human has claimed the field.
    if (!has(row.editedFields, 't0') && row.t0 !== d.t0) {
      patch.t0 = d.t0
      reasons.push('retimed')
    }
    if (!has(row.editedFields, 't1') && row.t1 !== d.t1) patch.t1 = d.t1
    if (!has(row.editedFields, 'slug') && row.slug !== d.slug) {
      patch.slug = d.slug
      reasons.push('relabelled')
    }
    if (!has(row.editedFields, 'label')) {
      const label = ctx.lookup?.(d.slug)?.label || d.label
      if (row.label !== label) patch.label = label
    }

    // meta carries derived measurements AND the orphaned flag, so both are
    // settled in one place — writing meta twice would lose whichever went first.
    const meta = (row.meta || {}) as Record<string, unknown>
    const metaPatch: Record<string, unknown> = {}
    if (JSON.stringify(meta.metrics ?? null) !== JSON.stringify(d.metrics ?? null)) {
      metaPatch.metrics = d.metrics ?? null
    }
    // A row previously flagged orphaned that the detector has found again.
    if (meta.orphaned) {
      metaPatch.orphaned = false
      reasons.push('refound')
    }
    if (Object.keys(metaPatch).length) patch.meta = { ...meta, ...metaPatch }

    if (Object.keys(patch).length) {
      plan.update.push({ id: row.id, detectionKey: d.key, patch, reasons })
    } else {
      plan.summary.unchanged++
    }
  }

  // ── Auto rows the detector no longer produces ─────────────────────────────
  for (const row of existing) {
    if (!row.detectionKey || seen.has(row.detectionKey)) continue
    if (row.rejected) continue   // already a tombstone; leave it be

    if (isHumanTouched(row)) {
      // A human vouched for this, or shaped it. The detector changing its mind
      // does not overrule them — but it is worth flagging, because a verified
      // tag the data no longer supports is exactly the sort of thing a coach
      // should glance at.
      if (!(row.meta as Record<string, unknown> | null)?.orphaned) {
        plan.update.push({
          id: row.id,
          detectionKey: row.detectionKey,
          patch: { meta: { ...(row.meta || {}), orphaned: true } },
          reasons: ['orphaned'],
        })
        plan.summary.orphaned++
      }
    } else {
      plan.remove.push(row.id)
    }
  }

  plan.summary.inserted = plan.insert.length
  plan.summary.updated = plan.update.length
  plan.summary.removed = plan.remove.length
  plan.summary.skippedRejected = plan.skipped.length
  return plan
}

/** Does this plan change anything? Lets a caller skip a write entirely. */
export const planIsEmpty = (p: SyncPlan): boolean =>
  !p.insert.length && !p.update.length && !p.remove.length

// ─────────────────────────────────────────────────────────────────────────────
// The sanctioned human edits.
//
// Each returns a PATCH rather than mutating, and each records what it claimed in
// editedFields so the next sync leaves it alone. Going around these — writing t0
// directly, say — is how an edit gets silently reverted three syncs later.
// ─────────────────────────────────────────────────────────────────────────────

const claim = (t: TagEvent, ...fields: DerivedField[]): string[] =>
  Array.from(new Set([...(t.editedFields || []), ...fields]))

/**
 * Move a tag, preserving its duration.
 *
 * BOTH endpoints shift. Writing t0 alone trips the `t1 >= t0` window CHECK on a
 * point tag the moment you move it forwards — which is not hypothetical, it is
 * the first thing the schema tests caught.
 */
export function moveTag(tag: TagEvent, deltaMs: number): Partial<TagEvent> {
  if (!Number.isFinite(deltaMs) || deltaMs === 0) return {}
  return {
    t0: tag.t0 + deltaMs,
    t1: tag.t1 + deltaMs,
    editedFields: claim(tag, 't0', 't1'),
  }
}

/** Set a tag's window outright — dragging an edge rather than the whole tag. */
export function setTagWindow(tag: TagEvent, t0: number, t1: number): Partial<TagEvent> {
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return {}
  const lo = Math.min(t0, t1)
  const hi = Math.max(t0, t1)
  const fields: DerivedField[] = []
  if (lo !== tag.t0) fields.push('t0')
  if (hi !== tag.t1) fields.push('t1')
  if (!fields.length) return {}
  return { t0: lo, t1: hi, editedFields: claim(tag, ...fields) }
}

/** The detector called it a tack; it was a gybe. */
export function relabelTag(tag: TagEvent, slug: string, label?: string): Partial<TagEvent> {
  if (!slug || slug === tag.slug) return {}
  return {
    slug,
    label: label ?? tag.label,
    editedFields: claim(tag, 'slug', ...(label != null ? (['label'] as DerivedField[]) : [])),
  }
}

/** "Yes, that is a real tack." Survives the detector later disagreeing. */
export const verifyTag = (tag: TagEvent, userId: string, now = Date.now()): Partial<TagEvent> =>
  tag.verifiedAt != null ? {} : { verifiedByUserId: userId, verifiedAt: now }

export const unverifyTag = (tag: TagEvent): Partial<TagEvent> =>
  tag.verifiedAt == null ? {} : { verifiedByUserId: null, verifiedAt: null }

/**
 * "That was not a tack, it was a luff." A substituting override: the row stays
 * as a tombstone so the next sync does not resurrect the detection.
 */
export const rejectTag = (tag: TagEvent, reason?: string): Partial<TagEvent> =>
  tag.rejected ? {} : { rejected: true, rejectedReason: reason || null, reelOrder: null }

/** Undo a rejection — the tombstone lifts and the next sync tends it again. */
export const unrejectTag = (tag: TagEvent): Partial<TagEvent> =>
  tag.rejected ? { rejected: false, rejectedReason: null } : {}

/** Hand the tag back to the detector: return to where it put it and release
 *  every claimed field. The "actually, you were right" button. */
export function resetToDetector(tag: TagEvent): Partial<TagEvent> {
  if (tag.autoT0 == null) return {}
  return {
    t0: tag.autoT0,
    t1: tag.autoT1 ?? tag.autoT0,
    editedFields: [],
  }
}

/** Put a tag on the debrief reel, or take it off. */
export const setReelOrder = (tag: TagEvent, order: number | null): Partial<TagEvent> =>
  tag.reelOrder === order ? {} : { reelOrder: order }

/** Add a descriptor, without duplicating one already there. */
export function addLabel(tag: TagEvent, label: TagLabel): Partial<TagEvent> {
  const current = tag.labels || []
  if (current.some((l) => l.group === label.group && l.text === label.text)) return {}
  return { labels: [...current, label] }
}

export function removeLabel(tag: TagEvent, label: TagLabel): Partial<TagEvent> {
  const current = tag.labels || []
  const next = current.filter((l) => !(l.group === label.group && l.text === label.text))
  return next.length === current.length ? {} : { labels: next }
}

/**
 * A tag's DETAIL was re-entered — the sail change reopened and the sails up
 * changed, say.
 *
 * One patch rather than four. The detail composer derives the label, the note
 * and the descriptors from the same answer that fills `meta`, so writing them
 * as separate ops would be four round trips, four rows in the history, and a
 * window in which the label says one thing and the state another.
 *
 * `meta` MERGES. It is a bag several unrelated things write into — the
 * detector's metrics live there too — and replacing it would throw away the
 * measurements that explain why the tag was suggested in the first place.
 *
 * The label is CLAIMED: a human has chosen it, so the next sync must leave it
 * alone rather than resetting it to "Sail change".
 */
export function recomposeTag(
  tag: TagEvent,
  next: {
    label?: string | null
    note?: string | null
    labels?: TagLabel[] | null
    meta?: Record<string, unknown> | null
  }
): Partial<TagEvent> {
  const patch: Partial<TagEvent> = {}
  const fields: DerivedField[] = []

  const label = typeof next.label === 'string' ? next.label.trim() : ''
  if (label && label !== tag.label) { patch.label = label; fields.push('label') }

  if (next.note !== undefined) {
    const note = next.note == null ? null : String(next.note)
    if (note !== (tag.note ?? null)) patch.note = note
  }

  if (Array.isArray(next.labels)) {
    const same = JSON.stringify(next.labels) === JSON.stringify(tag.labels || [])
    if (!same) patch.labels = next.labels
  }

  if (next.meta && typeof next.meta === 'object' && !Array.isArray(next.meta)) {
    const before = (tag.meta || {}) as Record<string, unknown>
    const merged = { ...before, ...next.meta }
    if (JSON.stringify(merged) !== JSON.stringify(before)) patch.meta = merged
  }

  if (!Object.keys(patch).length) return {}
  if (fields.length) patch.editedFields = claim(tag, ...fields)
  return patch
}

/** How far a human has moved this tag from where the detector put it, in ms.
 *  null when the detector never had an opinion (a hand-placed tag). */
export const driftFromDetector = (tag: TagEvent): number | null =>
  tag.autoT0 == null ? null : tag.t0 - tag.autoT0
