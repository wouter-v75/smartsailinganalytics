// src/lib/tagging/eventFile.ts
// ─────────────────────────────────────────────────────────────────────────────
// The SSA event file — one document per (boat, day) holding everything the crew
// tagged and every phase they cut.
//
// Expedition writes .ev.xml and SSA reads it (xmlEventParse.js). This is SSA's own
// half of that conversation: the tags and phases the CREW authored, in a format
// that is portable, diffable and re-importable. Supabase stays the source of
// truth — this file is generated from it on demand and can be fed back in.
//
// Shape decisions worth knowing:
//   • times are ISO-8601 UTC strings, because a file a human may open should not
//     be a wall of epoch milliseconds. They parse back to the same ms.
//   • every tag carries its label and colour as they were AT WRITE TIME, so the
//     file still reads correctly after the vocabulary is renamed.
//   • the vocabulary used by the day travels with it, so a file imported into
//     another boat's workspace can recreate the tags it references.
//   • keys are emitted in a fixed order so two exports of an unchanged day are
//     byte-identical and a diff shows only real edits.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import type { SsaPhase, TagDef, TagEvent, TagScope, TagSource, TagTargetKind } from './types'

export const SSA_EVENT_FORMAT = 'ssa-event-file'
export const SSA_EVENT_VERSION = 1

export interface EventFileTag {
  id: string
  slug: string
  label: string
  color: string
  scope: TagScope
  section: string | null
  t0: string
  t1: string
  targetKind: TagTargetKind
  targetId: string | null
  note: string | null
  source: TagSource
  by: string | null
}

export interface EventFilePhase {
  id: string
  batchId: string
  t0: string
  t1: string
  lengthSec: number
  mode: string | null
  tack: string | null
  nSamples: number
  rejected: boolean
  rejectReason: string | null
  metrics: Record<string, number | null> | null
}

export interface EventFileVocabEntry {
  slug: string
  label: string
  color: string
  scope: TagScope
  section: string | null
  kind: string
  minRole: string
}

export interface SsaEventFile {
  format: typeof SSA_EVENT_FORMAT
  version: number
  generatedAt: string
  team: { id: string; name?: string | null }
  boat: { id: string; name?: string | null }
  date: string
  sessionId: string | null
  /** Minutes to ADD to UTC for the day's local time — matches the app's tzOffset. */
  tzOffsetMin: number
  counts: { tags: number; phases: number; phasesKept: number }
  tags: EventFileTag[]
  phases: EventFilePhase[]
  vocabulary: EventFileVocabEntry[]
}

const iso = (ms: number): string => new Date(ms).toISOString()
const ms = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** Personal tags never leave the account that made them, so they never reach the
 *  file — an export handed to a coach must not carry someone's private notes. */
export const isExportable = (t: Pick<TagEvent, 'scope'>): boolean => t.scope !== 'personal'

export interface BuildEventFileInput {
  team: { id: string; name?: string | null }
  boat: { id: string; name?: string | null }
  date: string
  sessionId?: string | null
  tzOffsetMin?: number
  tags: TagEvent[]
  phases: SsaPhase[]
  vocabulary?: TagDef[]
  generatedAt?: number
}

export function buildEventFile(input: BuildEventFileInput): SsaEventFile {
  const tags = input.tags
    .filter(isExportable)
    .slice()
    .sort((a, b) => a.t0 - b.t0 || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id))
    .map<EventFileTag>((t) => ({
      id: t.id,
      slug: t.slug,
      label: t.label,
      color: t.color,
      scope: t.scope,
      section: t.section ?? null,
      t0: iso(t.t0),
      t1: iso(t.t1),
      targetKind: t.targetKind,
      targetId: t.targetId ?? null,
      note: t.note ?? null,
      source: t.source,
      by: t.createdByUserId ?? null,
    }))

  const phases = input.phases
    .slice()
    .sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id))
    .map<EventFilePhase>((p) => ({
      id: p.id,
      batchId: p.batchId,
      t0: iso(p.t0),
      t1: iso(p.t1),
      lengthSec: Math.round((p.t1 - p.t0) / 1000),
      mode: p.mode ?? null,
      tack: p.tack ?? null,
      nSamples: p.nSamples,
      rejected: p.rejected,
      rejectReason: p.rejectReason ?? null,
      metrics: p.metrics ?? null,
    }))

  // Only the vocabulary this day actually uses — an export is a record of a day,
  // not a dump of the boat's whole tag list.
  const used = new Set(tags.map((t) => `${t.scope}:${t.section || ''}:${t.slug}`))
  const vocabulary = (input.vocabulary || [])
    .filter((d) => d.scope !== 'personal' && used.has(`${d.scope}:${d.section || ''}:${d.slug}`))
    .slice()
    .sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug))
    .map<EventFileVocabEntry>((d) => ({
      slug: d.slug,
      label: d.label,
      color: d.color,
      scope: d.scope,
      section: d.section ?? null,
      kind: d.kind,
      minRole: d.minRole,
    }))

  return {
    format: SSA_EVENT_FORMAT,
    version: SSA_EVENT_VERSION,
    generatedAt: iso(input.generatedAt ?? Date.now()),
    team: { id: input.team.id, name: input.team.name ?? null },
    boat: { id: input.boat.id, name: input.boat.name ?? null },
    date: input.date,
    sessionId: input.sessionId ?? null,
    tzOffsetMin: input.tzOffsetMin ?? 0,
    counts: {
      tags: tags.length,
      phases: phases.length,
      phasesKept: phases.filter((p) => !p.rejected).length,
    },
    tags,
    phases,
    vocabulary,
  }
}

