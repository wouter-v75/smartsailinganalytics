// The seven duplicate groups that exist on the live library, 27 Nov 2026.
//
// Every one of these is here because an earlier version of the rule got it
// wrong, and the only thing that showed it was running the script against real
// rows. They are written with the real ids, sizes, durations, tag counts and
// import times so the regression is the actual case, not a sketch of it.

import { describe, it, expect } from 'vitest'
import { plan, copies, counts, describe as describeCopies } from '../videoRowDedupe'

/** A Stream library: guids listed here hold bytes, anything else does not. */
const lib = (...live: string[]) => (guid: string) => (live.includes(guid) ? 1 : 0)
const NONE = () => 0

const ST = ['northstar-76', 'st-tropez', 'racing;-winlee', 'tws-8-12kn', 'reach',
  'main_b 2026', 'j2_b 2026', 'spin-hoist', 'race']

describe('IMG 2894 — two rows, one dead guid, and the count cannot tell', () => {
  // 2026-06-27. Both rows: 137.9 MB, 72 s, a legacy bunny_stream_id and nothing
  // else, two tags each. Counting columns gives 1 and 1, so the old rule fell
  // through to "keep the oldest" — which has no idea that one of the two guids
  // points at a Stream video Bunny has deleted.
  const older = {
    id: '29c22acd-cae1-49fc-8c9a-46ff2bf03fa0', duration_ms: 72_000, bytes: 137_900_000,
    tags: ['northstar-76', 'training;-other'], created_at: '2026-07-01T06:39:00Z',
    bunny_stream_id: 'guid-older',
  }
  const newer = {
    id: '0b242746-ec75-4e71-aae1-7c2d66b3abf4', duration_ms: 72_000, bytes: 137_900_000,
    tags: ['northstar-76', 'training;-other'], created_at: '2026-07-01T06:54:00Z',
    bunny_stream_id: 'guid-newer',
  }

  it('keeps the row whose guid still resolves, even when it is the NEWER one', () => {
    const p = plan([older, newer], lib('guid-newer'))
    expect(p.verdict).toBe('safe')
    expect(p.keep?.id).toBe(newer.id)
    expect(p.why).toContain('most copies')
  })

  it('keeps the older one when that is the live one', () => {
    expect(plan([older, newer], lib('guid-older')).keep?.id).toBe(older.id)
  })

  it('falls back to the oldest only when BOTH really resolve', () => {
    const p = plan([older, newer], lib('guid-older', 'guid-newer'))
    expect(p.keep?.id).toBe(older.id)
    expect(p.why).toContain('oldest')
  })

  it('holds the group back when NEITHER resolves', () => {
    const p = plan([older, newer], NONE)
    expect(p.verdict).toBe('nothing-plays')
    expect(p.keep).toBeNull()
  })

  it('shows the dead copy as gone rather than omitting it', () => {
    expect(describeCopies(copies(older, lib('guid-newer')))).toBe('legacy✕')
    expect(describeCopies(copies(newer, lib('guid-newer')))).toBe('legacy✓')
  })
})

describe('11595 — one live row, three with no locator at all', () => {
  // 2026-07-12, 148.9 MB, 20 s each. Three of the four carry the same eight
  // tags, so nothing needs carrying; the fourth has none.
  const group = [
    { id: '1289a557', duration_ms: 20_000, tags: Array(8).fill(0).map((_, i) => `t${i}`),
      created_at: '2026-07-13T09:28:10Z', bunny_proxy_stream_id: 'live-proxy' },
    { id: '98f44b99', duration_ms: 20_000, tags: Array(8).fill(0).map((_, i) => `t${i}`),
      created_at: '2026-07-13T09:34:00Z' },
    { id: '11e27a69', duration_ms: 20_000, tags: Array(8).fill(0).map((_, i) => `t${i}`),
      created_at: '2026-07-13T09:28:40Z' },
    { id: 'c515f3d5', duration_ms: 20_000, tags: [], created_at: '2026-07-13T09:28:50Z' },
  ]

  it('keeps the one row with a copy and drops the other three', () => {
    const p = plan(group, lib('live-proxy'))
    expect(p.verdict).toBe('safe')
    expect(p.keep?.id).toBe('1289a557')
    expect(p.tagsToCarry).toEqual([])   // the tags are already on the keeper
  })
})

describe('11591 — nothing in this group plays', () => {
  // All four rows, 159.9 MB / 21 s, have no locator in any column. The old rule
  // ranked them anyway and picked the ONE row with no tags over three carrying
  // seven each, because created_at was the only tie-break left.
  const tagged = ['northstar-76', 'la-ciotat', 'training;-other', 'tws-0-8kn',
    'downwind', 'main_2026', 'race']
  const group = [
    { id: 'b2fb3caf', duration_ms: 21_000, tags: tagged, created_at: '2026-07-13T09:28:30Z' },
    { id: 'e3676726', duration_ms: 21_000, tags: [], created_at: '2026-07-13T09:28:10Z' },
    { id: '43514085', duration_ms: 21_000, tags: tagged, created_at: '2026-07-13T09:35:00Z' },
    { id: 'f6cf1a9f', duration_ms: 21_000, tags: tagged, created_at: '2026-07-13T09:30:00Z' },
  ]

  it('refuses to plan it at all', () => {
    const p = plan(group, NONE)
    expect(p.verdict).toBe('nothing-plays')
    expect(p.keep).toBeNull()
    expect(p.tagsToCarry).toEqual([])
    expect(p.note).toContain('no dedupe to do')
  })

  it('and so never proposes dropping the seven tags', () => {
    // The old output offered `delete ... where id in (b2fb3caf, 43514085,
    // f6cf1a9f)` while keeping the untagged e3676726.
    expect(plan(group, NONE).keep?.id).not.toBe('e3676726')
  })

  it('but DOES plan it once one row has a copy', () => {
    const withCopy = group.map((r) =>
      r.id === 'e3676726' ? { ...r, bunny_proxy_stream_id: 'p' } : r)
    const p = plan(withCopy, lib('p'))
    expect(p.verdict).toBe('safe')
    expect(p.keep?.id).toBe('e3676726')
    // …and then the tags must come with it.
    expect(p.tagsToCarry).toEqual(tagged)
  })
})

