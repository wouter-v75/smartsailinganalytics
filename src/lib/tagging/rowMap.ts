// src/lib/tagging/rowMap.ts
// ─────────────────────────────────────────────────────────────────────────────
// The one place that knows the database spells things with underscores and the
// app spells them in camel case, and that timestamps cross the wire as ISO
// strings but are milliseconds everywhere else.
//
// Every tag route reads and writes through here, so the mapping exists once
// rather than once per endpoint — which is how a `verified_at` quietly stops
// round-tripping and nobody notices for a month.
// ─────────────────────────────────────────────────────────────────────────────

import type { TagDef, TagEvent, TagLabel, TagLabelGroup } from './types'

/** Columns every tag-event read asks for. */
export const TAG_EVENT_COLUMNS = [
  'id', 'team_id', 'boat_id', 'session_id', 'session_date', 'tag_def_id',
  'slug', 'label', 'color', 'scope', 'section', 'owner_user_id',
  't0', 't1', 'target_kind', 'target_id', 'note', 'labels',
  'source', 'producer', 'detection_key', 'auto_t0', 'auto_t1', 'confidence',
  'edited_fields', 'verified_by_user_id', 'verified_at',
  'rejected', 'rejected_reason', 'reel_order',
  'meta', 'created_by_user_id', 'created_at', 'updated_at',
].join(',')

export const TAG_DEF_COLUMNS = [
  'id', 'team_id', 'boat_id', 'scope', 'section', 'owner_user_id',
  'slug', 'label', 'color', 'min_role', 'kind',
  'lead_sec', 'lag_sec', 'label_groups', 'lane', 'on_button_bar',
  'builtin', 'archived', 'sort',
].join(',')

const ms = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : 0
}
const msOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const t = ms(v)
  return t === 0 ? null : t
}
const iso = (v: number | null | undefined): string | null =>
  v == null || !Number.isFinite(v) ? null : new Date(v).toISOString()

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** Database row → the app's TagEvent. */
export function toTagEvent(r: any): TagEvent {
  return {
    id: String(r.id),
    teamId: String(r.team_id),
    boatId: String(r.boat_id),
    sessionId: r.session_id ?? null,
    sessionDate: String(r.session_date).slice(0, 10),
    tagDefId: r.tag_def_id ?? null,
    slug: String(r.slug),
    label: String(r.label),
    color: String(r.color || '#06B6D4'),
    scope: r.scope,
    section: r.section ?? null,
    ownerUserId: r.owner_user_id ?? null,
    t0: ms(r.t0),
    t1: ms(r.t1),
    targetKind: r.target_kind || 'track',
    targetId: r.target_id ?? null,
    note: r.note ?? null,
    labels: arr<TagLabel>(r.labels),
    source: r.source || 'human',
    producer: r.producer || 'user',
    detectionKey: r.detection_key ?? null,
    autoT0: msOrNull(r.auto_t0),
    autoT1: msOrNull(r.auto_t1),
    // NUMERIC comes back as a string from PostgREST; Number() is exact here
    // because the column is NUMERIC(3,2) — two decimals, no float surprises.
    confidence: r.confidence == null ? null : Number(r.confidence),
    editedFields: arr<string>(r.edited_fields),
    verifiedByUserId: r.verified_by_user_id ?? null,
    verifiedAt: msOrNull(r.verified_at),
    rejected: !!r.rejected,
    rejectedReason: r.rejected_reason ?? null,
    reelOrder: r.reel_order ?? null,
    createdByUserId: r.created_by_user_id ?? null,
    meta: r.meta ?? null,
  }
}

/** A patch in app terms → the column names the database wants.
 *
 *  Only keys PRESENT in the patch are emitted, so a partial update stays
 *  partial — passing `undefined` through would null the column out. */
