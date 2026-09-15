import { describe, it, expect } from 'vitest'
import {
  findDuplicates, isAccepted, acceptedWith, sourceOf, DUPLICATE_WINDOW_MS,
} from '../duplicates'
import type { TagEvent } from '../types'

const T = (h: number, m: number, s = 0) =>
  Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)

let n = 0
const tag = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: 'topmark', label: 'Top mark', color: '#EF4444',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(12, 20), t1: T(12, 20, 30), autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'human', producer: 'user', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: null,
  ...over,
})
const mine = (over: Partial<TagEvent> = {}) => tag({ createdByUserId: 'me', ...over })
const crewmate = (over: Partial<TagEvent> = {}) => tag({ createdByUserId: 'u-sam', ...over })
const theirs = (over: Partial<TagEvent> = {}) =>
  tag({ source: 'auto', producer: 'eventfile', detectionKey: `k${n}`, confidence: 0.98, createdByUserId: null, ...over })

describe('findDuplicates', () => {
  it('finds the crew’s tag and the file’s, seconds apart', () => {
    // The whole scenario: tagged on the water, event file uploaded that evening.
    const a = mine({ t0: T(12, 20, 11) })
    const b = theirs({ t0: T(12, 20) })
    const [d] = findDuplicates([a, b])
    expect(d.a.id).toBe(a.id)
    expect(d.b.id).toBe(b.id)
    expect(d.gapMs).toBe(11_000)
    expect(d.label).toBe('Top mark')
  })

  it('does not pair different kinds of moment', () => {
    // A top mark and a gate eleven seconds apart is a tight rounding, not a
    // duplicate.
    expect(findDuplicates([mine({ t0: T(12, 20, 11) }), theirs({ slug: 'gate', label: 'Gate' })])).toEqual([])
  })

  it('does not pair two things that are genuinely apart', () => {
    expect(findDuplicates([mine({ t0: T(12, 20) }), theirs({ t0: T(12, 21) })])).toEqual([])
  })

  it('takes the window as a setting', () => {
    const pair = [mine({ t0: T(12, 20, 20) }), theirs({ t0: T(12, 20) })]
    expect(findDuplicates(pair, 10_000)).toEqual([])
    expect(findDuplicates(pair, 30_000)).toHaveLength(1)
  })

  it('marks which kind of pair it is', () => {
    expect(findDuplicates([mine({ t0: T(12, 20, 5) }), theirs()])[0].kind).toBe('crossed')
    expect(findDuplicates([mine({ t0: T(12, 20) }), crewmate({ t0: T(12, 20, 5) })])[0].kind).toBe('crew')
  })

  it('puts the human side first on a crossed pair', () => {
    // So the row can ask "keep mine / keep the file's" without re-deriving it.
    const d = findDuplicates([theirs({ t0: T(12, 20) }), mine({ t0: T(12, 20, 5) })])[0]
    expect(d.a.source).toBe('human')
    expect(d.b.source).toBe('auto')
  })

  it('leaves two detections to the sync', () => {
    // They share a detection_key; re-derivation reconciles them, and a person
    // being asked about it would be a person doing the sync's job.
    expect(findDuplicates([theirs({ t0: T(12, 20) }), theirs({ t0: T(12, 20, 5) })])).toEqual([])
  })

  it('matches closest-first, one tag to one pair', () => {
    // The bow tagged it, the trimmer tagged it, and then the file arrived.
    // Three pairs describing one instant would leave stale rows offering to
    // delete tags that are already gone.
    const near = mine({ t0: T(12, 20, 2) })
    const far = mine({ t0: T(12, 20, 25) })
    const auto = theirs({ t0: T(12, 20) })
    const out = findDuplicates([far, near, auto])
    expect(out).toHaveLength(1)
    expect(out[0].a.id).toBe(near.id)
  })

  it('pairs each of two real roundings with its own match', () => {
    const out = findDuplicates([
      mine({ t0: T(12, 20, 8) }), theirs({ t0: T(12, 20) }),
      mine({ t0: T(12, 50, 6) }), theirs({ t0: T(12, 50) }),
    ])
    expect(out).toHaveLength(2)
    expect(out.map((d) => d.gapMs)).toEqual([8000, 6000])
  })

  it('comes back in the order the day happened', () => {
    const out = findDuplicates([
      mine({ t0: T(14, 0, 5) }), theirs({ t0: T(14, 0) }),
      mine({ t0: T(12, 20, 5) }), theirs({ t0: T(12, 20) }),
    ])
    expect(out[0].a.t0).toBeLessThan(out[1].a.t0)
  })

  it('ignores a tag that has been thrown out', () => {
    // A rejected detection is a tombstone; offering to keep it would be
    // offering to resurrect something already decided against.
    expect(findDuplicates([mine(), theirs({ rejected: true })])).toEqual([])
    expect(findDuplicates([mine({ rejected: true }), theirs()])).toEqual([])
  })

  it('gives the pair a key that does not move', () => {
    const a = mine({ id: 'aaa' })
    const b = theirs({ id: 'bbb' })
    expect(findDuplicates([a, b])[0].key).toBe(findDuplicates([b, a])[0].key)
  })

  it('survives a day with nothing in it', () => {
    expect(findDuplicates([])).toEqual([])
    expect(findDuplicates([mine()])).toEqual([])
    expect(findDuplicates(null as unknown as TagEvent[])).toEqual([])
  })

  it('ignores a row with no usable time', () => {
    expect(findDuplicates([mine({ t0: NaN }), theirs()])).toEqual([])
  })

  it('has a window wide enough for a late press and no wider', () => {
    expect(DUPLICATE_WINDOW_MS).toBeGreaterThanOrEqual(15_000)
    expect(DUPLICATE_WINDOW_MS).toBeLessThanOrEqual(60_000)
  })
})

