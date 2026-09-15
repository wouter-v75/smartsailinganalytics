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

/**
 * What is flying, what is aboard, and how the main is set up, after a change.
 *
 * THREE LEVELS, and they nest:
 *
 *   the DAY's sail list   what went out on the water. Set once in
 *                         Campaign → Day; includes the sails riding in the RIB.
 *   ON BOARD              what is actually on the boat. A subset, because a
 *                         crew routinely leaves sails in the RIB and passes
 *                         them across — and what is on the boat is what counts
 *                         towards the weight aboard.
 *   UP                    what is hoisted. A subset of what is aboard: you
 *                         cannot hoist a sail that is in the RIB.
 *
 * Only the inner two live here, because only they change during the day. The
 * day's list is the universe they are drawn from and belongs to the session.
 */
export interface SailState {
  /** Sails hoisted. The whole set, not what changed. */
  up: SailRef[]
  /** Sails physically on the boat. Always a superset of `up`. */
  onBoard: SailRef[]
  /** Battens as they were at this moment. */
  battens: BattenRecord[]
}

export const EMPTY_SAIL_STATE: SailState = { up: [], onBoard: [], battens: [] }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const TENSIONS = new Set(['soft', 'medium', 'stiff'])

/** A stable identity for a sail: its inventory id, else its lower-cased name. */
export const sailKey = (s: SailRef | null | undefined): string =>
  String(s?.id || s?.name || '').trim().toLowerCase()

export const sameSail = (a: SailRef, b: SailRef): boolean => sailKey(a) === sailKey(b)

/** Just the name, lower-cased — the only thing the event file gives. */
const nameKey = (s: SailRef | null | undefined): string =>
  String(s?.name ?? '').trim().toLowerCase()

/**
 * Same sail, ACROSS SOURCES.
 *
 * The crew pick sails out of the inventory, so theirs carry an id. The event
 * file knows only names. sailKey prefers the id, so inventory "Main" and the
 * file's "Main" hash differently and never match — which is invisible until the
 * carried deck comes back as "Main + J2 + J4 + A2 + Main + J4".
 *
 * Deliberately NOT what sameSail does. Inside the composer every sail comes
 * from one place, and two different mainsails that happen to share a name
 * should stay two sails; it is only when folding a day together that the
 * name is all there is to go on.
 */
export const sameSailAcrossSources = (a: SailRef, b: SailRef): boolean =>
  sailKey(a) === sailKey(b) || (!!nameKey(a) && nameKey(a) === nameKey(b))

/** Clean a list of sail references: named, de-duplicated, in order. */
function refList(raw: unknown): SailRef[] {
  const out: SailRef[] = []
  const seen = new Set<string>()
  for (const s of Array.isArray(raw) ? raw : []) {
    const name = String((s as SailRef)?.name ?? '').trim()
    if (!name) continue
    const ref: SailRef = { id: (s as SailRef)?.id ?? null, name }
    const k = sailKey(ref)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(ref)
  }
  return out
}

/** Coerce whatever is in a tag's meta into a state. Forgiving by design. */
export function normaliseSailState(raw: unknown): SailState {
  const o = (raw || {}) as Partial<SailState>
  const up = refList(o.up)

  // A sail cannot be hoisted from the RIB, so anything up is aboard by
  // definition. Rows written before `onBoard` existed have no list at all, and
  // reading those as "nothing aboard" would say the boat was sailing with an
  // empty deck — what is up is the only thing we know for certain was there.
  const stored = refList(o.onBoard)
  const onBoard = [...stored]
  const aboard = new Set(stored.map(sailKey))
  for (const s of up) if (!aboard.has(sailKey(s))) { aboard.add(sailKey(s)); onBoard.push(s) }

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

  return { up, onBoard, battens }
}

