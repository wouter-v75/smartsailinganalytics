import { describe, it, expect } from 'vitest'
import {
  MANOEUVRE_SLUGS, R_MANOEUVRE, R_MOMENT, markerStyle, sailsFrom, markerTip, markerLabel,
  FIXED_SLUGS, isRetimable,
} from '../markers'
import { SAIL_CHANGE_SLUG } from '../sailState'
import type { TagEvent } from '../types'

const T = (h: number, m: number, s = 0) =>
  Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)

let n = 0
const tag = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: 'tack', label: 'Tack', color: '#1D9E75',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(11, 42, 7), t1: T(11, 42, 7), autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'auto', producer: 'manoeuvres', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: null,
  ...over,
})

const change = (up: string[], over: Partial<TagEvent> = {}): TagEvent =>
  tag({
    slug: SAIL_CHANGE_SLUG,
    label: 'Sail change',
    source: 'human',
    producer: 'user',
    meta: {
      sail: {
        up: up.map((name) => ({ id: null, name })),
        onBoard: up.map((name) => ({ id: null, name })),
        battens: [],
      },
    },
    ...over,
  })

describe('markerStyle', () => {
  it('draws the routine turns small, so the day is not a bead necklace', () => {
    expect(markerStyle('tack').r).toBe(R_MANOEUVRE)
    expect(markerStyle('gybe').r).toBe(R_MANOEUVRE)
    expect(markerStyle('tack').r).toBeLessThan(markerStyle('race-start').r)
  })

  it('keeps the moments people navigate to at full size', () => {
    for (const slug of ['race-start', 'topmark', 'gate', 'finish', SAIL_CHANGE_SLUG]) {
      expect(markerStyle(slug).r).toBe(R_MOMENT)
    }
  })

  it('thins the stroke with the radius — a 2px ring on a 3.5px dot is a blob', () => {
    expect(markerStyle('tack').strokeWidth).toBeLessThan(markerStyle('topmark').strokeWidth)
  })

  it('is still big enough to hit: a 3.5 radius is a 7px dot, not a pixel', () => {
    expect(R_MANOEUVRE * 2).toBeGreaterThanOrEqual(7)
  })

  it('treats an unknown slug as a moment rather than hiding it', () => {
    expect(markerStyle('whatever-the-crew-invented').r).toBe(R_MOMENT)
    expect(MANOEUVRE_SLUGS.has('tack')).toBe(true)
  })
})

describe('sailsFrom', () => {
  it('answers the question the hover was asking: what were we carrying from here', () => {
    expect(sailsFrom(change(['Main', 'J2']))).toBe('Main + J2')
  })

  it('says nothing for a tag that knows nothing about sails', () => {
    expect(sailsFrom(tag())).toBeNull()
    expect(sailsFrom(tag({ slug: 'topmark', label: 'Top mark' }))).toBeNull()
  })

  it('reads a drop as a drop', () => {
    const t = change([], { meta: { sail: { up: [], onBoard: [{ id: null, name: 'A2' }], battens: [] } } })
    expect(sailsFrom(t)).toBe('All down')
  })

  it('admits it when a change was never filled in', () => {
    // Falling back to the PREVIOUS state would be worse than silence: the one
    // thing certain here is that what was up before is no longer what is up.
    expect(sailsFrom(tag({ slug: SAIL_CHANGE_SLUG, label: 'Sail change', meta: null })))
      .toBe('Sails not recorded')
    expect(sailsFrom(tag({ slug: SAIL_CHANGE_SLUG, label: 'Sail change', meta: { sail: {} } })))
      .toBe('Sails not recorded')
  })

  it('does not speak for a rejected change', () => {
    expect(sailsFrom(change(['Main'], { rejected: true }))).toBe('Sails not recorded')
  })
})

describe('markerTip / markerLabel', () => {
  it('uses the session clock, never the device clock', () => {
    expect(markerTip(tag()).clock).toBe('11:42:07')
    expect(markerTip(tag(), 120).clock).toBe('13:42:07')
  })

  it('carries the label and the sails together', () => {
    const tip = markerTip(change(['Main', 'J1']))
    expect(tip.title).toBe('Sail change')
    expect(tip.sails).toBe('Main + J1')
  })

  it('reads as one line for a screen reader', () => {
    expect(markerLabel(change(['Main', 'J1']))).toBe('Sail change · 11:42:07 · Main + J1')
    expect(markerLabel(tag())).toBe('Tack · 11:42:07')
  })
})

describe('what may be dragged along the track', () => {
  it('leaves the routine turns alone', () => {
    // A hundred and forty of them, all from the same TWA trace. One nudged by
    // hand is one sample quietly disagreeing with the detector that produced
    // every other one; if a tack is wrong, the fix is in the detection.
    for (const slug of ['tack', 'gybe']) {
      expect(isRetimable(slug)).toBe(false)
      expect(FIXED_SLUGS.has(slug)).toBe(true)
    }
  })

  it('lets the racing moments be put right', () => {
    // A start or a rounding on the wrong side of the mark is exactly the error
    // you can SEE on a track and cannot see on a clock — which is the whole
    // argument for dragging rather than typing a time.
    for (const slug of ['race-start', 'topmark', 'gate', 'mark', 'race-finish']) {
      expect(isRetimable(slug)).toBe(true)
    }
  })

  it('lets a person put right what a person placed', () => {
    for (const slug of ['note', 'team-note', 'sail-change', 'rig-change', 'technical', 'review', 'lineup', 'grab-video']) {
      expect(isRetimable(slug)).toBe(true)
    }
  })

  it('treats a tag nobody has heard of as the crew’s', () => {
    // A team's own vocabulary is theirs to place and theirs to correct.
    expect(isRetimable('whatever-the-crew-invented')).toBe(true)
  })
})

describe('the carried deck on a marker', () => {
  const deckSet = change(['Main', 'J2'], {
    t0: T(11, 40), t1: T(11, 40),
    meta: {
      sail: {
        up: [{ id: null, name: 'Main' }, { id: null, name: 'J2' }],
        onBoard: ['Main', 'J2', 'J4', 'A2'].map((name) => ({ id: null, name })),
        battens: [],
      },
    },
  })
  const fromFile = tag({
    slug: SAIL_CHANGE_SLUG, label: 'Sails changed', t0: T(12, 15), t1: T(12, 15),
    source: 'auto', producer: 'eventfile', meta: { sails: ['Main', 'J4'] },
  })
  const day = [deckSet, fromFile]

  it('says what is aboard from that point, not just what is up', () => {
    const tip = markerTip(fromFile, 0, day)
    expect(tip.sails).toBe('Main + J4')
    expect(tip.aboard).toBe('Main + J2 + J4 + A2')
  })

  it('stays quiet when the deck says nothing the sails up do not', () => {
    // A boat with nothing in the bag has two identical lists, and printing both
    // is printing the same fact twice.
    expect(markerTip(change(['Main', 'J2']), 0, [change(['Main', 'J2'])]).aboard).toBeNull()
  })

  it('is absent without the day to fold', () => {
    expect(markerTip(fromFile, 0).aboard).toBeNull()
  })

  it('is not offered for a tag that is not a sail change', () => {
    expect(markerTip(tag(), 0, day).aboard).toBeNull()
  })

  it('reads as one line for a screen reader', () => {
    expect(markerLabel(fromFile, 0, day))
      .toBe('Sails changed · 12:15:00 · Main + J4 · aboard Main + J2 + J4 + A2')
  })
})
