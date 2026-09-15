import { describe, it, expect } from 'vitest'
import {
  SAIL_CHANGE_SLUG, EMPTY_SAIL_STATE, normaliseSailState, stateOf, sailChanges,
  sailStateAt, lastChangeBefore, toggleUp, isUp, setBatten, withBattenCount,
  stateIsEmpty, describeState, describeChange, sailKey,
  type SailState,
} from '../sailState'
import type { TagEvent } from '../types'

const T = (h: number, m: number) => Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)

let n = 0
const tag = (over: Partial<TagEvent>): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: SAIL_CHANGE_SLUG, label: 'Sail change', color: '#F59E0B',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(11, 0), t1: T(11, 0), autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'human', producer: 'user', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: null,
  ...over,
})

const withSail = (t0: number, state: Partial<SailState>, over: Partial<TagEvent> = {}) =>
  tag({ t0, t1: t0, meta: { sail: { up: [], battens: [], ...state } }, ...over })

const names = (s: SailState) => s.up.map((x) => x.name)

describe('normaliseSailState', () => {
  it('reads a stored state back', () => {
    const s = normaliseSailState({ up: [{ id: 's1', name: 'J2' }], battens: [{ no: 1, tension: 'soft', turns: 5 }] })
    expect(names(s)).toEqual(['J2'])
    expect(s.battens[0]).toEqual({ no: 1, tension: 'soft', turns: 5 })
  })

  it('drops a sail with no name — an unnamed sail is not a sail', () => {
    const s = normaliseSailState({ up: [{ id: 'x', name: '  ' }, { name: 'Main' }] })
    expect(names(s)).toEqual(['Main'])
  })

  it('de-duplicates, so a double tap cannot hoist the same sail twice', () => {
    const s = normaliseSailState({ up: [{ id: 's1', name: 'J2' }, { id: 's1', name: 'J2' }] })
    expect(s.up).toHaveLength(1)
  })

  it('sorts battens from the top and keeps negative turns', () => {
    const s = normaliseSailState({
      battens: [{ no: 3, tension: 'stiff', turns: -2 }, { no: 1, tension: 'soft', turns: 1 }],
    })
    expect(s.battens.map((b) => b.no)).toEqual([1, 3])
    expect(s.battens[1].turns).toBe(-2)
  })

  it('throws away an unknown stiffness but keeps the turns', () => {
    const s = normaliseSailState({ battens: [{ no: 1, tension: 'springy', turns: 4 }] })
    expect(s.battens[0]).toEqual({ no: 1, tension: null, turns: 4 })
  })

  it('drops a batten with no number, which has nowhere to go', () => {
    expect(normaliseSailState({ battens: [{ tension: 'soft', turns: 1 }] }).battens).toEqual([])
    expect(normaliseSailState({ battens: [{ no: 0, turns: 1 }] }).battens).toEqual([])
  })

  it('gives an empty state for junk rather than throwing', () => {
    for (const junk of [null, undefined, {}, 'no', 7, []]) {
      expect(normaliseSailState(junk)).toEqual({ up: [], battens: [] })
    }
  })
})

describe('stateOf', () => {
  it('reads a sail-change tag', () => {
    expect(names(stateOf(withSail(T(11, 40), { up: [{ name: 'J2' }] }))!)).toEqual(['J2'])
  })

  it('ignores a tag that is not a sail change', () => {
    expect(stateOf(withSail(T(11, 40), { up: [{ name: 'J2' }] }, { slug: 'incident' }))).toBeNull()
  })

  it('ignores a tag with no sail meta', () => {
    expect(stateOf(tag({ meta: { raceNum: 1 } }))).toBeNull()
    expect(stateOf(tag({ meta: null }))).toBeNull()
  })

  it('ignores a REJECTED change — a state somebody threw away is not the state', () => {
    expect(stateOf(withSail(T(11, 40), { up: [{ name: 'J2' }] }, { rejected: true }))).toBeNull()
  })
})

