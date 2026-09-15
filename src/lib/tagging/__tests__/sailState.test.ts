import { describe, it, expect } from 'vitest'
import {
  SAIL_CHANGE_SLUG, EMPTY_SAIL_STATE, normaliseSailState, stateOf, sailChanges,
  sailStateAt, lastChangeBefore, toggleUp, isUp, setBatten, withBattenCount,
  stateIsEmpty, describeState, describeChange, sailKey, inferDeck, sameDeck,
  toggleOnBoard, isOnBoard, weightAboard, hasStatedDeck, sameSail, sameSailAcrossSources,
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

describe('the event file answers when the crew did not', () => {
  const fromFile = (sails: unknown, over: Partial<TagEvent> = {}) =>
    tag({ meta: { sails }, source: 'auto', producer: 'eventfile', ...over })

  it('reads the sails up out of a detected sail change', () => {
    // "Main + J2, from the file" is enormously more useful than "not recorded"
    // on a day nobody had a phone out.
    expect(describeState(stateOf(fromFile(['Main', 'J2']))!)).toBe('Main + J2')
  })

  it('counts them aboard too — they cannot be up from the RIB', () => {
    const s = stateOf(fromFile(['Main', 'A2']))!
    expect(s.onBoard.map((x) => x.name)).toEqual(['Main', 'A2'])
  })

  it('lets the crew’s own entry win where there is one', () => {
    const both = tag({
      meta: {
        sails: ['Main', 'J2'],                                   // the file
        sail: { up: [{ id: 'i5', name: 'A2' }], onBoard: [], battens: [] },  // the crew
      },
    })
    expect(describeState(stateOf(both)!)).toBe('A2')
  })

  it('reads a sail that arrived as an object rather than a string', () => {
    expect(describeState(stateOf(fromFile([{ name: 'Main' }, { name: 'J4' }]))!)).toBe('Main + J4')
  })

  it('is still nothing when the file said nothing', () => {
    expect(stateOf(fromFile([]))).toBeNull()
    expect(stateOf(fromFile(null))).toBeNull()
    expect(stateOf(fromFile(['   ', '']))).toBeNull()
    expect(stateOf(tag({ meta: {} }))).toBeNull()
  })

  it('does not speak for a rejected change', () => {
    expect(stateOf(fromFile(['Main'], { rejected: true }))).toBeNull()
  })

  it('does not read a tack’s sails as a sail change', () => {
    // detect.ts puts the sails up on every manoeuvre too; a tack is not a
    // change, and reading one as one would invent a change that never happened.
    expect(stateOf(fromFile(['Main', 'J2'], { slug: 'tack', label: 'Tack' }))).toBeNull()
  })

  it('carries through to what was up at a later moment', () => {
    const day = [fromFile(['Main', 'J2'], { t0: T(11, 40), t1: T(11, 40) })]
    expect(describeState(sailStateAt(day, T(12, 30)))).toBe('Main + J2')
  })
})

describe('the deck is sticky — what is aboard stays aboard', () => {
  const aboard = (s: SailState) => s.onBoard.map((x) => x.name).sort()

  const dayList = ['Main', 'J2', 'J4', 'A2']
  const setDeck = withSail(T(11, 40), {
    up: [{ id: null, name: 'Main' }, { id: null, name: 'J2' }],
    onBoard: dayList.map((name) => ({ id: null, name })),
  })

  it('survives a detected change, which only ever knows what was UP', () => {
    // The failure this exists for: the event file records sails up, so folding
    // a detected change in as fact says the crew threw two sails overboard at
    // 12:15 because Expedition logged a headsail swap. The weight aboard,
    // which every later screen reads, would drop with it.
    const fromFile = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile',
      meta: { sails: ['Main', 'J4'] },
    })
    const s = sailStateAt([setDeck, fromFile], T(12, 30))
    expect(names(s)).toEqual(['Main', 'J4'])
    expect(aboard(s)).toEqual(['A2', 'J2', 'J4', 'Main'])
  })

  it('lasts the rest of the day across any number of them', () => {
    const later = [T(12, 15), T(13, 0), T(14, 30)].map((t) =>
      tag({ t0: t, t1: t, source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'A2'] } })
    )
    expect(aboard(sailStateAt([setDeck, ...later], T(15, 0)))).toEqual(['A2', 'J2', 'J4', 'Main'])
  })

  it('changes when somebody says it changed', () => {
    // A sail passed back to the RIB: the crew state the new deck, and that is
    // what sticks from then on.
    const passedBack = withSail(T(13, 0), {
      up: [{ id: null, name: 'Main' }],
      onBoard: [{ id: null, name: 'Main' }, { id: null, name: 'J2' }],
    })
    expect(aboard(sailStateAt([setDeck, passedBack], T(14, 0)))).toEqual(['J2', 'Main'])
  })

  it('takes a sail aboard when it is hoisted — it cannot come up from the RIB', () => {
    const hoistUnknown = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile',
      meta: { sails: ['Main', 'Storm jib'] },
    })
    expect(aboard(sailStateAt([setDeck, hoistUnknown], T(12, 30))))
      .toEqual(['A2', 'J2', 'J4', 'Main', 'Storm jib'])
  })

  it('does not add the same sail to the deck twice', () => {
    const reHoist = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile',
      meta: { sails: ['Main', 'J2'] },
    })
    expect(aboard(sailStateAt([setDeck, reHoist], T(12, 30)))).toEqual(['A2', 'J2', 'J4', 'Main'])
  })

  it('starts empty on a day where nobody ever said', () => {
    const onlyFile = tag({
      t0: T(11, 40), t1: T(11, 40),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J2'] },
    })
    // What was up is the only thing known to be aboard, which is honest.
    expect(aboard(sailStateAt([onlyFile], T(12, 0)))).toEqual(['J2', 'Main'])
  })

  it('hands the composer the carried deck as “previous”', () => {
    // Seeding a new change from a detected one's RAW state would give the crew
    // a deck with half their sails missing from it.
    const fromFile = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J4'] },
    })
    const prev = lastChangeBefore([setDeck, fromFile], T(13, 0))!
    expect(aboard(prev.state)).toEqual(['A2', 'J2', 'J4', 'Main'])
  })

  it('weighs the whole deck, not just what is flying', () => {
    const fromFile = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main'] },
    })
    const s = sailStateAt([setDeck, fromFile], T(12, 30))
    const kg: Record<string, number> = { Main: 116.6, J2: 58.4, J4: 44.1, A2: 49.2 }
    expect(weightAboard(s, (x) => kg[x.name] ?? null)!.kg).toBeCloseTo(268.3, 1)
  })
})