/** Pretty, stable JSON — two exports of an unchanged day are byte-identical. */
export const serializeEventFile = (f: SsaEventFile): string => JSON.stringify(f, null, 2) + '\n'

/** `northstar-76_2026-09-11.ssa.json` — sorts by boat then date in a folder. */
export function eventFileName(boatName: string | null | undefined, date: string): string {
  const slug = String(boatName || 'boat')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'boat'
  return `${slug}_${date}.ssa.json`
}

export class EventFileError extends Error {}

/** Parse and validate a .ssa.json. Throws EventFileError on anything that is not
 *  one — an import is a place to be strict, not forgiving. */
export function parseEventFile(text: string): SsaEventFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new EventFileError('Not valid JSON')
  }
  const o = raw as Partial<SsaEventFile>
  if (!o || typeof o !== 'object') throw new EventFileError('Not an object')
  if (o.format !== SSA_EVENT_FORMAT) throw new EventFileError('Not an SSA event file')
  if (typeof o.version !== 'number' || o.version > SSA_EVENT_VERSION) {
    throw new EventFileError(`Unsupported event-file version ${String(o.version)}`)
  }
  if (!o.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(o.date))) {
    throw new EventFileError('Missing or malformed date')
  }
  if (!Array.isArray(o.tags) || !Array.isArray(o.phases)) {
    throw new EventFileError('Missing tags[] or phases[]')
  }
  return {
    format: SSA_EVENT_FORMAT,
    version: o.version,
    generatedAt: String(o.generatedAt || ''),
    team: { id: String(o.team?.id || ''), name: o.team?.name ?? null },
    boat: { id: String(o.boat?.id || ''), name: o.boat?.name ?? null },
    date: String(o.date),
    sessionId: o.sessionId ?? null,
    tzOffsetMin: Number(o.tzOffsetMin) || 0,
    counts: o.counts || { tags: o.tags.length, phases: o.phases.length, phasesKept: 0 },
    tags: o.tags as EventFileTag[],
    phases: o.phases as EventFilePhase[],
    vocabulary: Array.isArray(o.vocabulary) ? (o.vocabulary as EventFileVocabEntry[]) : [],
  }
}

/** File tags → the shape the tag API upserts, retargeted at the importing boat.
 *  Ids are dropped: an import ADDS the day's tags to this workspace, it does not
 *  claim to be the same rows. */
export function eventFileTagsToEvents(
  f: SsaEventFile,
  target: { teamId: string; boatId: string; sessionId?: string | null }
): Omit<TagEvent, 'id' | 'tagDefId' | 'ownerUserId' | 'createdByUserId'>[] {
  return f.tags.filter(isExportable).map((t) => ({
    teamId: target.teamId,
    boatId: target.boatId,
    sessionId: target.sessionId ?? null,
    sessionDate: f.date,
    slug: t.slug,
    label: t.label,
    color: t.color,
    scope: t.scope,
    section: t.section ?? null,
    t0: ms(t.t0),
    t1: ms(t.t1),
    targetKind: t.targetKind,
    targetId: t.targetId ?? null,
    note: t.note ?? null,
    source: t.source,
    meta: { importedFrom: `${f.boat.name || f.boat.id}/${f.date}`, originalId: t.id },
  }))
}
