import { describe, it, expect } from 'vitest'
import {
  SAIL_CHANGE_SLUG, EMPTY_SAIL_STATE, normaliseSailState, stateOf, sailChanges,
  sailStateAt, lastChangeBefore, toggleUp, isUp, setBatten, withBattenCount,
  stateIsEmpty, describeState, describeChange, sailKey,
  toggleOnBoard, isOnBoard, weightAboard,
  type SailState, type SailRef,
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
  tag({ t0, t1: t0, meta: { sail: { up: [], onBoard: [], battens: [], ...state } }, ...over })

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
      expect(normaliseSailState(junk)).toEqual({ up: [], onBoard: [], battens: [] })
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
  const base: SailState = {
    up: [{ id: 's1', name: 'Main' }],
    onBoard: [{ id: 's1', name: 'Main' }, { id: 's2', name: 'J2' }],
    battens: [],
  }

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
    const typed: SailState = { up: [{ name: 'Storm jib' }], onBoard: [{ name: 'Storm jib' }], battens: [] }
    expect(names(toggleUp(typed, { name: 'STORM JIB' }))).toEqual([])
  })

  it('does not mutate what it was given', () => {
    toggleUp(base, { id: 's2', name: 'J2' })
    expect(base.up).toHaveLength(1)
  })
})

describe('setBatten / withBattenCount', () => {
  it('sets one batten and leaves the others', () => {
    let s: SailState = { up: [], onBoard: [], battens: [{ no: 1, tension: 'soft', turns: 1 }] }
    s = setBatten(s, 2, { tension: 'stiff', turns: -3 })
    expect(s.battens).toEqual([
      { no: 1, tension: 'soft', turns: 1 },
      { no: 2, tension: 'stiff', turns: -3 },
    ])
  })

  it('patches one field without clearing the other', () => {
    let s: SailState = { up: [], onBoard: [], battens: [{ no: 1, tension: 'soft', turns: 4 }] }
    s = setBatten(s, 1, { turns: 6 })
    expect(s.battens[0]).toEqual({ no: 1, tension: 'soft', turns: 6 })
    s = setBatten(s, 1, { tension: 'stiff' })
    expect(s.battens[0]).toEqual({ no: 1, tension: 'stiff', turns: 6 })
  })

  it('can clear a stiffness explicitly', () => {
    let s: SailState = { up: [], onBoard: [], battens: [{ no: 1, tension: 'soft', turns: 4 }] }
    s = setBatten(s, 1, { tension: null })
    expect(s.battens[0].tension).toBeNull()
  })

  it('grows to the main’s batten count, keeping what was set', () => {
    const s = withBattenCount({ up: [], onBoard: [], battens: [{ no: 2, tension: 'soft', turns: 2 }] }, 3)
    expect(s.battens.map((b) => b.no)).toEqual([1, 2, 3])
    expect(s.battens[1].tension).toBe('soft')
  })

  it('trims when a main loses a batten', () => {
    const s = withBattenCount({ up: [], onBoard: [], battens: [{ no: 1, tension: 'soft', turns: 1 }, { no: 2, tension: 'stiff', turns: 2 }] }, 1)
    expect(s.battens.map((b) => b.no)).toEqual([1])
  })
})

describe('stateIsEmpty', () => {
  it('is true for nothing recorded, even with blank batten rows present', () => {
    expect(stateIsEmpty(withBattenCount(EMPTY_SAIL_STATE, 3))).toBe(true)
  })

  it('is false once anything is set', () => {
    expect(stateIsEmpty({ up: [{ name: 'J2' }], onBoard: [{ name: 'J2' }], battens: [] })).toBe(false)
    expect(stateIsEmpty({ up: [], onBoard: [{ name: 'J2' }], battens: [] })).toBe(false)
    expect(stateIsEmpty({ up: [], onBoard: [], battens: [{ no: 1, tension: null, turns: -1 }] })).toBe(false)
  })
})

describe('describeState', () => {
  it('reads like the tag label already does', () => {
    expect(describeState({ up: [{ name: 'Main' }, { name: 'J2' }], onBoard: [], battens: [] })).toBe('Main + J2')
  })

  it('says a drop is a drop, rather than rendering as nothing', () => {
    expect(describeState(EMPTY_SAIL_STATE)).toBe('All down')
  })
})