describe('sailStateAt', () => {
  const day = [
    withSail(T(11, 40), { up: [{ name: 'Main' }, { name: 'J2' }] }),
    withSail(T(12, 20), { up: [{ name: 'Main' }, { name: 'A2' }] }),
    withSail(T(12, 50), { up: [{ name: 'Main' }, { name: 'J2' }] }),
    tag({ t0: T(12, 30), slug: 'incident', meta: null }),   // noise
  ]

  it('is the last change at or before the instant', () => {
    expect(names(sailStateAt(day, T(12, 30)))).toEqual(['Main', 'A2'])
    expect(names(sailStateAt(day, T(13, 0)))).toEqual(['Main', 'J2'])
  })

  it('counts a change AT the instant — the tag is the moment it took effect', () => {
    expect(names(sailStateAt(day, T(12, 20)))).toEqual(['Main', 'A2'])
  })

  it('never looks forward: before the first change nothing is up', () => {
    expect(sailStateAt(day, T(11, 0))).toEqual(EMPTY_SAIL_STATE)
  })

  it('does not care what order the tags arrive in', () => {
    expect(names(sailStateAt([...day].reverse(), T(12, 30)))).toEqual(['Main', 'A2'])
  })

  it('skips a rejected change and falls back to the one before it', () => {
    const withBad = [...day, withSail(T(12, 40), { up: [{ name: 'Nothing' }] }, { rejected: true })]
    expect(names(sailStateAt(withBad, T(12, 45)))).toEqual(['Main', 'A2'])
  })
})

describe('lastChangeBefore', () => {
  const day = [
    withSail(T(11, 40), { up: [{ name: 'J2' }] }),
    withSail(T(12, 20), { up: [{ name: 'A2' }] }),
  ]

  it('hands back the tag as well as the state, so the UI can say when', () => {
    const c = lastChangeBefore(day, T(12, 30))!
    expect(c.tag.t0).toBe(T(12, 20))
    expect(names(c.state)).toEqual(['A2'])
  })

  it('is null before the first change', () => {
    expect(lastChangeBefore(day, T(10, 0))).toBeNull()
  })
})

describe('toggleUp / isUp', () => {
  const base: SailState = { up: [{ id: 's1', name: 'Main' }], battens: [] }

  it('hoists a sail that was not up', () => {
    const next = toggleUp(base, { id: 's2', name: 'J2' })
    expect(names(next)).toEqual(['Main', 'J2'])
    expect(isUp(next, { id: 's2', name: 'J2' })).toBe(true)
  })

  it('drops one that was', () => {
    expect(names(toggleUp(base, { id: 's1', name: 'Main' }))).toEqual([])
  })

  it('matches on inventory id even when the name has been edited since', () => {
    expect(names(toggleUp(base, { id: 's1', name: 'Main (old)' }))).toEqual([])
  })

  it('matches a typed sail by name, case-insensitively', () => {
    const typed: SailState = { up: [{ name: 'Storm jib' }], battens: [] }
    expect(names(toggleUp(typed, { name: 'STORM JIB' }))).toEqual([])
  })

  it('does not mutate what it was given', () => {
    toggleUp(base, { id: 's2', name: 'J2' })
    expect(base.up).toHaveLength(1)
  })
})