describe('a pair somebody has said is really two moments', () => {
  it('stops being offered', () => {
    const b = theirs({ id: 'bbb' })
    const a = mine({ id: 'aaa', meta: { dupOkWith: ['bbb'] } })
    expect(isAccepted(a, b)).toBe(true)
    expect(findDuplicates([a, b])).toEqual([])
  })

  it('is enough for either side to carry the note', () => {
    const a = mine({ id: 'aaa' })
    const b = theirs({ id: 'bbb', meta: { dupOkWith: ['aaa'] } })
    expect(findDuplicates([a, b])).toEqual([])
  })

  it('only suppresses THAT pair, not the tag for ever', () => {
    // Accepting one pairing must not make a tag invisible to a later, better
    // match — the file can be re-imported with different times.
    const a = mine({ id: 'aaa', t0: T(12, 20, 5), meta: { dupOkWith: ['bbb'] } })
    const other = theirs({ id: 'ccc', t0: T(12, 20) })
    expect(findDuplicates([a, other])).toHaveLength(1)
  })

  it('adds to the list rather than replacing it', () => {
    const t = mine({ meta: { dupOkWith: ['x'] } })
    expect(acceptedWith(t, 'y')).toEqual(['x', 'y'])
    expect(acceptedWith(t, 'x')).toEqual(['x'])
    expect(acceptedWith(mine(), 'y')).toEqual(['y'])
  })

  it('is not confused by junk in meta', () => {
    expect(isAccepted(mine({ meta: { dupOkWith: 'bbb' } }), theirs({ id: 'bbb' }))).toBe(false)
    expect(isAccepted(mine({ meta: null }), theirs())).toBe(false)
  })
})

describe('sourceOf', () => {
  it('says where each side came from, in words', () => {
    expect(sourceOf(mine(), { meId: 'me' })).toBe('You tagged it')
    expect(sourceOf(theirs())).toBe('From the event file')
    expect(sourceOf(theirs({ producer: 'manoeuvres' }))).toBe('Found in the log')
    expect(sourceOf(theirs({ producer: 'ai' as never }))).toBe('Detected')
  })
})