export function toTagEventPatch(p: Partial<TagEvent>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const set = (key: string, v: unknown) => { out[key] = v }

  if ('slug' in p) set('slug', p.slug)
  if ('label' in p) set('label', p.label)
  if ('color' in p) set('color', p.color)
  if ('t0' in p) set('t0', iso(p.t0))
  if ('t1' in p) set('t1', iso(p.t1))
  if ('targetKind' in p) set('target_kind', p.targetKind)
  if ('targetId' in p) set('target_id', p.targetId)
  if ('note' in p) set('note', p.note)
  if ('labels' in p) set('labels', p.labels)
  if ('producer' in p) set('producer', p.producer)
  if ('autoT0' in p) set('auto_t0', iso(p.autoT0))
  if ('autoT1' in p) set('auto_t1', iso(p.autoT1))
  if ('confidence' in p) set('confidence', p.confidence)
  if ('editedFields' in p) set('edited_fields', p.editedFields)
  if ('verifiedByUserId' in p) set('verified_by_user_id', p.verifiedByUserId)
  if ('verifiedAt' in p) set('verified_at', iso(p.verifiedAt))
  if ('rejected' in p) set('rejected', p.rejected)
  if ('rejectedReason' in p) set('rejected_reason', p.rejectedReason)
  if ('reelOrder' in p) set('reel_order', p.reelOrder)
  if ('meta' in p) set('meta', p.meta)
  return out
}

/** A whole new row → insert payload. */
export function toTagEventInsert(t: Omit<TagEvent, 'id'>): Record<string, unknown> {
  return {
    team_id: t.teamId,
    boat_id: t.boatId,
    session_id: t.sessionId,
    session_date: t.sessionDate,
    tag_def_id: t.tagDefId,
    slug: t.slug,
    label: t.label,
    color: t.color,
    scope: t.scope,
    section: t.section,
    owner_user_id: t.ownerUserId,
    t0: iso(t.t0),
    t1: iso(t.t1),
    target_kind: t.targetKind,
    target_id: t.targetId,
    note: t.note,
    labels: t.labels,
    source: t.source,
    producer: t.producer,
    detection_key: t.detectionKey,
    auto_t0: iso(t.autoT0),
    auto_t1: iso(t.autoT1),
    confidence: t.confidence,
    edited_fields: t.editedFields,
    verified_by_user_id: t.verifiedByUserId,
    verified_at: iso(t.verifiedAt),
    rejected: t.rejected,
    rejected_reason: t.rejectedReason,
    reel_order: t.reelOrder,
    meta: t.meta ?? null,
    created_by_user_id: t.createdByUserId,
  }
}

export function toTagDef(r: any): TagDef {
  return {
    id: String(r.id),
    teamId: String(r.team_id),
    boatId: r.boat_id ?? null,
    scope: r.scope,
    section: r.section ?? null,
    ownerUserId: r.owner_user_id ?? null,
    slug: String(r.slug),
    label: String(r.label),
    color: String(r.color || '#06B6D4'),
    minRole: String(r.min_role || 'tl1'),
    kind: r.kind || 'point',
    leadSec: Number(r.lead_sec ?? 0),
    lagSec: Number(r.lag_sec ?? 0),
    labelGroups: arr<TagLabelGroup>(r.label_groups),
    lane: r.lane ?? null,
    onButtonBar: !!r.on_button_bar,
    builtin: !!r.builtin,
    archived: !!r.archived,
    sort: Number(r.sort ?? 100),
  }
}

export function toTagDefPatch(p: Partial<TagDef>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('label' in p) out.label = p.label
  if ('color' in p) out.color = p.color
  if ('minRole' in p) out.min_role = p.minRole
  if ('kind' in p) out.kind = p.kind
  if ('leadSec' in p) out.lead_sec = p.leadSec
  if ('lagSec' in p) out.lag_sec = p.lagSec
  if ('labelGroups' in p) out.label_groups = p.labelGroups
  if ('lane' in p) out.lane = p.lane
  if ('onButtonBar' in p) out.on_button_bar = p.onButtonBar
  if ('archived' in p) out.archived = p.archived
  if ('sort' in p) out.sort = p.sort
  return out
}

/**
 * Where a button press lands, given the definition's lead and lag.
 *
 * People press LATE — they have to see the moment, recognise it and find the
 * button — so the tag starts before the press and runs on after it. Doing this
 * server-side means every client gets the same answer and a crew member cannot
 * accidentally post a tag with no lead at all.
 */
export function windowForPress(def: Pick<TagDef, 'leadSec' | 'lagSec' | 'kind'>, at: number) {
  const t0 = at - (def.leadSec || 0) * 1000
  const t1 = at + (def.lagSec || 0) * 1000
  // A point tag still gets a window — that is what lead/lag are for — but it can
  // never be inverted, whatever a definition is configured with.
  return { t0: Math.min(t0, t1), t1: Math.max(t0, t1) }
}