/**
 * The sail state a tag carries, or null when it carries none.
 *
 * TWO SHAPES, because a sail change can arrive two ways and both are real.
 *
 *   meta.sail   the crew entered it in the tagger: what was up, what was
 *               aboard, and the battens. The full picture.
 *   meta.sails  the EVENT FILE said so — Expedition logs the sails up at each
 *               change as a plain list of names, and detect.ts carries it
 *               through. No battens, nothing about the RIB.
 *
 * The crew's own entry wins where there is one; otherwise the event file
 * answers, because "Main + J2, from the file" is enormously more useful than
 * "not recorded" on a day nobody had a phone out. Read here rather than at
 * detection time so it also covers the tags already sitting in the database,
 * which were synced before any of this existed.
 */
export function stateOf(tag: TagEvent): SailState | null {
  if (tag.slug !== SAIL_CHANGE_SLUG || tag.rejected) return null
  const meta = (tag.meta as Record<string, unknown> | null) || null
  if (meta?.sail) return normaliseSailState(meta.sail)
  const names = namesFromEventFile(meta?.sails)
  if (!names.length) return null
  // Up, and therefore aboard — normaliseSailState makes that inference for us,
  // and it is the only thing the file lets us say for certain.
  return normaliseSailState({ up: names.map((name) => ({ id: null, name })) })
}

/** The event file's sails-up list: plain names, forgiving about the junk a
 *  parsed XML attribute can turn out to be. */
function namesFromEventFile(raw: unknown): string[] {
  const out: string[] = []
  for (const v of Array.isArray(raw) ? raw : []) {
    // A sail row can come through as an object with a name on it as easily as
    // a string, depending on which part of the file it was read from.
    const name = typeof v === 'string' ? v : String((v as { name?: unknown } | null)?.name ?? '')
    const t = name.trim()
    if (t) out.push(t)
  }
  return out
}

const ref = (s: SailRef): SailRef => ({ id: s.id ?? null, name: s.name })

/** Did this tag actually SAY what was on the boat, or is its on-board list just
 *  an inference from what was up? The event file only ever records sails up, so
 *  every detected change falls in the second camp. */
function statesOnBoard(tag: TagEvent): boolean {
  const raw = (tag.meta as Record<string, unknown> | null)?.sail as { onBoard?: unknown } | undefined
  return Array.isArray(raw?.onBoard) && raw.onBoard.length > 0
}

export interface SailChange {
  tag: TagEvent
  state: SailState
  /** The crew said what was aboard here, rather than it being read off `up`. */
  statedOnBoard: boolean
}

/** Sail-change tags that carry a state, oldest first. */
export function sailChanges(tags: readonly TagEvent[]): SailChange[] {
  return tags
    .map((tag) => ({ tag, state: stateOf(tag), statedOnBoard: statesOnBoard(tag) }))
    .filter((x): x is SailChange => !!x.state)
    .sort((a, b) => a.tag.t0 - b.tag.t0)
}

/**
 * Fold the day up to an instant, CARRYING THE DECK FORWARD.
 *
 * What is aboard changes when somebody passes a sail across to the RIB, and
 * that is rare — twice a day at most. What is UP changes constantly. So the
 * on-board list is sticky: once the crew have said what is on the boat, it
 * stays said until they say otherwise.
 *
 * Without this, one detected sail change wipes it. The event file records only
 * the sails UP, so a detected change's on-board list is an inference from that
 * — and folding it in as fact would say the crew threw four sails overboard at
 * 12:15 because Expedition logged a headsail swap. Everything downstream reads
 * that as the weight aboard.
 *
 * Hoisting still puts a sail aboard: you cannot hoist one from the RIB.
 */
function foldTo(
  tags: readonly TagEvent[],
  utc: number
): { state: SailState; change: SailChange | null } {
  let aboard: SailRef[] = []
  let state = EMPTY_SAIL_STATE
  let change: SailChange | null = null

  for (const c of sailChanges(tags)) {
    if (c.tag.t0 > utc) break
    if (c.statedOnBoard) {
      aboard = c.state.onBoard.map(ref)
    } else {
      // Carry the deck; anything newly hoisted is on it by definition. Matched
      // across sources — the file's "Main" is the inventory's "Main", and
      // matching on the id alone puts it aboard a second time.
      for (const s of c.state.up) {
        if (!aboard.some((x) => sameSailAcrossSources(x, s))) aboard = [...aboard, ref(s)]
      }
    }
    state = { ...c.state, onBoard: aboard }
    change = { ...c, state }
  }
  return { state, change }
}

