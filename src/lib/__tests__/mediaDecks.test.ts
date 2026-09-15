import { describe, it, expect } from 'vitest'
import { MEDIA_COLOURS, MEDIA_LABELS, isSpan, mediaMarks, isDroneClip } from '../mediaDecks'

const T = (h: number, m: number) => Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
const iso = (t: number) => new Date(t).toISOString()

describe('the four decks', () => {
  it('names a colour for every kind, and no two the same', () => {
    const cs = Object.values(MEDIA_COLOURS)
    expect(cs).toHaveLength(4)
    expect(new Set(cs).size).toBe(4)
    for (const c of cs) expect(c).toMatch(/^#[0-9A-F]{6}$/i)
  })

  it('names all four', () => {
    expect(Object.keys(MEDIA_LABELS).sort()).toEqual(['drone', 'photo', 'sailscan', 'video'])
  })

  it('knows which ones cover a stretch of water', () => {
    // "Was this manoeuvre filmed" is a question about a WINDOW; a clip drawn as
    // a dot answers it wrongly.
    expect(isSpan('video')).toBe(true)
    expect(isSpan('drone')).toBe(true)
    expect(isSpan('photo')).toBe(false)
    expect(isSpan('sailscan')).toBe(false)
  })
})

describe('mediaMarks', () => {
  it('turns a clip into the window it covers', () => {
    const [m] = mediaMarks({ videos: [{ id: 'v1', start_utc: iso(T(12, 0)), duration: 120, title: 'Onboard' }] })
    expect(m.kind).toBe('video')
    expect(m.t1 - m.t0).toBe(120_000)
  })

  it('sends a DJI clip to the drone deck', () => {
    const [m] = mediaMarks({ videos: [{ id: 'v1', start_utc: iso(T(12, 0)), duration: 60, title: 'DJI_20260911120000_0036_D' }] })
    expect(m.kind).toBe('drone')
  })

  it('still shows a clip whose duration has not loaded yet', () => {
    // Duration arrives asynchronously after import. Dropping the clip until it
    // does means a freshly imported day looks like a day nobody filmed.
    const [m] = mediaMarks({ videos: [{ id: 'v1', start_utc: iso(T(12, 0)) }] })
    expect(m).toBeTruthy()
    expect(m.t1).toBe(m.t0)
  })

  it('takes photos and scans as instants', () => {
    const out = mediaMarks({
      photos: [{ id: 'p1', taken_utc: iso(T(12, 30)) }],
      scans: [{ id: 's1', captured_at: iso(T(13, 0)), conditions: { sail_code: 'M-2026' } }],
    })
    expect(out.map((m) => m.kind)).toEqual(['photo', 'sailscan'])
    expect(out[0].t0).toBe(out[0].t1)
    expect(out[1].title).toBe('M-2026')
  })

  it('drops a row with no usable time rather than drawing it at the epoch', () => {
    // On a track, 1970 is not "off the end" — it snaps to the first point of the
    // day, which is a lie somebody would act on.
    const out = mediaMarks({
      videos: [{ id: 'v1', start_utc: null, duration: 60 }],
      photos: [{ id: 'p1', taken_utc: 'not a date' }],
      scans: [{ id: 's1', captured_at: undefined }],
    })
    expect(out).toEqual([])
  })

  it('accepts a time that is already a number', () => {
    const [m] = mediaMarks({ photos: [{ id: 'p1', taken_utc: T(12, 30) }] })
    expect(m.t0).toBe(T(12, 30))
  })

  it('comes back in the order the day happened', () => {
    const out = mediaMarks({
      photos: [{ id: 'p2', taken_utc: iso(T(14, 0)) }, { id: 'p1', taken_utc: iso(T(11, 0)) }],
    })
    expect(out.map((m) => m.id)).toEqual(['p:p1', 'p:p2'])
  })

  it('gives every mark a unique id across the three sources', () => {
    const out = mediaMarks({
      videos: [{ id: '1', start_utc: iso(T(12, 0)), duration: 10 }],
      photos: [{ id: '1', taken_utc: iso(T(12, 1)) }],
      scans: [{ id: '1', captured_at: iso(T(12, 2)) }],
    })
    expect(new Set(out.map((m) => m.id)).size).toBe(3)
  })

  it('survives being handed nothing', () => {
    expect(mediaMarks({})).toEqual([])
  })
})

describe('isDroneClip still reads the name', () => {
  it('matches the two shapes drone clips actually arrive in', () => {
    expect(isDroneClip({ title: 'DJI_20260903115026_0036_D' })).toBe(true)
    expect(isDroneClip({ title: '20260903130935_topmark_day2_DJI-001' })).toBe(true)
    expect(isDroneClip({ title: '20260904 133735' })).toBe(false)
  })
})
