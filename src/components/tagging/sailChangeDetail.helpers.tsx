'use client'
import * as React from 'react'
import SailChangeDetail from './SailChangeDetail'
import type { ComposerDetail } from './TagComposer'
import type { SheetDetail } from './TagSheet'
import {
  SAIL_CHANGE_SLUG, sailStateAt, lastChangeBefore, describeState, describeChange,
  stateIsEmpty, stateOf, EMPTY_SAIL_STATE, type SailState, type SailRef,
} from '@/lib/tagging/sailState'
import { cardForSail, type BattenCard, type SailBattenCard } from '@/lib/battens'
import type { TagDef, TagEvent } from '@/lib/tagging/types'

// Everything the sail-change composer needs, fetched once per boat/day and
// turned into the ComposerDetail the button bar hands to TagComposer.
//
// Kept out of TaggerTab because it is three network calls and a fold over the
// day's tags, and out of SailChangeDetail because that component should be
// givable fixture data and screenshotted without a session.

export interface SailContext {
  inventory: SailRef[]
  /** Kg per inventory id, from the event file's sail list (sails.specs). */
  weights: Record<string, number>
  /** The day's sail list — everything that went on the water, RIB included. */
  dayList: SailRef[]
  /** Every batten card the boat has, one per mainsail. */
  battenCards: SailBattenCard[]
  /** Which inventory ids are mainsails, so the batten tab knows whose card to
   *  show when the crew changes what is up. */
  mainsailIds: string[]
  loading: boolean
  /** Re-read the boat's inventory — after sails have been added to it, so the
   *  day's tags link to the rows that now exist. */
  reload: () => void
}