/**
 * What was up at `utc` — the last change AT OR BEFORE it.
 *
 * At or before, not nearest: a change at 12:31 says nothing about 12:30, and
 * snapping backwards from the nearest tag would have the boat flying a kite it
 * had not hoisted yet.
 */
export function sailStateAt(tags: readonly TagEvent[], utc: number): SailState {
  return foldTo(tags, utc).state
}

/**
 * Has anybody said what is on the boat today?
 *
 * False means every on-board list in the day is an inference from the sails up
 * — which is what the event file gives and what the weight aboard would then be
 * computed from. It is the difference between a real figure and a floor.
 */
export const hasStatedDeck = (tags: readonly TagEvent[]): boolean =>
  sailChanges(tags).some((c) => c.statedOnBoard)

/** The change immediately before `utc`, for "carried over from 11:40". */
export function lastChangeBefore(
  tags: readonly TagEvent[],
  utc: number
): SailChange | null {
  // The FOLDED state, not the tag's own: the composer seeds its "previous" from
  // this, and seeding from a detected change's raw state would hand the crew a
  // deck with four sails missing from it.
  return foldTo(tags, utc).change
}

/**
 * Hoist or drop one sail.
 *
 * Hoisting also puts the sail ABOARD, because it just was: a sail cannot go up
 * from the RIB, and making the crew tick two boxes to record one act is how a
 * boat ends up with a weight figure that does not include the kite that is
 * flying. Dropping leaves it aboard — a dropped sail is still on the boat.
 */
export function toggleUp(state: SailState, sail: SailRef): SailState {
  const on = isUp(state, sail)
  if (on) return { ...state, up: state.up.filter((s) => !sameSail(s, sail)) }
  return {
    ...state,
    up: [...state.up, ref(sail)],
    onBoard: isOnBoard(state, sail) ? state.onBoard : [...state.onBoard, ref(sail)],
  }
}

/**
 * Put a sail on the boat, or pass it back to the RIB.
 *
 * Passing one across takes it down first. A sail in the RIB that the app still
 * believes is hoisted is not a state the boat can be in, and it would carry
 * forward through every later change.
 */
export function toggleOnBoard(state: SailState, sail: SailRef): SailState {
  const aboard = isOnBoard(state, sail)
  if (!aboard) return { ...state, onBoard: [...state.onBoard, ref(sail)] }
  return {
    ...state,
    onBoard: state.onBoard.filter((s) => !sameSail(s, sail)),
    up: state.up.filter((s) => !sameSail(s, sail)),
  }
}

export const isUp = (state: SailState, sail: SailRef): boolean =>
  state.up.some((s) => sameSail(s, sail))

export const isOnBoard = (state: SailState, sail: SailRef): boolean =>
  state.onBoard.some((s) => sameSail(s, sail))

/**
 * What is aboard weighs something — the figure that goes on a weigh-in sheet.
 *
 * null when no sail aboard has a known weight, because "0.0 kg" next to a deck
 * full of sails reads as a measurement rather than as a gap. A PARTIAL total is
 * returned with a count of what is missing, so a crew can see it is short
 * rather than trusting a number that is quietly two sails light.
 */
export function weightAboard(
  state: SailState,
  weightOf: (s: SailRef) => number | null | undefined
): { kg: number; known: number; unknown: number } | null {
  let kg = 0, known = 0, unknown = 0
  for (const s of state.onBoard) {
    const w = weightOf(s)
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) { kg += w; known++ }
    else unknown++
  }
  if (!known) return null
  return { kg: Math.round(kg * 10) / 10, known, unknown }
}

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
  s.up.length === 0 && s.onBoard.length === 0 &&
  s.battens.every((b) => b.tension == null && !b.turns)

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
