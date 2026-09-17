// Analytics must show the same day as the tagger, in the same words. These tests are
// about that sameness: the label, the colour and the size hierarchy come from the
// tagger's own helpers, not from a second set of names in Analytics.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchDayTags, trackTags, tagLegend, tagsInRange, isTagged, EVENT_FILE_SLUG, TAG_MATCH_S } from '../dayTags'
import { markerStyle, R_MANOEUVRE, R_MOMENT } from '../tagging/markers'
import type { TagEvent } from '../tagging/types'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)
const m = (min: number) => T0 + min * 60_000

const tag = (over: Partial<TagEvent> & { slug: string }): TagEvent => ({
  id: over.slug + (over.t0 ?? 0), teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, label: over.slug, color: '#888', scope: 'general', section: null, ownerUserId: null,
  t0: T0, t1: T0, targetKind: 'session', targetId: null, note: null, labels: [], source: 'manual',
  producer: 'crew', ...over,
} as TagEvent)

describe('trackTags', () => {
  const day = [
    tag({ slug: 'tack', label: 'Tack', color: '#1D9E75', t0: m(5) }),
    tag({ slug: 'race-start', label: 'Race start', color: '#EF4444', t0: m(10) }),
    tag({ slug: 'sail-change', label: 'Sail change', color: '#F59E0B', t0: m(2) }),
  ]

  it('keeps the team’s own label and colour — no second name for a moment', () => {
    const drawn = trackTags(day)
    expect(drawn.map(d => d.label)).toEqual(['Sail change', 'Tack', 'Race start'])
    expect(drawn.find(d => d.slug === 'tack')?.color).toBe('#1D9E75')
  })

  it('draws with the tagger’s size hierarchy: a turn small, a moment full size', () => {
    const drawn = trackTags(day)
    expect(drawn.find(d => d.slug === 'tack')?.r).toBe(R_MANOEUVRE)
    expect(drawn.find(d => d.slug === 'race-start')?.r).toBe(R_MOMENT)
    expect(drawn.find(d => d.slug === 'tack')?.strokeWidth).toBe(markerStyle('tack').strokeWidth)
  })

  it('returns them in time order whatever order they arrived in', () => {
    expect(trackTags(day).map(d => d.t0)).toEqual([m(2), m(5), m(10)])
  })

  it('puts the time on the session clock, not the device’s', () => {
    const [first] = trackTags([tag({ slug: 'race-start', t0: m(10) })], 120)
    expect(first.clock).toBe('12:10:00')     // UTC+2
  })

  it('marks the routine turns as such, so the track can keep them quiet', () => {
    const drawn = trackTags(day)
    expect(drawn.find(d => d.slug === 'tack')?.isManoeuvre).toBe(true)
    expect(drawn.find(d => d.slug === 'race-start')?.isManoeuvre).toBe(false)
  })

  it('gives every tag an accessible name', () => {
    expect(trackTags([tag({ slug: 'race-start', label: 'Race start', t0: m(10) })])[0].ariaLabel)
      .toMatch(/Race start/)
  })

  it('skips a tag with no time rather than drawing it at zero', () => {
    expect(trackTags([tag({ slug: 'tack', t0: undefined as never })])).toHaveLength(0)
    expect(trackTags(null)).toEqual([])
  })
})

describe('tagLegend', () => {
  it('lists the kinds of tag with the team’s labels and counts', () => {
    const legend = tagLegend([
      tag({ slug: 'tack', label: 'Tack', color: '#1D9E75', t0: m(1) }),
      tag({ slug: 'tack', label: 'Tack', color: '#1D9E75', t0: m(2) }),
      tag({ slug: 'sail-change', label: 'Sail change', color: '#F59E0B', t0: m(3) }),
    ])
    // Commonest last: the routine turns do not head the list.
    expect(legend.map(r => [r.label, r.n])).toEqual([['Sail change', 1], ['Tack', 2]])
  })

  it('is empty for a day with no tags', () => {
    expect(tagLegend([])).toEqual([])
  })
})

describe('tagsInRange', () => {
  const day = [
    tag({ slug: 'sail-change', t0: m(9), t1: m(9) }),
    tag({ slug: 'tack', t0: m(20), t1: m(20) }),
    tag({ slug: 'race-start', t0: m(40), t1: m(40) }),
  ]

  it('keeps the tags inside a selected stretch', () => {
    expect(tagsInRange(day, [m(15), m(30)]).map(t => t.slug)).toEqual(['tack'])
  })

  it('keeps a tag that overlaps the edge — a window tag spanning the selection counts', () => {
    const spanning = [tag({ slug: 'race', t0: m(5), t1: m(35) })]
    expect(tagsInRange(spanning, [m(15), m(30)])).toHaveLength(1)
  })

  it('is the whole day without a selection, and copes with a range given backwards', () => {
    expect(tagsInRange(day, null)).toHaveLength(3)
    expect(tagsInRange(day, [m(30), m(15)]).map(t => t.slug)).toEqual(['tack'])
  })
})

describe('fetchDayTags', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the tagger’s own endpoint, so both screens read one source', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ events: [tag({ slug: 'tack' })] }) })
    vi.stubGlobal('fetch', fetchMock)
    const events = await fetchDayTags('team-1', 'boat-1', '2026-09-11')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/teams/team-1/tags/events?boat_id=boat-1&date=2026-09-11')
    expect(events).toHaveLength(1)
  })

  it('is empty rather than broken when the tags cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    expect(await fetchDayTags('t', 'b', '2026-09-11')).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchDayTags('t', 'b', '2026-09-11')).toEqual([])
  })
})

describe('isTagged — both sources show, an overlap is drawn once', () => {
  const day = [
    tag({ slug: 'tack', t0: m(20) }),
    tag({ slug: 'sail-change', t0: m(40) }),
  ]

  it('says a moment the tagger already has is covered', () => {
    expect(isTagged(day, m(20), [EVENT_FILE_SLUG.tack])).toBe(true)
  })

  it('allows for a detector disagreeing by a few seconds', () => {
    expect(isTagged(day, m(20) + 15_000, [EVENT_FILE_SLUG.tack])).toBe(true)
    expect(isTagged(day, m(20) + (TAG_MATCH_S + 5) * 1000, [EVENT_FILE_SLUG.tack])).toBe(false)
  })

  it('does not treat a different kind of tag as cover', () => {
    expect(isTagged(day, m(20), [EVENT_FILE_SLUG.gybe])).toBe(false)
    expect(isTagged(day, m(40), [EVENT_FILE_SLUG.mark])).toBe(false)
  })

  it('leaves an untagged event-file moment to be drawn', () => {
    expect(isTagged(day, m(90), [EVENT_FILE_SLUG.tack])).toBe(false)
    expect(isTagged([], m(20), [EVENT_FILE_SLUG.tack])).toBe(false)
    expect(isTagged(null, m(20), [EVENT_FILE_SLUG.tack])).toBe(false)
  })
})
