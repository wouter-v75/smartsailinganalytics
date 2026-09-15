'use client'
import * as React from 'react'
import SailChangeDetail from './SailChangeDetail'
import type { ComposerDetail } from './TagComposer'
import {
  SAIL_CHANGE_SLUG, sailStateAt, lastChangeBefore, describeState, describeChange,
  stateIsEmpty, type SailState, type SailRef,
} from '@/lib/tagging/sailState'
import { normaliseBattenCard, type BattenCard } from '@/lib/battens'
import type { TagDef, TagEvent } from '@/lib/tagging/types'

// Everything the sail-change composer needs, fetched once per boat/day and
// turned into the ComposerDetail the button bar hands to TagComposer.
//
// Kept out of TaggerTab because it is three network calls and a fold over the
// day's tags, and out of SailChangeDetail because that component should be
// givable fixture data and screenshotted without a session.

export interface SailContext {
  inventory: SailRef[]
  onBoard: SailRef[]
  battenCard: BattenCard | null
  loading: boolean
}

export function useSailContext(
  teamId?: string | null,
  boatId?: string | null,
  date?: string | null
): SailContext {
  const [inventory, setInventory] = React.useState<SailRef[]>([])
  const [onBoard, setOnBoard] = React.useState<SailRef[]>([])
  const [battenCard, setBattenCard] = React.useState<BattenCard | null>(null)
  const [loading, setLoading] = React.useState(false)

  // Inventory and the batten card belong to the BOAT, so they survive a change
  // of day; only the sail list is reloaded when the date moves.
  React.useEffect(() => {
    if (!teamId || !boatId) { setInventory([]); setBattenCard(null); return }
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
      setInventory(
        (sails?.sails || [])
          .filter((s: { retired?: boolean }) => !s.retired)
          .map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }))
      )
      setBattenCard(battens?.card ? normaliseBattenCard(battens.card) : null)
    })
    return () => { live = false }
  }, [teamId, boatId])

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setOnBoard([]); return }
    let live = true
    setLoading(true)
    fetch(`/api/teams/${teamId}/boats/${boatId}/campaign/conditions?date=${date}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        if (!live) return
        const sl = (j as { sailList?: { sails?: unknown } } | null)?.sailList
        const list = Array.isArray(sl?.sails) ? sl.sails : []
        setOnBoard(
          list
            .filter((s: { name?: string }) => s?.name)
            .map((s: { id?: string; name: string }) => ({ id: s.id ?? null, name: s.name }))
        )
      })
      .catch(() => { if (live) setOnBoard([]) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [teamId, boatId, date])

  return { inventory, onBoard, battenCard, loading }
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
}): ComposerDetail<SailState> | null {
  const { def, events, ctx, logRows, tzOffsetMin, onEditSailList } = args
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
          onBoard={ctx.onBoard}
          previous={prev ? { state: prev.state, utc: prev.tag.t0 } : null}
          battenCard={ctx.battenCard}
          twsKn={twsAt(logRows, at)}
          tzOffsetMin={tzOffsetMin}
          onEditSailList={onEditSailList}
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
