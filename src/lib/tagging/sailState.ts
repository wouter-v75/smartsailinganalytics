// src/lib/tagging/sailState.ts
// ─────────────────────────────────────────────────────────────────────────────
// What was up, and when.
//
// A sail change is not an event so much as a TRANSITION, and the useful question
// is almost never "what changed at 12:31" — it is "what were we carrying on the
// second beat". So each sail-change tag records the full state after the change
// rather than a diff, and the state at any instant is the last such tag before
// it. Storing the state rather than the delta is what makes the day readable
// backwards: one mistyped change does not corrupt everything after it, and a tag
// deleted in review does not leave the rest of the afternoon flying a kite it
// dropped an hour ago.
//
// The same tag carries the battens, for the same reason: they are a setting, not
// an event, and "what were the battens on that beat" is the question a designer
// asks in the debrief.
//
// It all lives in the tag's `meta.sail`, which ssa_tag_events already has as
// JSONB — no new table, and the state inherits the track, the segments, the
// export and the permissions that tags already have.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import type { Tension } from '../battens'
import type { TagEvent } from './types'

/** The slug whose tags carry sail state. */
export const SAIL_CHANGE_SLUG = 'sail-change'

export interface SailRef {
  /** Inventory id when the sail is one the boat owns; absent for a typed name. */
  id?: string | null
  name: string
}

export interface BattenRecord {
  /** 1 = top. */
  no: number
  tension: Tension | null
  turns: number
}

/** What is flying, and how the main is set up, after a change. */
export interface SailState {
  /** Sails hoisted. The whole set, not what changed. */
  up: SailRef[]
  /** Battens as they were at this moment. */
  battens: BattenRecord[]
}

export const EMPTY_SAIL_STATE: SailState = { up: [], battens: [] }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const TENSIONS = new Set(['soft', 'medium', 'stiff'])

/** A stable identity for a sail: its inventory id, else its lower-cased name. */
export const sailKey = (s: SailRef | null | undefined): string =>
  String(s?.id || s?.name || '').trim().toLowerCase()

export const sameSail = (a: SailRef, b: SailRef): boolean => sailKey(a) === sailKey(b)

/** Coerce whatever is in a tag's meta into a state. Forgiving by design. */
export function normaliseSailState(raw: unknown): SailState {
  const o = (raw || {}) as Partial<SailState>
  const up: SailRef[] = []
  const seen = new Set<string>()
  for (const s of Array.isArray(o.up) ? o.up : []) {
    const name = String((s as SailRef)?.name ?? '').trim()
    if (!name) continue
    const ref: SailRef = { id: (s as SailRef)?.id ?? null, name }
    const k = sailKey(ref)
    if (seen.has(k)) continue
    seen.add(k)
    up.push(ref)
  }

  const battens: BattenRecord[] = []
  for (const b of Array.isArray(o.battens) ? o.battens : []) {
    const rec = b as Partial<BattenRecord>
    if (!isNum(rec?.no) || rec.no < 1) continue
    battens.push({
      no: Math.round(rec.no),
      tension: TENSIONS.has(rec.tension as string) ? (rec.tension as Tension) : null,
      turns: isNum(rec.turns) ? rec.turns : 0,
    })
  }
  battens.sort((a, b) => a.no - b.no)

  return { up, battens }
}

/** The sail state a tag carries, or null when it carries none. */
export function stateOf(tag: TagEvent): SailState | null {
  if (tag.slug !== SAIL_CHANGE_SLUG || tag.rejected) return null
  const raw = (tag.meta as Record<string, unknown> | null)?.sail
  if (!raw) return null
  return normaliseSailState(raw)
}

/** Sail-change tags that carry a state, oldest first. */
export function sailChanges(tags: readonly TagEvent[]): { tag: TagEvent; state: SailState }[] {
  return tags
    .map((tag) => ({ tag, state: stateOf(tag) }))
    .filter((x): x is { tag: TagEvent; state: SailState } => !!x.state)
    .sort((a, b) => a.tag.t0 - b.tag.t0)
}