describe('setBatten / withBattenCount', () => {
  it('sets one batten and leaves the others', () => {
    let s: SailState = { up: [], battens: [{ no: 1, tension: 'soft', turns: 1 }] }
    s = setBatten(s, 2, { tension: 'stiff', turns: -3 })
    expect(s.battens).toEqual([
      { no: 1, tension: 'soft', turns: 1 },
      { no: 2, tension: 'stiff', turns: -3 },
    ])
  })

  it('patches one field without clearing the other', () => {
    let s: SailState = { up: [], battens: [{ no: 1, tension: 'soft', turns: 4 }] }
    s = setBatten(s, 1, { turns: 6 })
    expect(s.battens[0]).toEqual({ no: 1, tension: 'soft', turns: 6 })
    s = setBatten(s, 1, { tension: 'stiff' })
    expect(s.battens[0]).toEqual({ no: 1, tension: 'stiff', turns: 6 })
  })

  it('can clear a stiffness explicitly', () => {
    let s: SailState = { up: [], battens: [{ no: 1, tension: 'soft', turns: 4 }] }
    s = setBatten(s, 1, { tension: null })
    expect(s.battens[0].tension).toBeNull()
  })

  it('grows to the main’s batten count, keeping what was set', () => {
    const s = withBattenCount({ up: [], battens: [{ no: 2, tension: 'soft', turns: 2 }] }, 3)
    expect(s.battens.map((b) => b.no)).toEqual([1, 2, 3])
    expect(s.battens[1].tension).toBe('soft')
  })

  it('trims when a main loses a batten', () => {
    const s = withBattenCount({ up: [], battens: [{ no: 1, tension: 'soft', turns: 1 }, { no: 2, tension: 'stiff', turns: 2 }] }, 1)
    expect(s.battens.map((b) => b.no)).toEqual([1])
  })
})

describe('stateIsEmpty', () => {
  it('is true for nothing recorded, even with blank batten rows present', () => {
    expect(stateIsEmpty(withBattenCount(EMPTY_SAIL_STATE, 3))).toBe(true)
  })

  it('is false once anything is set', () => {
    expect(stateIsEmpty({ up: [{ name: 'J2' }], battens: [] })).toBe(false)
    expect(stateIsEmpty({ up: [], battens: [{ no: 1, tension: null, turns: -1 }] })).toBe(false)
  })
})

describe('describeState', () => {
  it('reads like the tag label already does', () => {
    expect(describeState({ up: [{ name: 'Main' }, { name: 'J2' }], battens: [] })).toBe('Main + J2')
  })

  it('says a drop is a drop, rather than rendering as nothing', () => {
    expect(describeState(EMPTY_SAIL_STATE)).toBe('All down')
  })
})

describe('describeChange', () => {
  const before: SailState = { up: [{ name: 'Main' }, { name: 'J2' }], battens: [] }

  it('names what went up and what came down', () => {
    expect(describeChange(before, { up: [{ name: 'Main' }, { name: 'A2' }], battens: [] }))
      .toBe('+A2 −J2')
  })

  it('names a hoist alone', () => {
    expect(describeChange(before, { up: [{ name: 'Main' }, { name: 'J2' }, { name: 'A2' }], battens: [] }))
      .toBe('+A2')
  })

  it('falls back to the full state for the first change of the day', () => {
    expect(describeChange(null, before)).toBe('Main + J2')
  })

  it('falls back to the full state when the sails did not actually change', () => {
    expect(describeChange(before, { ...before, battens: [{ no: 1, tension: 'stiff', turns: 2 }] }))
      .toBe('Main + J2')
  })
})

describe('sailKey', () => {
  it('prefers the inventory id, so a rename does not fork the sail', () => {
    expect(sailKey({ id: 'abc', name: 'J2' })).toBe(sailKey({ id: 'abc', name: 'J2 (2026)' }))
  })

  it('falls back to the name for a typed sail', () => {
    expect(sailKey({ name: ' Storm Jib ' })).toBe('storm jib')
  })
})

describe('sailChanges', () => {
  it('returns only the tags carrying a state, oldest first', () => {
    const list = sailChanges([
      withSail(T(12, 20), { up: [{ name: 'A2' }] }),
      tag({ t0: T(11, 0), slug: 'incident' }),
      withSail(T(11, 40), { up: [{ name: 'J2' }] }),
    ])
    expect(list.map((c) => c.tag.t0)).toEqual([T(11, 40), T(12, 20)])
  })
})