describe('two crew members tagging the same moment', () => {
  it('is a pair, and the earlier one comes first', () => {
    // Neither can see what the other pressed, so this is the commoner case.
    const a = mine({ t0: T(12, 31, 2) })
    const b = crewmate({ t0: T(12, 31, 13) })
    const [d] = findDuplicates([b, a])
    expect(d.kind).toBe('crew')
    expect(d.a.id).toBe(a.id)
    expect(d.b.id).toBe(b.id)
    expect(d.gapMs).toBe(11_000)
  })

  it('is NOT a pair when it is one person pressing twice', () => {
    // A double press is not a disagreement about what happened. Asking somebody
    // which of their own two identical tags to keep is a chore, not a question.
    expect(findDuplicates([mine({ t0: T(12, 20) }), mine({ t0: T(12, 20, 4) })])).toEqual([])
  })

  it('reads a personal tag’s owner as its author', () => {
    const a = tag({ scope: 'personal', ownerUserId: 'me', createdByUserId: null, t0: T(12, 20) })
    const b = tag({ scope: 'personal', ownerUserId: 'u-sam', createdByUserId: null, t0: T(12, 20, 5) })
    expect(findDuplicates([a, b])).toHaveLength(1)
  })

  it('is not a pair when nobody knows who placed one of them', () => {
    // Two anonymous hand-placed tags could be the same person twice, and
    // guessing wrong means offering to delete somebody's only record of it.
    const a = tag({ createdByUserId: null, ownerUserId: null, t0: T(12, 20) })
    const b = crewmate({ t0: T(12, 20, 5) })
    expect(findDuplicates([a, b])).toEqual([])
  })

  it('competes with a crossed pair on gap, not on kind', () => {
    // Matched greedily over BOTH kinds together: the closest pairing wins
    // whichever kind it is, rather than one kind taking the good partners.
    const auto = theirs({ t0: T(12, 20) })
    const far = mine({ t0: T(12, 20, 20) })
    const near = crewmate({ t0: T(12, 20, 1) })
    const out = findDuplicates([auto, far, near])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('crossed')
    expect(out[0].b.id).toBe(auto.id)
    expect(out[0].a.id).toBe(near.id)
  })

  it('can be accepted as two real moments like any other pair', () => {
    const b = crewmate({ id: 'bbb', t0: T(12, 20, 5) })
    const a = mine({ id: 'aaa', t0: T(12, 20), meta: { dupOkWith: ['bbb'] } })
    expect(findDuplicates([a, b])).toEqual([])
  })
})

describe('sourceOf, with names', () => {
  it('says whose it is when it knows', () => {
    const t = crewmate()
    expect(sourceOf(t, { meId: 'me', nameOf: () => 'Sam Whitcombe' })).toBe('Sam Whitcombe tagged it')
  })

  it('says it is yours when it is', () => {
    expect(sourceOf(mine(), { meId: 'me', nameOf: () => 'Wouter' })).toBe('You tagged it')
  })

  it('does not invent a name it cannot read', () => {
    // "You" against "Another crew member" is still a choice somebody can make.
    expect(sourceOf(crewmate(), { meId: 'me', nameOf: () => null })).toBe('Another crew member')
    expect(sourceOf(crewmate(), { meId: 'me' })).toBe('Another crew member')
  })

  it('falls back when nobody signed it', () => {
    expect(sourceOf(tag({ createdByUserId: null, ownerUserId: null }), { meId: 'me' }))
      .toBe('Tagged by hand')
  })
})

describe('a cluster clears one pair at a time', () => {
  it('shows the next pair once the first is resolved', () => {
    // Three tags of one moment: the file's, mine two seconds later, and a
    // crewmate's eleven seconds after that. Only the closest pairing is offered
    // — three rows for one instant would leave two of them offering to delete
    // tags already gone — and the rest surfaces on the next pass.
    const auto = theirs({ id: 'auto', t0: T(12, 31) })
    const me = mine({ id: 'me1', t0: T(12, 31, 2) })
    const sam = crewmate({ id: 'sam1', t0: T(12, 31, 13) })

    const first = findDuplicates([auto, me, sam])
    expect(first).toHaveLength(1)
    expect(first[0].kind).toBe('crossed')

    // Keep mine: the detection is tombstoned. Sam's is now the one to settle.
    const after = findDuplicates([{ ...auto, rejected: true }, me, sam])
    expect(after).toHaveLength(1)
    expect(after[0].kind).toBe('crew')
    expect(after[0].a.id).toBe('me1')
  })
})