describe('hasStatedDeck', () => {
  it('is false on a day nobody has filled in', () => {
    expect(hasStatedDeck([])).toBe(false)
  })

  it('is false when every change came from the event file', () => {
    // Those only ever record sails UP, so the deck is a floor rather than a
    // figure — and the weight aboard computed from it is too.
    const fromFile = tag({
      t0: T(11, 40), t1: T(11, 40),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J2'] },
    })
    expect(hasStatedDeck([fromFile])).toBe(false)
  })

  it('is true once somebody says', () => {
    const said = withSail(T(11, 40), {
      up: [{ id: null, name: 'Main' }],
      onBoard: [{ id: null, name: 'Main' }, { id: null, name: 'J2' }],
    })
    expect(hasStatedDeck([said])).toBe(true)
  })

  it('stays true for the rest of the day', () => {
    const said = withSail(T(11, 40), {
      up: [{ id: null, name: 'Main' }],
      onBoard: [{ id: null, name: 'Main' }, { id: null, name: 'J2' }],
    })
    const later = tag({
      t0: T(14, 0), t1: T(14, 0),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main'] },
    })
    expect(hasStatedDeck([said, later])).toBe(true)
  })
})

describe('the deck folds across sources', () => {
  it('does not put the same sail aboard twice under two identities', () => {
    // The crew pick out of the inventory, so their sails carry an id; the event
    // file knows only names. Matching on the id alone gave a carried deck of
    // "Main + J2 + J4 + A2 + Main + J4".
    const withIds = withSail(T(11, 40), {
      up: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }],
      onBoard: [
        { id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' },
        { id: 'i4', name: 'J4' }, { id: 'i5', name: 'A2' },
      ],
    })
    const byName = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J4'] },
    })
    const deck = sailStateAt([withIds, byName], T(12, 30)).onBoard.map((x) => x.name)
    expect(deck).toEqual(['Main', 'J2', 'J4', 'A2'])
  })

  it('matches names case- and space-insensitively', () => {
    const withIds = withSail(T(11, 40), {
      up: [{ id: 'i1', name: 'Main' }],
      onBoard: [{ id: 'i1', name: 'Main' }],
    })
    const byName = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile', meta: { sails: ['  MAIN  '] },
    })
    expect(sailStateAt([withIds, byName], T(12, 30)).onBoard).toHaveLength(1)
  })

  it('still adds a sail the deck has never seen', () => {
    const withIds = withSail(T(11, 40), {
      up: [{ id: 'i1', name: 'Main' }],
      onBoard: [{ id: 'i1', name: 'Main' }],
    })
    const byName = tag({
      t0: T(12, 15), t1: T(12, 15),
      source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'Storm jib'] },
    })
    expect(sailStateAt([withIds, byName], T(12, 30)).onBoard.map((x) => x.name))
      .toEqual(['Main', 'Storm jib'])
  })

  it('leaves sameSail strict — two sails sharing a name stay two sails', () => {
    // Inside the composer every sail comes from one place, and conflating them
    // there would make one of them impossible to select.
    const a = { id: 'i1', name: 'Main' }
    const b = { id: 'i2', name: 'Main' }
    expect(sameSail(a, b)).toBe(false)
    expect(sameSailAcrossSources(a, b)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A stated deck resets the day's carried list; an inferred one does not. Which
// is which decides whether an earlier statement reaches anything after it.
// ─────────────────────────────────────────────────────────────────────────────

describe('inferDeck', () => {
  it('carries what was aboard and adds what went up', () => {
    expect(inferDeck([{ id: 'i1', name: 'Main' }], [{ id: 'i3', name: 'J2' }]).map((s) => s.name))
      .toEqual(['Main', 'J2'])
  })

  it('does not put a sail aboard twice because the sources spell it differently', () => {
    expect(inferDeck([{ id: 'i1', name: 'Main' }], [{ id: null, name: 'main' }])).toHaveLength(1)
  })
})

describe('sameDeck', () => {
  it('ignores the order and the source', () => {
    expect(sameDeck(
      [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }],
      [{ id: null, name: 'J2' }, { id: null, name: 'Main' }]
    )).toBe(true)
    expect(sameDeck([{ id: 'i1', name: 'Main' }], [])).toBe(false)
  })
})

describe('which tags state the deck', () => {
  const T2 = (h: number, m: number) => Date.parse(`2026-09-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
  const deck = Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, name: `S${i}` }))
  const at = (t0: number, sail: Record<string, unknown>) =>
    tag({ t0, t1: t0, meta: { sail } })

  const stated = at(T2(11, 34), { up: [deck[0], deck[1]], onBoard: deck, battens: [], deckStated: true })

  it('reaches a later change that never claimed a deck', () => {
    const later = at(T2(12, 51), { up: [deck[0], deck[2]], onBoard: [], battens: [], deckStated: false })
    expect(sailStateAt([stated, later], T2(12, 51)).onBoard).toHaveLength(11)
  })

  it('reaches one pinned by an older version, whose deck was only its sails up', () => {
    // Saving used to store the on-board list inferred from what was up. That is
    // the inference coming back, not the crew saying the boat carried nothing
    // else — and reading it as a statement is what stranded the day at three.
    const legacy = at(T2(12, 51), { up: [deck[0], deck[2]], onBoard: [deck[0], deck[2]], battens: [] })
    expect(sailStateAt([stated, legacy], T2(12, 51)).onBoard).toHaveLength(11)
  })

  it('still stops at a later change that really does state one', () => {
    const restated = at(T2(12, 51), { up: [deck[0]], onBoard: [deck[0], deck[1]], battens: [], deckStated: true })
    expect(sailStateAt([stated, restated], T2(12, 51)).onBoard).toHaveLength(2)
  })

  it('reads an old row that stated a deck wider than its sails up', () => {
    // No flag, but the crew plainly said something: four aboard, one up.
    const old = at(T2(11, 0), { up: [deck[0]], onBoard: deck.slice(0, 4), battens: [] })
    expect(hasStatedDeck([old])).toBe(true)
    expect(sailStateAt([old], T2(12, 0)).onBoard).toHaveLength(4)
  })
})

describe('a day that has one deliberate statement', () => {
  const T2 = (h: number, m: number) => Date.parse(`2026-09-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
  const deck = Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, name: `S${i}` }))
  const at = (t0: number, sail: Record<string, unknown>) => tag({ t0, t1: t0, meta: { sail } })

  // Saving a sail change used to write the carried deck back onto the tag, so
  // half a day's tags each hold a copy of the deck of their moment. Read as
  // statements they pin it, and a correction made at 11:34 reaches nothing
  // after the first of them.
  const pinned = at(T2(12, 51), { up: [deck[0], deck[2]], onBoard: deck.slice(0, 3), battens: [] })

  it('lets the pins an older version left behind go quiet', () => {
    const stated = at(T2(11, 34), { up: [deck[0], deck[1]], onBoard: deck, battens: [], deckStated: true })
    expect(sailStateAt([stated, pinned], T2(13, 0)).onBoard).toHaveLength(11)
  })

  it('still reads them when nobody has stated anything on purpose', () => {
    // A day that predates the flag entirely has nothing better to go on.
    const older = at(T2(11, 34), { up: [deck[0]], onBoard: deck.slice(0, 5), battens: [] })
    expect(sailStateAt([older, pinned], T2(13, 0)).onBoard).toHaveLength(3)
  })
})
