import { describe, it, expect } from 'vitest'
import { sailMedia, countSailMedia, hiddenMediaOf, toggleHidden, twsBand, allTwsBands, isVideo360, type SailMediaInput, type PhaseLite } from '../sailMedia'
import { SAIL_CHANGE_SLUG } from '../tagging/sailState'
import type { TagEvent } from '../tagging/types'

const D = '2026-09-11'
const T = (h: number, m: number, s = 0) =>
  Date.parse(`${D}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)
const iso = (t: number) => new Date(t).toISOString()

let n = 0
const change = (t0: number, up: { id?: string; name: string }[], over: Partial<TagEvent> = {}): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: D,
  tagDefId: null, slug: SAIL_CHANGE_SLUG, label: 'Sail change', color: '#F59E0B',
  scope: 'general', section: null, ownerUserId: null,
  t0, t1: t0, autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'human', producer: 'user', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: { sail: { up, onBoard: [], battens: [] } },
  ...over,
})

/** 30 s phases from a to b carrying `sails` at `tws`. */
const phases = (a: number, b: number, sails: string[], tws: number): PhaseLite[] => {
  const out: PhaseLite[] = []
  for (let t = a; t < b; t += 30_000) out.push({ utc: t, endUtc: t + 30_000, sails, tws })
  return out
}

const inventory = [
  { id: 'j2', name: 'J2', aliases: ['J2 2026'] },
  { id: 'j3', name: 'J3' },
  { id: 'main', name: 'Main' },
]

const base = (over: Partial<SailMediaInput>): SailMediaInput => ({
  sailId: 'j2', inventory, scans: [], photos: [], videos: [], days: {}, ...over,
})

describe('twsBand', () => {
  it('is 2 kn wide, centred on the even numbers', () => {
    expect(twsBand(11.9).label).toBe('12 kn')
    expect(twsBand(12.99).label).toBe('12 kn')
    expect(twsBand(13).label).toBe('14 kn')
    expect(twsBand(3).label).toBe('< 5 kn')
    expect(twsBand(30).label).toBe('25+ kn')
    expect(twsBand(null).key).toBe('unknown')
  })

  it('lists every band once, in order', () => {
    const b = allTwsBands()
    expect(b.map((x) => x.order)).toEqual([...b.map((x) => x.order)].sort((x, y) => x - y))
    expect(new Set(b.map((x) => x.key)).size).toBe(b.length)
  })
})

describe('isVideo360', () => {
  it('knows a 360 clip by its tag or its name, not by a 360p rendition', () => {
    expect(isVideo360({ tags: ['360'] })).toBe(true)
    expect(isVideo360({ title: 'VID_20260911_114300_00_012.insv' })).toBe(true)
    expect(isVideo360({ title: 'Insta360 masthead' })).toBe(true)
    expect(isVideo360({ title: 'drone start 1', tags: ['360p'] })).toBe(false)
    expect(isVideo360({ tags: ['360 video'] })).toBe(true)
    expect(isVideo360({ tags: ['360cam'] })).toBe(true)
    expect(isVideo360({ tags: ['Insta360'] })).toBe(true)
    expect(isVideo360({ tags: ['tack', '1360'] })).toBe(false)
  })
})

describe('sailMedia', () => {
  it('takes a scan filed to the sail, and an unfiled one whose code resolves to it', () => {
    const items = sailMedia(base({
      scans: [
        { id: 's1', sail_id: 'j2', captured_at: iso(T(11, 0)), tws_kn: 12 },
        { id: 's2', sail_id: null, captured_at: iso(T(11, 5)), conditions: { sail_code: 'j2 2026' } },
        { id: 's3', sail_id: 'j3', captured_at: iso(T(11, 5)) },
      ],
    }))
    expect(items.map((i) => i.id).sort()).toEqual(['s1', 's2'])
  })

  it('reads a tagged day from the tags ONLY — the event file cannot put a sail back up', () => {
    const items = sailMedia(base({
      photos: [{ id: 'p1', taken_utc: iso(T(12, 30)), date: D, sails: ['J2'] }],
      days: {
        [D]: {
          event: 'Worlds',
          tags: [change(T(11, 0), [{ id: 'j2', name: 'J2' }]), change(T(12, 0), [{ id: 'j3', name: 'J3' }])],
          // The phases still say J2 — the crew corrected it to J3 at 12:00.
          phases: phases(T(11, 0), T(13, 0), ['J2'], 12),
        },
      },
    }))
    expect(items).toEqual([])
  })

  it('falls back to the phases, then to the photo’s own sail list', () => {
    const items = sailMedia(base({
      photos: [
        { id: 'inPhase', taken_utc: iso(T(11, 10)), date: D },
        { id: 'noLog', taken_utc: iso(T(15, 0)), date: D, sails: ['J2 2026'], tws: 8 },
        { id: 'other', taken_utc: iso(T(15, 0)), date: D, sails: ['J3'] },
      ],
      days: { [D]: { event: null, tags: [], phases: phases(T(11, 0), T(12, 0), ['Main', 'J2'], 14.2) } },
    }))
    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(Object.keys(byId).sort()).toEqual(['inPhase', 'noLog'])
    expect(byId.inPhase.tws).toBe(14.2)   // TWS from the phase when the photo has none
    expect(byId.noLog.tws).toBe(8)
  })

  it('puts a measured frame under SailTrim, not Photos', () => {
    const items = sailMedia(base({
      photos: [{ id: 'p', taken_utc: iso(T(11, 10)), date: D, trim: true }],
      days: { [D]: { event: null, tags: [], phases: phases(T(11, 0), T(12, 0), ['J2'], 10) } },
    }))
    expect(items[0].kind).toBe('trim')
  })

  it('splits a clip by band and starts each entry where that stretch begins', () => {
    const items = sailMedia(base({
      videos: [{
        id: 'v', start_utc: iso(T(11, 0)), duration_ms: 10 * 60_000, date: D, title: 'RIB cam',
      }],
      days: {
        [D]: {
          event: null, tags: [],
          phases: [
            ...phases(T(11, 0), T(11, 3), ['J2'], 10),   // 3 min at 10 kn
            ...phases(T(11, 3), T(11, 7), ['J2'], 14),   // 4 min at 14 kn
            ...phases(T(11, 7), T(11, 10), ['J3'], 16),  // not ours
          ],
        },
      },
    }))
    expect(items.map((i) => [twsBand(i.tws).label, i.startSec, i.durSec]).sort()).toEqual([
      ['10 kn', 0, 180],
      ['14 kn', 180, 240],
    ])
    expect(items.every((i) => i.kind === 'video')).toBe(true)
  })

  it('applies the sync offset, so the start second is in CLIP time', () => {
    const items = sailMedia(base({
      // Clip clock 20 s behind the log: frame 0 is log 11:00:20.
      videos: [{ id: 'v', start_utc: iso(T(11, 0)), duration_ms: 120_000, sync_offset_secs: 20, date: D }],
      days: {
        [D]: {
          event: null, tags: [],
          phases: [...phases(T(11, 0), T(11, 1), ['J3'], 10), ...phases(T(11, 1), T(11, 3), ['J2'], 10)],
        },
      },
    }))
    expect(items).toHaveLength(1)
    expect(items[0].startSec).toBe(40)  // log 11:01:00 − 11:00:20
  })

  it('keeps one entry per clip per band — the longest stretch', () => {
    const items = sailMedia(base({
      videos: [{ id: 'v', start_utc: iso(T(11, 0)), duration_ms: 10 * 60_000, date: D, tags: ['360'] }],
      days: {
        [D]: {
          event: null, tags: [],
          phases: [
            ...phases(T(11, 0), T(11, 1), ['J2'], 12),
            ...phases(T(11, 1), T(11, 2), ['J3'], 12),
            ...phases(T(11, 2), T(11, 6), ['J2'], 12),
          ],
        },
      },
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'video360', startSec: 120, durSec: 240 })
  })

  it('reads a main off the phases only when the boat has one', () => {
    const day = { [D]: { event: null, tags: [], phases: phases(T(11, 0), T(12, 0), ['J2'], 10) } }
    const photos = [
      { id: 'bare', taken_utc: iso(T(11, 10)), date: D },
      { id: 'listed', taken_utc: iso(T(11, 20)), date: D, sails: ['Main', 'J2'] },
    ]
    const only = sailMedia(base({ sailId: 'main', main: 'only', photos, days: day }))
    expect(only.map((i) => i.id).sort()).toEqual(['bare', 'listed'])
    // Two mains: the phase cannot say which — only the photo's own list can.
    const several = sailMedia(base({ sailId: 'main', main: 'several', photos, days: day }))
    expect(several.map((i) => i.id)).toEqual(['listed'])
  })

  it('places a clip on a day with tags but no log, with its band unknown', () => {
    const items = sailMedia(base({
      videos: [{ id: 'v', start_utc: iso(T(11, 0)), duration_ms: 60_000, date: D }],
      days: { [D]: { event: 'Worlds', tags: [change(T(10, 0), [{ id: 'j2', name: 'J2' }])], phases: [] } },
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ tws: null, event: 'Worlds', startSec: 0 })
  })
})

describe('countSailMedia', () => {
  it('counts a clip once however many bands it spans, and trim frames as photos', () => {
    const items = sailMedia(base({
      photos: [
        { id: 'p1', taken_utc: iso(T(11, 1)), date: D },
        { id: 'p2', taken_utc: iso(T(11, 4)), date: D, trim: true },
      ],
      scans: [{ id: 's1', sail_id: 'j2', captured_at: iso(T(11, 0)) }],
      videos: [{ id: 'v', start_utc: iso(T(11, 0)), duration_ms: 6 * 60_000, date: D }],
      days: {
        [D]: { event: null, tags: [], phases: [...phases(T(11, 0), T(11, 3), ['J2'], 10), ...phases(T(11, 3), T(11, 6), ['J2'], 14)] },
      },
    }))
    expect(items.filter((i) => i.kind === 'video')).toHaveLength(2)  // two bands…
    expect(countSailMedia(items)).toEqual({ photos: 2, scans: 1, videos: 1, lidar: 0 })  // …one clip
  })

  it('finds the phase at a time among many (binary search), edges included', () => {
    const many = phases(T(8, 0), T(18, 0), ['J2'], 12)
    const items = sailMedia(base({
      photos: [
        { id: 'first', taken_utc: iso(T(8, 0)), date: D },
        { id: 'mid', taken_utc: iso(T(13, 17, 29)), date: D },
        { id: 'last', taken_utc: iso(T(17, 59, 59)), date: D },
        { id: 'after', taken_utc: iso(T(18, 0)), date: D },
      ],
      days: { [D]: { event: null, tags: [], phases: many } },
    }))
    expect(items.map((i) => i.id).sort()).toEqual(['first', 'last', 'mid'])
  })
})

describe('not relevant to this sail', () => {
  const day = { [D]: { event: null, tags: [], phases: phases(T(11, 0), T(11, 6), ['J2'], 12) } }
  const input = (hidden: string[]) => base({
    hidden,
    photos: [{ id: 'p1', taken_utc: iso(T(11, 1)), date: D }, { id: 'p2', taken_utc: iso(T(11, 2)), date: D }],
    scans: [{ id: 's1', sail_id: 'j2', captured_at: iso(T(11, 0)) }],
    videos: [{ id: 'v', start_utc: iso(T(11, 0)), duration_ms: 60_000, date: D }],
    days: day,
  })

  it('marks, rather than drops, what was hidden — and leaves it out of the counts', () => {
    const items = sailMedia(input(['p1', 'v']))
    expect(items.filter((i) => i.hidden).map((i) => i.id).sort()).toEqual(['p1', 'v'])
    expect(countSailMedia(items)).toEqual({ photos: 1, scans: 1, videos: 0, lidar: 0 })
  })

  it('does not hide a scan — a scan is refiled, not hidden', () => {
    expect(sailMedia(input(['s1'])).find((i) => i.id === 's1')?.hidden).toBeFalsy()
  })

  it('reads the list forgivingly and toggles it', () => {
    expect(hiddenMediaOf({ media_hidden: ['a', 3, '', 'b'] })).toEqual(['a', 'b'])
    expect(hiddenMediaOf(null)).toEqual([])
    expect(toggleHidden(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggleHidden(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(toggleHidden(['a'], 'a', true)).toBeNull()   // nothing to save
    expect(toggleHidden(['a'], 'b', false)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Lidar. Not one item per phase — thirty seconds is not a thing anyone opens —
// but one button per day and wind band, beside the SailScans it is compared to.
// ─────────────────────────────────────────────────────────────────────────────

/** Phases carrying lidar for the given sail kinds. */
const lidarPhases = (a: number, b: number, sails: string[], tws: number, kinds: ('mn'|'jib'|'spi')[]): PhaseLite[] =>
  phases(a, b, sails, tws).map((p) => ({ ...p, lidar: kinds }))

const day = (ph: PhaseLite[], tags: TagEvent[] = []) => ({ [D]: { event: 'Maxi Worlds', tags, phases: ph } })

describe('lidar in the sail media grid', () => {
  it('gives one button per wind band, counting the phases behind it', () => {
    const items = sailMedia(base({
      sailId: 'j2', lidarSail: 'jib',
      days: day([
        ...lidarPhases(T(11, 0), T(11, 5), ['J2'], 12, ['jib']),   // 10 phases at 12 kn
        ...lidarPhases(T(11, 5), T(11, 7), ['J2'], 18, ['jib']),   //  4 phases at 18 kn
      ]),
    })).filter((i) => i.kind === 'lidar')

    expect(items).toHaveLength(2)
    expect(items.map((i) => [twsBand(i.tws).label, i.phases])).toEqual(
      expect.arrayContaining([['12 kn', 10], ['18 kn', 4]]),
    )
    // …and it says which day and event it stands for.
    expect(items[0].date).toBe(D)
    expect(items[0].event).toBe('Maxi Worlds')
  })

  it('reads the MAIN off the main channels and the jib off the jib ones', () => {
    // The phases cannot say which main was up, but they can say the instrument
    // measured one — so a boat's only main takes them.
    const both = day(lidarPhases(T(11, 0), T(11, 2), ['J2'], 12, ['mn', 'jib']))
    const asJib = sailMedia(base({ sailId: 'j2', lidarSail: 'jib', days: both })).filter((i) => i.kind === 'lidar')
    const asMain = sailMedia(base({ sailId: 'main', lidarSail: 'mn', main: 'only', days: both })).filter((i) => i.kind === 'lidar')
    expect(asJib[0].phases).toBe(4)
    expect(asMain[0].phases).toBe(4)
  })

  it('ignores phases whose lidar is of the OTHER sail', () => {
    // A day the main's unit ran and the jib's did not says nothing about the jib.
    const items = sailMedia(base({
      sailId: 'j2', lidarSail: 'jib',
      days: day(lidarPhases(T(11, 0), T(11, 2), ['J2'], 12, ['mn'])),
    })).filter((i) => i.kind === 'lidar')
    expect(items).toHaveLength(0)
  })

  it('shows nothing at all for a sail no lidar measures', () => {
    // Without a kind there is no column — better than somebody else's numbers.
    const items = sailMedia(base({
      sailId: 'j2', days: day(lidarPhases(T(11, 0), T(11, 2), ['J2'], 12, ['jib'])),
    })).filter((i) => i.kind === 'lidar')
    expect(items).toHaveLength(0)
  })

  it('counts only the phases this sail was UP for', () => {
    // The same rule the photos use: a J3 phase is not the J2's lidar.
    const items = sailMedia(base({
      sailId: 'j2', lidarSail: 'jib',
      days: day([
        ...lidarPhases(T(11, 0), T(11, 2), ['J2'], 12, ['jib']),
        ...lidarPhases(T(11, 2), T(11, 6), ['J3'], 12, ['jib']),
      ]),
    })).filter((i) => i.kind === 'lidar')
    expect(items).toHaveLength(1)
    expect(items[0].phases).toBe(4)
  })

  it('obeys the day\'s TAGS over the event file, like everything else here', () => {
    // Tags are the crew's own state and win outright; the phases still say J2.
    const items = sailMedia(base({
      sailId: 'j2', lidarSail: 'jib',
      days: day(lidarPhases(T(11, 0), T(11, 4), ['J2'], 12, ['jib']), [change(T(10, 0), [{ id: 'j3', name: 'J3' }])]),
    })).filter((i) => i.kind === 'lidar')
    expect(items).toHaveLength(0)
  })

  it('counts PHASES in the sail-media total, not buttons', () => {
    // "3 lidar" reading as three days when it is three half-minutes would be
    // worse than not saying it.
    const items = sailMedia(base({
      sailId: 'j2', lidarSail: 'jib',
      days: day([
        ...lidarPhases(T(11, 0), T(11, 5), ['J2'], 12, ['jib']),
        ...lidarPhases(T(11, 5), T(11, 7), ['J2'], 18, ['jib']),
      ]),
    }))
    expect(countSailMedia(items).lidar).toBe(14)
  })
})
