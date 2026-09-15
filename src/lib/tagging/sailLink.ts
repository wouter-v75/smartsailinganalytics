// src/lib/tagging/sailLink.ts
// ─────────────────────────────────────────────────────────────────────────────
// Event-file sail names → sails in the boat's inventory.
//
// The event file says "J2". The inventory holds a row with an id, a weight, a
// build date, a batten card and a stack of scans. Those are the same sail, and
// everything that makes the tagger worth having depends on knowing it: the
// weight aboard reads specs.weight_kg, the batten tab hangs off a mainsail's
// id, and the sail-change composer highlights what is up by id.
//
// Unlinked, they are two different things that happen to share a spelling. That
// showed up as a carried deck reading "Main + J2 + J4 + A2 + Main + J4" — the
// same two sails, aboard twice, under two identities.
//
// So names are RESOLVED against the inventory on the way in, and whatever the
// inventory has never heard of is reported so somebody can add it. Not added
// automatically: an event file with a stray space in it would otherwise mint a
// second "J2 " nobody asked for, and an inventory is a thing crews curate.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { SAIL_CHANGE_SLUG, type SailRef } from './sailState'
import type { TagEvent } from './types'

/** The one comparison. Trimmed and lower-cased, because an event file's
 *  spelling of a sail is not under anybody's control. */
export const nameKey = (name: unknown): string =>
  String(name ?? '').trim().toLowerCase()

export interface SailLinks {
  /** nameKey → the inventory sail it means. */
  bySail: Map<string, SailRef>
  /** Names the inventory has never heard of, in the order they first appear. */
  missing: string[]
}

/** Build the lookup from a boat's inventory. */
export function sailLinks(inventory: readonly SailRef[]): Map<string, SailRef> {
  const out = new Map<string, SailRef>()
  for (const s of inventory || []) {
    const k = nameKey(s?.name)
    // FIRST wins. Two inventory rows sharing a name is a curation problem the
    // crew has already got; picking the later one would make which sail a tag
    // means depend on the order a query came back in.
    if (k && !out.has(k)) out.set(k, { id: s.id ?? null, name: s.name })
  }
  return out
}

/** Every sail name the day's tags use, however they carry it. */
export function sailNamesIn(tags: readonly TagEvent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (name: unknown) => {
    const t = String(name ?? '').trim()
    const k = nameKey(t)
    if (!t || seen.has(k)) return
    seen.add(k)
    out.push(t)
  }

  for (const tag of tags || []) {
    if (tag.slug !== SAIL_CHANGE_SLUG || tag.rejected) continue
    const meta = (tag.meta as Record<string, unknown> | null) || null
    // The crew's own shape.
    const sail = meta?.sail as { up?: unknown; onBoard?: unknown } | undefined
    for (const list of [sail?.up, sail?.onBoard]) {
      for (const s of Array.isArray(list) ? list : []) add((s as SailRef)?.name)
    }
    // The event file's: a plain list of names.
    for (const s of Array.isArray(meta?.sails) ? (meta!.sails as unknown[]) : []) {
      add(typeof s === 'string' ? s : (s as { name?: unknown })?.name)
    }
  }
  return out
}

/** Which of the day's sail names the inventory cannot account for. */
export function missingFromInventory(
  tags: readonly TagEvent[],
  inventory: readonly SailRef[]
): string[] {
  const links = sailLinks(inventory)
  return sailNamesIn(tags).filter((n) => !links.has(nameKey(n)))
}

/** Put the inventory's id on a sail the event file named. Unknown names keep
 *  their own spelling and no id — they are still real sails, just unlinked. */
export const linkRef = (s: SailRef, links: Map<string, SailRef>): SailRef => {
  const found = links.get(nameKey(s?.name))
  return found ? { id: found.id ?? null, name: found.name } : { id: s?.id ?? null, name: s?.name }
}

const linkList = (raw: unknown, links: Map<string, SailRef>): SailRef[] | null => {
  if (!Array.isArray(raw)) return null
  return raw
    .map((s) => (typeof s === 'string' ? { id: null, name: s } : (s as SailRef)))
    .filter((s) => String(s?.name ?? '').trim())
    .map((s) => linkRef(s, links))
}

/**
 * Rewrite a day's sail-change tags so every sail carries its inventory id.
 *
 * A DERIVED VIEW: nothing is written back. The rows keep whatever the crew and
 * the file put in them, and the identity problem is solved where it is actually
 * felt — in the fold, the composer and the weight — rather than by a migration
 * that would have to run again every time a sail is renamed.
 *
 * Also normalises the event file's flat `meta.sails` into a real `meta.sail`
 * state, so the rest of the app has one shape to read.
 */
export function linkDay(
  tags: readonly TagEvent[],
  inventory: readonly SailRef[]
): TagEvent[] {
  const links = sailLinks(inventory)
  if (!links.size) return tags as TagEvent[]

  return (tags || []).map((tag) => {
    if (tag.slug !== SAIL_CHANGE_SLUG) return tag
    const meta = (tag.meta as Record<string, unknown> | null) || null
    if (!meta) return tag

    const sail = meta.sail as { up?: unknown; onBoard?: unknown; battens?: unknown } | undefined
    const fromFile = linkList(meta.sails, links)

    if (sail) {
      const up = linkList(sail.up, links)
      const onBoard = linkList(sail.onBoard, links)
      if (!up && !onBoard) return tag
      return {
        ...tag,
        meta: {
          ...meta,
          sail: {
            ...sail,
            ...(up ? { up } : {}),
            ...(onBoard ? { onBoard } : {}),
          },
        },
      }
    }

    // Event-file only. Give it the same shape the crew's tags have, so nothing
    // downstream has to know there were ever two.
    if (fromFile?.length) {
      return { ...tag, meta: { ...meta, sail: { up: fromFile, onBoard: [], battens: [] } } }
    }
    return tag
  })
}

/** What to send to the sails importer for the names nobody has. Deliberately
 *  minimal: a name and nothing else. Guessing a kind from a spelling is how an
 *  inventory ends up with a spinnaker called "J4". */
export const sailsToCreate = (names: readonly string[]): { name: string }[] =>
  (names || []).map((n) => ({ name: String(n).trim() })).filter((s) => s.name)
