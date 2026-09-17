// Picking a race, and being honest about its finish. The event file never records a
// finish, so the value of this module is that a guessed end SAYS it is guessed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  raceOptions, finishesFromTags, finishNote, saveFinishTag, fetchFinishTags,
  startsFromTags, effectiveGuns, FINISH_SLUG,
} from '../raceSelect'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)
const m = (min: number) => T0 + min * 60_000

describe('finishesFromTags', () => {
  it('takes the race-finish tags and ignores everything else', () => {
    expect(finishesFromTags([
      { slug: 'race-finish', t0: m(40) },
      { slug: 'tack', t0: m(20) },
      { slug: 'race-finish', t0: m(10) },
    ])).toEqual([{ utc: m(10) }, { utc: m(40) }])
  })

  it('ignores a finish tag with no time on it', () => {
    expect(finishesFromTags([{ slug: 'race-finish' }])).toEqual([])
    expect(finishesFromTags(null)).toEqual([])
  })
})

describe('raceOptions', () => {
  const day = {
    guns: [{ utc: m(10), raceNum: 5 }, { utc: m(90), raceNum: 6 }],
    markRoundings: [{ utc: m(25) }, { utc: m(48) }, { utc: m(100) }, { utc: m(130) }],
    dayStartUtc: T0, dayStopUtc: m(180),
  }

  it('offers one option per race, opening at the warning signal so the start is in it', () => {
    const races = raceOptions(day)
    expect(races.map(r => r.raceNum)).toEqual([5, 6])
    expect(races[0].gun).toBe(m(10))
    expect(races[0].from).toBe(m(5))      // the 5-minute gun
  })

  it('says when the end was inferred, and suggests where the finish goes', () => {
    const [race5] = raceOptions(day)
    expect(race5.hasFinish).toBe(false)
    // Last mark inside race 5 is at +48 min; the suggestion is that plus the 3 min grace.
    expect(race5.suggestedFinish).toBe(m(51))
    expect(race5.endSource).not.toBe('finish')
  })

  it('uses a real finish tag when there is one, and suggests nothing', () => {
    const [race5] = raceOptions(day, [{ utc: m(55) }])
    expect(race5.hasFinish).toBe(true)
    expect(race5.to).toBe(m(55))
    expect(race5.suggestedFinish).toBeNull()
  })

  it('never suggests a finish beyond the stretch it belongs to', () => {
    // A mark rounding one minute before the end leaves no room for the full grace.
    const races = raceOptions({
      guns: [{ utc: m(10), raceNum: 1 }], markRoundings: [{ utc: m(19) }],
      dayStartUtc: T0, dayStopUtc: m(20),
    })
    expect(races[0].suggestedFinish).toBeLessThanOrEqual(races[0].to)
  })

  it('falls back to the segment end when a race has no mark roundings', () => {
    const races = raceOptions({ guns: [{ utc: m(10), raceNum: 1 }], dayStartUtc: T0, dayStopUtc: m(60) })
    expect(races[0].suggestedFinish).toBe(races[0].to)
  })

  it('offers nothing on a training day — there is no race to pick', () => {
    expect(raceOptions({ dataT0: T0, dataT1: m(120) })).toEqual([])
  })
})

describe('finishNote', () => {
  it('names how the end was guessed, because that says how wrong it may be', () => {
    const [race5] = raceOptions({
      guns: [{ utc: m(10), raceNum: 5 }], markRoundings: [{ utc: m(48) }],
      dayStartUtc: T0, dayStopUtc: m(180),
    })
    const note = finishNote(race5)
    expect(note).toMatch(/No finish tag for race 5/)
    expect(note).toMatch(/last mark rounding plus 3 min/)
    expect(note).toMatch(/Drag the flashing marker/)
  })

  it('says nothing when the finish is known', () => {
    const [race] = raceOptions({ guns: [{ utc: m(10), raceNum: 1 }], dayStopUtc: m(60) }, [{ utc: m(40) }])
    expect(finishNote(race)).toBeNull()
    expect(finishNote(null)).toBeNull()
  })
})

describe('saving the finish', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('writes it as a real tag, so every other screen sees the same finish', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ event: { id: 'e1' } }) })
    vi.stubGlobal('fetch', fetchMock)
    const res = await saveFinishTag('team-1', 'boat-1', '2026-09-11', m(52))
    expect(res.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/teams/team-1/tags/events')
    expect(JSON.parse(init.body)).toMatchObject({ boat_id: 'boat-1', session_date: '2026-09-11', slug: FINISH_SLUG, at: m(52) })
  })

  it('reports a refusal instead of pretending it saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'your role may not apply this tag' }) }))
    const res = await saveFinishTag('t', 'b', '2026-09-11', m(52))
    expect(res).toMatchObject({ ok: false, error: 'your role may not apply this tag' })
  })

  it('does not claim success when the server answers without an event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
    expect((await saveFinishTag('t', 'b', '2026-09-11', m(52))).ok).toBe(false)
  })
})

describe('reading the day’s finishes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks for the day and keeps only the finishes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ events: [{ slug: 'race-finish', t0: m(50) }, { slug: 'gybe', t0: m(20) }] }),
    }))
    expect(await fetchFinishTags('t', 'b', '2026-09-11')).toEqual([{ utc: m(50) }])
  })

  it('is empty rather than broken when the tags cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchFinishTags('t', 'b', '2026-09-11')).toEqual([])
  })
})

describe('which races the day has', () => {
  const xml = { raceGuns: [{ utc: m(10), raceNum: 5 }, { utc: m(90), raceNum: 6 }] }

  it('uses the event file when nothing has been tagged', () => {
    expect(effectiveGuns(xml, []).map(g => g.raceNum)).toEqual([5, 6])
    expect(effectiveGuns(xml, null).map(g => g.utc)).toEqual([m(10), m(90)])
  })

  it('once starts are tagged, THEY are the day’s races', () => {
    const tags = [
      { slug: 'race-start', t0: m(10), label: 'Race 5 start' },
      { slug: 'race-start', t0: m(90), label: 'Race 6 start' },
    ]
    expect(effectiveGuns(xml, tags).map(g => g.raceNum)).toEqual([5, 6])
  })

  it('a start deleted in the tagger takes its race with it', () => {
    // The second start has been removed — a general recall, or another class's gun.
    const tags = [{ slug: 'race-start', t0: m(10), label: 'Race 5 start' }]
    const guns = effectiveGuns(xml, tags)
    expect(guns).toHaveLength(1)
    expect(guns[0].utc).toBe(m(10))
    // And the race list follows: one race, not two.
    expect(raceOptions({ guns, dayStartUtc: m(0), dayStopUtc: m(180) }).map(r => r.raceNum)).toEqual([5])
  })

  it('numbers an unnamed start by its place in the day', () => {
    const tags = [{ slug: 'race-start', t0: m(90) }, { slug: 'race-start', t0: m(10) }]
    expect(startsFromTags(tags).map(g => [g.utc, g.raceNum])).toEqual([[m(10), 1], [m(90), 2]])
  })

  it('ignores tags that are not starts, and starts with no time', () => {
    expect(startsFromTags([{ slug: 'tack', t0: m(5) }, { slug: 'race-start' }])).toEqual([])
  })
})
