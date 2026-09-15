import { describe, it, expect } from 'vitest'
import { sailSheetDetail } from '../sailChangeDetail.helpers'
import type { SailContext } from '../sailChangeDetail.helpers'
import { SAIL_CHANGE_SLUG, type SailState } from '@/lib/tagging/sailState'
import type { TagEvent } from '@/lib/tagging/types'

// Re-opening a sail change and correcting what was up.
//
// The danger here is not the sails — it is everything DERIVED from them. The
// label, the note and the Change descriptor are all computed from the state at
// the moment the tag is made, and a crew that has since renamed the tag or
// typed their own note has said something that a sail edit is not permission to
// throw away.

const T = (h: number, m: number) => Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)

let n = 0
const tag = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: SAIL_CHANGE_SLUG, label: 'Sail change', color: '#F59E0B',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(12, 0), t1: T(12, 0), autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'human', producer: 'user', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: null,
  ...over,
})

const ref = (name: string, id?: string) => ({ id: id ?? null, name })
const state = (up: string[], onBoard = up): SailState => ({
  up: up.map((s) => ref(s)), onBoard: onBoard.map((s) => ref(s)), battens: [],
})
const withState = (s: SailState, over: Partial<TagEvent> = {}) =>
  tag({ meta: { sail: s }, ...over })

const ctx: SailContext = {
  inventory: [ref('Main', 'i1'), ref('J2', 'i3'), ref('A2', 'i5')],
  weights: {}, dayList: [ref('Main', 'i1'), ref('J2', 'i3'), ref('A2', 'i5')],
  battenCards: [], mainsailIds: ['i1'], loading: false,
}

const detailFor = (t: TagEvent, events: TagEvent[] = []) =>
  sailSheetDetail({ tag: t, events: [t, ...events], ctx })!

describe('which tags get one', () => {
  it('is a sail change and nothing else', () => {
    expect(sailSheetDetail({ tag: tag({ slug: 'tack', label: 'Tack' }), events: [], ctx })).toBeNull()
    expect(sailSheetDetail({ tag: tag(), events: [], ctx })).not.toBeNull()
  })
})

describe('what it starts from', () => {
  it('starts from what the tag says was up', () => {
    const d = detailFor(withState(state(['Main', 'J2'])))
    expect(d.initial().up.map((s) => s.name)).toEqual(['Main', 'J2'])
  })

  it('starts from the EVENT FILE for a change nobody opened', () => {
    // Otherwise reopening an auto-detected change begins from an empty deck and
    // the crew has to retype what Expedition already recorded.
    const d = detailFor(tag({ source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J4'] } }))
    expect(d.initial().up.map((s) => s.name)).toEqual(['Main', 'J4'])
  })

  it('starts empty when nothing is known, rather than throwing', () => {
    expect(detailFor(tag()).initial().up).toEqual([])
  })
})

describe('what it writes back', () => {
  it('carries the whole state into meta', () => {
    const t = withState(state(['Main', 'J2']))
    const p = detailFor(t).toPatch(state(['Main', 'A2']), t.t0)
    expect((p.meta as { sail: SailState }).sail.up.map((s) => s.name)).toEqual(['Main', 'A2'])
  })

  it('keeps deriving the label while nobody has claimed it', () => {
    const t = withState(state(['Main', 'J2']), { label: 'Main + J2' })
    expect(detailFor(t).toPatch(state(['Main', 'A2']), t.t0).label).toBe('Main + A2')
  })

  it('brings an event file’s own wording up to date', () => {
    // "Sails changed" was never anybody's choice, and leaving it there after a
    // correction leaves the label contradicting the sails underneath it.
    const t = tag({ label: 'Sails changed', source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J4'] } })
    expect(detailFor(t).toPatch(state(['Main', 'A2']), t.t0).label).toBe('Main + A2')
  })

  it('leaves a label somebody renamed alone', () => {
    // editedFields is the app's existing record of what a human has claimed —
    // the same thing the sync consults before overwriting anything.
    const t = withState(state(['Main', 'J2']), { label: 'The bad peel', editedFields: ['label'] })
    expect(detailFor(t).toPatch(state(['Main', 'A2']), t.t0).label).toBeUndefined()
  })

  it('leaves a note somebody typed alone', () => {
    const t = withState(state(['Main', 'J2']), { note: 'Halyard was not clear.' })
    expect(detailFor(t).toPatch(state(['Main', 'A2']), t.t0).note).toBeUndefined()
  })

  it('rewrites a note that is still the derived one', () => {
    const before = withState(state(['Main', 'J2']), { t0: T(11, 30), t1: T(11, 30) })
    const t = withState(state(['Main', 'A2']), { note: '+A2 −J2' })
    const p = sailSheetDetail({ tag: t, events: [before, t], ctx })!.toPatch(state(['Main', 'J2']), t.t0)
    // Corrected back to what was already up: nothing hoisted, nothing dropped,
    // so the note reads as the state rather than as an empty delta.
    expect(p.note).toBe('Main + J2')
  })

  it('fills an empty note rather than leaving the tag silent', () => {
    const before = withState(state(['Main', 'J2']), { t0: T(11, 30), t1: T(11, 30) })
    const t = withState(state(['Main', 'J2']), { note: null })
    const p = sailSheetDetail({ tag: t, events: [before, t], ctx })!.toPatch(state(['Main', 'A2']), t.t0)
    expect(p.note).toBe('+A2 −J2')
  })

  it('replaces the derived Change descriptor and keeps every other group', () => {
    // A crew's own "Quality: scrappy" is not ours to drop because the sails moved.
    const t = withState(state(['Main']), {
      labels: [{ group: 'Change', text: 'drop' }, { group: 'Quality', text: 'scrappy' }],
    })
    const p = detailFor(t).toPatch(state(['Main', 'A2']), t.t0)
    expect(p.labels).toEqual([{ group: 'Quality', text: 'scrappy' }, { group: 'Change', text: 'hoist' }])
  })

  it('does not read the tag being edited as its own predecessor', () => {
    // lastChangeBefore over a list that includes this tag would compare the new
    // state with the old state OF THE SAME TAG, and "+A2 −J2" would describe a
    // change that never happened between two different moments.
    const earlier = withState(state(['Main', 'J2']), { t0: T(11, 0), t1: T(11, 0) })
    const t = withState(state(['Main', 'J2']), { t0: T(12, 0), t1: T(12, 0) })
    const p = sailSheetDetail({ tag: t, events: [earlier, t], ctx })!.toPatch(state(['Main', 'A2']), t.t0)
    expect(p.note).toBe('+A2 −J2')
  })
})

describe('an empty deck is not a change', () => {
  it('blocks saving nothing at all', () => {
    const d = detailFor(withState(state(['Main'])))
    expect(d.isIncomplete!({ up: [], onBoard: [], battens: [] })).toBe(true)
    expect(d.isIncomplete!(state(['Main']))).toBe(false)
  })
})