describe('describeChange', () => {
  const before: SailState = { up: [{ name: 'Main' }, { name: 'J2' }], onBoard: [], battens: [] }

  it('names what went up and what came down', () => {
    expect(describeChange(before, { up: [{ name: 'Main' }, { name: 'A2' }], onBoard: [], battens: [] }))
      .toBe('+A2 −J2')
  })

  it('names a hoist alone', () => {
    expect(describeChange(before, { up: [{ name: 'Main' }, { name: 'J2' }, { name: 'A2' }], onBoard: [], battens: [] }))
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

describe('on board — the sails actually on the boat', () => {
  const j2: SailRef = { id: 's2', name: 'J2' }
  const a2: SailRef = { id: 's3', name: 'A2' }
  const base: SailState = {
    up: [{ id: 's1', name: 'Main' }],
    onBoard: [{ id: 's1', name: 'Main' }, j2],
    battens: [],
  }

  it('knows what is aboard and what is in the RIB', () => {
    expect(isOnBoard(base, j2)).toBe(true)
    expect(isOnBoard(base, a2)).toBe(false)
  })

  it('passes a sail across from the RIB', () => {
    expect(toggleOnBoard(base, a2).onBoard.map((s) => s.name)).toEqual(['Main', 'J2', 'A2'])
  })

  it('passing a sail BACK to the RIB takes it down first', () => {
    // A sail in the RIB that the app still believes is hoisted is not a state
    // the boat can be in, and it would carry forward through every later change.
    const next = toggleOnBoard(base, { id: 's1', name: 'Main' })
    expect(next.onBoard.map((s) => s.name)).toEqual(['J2'])
    expect(next.up).toEqual([])
  })

  it('hoisting a sail puts it aboard — you cannot hoist from the RIB', () => {
    const next = toggleUp(base, a2)
    expect(next.up.map((s) => s.name)).toEqual(['Main', 'A2'])
    expect(next.onBoard.map((s) => s.name)).toEqual(['Main', 'J2', 'A2'])
  })

  it('dropping a sail leaves it aboard', () => {
    const next = toggleUp(base, { id: 's1', name: 'Main' })
    expect(next.up).toEqual([])
    expect(next.onBoard.map((s) => s.name)).toEqual(['Main', 'J2'])
  })

  it('never puts the same sail aboard twice', () => {
    expect(toggleUp(base, j2).onBoard).toHaveLength(2)
  })

  it('does not mutate what it was given', () => {
    toggleOnBoard(base, a2)
    expect(base.onBoard).toHaveLength(2)
  })

  it('reads a state written before onBoard existed as "what was up was aboard"', () => {
    // The alternative — an empty list — would say the boat was sailing with an
    // empty deck, and would zero the weight for every day already tagged.
    const s = normaliseSailState({ up: [{ id: 's1', name: 'Main' }], battens: [] })
    expect(s.onBoard.map((x) => x.name)).toEqual(['Main'])
  })

  it('keeps a sail that is aboard but not up', () => {
    const s = normaliseSailState({ up: [{ name: 'Main' }], onBoard: [{ name: 'Main' }, { name: 'J4' }] })
    expect(s.onBoard.map((x) => x.name)).toEqual(['Main', 'J4'])
    expect(s.up.map((x) => x.name)).toEqual(['Main'])
  })

  it('repairs a stored state where something up was not listed aboard', () => {
    const s = normaliseSailState({ up: [{ name: 'A2' }], onBoard: [{ name: 'Main' }] })
    expect(s.onBoard.map((x) => x.name)).toEqual(['Main', 'A2'])
  })
})

describe('weightAboard', () => {
  const kgs: Record<string, number> = { Main: 116.6, J2: 62.5, A2: 49.2 }
  const weightOf = (s: SailRef) => kgs[s.name] ?? null
  const state = (...names: string[]): SailState => ({
    up: [], onBoard: names.map((name) => ({ name })), battens: [],
  })

  it('adds up what is on the boat', () => {
    expect(weightAboard(state('Main', 'J2'), weightOf)).toEqual({ kg: 179.1, known: 2, unknown: 0 })
  })

  it('counts only what is aboard — the RIB does not weigh the boat down', () => {
    const s: SailState = { up: [], onBoard: [{ name: 'Main' }], battens: [] }
    expect(weightAboard(s, weightOf)?.kg).toBe(116.6)
  })

  it('says how many it could not weigh, rather than quietly under-reporting', () => {
    expect(weightAboard(state('Main', 'Mystery jib'), weightOf))
      .toEqual({ kg: 116.6, known: 1, unknown: 1 })
  })

  it('is null when nothing aboard has a known weight', () => {
    // "0.0 kg" beside a deck full of sails reads as a measurement, not a gap.
    expect(weightAboard(state('Mystery jib'), weightOf)).toBeNull()
    expect(weightAboard(state(), weightOf)).toBeNull()
  })

  it('ignores a zero or negative weight as unknown', () => {
    expect(weightAboard(state('Main', 'Free'), () => 0)).toBeNull()
  })

  it('rounds to a tenth, the way a weigh-in sheet does', () => {
    expect(weightAboard(state('a', 'b', 'c'), () => 1.11)?.kg).toBe(3.3)
  })
})