/**
 * What was up at `utc` — the last change AT OR BEFORE it.
 *
 * At or before, not nearest: a change at 12:31 says nothing about 12:30, and
 * snapping backwards from the nearest tag would have the boat flying a kite it
 * had not hoisted yet.
 */
export function sailStateAt(tags: readonly TagEvent[], utc: number): SailState {
  const changes = sailChanges(tags)
  let out = EMPTY_SAIL_STATE
  for (const c of changes) {
    if (c.tag.t0 > utc) break
    out = c.state
  }
  return out
}

/** The change immediately before `utc`, for "carried over from 11:40". */
export function lastChangeBefore(
  tags: readonly TagEvent[],
  utc: number
): { tag: TagEvent; state: SailState } | null {
  const changes = sailChanges(tags)
  let out: { tag: TagEvent; state: SailState } | null = null
  for (const c of changes) {
    if (c.tag.t0 > utc) break
    out = c
  }
  return out
}

/** Add or remove one sail from a state's hoisted set. */
export function toggleUp(state: SailState, sail: SailRef): SailState {
  const on = state.up.some((s) => sameSail(s, sail))
  return {
    ...state,
    up: on
      ? state.up.filter((s) => !sameSail(s, sail))
      : [...state.up, { id: sail.id ?? null, name: sail.name }],
  }
}

export const isUp = (state: SailState, sail: SailRef): boolean =>
  state.up.some((s) => sameSail(s, sail))

/** Set one batten, keeping the rest and the top-down order. */
export function setBatten(
  state: SailState,
  no: number,
  patch: Partial<Omit<BattenRecord, 'no'>>
): SailState {
  const existing = state.battens.find((b) => b.no === no)
  const next: BattenRecord = {
    no,
    tension: patch.tension !== undefined ? patch.tension : existing?.tension ?? null,
    turns: patch.turns !== undefined ? patch.turns : existing?.turns ?? 0,
  }
  const rest = state.battens.filter((b) => b.no !== no)
  return { ...state, battens: [...rest, next].sort((a, b) => a.no - b.no) }
}

/** Grow or trim the recorded battens to the main's batten count. */
export function withBattenCount(state: SailState, count: number): SailState {
  const n = Math.max(0, Math.round(count) || 0)
  const byNo = new Map(state.battens.map((b) => [b.no, b]))
  return {
    ...state,
    battens: Array.from({ length: n }, (_, i) => byNo.get(i + 1) || { no: i + 1, tension: null, turns: 0 }),
  }
}

/** True when nothing has been recorded — used to keep empty state out of the row. */
export const stateIsEmpty = (s: SailState): boolean =>
  s.up.length === 0 && s.battens.every((b) => b.tension == null && !b.turns)

/**
 * A one-line summary for the tag's label — "J2 + Main", the way the tag already
 * reads in the list. A sail change with nothing up is a DROP, and says so
 * rather than rendering as an empty tag nobody can interpret.
 */
export function describeState(s: SailState): string {
  if (!s.up.length) return 'All down'
  return s.up.map((x) => x.name).join(' + ')
}

/** What actually changed between two states, for the note and the debrief. */
export function describeChange(before: SailState | null, after: SailState): string {
  if (!before) return describeState(after)
  const was = new Set(before.up.map(sailKey))
  const now = new Set(after.up.map(sailKey))
  const hoisted = after.up.filter((s) => !was.has(sailKey(s))).map((s) => s.name)
  const dropped = before.up.filter((s) => !now.has(sailKey(s))).map((s) => s.name)
  if (!hoisted.length && !dropped.length) return describeState(after)
  const parts: string[] = []
  if (hoisted.length) parts.push(`+${hoisted.join(' +')}`)
  if (dropped.length) parts.push(`−${dropped.join(' −')}`)
  return parts.join(' ')
}
