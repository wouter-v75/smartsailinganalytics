import { describe, it, expect } from 'vitest'
import {
  nameKey, sailLinks, sailNamesIn, missingFromInventory, linkRef, linkDay, sailsToCreate,
} from '../sailLink'
import { SAIL_CHANGE_SLUG, sailStateAt, type SailRef } from '../sailState'
import type { TagEvent } from '../types'

const T = (h: number, m: number) => Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)

let n = 0
const tag = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: SAIL_CHANGE_SLUG, label: 'Sail change', color: '#F59E0B',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(11, 40), t1: T(11, 40), autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'human', producer: 'user', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: null,
  ...over,
})

const INVENTORY: SailRef[] = [
  { id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' },
  { id: 'i4', name: 'J4' }, { id: 'i5', name: 'A2' },
]

const fromFile = (sails: string[], over: Partial<TagEvent> = {}) =>
  tag({ source: 'auto', producer: 'eventfile', meta: { sails }, ...over })

const fromCrew = (up: SailRef[], onBoard: SailRef[] = up, over: Partial<TagEvent> = {}) =>
  tag({ meta: { sail: { up, onBoard, battens: [] } }, ...over })

describe('nameKey', () => {
  it('ignores the spelling an event file is not obliged to get right', () => {
    expect(nameKey('  J2 ')).toBe('j2')
    expect(nameKey('MAIN')).toBe('main')
    expect(nameKey(null)).toBe('')
  })
})

describe('sailLinks', () => {
  it('maps a name to the inventory row it means', () => {
    expect(sailLinks(INVENTORY).get('j2')).toEqual({ id: 'i3', name: 'J2' })
  })

  it('keeps the INVENTORY’s spelling, not the file’s', () => {
    expect(linkRef({ id: null, name: 'main' }, sailLinks(INVENTORY))).toEqual({ id: 'i1', name: 'Main' })
  })

  it('lets the first of two rows sharing a name win, rather than the query order', () => {
    const dupes: SailRef[] = [{ id: 'a', name: 'Main' }, { id: 'b', name: 'Main' }]
    expect(sailLinks(dupes).get('main')!.id).toBe('a')
  })

  it('leaves a name it has never heard of alone', () => {
    const out = linkRef({ id: null, name: 'Storm jib' }, sailLinks(INVENTORY))
    expect(out).toEqual({ id: null, name: 'Storm jib' })
  })

  it('survives an empty inventory', () => {
    expect(sailLinks([]).size).toBe(0)
  })
})

describe('sailNamesIn', () => {
  it('finds names in both shapes', () => {
    const day = [
      fromCrew([{ id: 'i1', name: 'Main' }], [{ id: 'i1', name: 'Main' }, { id: 'i4', name: 'J4' }]),
      fromFile(['A2']),
    ]
    expect(sailNamesIn(day).sort()).toEqual(['A2', 'J4', 'Main'])
  })

  it('reports each name once, in the spelling it first appeared in', () => {
    expect(sailNamesIn([fromFile(['J2']), fromFile(['  j2  '])])).toEqual(['J2'])
  })

  it('ignores anything that is not a sail change', () => {
    expect(sailNamesIn([tag({ slug: 'tack', label: 'Tack', meta: { sails: ['Main'] } })])).toEqual([])
  })

  it('ignores a rejected change', () => {
    expect(sailNamesIn([fromFile(['Main'], { rejected: true })])).toEqual([])
  })

  it('survives junk in meta', () => {
    expect(sailNamesIn([tag({ meta: { sails: [null, 7, '', '  '] } })])).toEqual([])
    expect(sailNamesIn([tag({ meta: null })])).toEqual([])
    expect(sailNamesIn([])).toEqual([])
  })
})

describe('missingFromInventory', () => {
  it('names what the inventory cannot account for', () => {
    const day = [fromFile(['Main', 'J2', 'Storm jib'])]
    expect(missingFromInventory(day, INVENTORY)).toEqual(['Storm jib'])
  })

  it('is empty when everything is accounted for', () => {
    expect(missingFromInventory([fromFile(['Main', 'J2'])], INVENTORY)).toEqual([])
  })

  it('reports everything when the inventory is empty', () => {
    expect(missingFromInventory([fromFile(['Main', 'J2'])], [])).toEqual(['Main', 'J2'])
  })
})

describe('linkDay', () => {
  it('gives an event file’s sails their inventory ids', () => {
    const [out] = linkDay([fromFile(['Main', 'J4'])], INVENTORY)
    const sail = (out.meta as any).sail
    expect(sail.up).toEqual([{ id: 'i1', name: 'Main' }, { id: 'i4', name: 'J4' }])
  })

  it('normalises the file’s flat list into the shape everything else reads', () => {
    const [out] = linkDay([fromFile(['Main'])], INVENTORY)
    expect((out.meta as any).sail).toEqual({ up: [{ id: 'i1', name: 'Main' }], onBoard: [], battens: [] })
    // The original list is kept: it is what the file said.
    expect((out.meta as any).sails).toEqual(['Main'])
  })

  it('re-links the crew’s own sails too, so a renamed sail follows', () => {
    const [out] = linkDay([fromCrew([{ id: null, name: 'j2' }])], INVENTORY)
    expect((out.meta as any).sail.up).toEqual([{ id: 'i3', name: 'J2' }])
  })

  it('keeps the battens it did not come for', () => {
    const t = fromCrew([{ id: 'i1', name: 'Main' }])
    ;(t.meta as any).sail.battens = [{ no: 1, tension: 'soft', turns: 5 }]
    const [out] = linkDay([t], INVENTORY)
    expect((out.meta as any).sail.battens).toEqual([{ no: 1, tension: 'soft', turns: 5 }])
  })

  it('leaves everything that is not a sail change untouched', () => {
    const t = tag({ slug: 'tack', label: 'Tack' })
    expect(linkDay([t], INVENTORY)[0]).toBe(t)
  })

  it('does nothing at all without an inventory to link to', () => {
    const day = [fromFile(['Main'])]
    expect(linkDay(day, [])).toBe(day)
  })

  it('fixes the deck that used to come back doubled', () => {
    // The bug this module exists for: the crew's sails carry ids, the file's
    // carry names, and the fold put the same two sails aboard twice.
    const day = linkDay([
      fromCrew(
        [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }],
        INVENTORY,
        { t0: T(11, 40), t1: T(11, 40) }
      ),
      fromFile(['Main', 'J4'], { t0: T(12, 15), t1: T(12, 15) }),
    ], INVENTORY)
    const deck = sailStateAt(day, T(12, 30)).onBoard
    expect(deck.map((s) => s.name)).toEqual(['Main', 'J2', 'J4', 'A2'])
    expect(deck.every((s) => !!s.id)).toBe(true)
  })
})

describe('sailsToCreate', () => {
  it('sends a name and nothing else', () => {
    // Guessing a kind from a spelling is how an inventory ends up with a
    // spinnaker called "J4".
    expect(sailsToCreate(['Storm jib', ' A3 '])).toEqual([{ name: 'Storm jib' }, { name: 'A3' }])
  })

  it('drops anything that is not a name', () => {
    expect(sailsToCreate(['', '   '])).toEqual([])
  })
})