describe('the three real 29 Sept pairs — live copies one side, every tag the other', () => {
  // 134838, 150355, 150500. Identical bytes and duration on both rows; the
  // clips:day re-run made the modern pair of copies, the team's tags stayed on
  // the row from the first run.
  const first = {
    id: '734cf00c', duration_ms: 81_000, bytes: 77_200_000, tags: ST,
    created_at: '2026-09-30T07:36:00Z', bunny_stream_id: 'legacy-live',
  }
  const recut = {
    id: 'f6f0d998', duration_ms: 81_000, bytes: 77_200_000, tags: [],
    created_at: '2026-10-02T15:07:00Z',
    bunny_proxy_stream_id: 'p', bunny_original_stream_id: 'o',
  }

  it('keeps the row with TWO copies, not the one with the tags', () => {
    // The tags carry forward in one UPDATE; an HD ladder does not. A yes/no
    // liveness test ties here and would keep the legacy-only row.
    const p = plan([first, recut], lib('legacy-live', 'p', 'o'))
    expect(p.keep?.id).toBe(recut.id)
    expect(counts(copies(recut, lib('p', 'o'))).live).toBe(2)
  })

  it('and names every tag that would otherwise go with the dropped row', () => {
    const p = plan([first, recut], lib('legacy-live', 'p', 'o'))
    expect(p.tagsToCarry).toEqual(ST)
    expect(p.tagsToCarry).toHaveLength(9)
  })

  it('switches sides if the modern copies turn out to be gone', () => {
    const p = plan([first, recut], lib('legacy-live'))
    expect(p.keep?.id).toBe(first.id)
    expect(p.tagsToCarry).toEqual([])
  })
})

describe('20260929153553 — not a duplicate at all', () => {
  // 95.5 MB / 100 s against 85.8 MB / 90 s. CLAUDE.md records the 29 Sept pairs
  // as "bytes within 0.03 %", which is true of the other three and false here:
  // this is one moment cut with two different windows.
  const longer = {
    id: '2d13d03f', duration_ms: 100_000, bytes: 95_500_000,
    tags: ST.concat(['j1.5_b 2026', 'a2_b 2026', 'topmark']),
    created_at: '2026-09-30T07:36:00Z', bunny_stream_id: 'legacy-live',
  }
  const shorter = {
    id: 'dd022b49', duration_ms: 90_000, bytes: 85_800_000, tags: [],
    created_at: '2026-10-02T15:15:00Z',
    bunny_proxy_stream_id: 'p', bunny_original_stream_id: 'o',
  }

  it('is held back, because dropping the longer row loses ten seconds', () => {
    const p = plan([longer, shorter], lib('legacy-live', 'p', 'o'))
    expect(p.verdict).toBe('lengths-differ')
    expect(p.keep).toBeNull()
    expect(p.note).toContain('100 s')
    expect(p.note).toContain('90 s')
    expect(p.note).toContain('11.1 %')
  })

  it('tolerates encoder jitter — the same cut twice is still a duplicate', () => {
    // 0.03 % apart, which is what the other three pairs really are.
    const a = { ...longer, duration_ms: 81_000, bytes: 77_200_000 }
    const b = { ...shorter, duration_ms: 81_025, bytes: 77_223_000 }
    expect(plan([a, b], lib('legacy-live', 'p', 'o')).verdict).toBe('safe')
  })

  it('does not trip over a row with no duration recorded', () => {
    const a = { ...longer, duration_ms: null }
    const b = { ...shorter, duration_ms: 90_000 }
    expect(plan([a, b], lib('legacy-live', 'p', 'o')).verdict).toBe('safe')
  })
})

describe('a storage path is reported as unverified, never as proof', () => {
  it('counts it as a maybe and says so on the keeper', () => {
    const withPath = { id: 'a', duration_ms: 10_000, tags: [],
      created_at: '2026-01-01T00:00:00Z', bunny_proxy_path: 'proxies/x.mp4' }
    const bare = { id: 'b', duration_ms: 10_000, tags: [], created_at: '2026-01-02T00:00:00Z' }
    const p = plan([withPath, bare], NONE)
    expect(p.verdict).toBe('safe')
    expect(p.keep?.id).toBe('a')
    expect(p.note).toContain('does not probe')
    expect(describeCopies(copies(withPath, NONE))).toBe('proxyFile?')
  })

  it('treats a path of the invented shape as gone, not as a maybe', () => {
    // 0110's shape: no extension, nothing ever PUT it.
    const r = { id: 'a', bunny_original_path: 'sessions/2026-07-12/videos/abc/original' }
    expect(describeCopies(copies(r, NONE))).toBe('origFile✕')
    expect(counts(copies(r, NONE))).toEqual({ live: 0, maybe: 0 })
  })
})
