import { describe, it, expect } from 'vitest'
import { parseDjiSrt, srtCandidates } from '../djiSrt'

// Verbatim from the Mavic 4 Pro card flown at Porto Cervo, 8 Sept 2026.
const MAVIC4 = `1
00:00:00,000 --> 00:00:00,040
<font size="28">FrameCnt: 1, DiffTime: 40ms
2026-09-08 12:11:54.466
[iso: 250] [shutter: 1/50.0] [fnum: 2.8] [ev: -1.0] [color_md: default] [focal_len: 28.00] [latitude: 41.182442] [longitude: 9.552726] [rel_alt: 121.558 abs_alt: 169.398] [ct: 7268, tint: 14] </font>

2
00:00:00,040 --> 00:00:00,079
<font size="28">FrameCnt: 2, DiffTime: 39ms
2026-09-08 12:11:54.507
[iso: 250] [shutter: 1/50.0] [fnum: 2.8] [ev: -1.0] [color_md: default] [focal_len: 28.00] [latitude: 41.182442] [longitude: 9.552726] [rel_alt: 121.558 abs_alt: 169.398] [ct: 7268, tint: 14] </font>

7374
00:04:54,837 --> 00:04:54,877
<font size="28">FrameCnt: 7374, DiffTime: 40ms
2026-09-08 12:16:49.303
[iso: 100] [shutter: 1/120.0] [fnum: 2.8] [ev: -0.3] [color_md: default] [focal_len: 28.00] [latitude: 41.186531] [longitude: 9.548051] [rel_alt: 129.553 abs_alt: 177.393] [ct: 7139, tint: 13] </font>
`

describe('parseDjiSrt — the Mavic 4 Pro card', () => {
  const r = parseDjiSrt(MAVIC4)!

  it('takes the first cue as the first frame, to the millisecond', () => {
    // The clip is DJI_20260908121154_…, i.e. the filename says 12:11:54 flat.
    // The real first frame is 0.466 s later — the filename is stamped when
    // recording is ARMED, which is why the sidecar is worth reading at all.
    expect(new Date(r.startMs).toISOString()).toBe('2026-09-08T12:11:54.466Z')
  })

  it('reports the aircraft clock against the video timebase', () => {
    // 12:16:49.303 - 12:11:54.466 = 294.837 s, and the last cue sits at
    // 00:04:54,837 = 294.837 s. Zero drift; the clock ran straight.
    expect(r.spanSec).toBeCloseTo(294.837, 3)
    expect(r.timelineSec).toBeCloseTo(294.837, 3)
    expect(r.driftSec).toBe(0)
  })

  it('reads the frame rate from DiffTime, and the fixes', () => {
    expect(r.fps).toBe(25)
    expect(r.firstFix).toEqual({ lat: 41.182442, lon: 9.552726 })
    expect(r.lastFix).toEqual({ lat: 41.186531, lon: 9.548051 })
  })
})

describe('parseDjiSrt — the other layouts DJI has shipped', () => {
  it('Phantom / older Mavic: comma fraction with microseconds appended', () => {
    const r = parseDjiSrt(`1
00:00:00,000 --> 00:00:00,033
<font size="36">FrameCnt: 1, DiffTime: 33ms
2019-08-15 10:34:22,123,456
[iso: 100] [shutter: 1/500] [latitude: 43.1] [longitude: 9.9]
`)!
    expect(new Date(r.startMs).toISOString()).toBe('2019-08-15T10:34:22.123Z')
    expect(r.fps).toBe(30)
  })

  it('accepts DJI\'s own misspelling of longitude', () => {
    // "longtitude" ships on real firmware. Rejecting it loses the fix entirely.
    const r = parseDjiSrt(`1
00:00:00,000 --> 00:00:00,040
2026-09-08 12:00:00.000
[latitude: 41.5] [longtitude: 9.5]
`)!
    expect(r.firstFix).toEqual({ lat: 41.5, lon: 9.5 })
  })

  it('very old firmware: dotted date, no fractional seconds', () => {
    const r = parseDjiSrt(`1
00:00:00,000 --> 00:00:01,000
2016.06.13 15:23:39
`)!
    expect(new Date(r.startMs).toISOString()).toBe('2016-06-13T15:23:39.000Z')
  })

  it('returns null rather than a wrong time for junk, empty or non-SRT input', () => {
    expect(parseDjiSrt('')).toBeNull()
    expect(parseDjiSrt('not a subtitle file at all')).toBeNull()
    // a well-formed SRT with no absolute stamp is still unusable to us
    expect(parseDjiSrt('1\n00:00:00,000 --> 00:00:01,000\nhello\n')).toBeNull()
  })

  it('rejects an out-of-range date instead of placing the clip in year 1', () => {
    expect(parseDjiSrt('1\n00:00:00,000 --> 00:00:01,000\n0001-01-01 00:00:00\n')).toBeNull()
  })
})

describe('srtCandidates', () => {
  it('tries both cases beside the clip', () => {
    expect(srtCandidates('/x/Day 7/DJI_0169_D.MP4')).toEqual([
      '/x/Day 7/DJI_0169_D.SRT', '/x/Day 7/DJI_0169_D.srt',
    ])
  })
  it('does not mistake a dot in the folder for the extension', () => {
    expect(srtCandidates('/x/day.7/clip.MP4')[0]).toBe('/x/day.7/clip.SRT')
  })
})