export function useSailContext(
  teamId?: string | null,
  boatId?: string | null,
  date?: string | null
): SailContext {
  const [inventory, setInventory] = React.useState<SailRef[]>([])
  const [mainsailIds, setMainsailIds] = React.useState<string[]>([])
  const [dayList, setDayList] = React.useState<SailRef[]>([])
  const [weights, setWeights] = React.useState<Record<string, number>>({})
  const [battenCards, setBattenCards] = React.useState<SailBattenCard[]>([])
  const [loading, setLoading] = React.useState(false)
  // Bumped to re-read the boat's inventory without changing boat or day.
  const [gen, setGen] = React.useState(0)

  // The inventory and the batten cards belong to the BOAT, so they survive a
  // change of day; only the sail list is reloaded when the date moves.
  React.useEffect(() => {
    if (!teamId || !boatId) { setInventory([]); setMainsailIds([]); setBattenCards([]); setWeights({}); return }
    let live = true
    Promise.all([
      fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`)
        .then((r) => (r.ok ? r.json() : { sails: [] }))
        .catch(() => ({ sails: [] })),
      fetch(`/api/teams/${teamId}/boats/${boatId}/battens`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([sails, battens]) => {
      if (!live) return
      const active = (sails?.sails || []).filter((s: { retired?: boolean }) => !s.retired)
      setInventory(active.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })))
      setMainsailIds(
        active.filter((s: { kind?: string }) => s.kind === 'mainsail').map((s: { id: string }) => s.id)
      )
      // Weights come from the event file's sail list, kept under specs by the
      // sails import. A boat that has never imported one simply has none, and
      // the On board tab shows a count without a total rather than a zero.
      const w: Record<string, number> = {}
      for (const s of active as { id: string; specs?: { weight_kg?: unknown } }[]) {
        const kg = s.specs?.weight_kg
        if (typeof kg === 'number' && Number.isFinite(kg) && kg > 0) w[s.id] = kg
      }
      setWeights(w)
      setBattenCards((battens?.cards || []) as SailBattenCard[])
    })
    return () => { live = false }
  }, [teamId, boatId, gen])

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setDayList([]); return }
    let live = true
    setLoading(true)
    fetch(`/api/teams/${teamId}/boats/${boatId}/campaign/conditions?date=${date}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        if (!live) return
        const sl = (j as { sailList?: { sails?: unknown } } | null)?.sailList
        const list = Array.isArray(sl?.sails) ? sl.sails : []
        setDayList(
          list
            .filter((s: { name?: string }) => s?.name)
            .map((s: { id?: string; name: string }) => ({ id: s.id ?? null, name: s.name }))
        )
      })
      .catch(() => { if (live) setDayList([]) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [teamId, boatId, date])

  return {
    inventory, mainsailIds, weights, dayList, battenCards, loading,
    reload: React.useCallback(() => setGen((n) => n + 1), []),
  }
}

/**
 * The card for whichever main is up.
 *
 * Follows the sails, not the boat: on a day that starts with the delivery main
 * and changes to the race main, the batten tab has to change with it or it is
 * suggesting the wrong numbers at exactly the moment they are being set. When
 * two mains are somehow up, or none is, the boat's only card is the best
 * available answer — and when there is more than one, no answer is better than
 * a coin toss.
 */
export function battenCardFor(
  ctx: SailContext,
  state: SailState
): { card: BattenCard | null; sailName: string | null } {
  const upMain = state.up.find((s) => s.id && ctx.mainsailIds.includes(s.id))
  const own = cardForSail(ctx.battenCards, upMain?.id)
  if (own) return { card: own, sailName: upMain?.name ?? null }

  // No main up, or the one that is has no card of its own. A boat with exactly
  // one card has only one possible answer; with two, a plausible-looking wrong
  // number is worse than none at all.
  const assigned = ctx.battenCards.filter((c) => c.sailId != null)
  if (assigned.length !== 1) return { card: null, sailName: null }
  const name = ctx.inventory.find((s) => s.id === assigned[0].sailId)?.name ?? null
  return { card: assigned[0].card, sailName: name }
}

/** True wind speed at an instant, from the day's log. */
export function twsAt(rows: { utc: number; tws?: number | null }[] | null | undefined, utc: number): number | null {
  const list = rows || []
  if (!list.length || !Number.isFinite(utc)) return null
  let lo = 0, hi = list.length - 1
  if (utc <= list[0].utc) return num(list[0].tws)
  if (utc >= list[hi].utc) return num(list[hi].tws)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (list[mid].utc <= utc) lo = mid
    else hi = mid
  }
  // Nearest sample, not an interpolation: this picks a five-knot-wide band, and
  // no band boundary has ever turned on a tenth of a knot.
  const pick = utc - list[lo].utc <= list[hi].utc - utc ? list[lo] : list[hi]
  return num(pick.tws)
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * The sail-change detail, for one press.
 *
 * Seeded from what was already up at that instant, so a change is an EDIT of the
 * current state rather than a blank form — which is both less typing and the
 * thing that makes "+A2 −J2" derivable.
 */
export function sailDetail(args: {
  def: TagDef
  events: TagEvent[]
  ctx: SailContext
  logRows?: { utc: number; tws?: number | null }[] | null
  tzOffsetMin?: number
  onEditSailList?: () => void
  /** Which tab the composer opens on — the day-start prompt asks about the
   *  deck, not about what is up. */
  startPane?: 'up' | 'onboard' | 'battens'
}): ComposerDetail<SailState> | null {
  const { def, events, ctx, logRows, tzOffsetMin, onEditSailList, startPane } = args
  if (def.slug !== SAIL_CHANGE_SLUG) return null

  return {
    initial: (at) => sailStateAt(events, at),

    render: (value, onChange, at) => {
      const prev = lastChangeBefore(events, at)
      return (
        <SailChangeDetail
          value={value}
          onChange={onChange}
          inventory={ctx.inventory}
          dayList={ctx.dayList}
          weightOf={(s) => (s.id ? ctx.weights[s.id] ?? null : null)}
          previous={prev ? { state: prev.state, utc: prev.tag.t0 } : null}
          battenCard={battenCardFor(ctx, value).card}
          battenCardSail={battenCardFor(ctx, value).sailName}
          twsKn={twsAt(logRows, at)}
          tzOffsetMin={tzOffsetMin}
          onEditSailList={onEditSailList}
          startPane={startPane}
        />
      )
    },

    toPayload: (value, at) => {
      // What was up immediately before decides how this change reads. Read at
      // SAVE time, not at the press, because the crew may have nudged the time
      // back across an earlier change while the sheet was open — and then
      // "+A2 −J2" would be describing the wrong pair of states.
      const before = lastChangeBefore(events, at - 1) ?? null
      return {
        // The label is what the day's list shows. "Main + J2" is the answer to
        // the question people scan the list asking; "Sail change" nine times is
        // not. The definition still owns the slug, the colour and the gating.
        label: describeState(value),
        // The note falls back to what actually changed — "+A2 −J2" — which is
        // the line a debrief wants and nobody would type nine times a day.
        note: describeChange(before?.state ?? null, value),
        meta: { sail: value },
        labels: kindOfChange(before?.state ?? null, value),
      }
    },

    // A change that records nothing is not a change. Without this the button
    // quietly writes an empty tag that reads "All down".
    isIncomplete: (value) => stateIsEmpty(value),
  }
}

/**
 * Which of the existing "Change" descriptors this is — hoist, drop or peel.
 *
 * Derived rather than asked for: the crew has already said what is up, and
 * making them then classify it is asking the same question twice. Uses the
 * vocabulary baseTags.ts already gives the sail-change definition, so the result
 * filters alongside every hand-set descriptor.
 */
export function kindOfChange(
  before: SailState | null,
  after: SailState
): { group: string; text: string }[] {
  const was = new Set((before?.up || []).map((s) => (s.id || s.name).toLowerCase()))
  const now = new Set(after.up.map((s) => (s.id || s.name).toLowerCase()))
  const added = Array.from(now).some((k) => !was.has(k))
  const removed = Array.from(was).some((k) => !now.has(k))
  if (added && removed) return [{ group: 'Change', text: 'peel' }]
  if (added) return [{ group: 'Change', text: 'hoist' }]
  if (removed) return [{ group: 'Change', text: 'drop' }]
  return []
}

/** "+A2 −J2" for the note, given what was up before. Exported for the tests. */
export function changeNote(events: TagEvent[], at: number, after: SailState): string {
  const prev = lastChangeBefore(events, at)
  return describeChange(prev?.state ?? null, after)
}

/**
 * The same sail detail, for a tag that ALREADY EXISTS.
 *
 * Opening a sail change from the track and finding no way to say which sails
 * were up was the gap this fills: the composer only ever appeared on the way
 * IN, so a change entered in a hurry — or one the event file wrote — could
 * never be corrected without deleting it and starting again.
 *
 * Seeded from the tag's own state, which falls back to the event file's list
 * (see sailState.stateOf), so reopening an auto-detected change starts from
 * what Expedition recorded rather than from an empty deck.
 *
 * The derived fields are only REWRITTEN while they are still derived. A crew
 * that has renamed the tag or typed their own note has said something, and a
 * sail edit is not permission to throw it away.
 */
export function sailSheetDetail(args: {
  tag: TagEvent
  events: TagEvent[]
  ctx: SailContext
  logRows?: { utc: number; tws?: number | null }[] | null
  tzOffsetMin?: number
  onEditSailList?: () => void
}): SheetDetail<SailState> | null {
  const { tag, events, ctx, logRows, tzOffsetMin, onEditSailList } = args
  if (tag.slug !== SAIL_CHANGE_SLUG) return null

  const before = lastChangeBefore(events.filter((e) => e.id !== tag.id), tag.t0 - 1)?.state ?? null
  // What this tag RECORDED, for deciding whether its label and note are still
  // derived. Not what to show — see below.
  const was = stateOf(tag)
  // What the boat was actually carrying here: this tag's sails up, on the deck
  // carried forward from wherever somebody last stated one. Seeding from `was`
  // showed whatever the single tag happened to know, which for a detected
  // change is only the sails up — so a day with eleven sails aboard opened at
  // 12:51 and offered three.
  const seed = sailStateAt(events, tag.t0)

  return {
    initial: () => (was || seed.up.length ? seed : EMPTY_SAIL_STATE),

    render: (value, onChange, at) => (
      <SailChangeDetail
        value={value}
        onChange={onChange}
        inventory={ctx.inventory}
        dayList={ctx.dayList}
        weightOf={(s) => (s.id ? ctx.weights[s.id] ?? null : null)}
        previous={before ? { state: before, utc: at } : null}
        battenCard={battenCardFor(ctx, value).card}
        battenCardSail={battenCardFor(ctx, value).sailName}
        twsKn={twsAt(logRows, at)}
        tzOffsetMin={tzOffsetMin}
        onEditSailList={onEditSailList}
      />
    ),

    toPatch: (value) => {
      const patch: {
        label?: string
        note?: string | null
        labels?: { group: string; text: string }[]
        meta?: Record<string, unknown>
      } = { meta: { sail: value } }

      // Keep deriving the label unless a human has CLAIMED it. `editedFields`
      // is the app's existing answer to exactly this question — the sync uses
      // it to decide what it may overwrite — so a rename made through the sheet
      // survives, and a label that was only ever derived ("Sails changed", from
      // the event file) is brought up to date instead of contradicting the
      // sails underneath it.
      if (!(tag.editedFields || []).includes('label')) patch.label = describeState(value)

      const derivedNote = was ? describeChange(before, was) : null
      const currentNote = (tag.note ?? '').trim()
      if (!currentNote || (derivedNote && currentNote === derivedNote)) {
        patch.note = describeChange(before, value)
      }

      // Descriptors: replace the derived Change descriptor, leave every other
      // group alone — a crew's own "Quality: scrappy" is not ours to drop.
      const kept = (tag.labels || []).filter((l) => l.group !== 'Change')
      patch.labels = [...kept, ...kindOfChange(before, value)]

      return patch
    },

    isIncomplete: (value) => stateIsEmpty(value),
  }
}
