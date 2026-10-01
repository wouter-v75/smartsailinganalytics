import { describe, it, expect } from 'vitest'
import {
  fileAt, isProxyName, isVideoName, nextFileFrom, pairFootage, parseDjiStamp,
  playableName, proxyCount, stemOf, toUtc,
} from '../droneProxy'

// The 30 September card, in miniature.
const NAMES = [
  'DJI_20260930141950_0001_D.MP4', 'DJI_20260930141950_0001_D.LRF',
  'DJI_20260930142523_0002_D.MP4', 'DJI_20260930142523_0002_D.LRF',
  'DJI_20260930144334_0004_D.MP4',                                  // no proxy
  'DJI_20260930144334_0004_D.SRT',                                  // not video
  '.DS_Store',
]
const TZ = 120   // St Tropez, UTC+2
const U = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 30, h, m, s) - TZ * 60_000

describe('names', () => {
  it('knows a video, a proxy and neither', () => {
    expect(isVideoName('a.MP4')).toBe(true)
    expect(isVideoName('a.mov')).toBe(true)
    expect(isProxyName('a.LRF')).toBe(true)
    expect(isProxyName('a.lrf')).toBe(true)
    expect(isVideoName('a.LRF')).toBe(false)
    expect(isProxyName('a.SRT')).toBe(false)
  })
  it('takes the stem the original and the proxy share', () => {
    expect(stemOf('DJI_20260930141950_0001_D.MP4')).toBe('DJI_20260930141950_0001_D')
    expect(stemOf('DJI_20260930141950_0001_D.LRF')).toBe('DJI_20260930141950_0001_D')
  })
})

describe('parseDjiStamp', () => {
  it('reads the filename stamp as LOCAL wall time', () => {
    // Not UTC. The card writes venue time, which is why toUtc takes an offset.
    expect(parseDjiStamp('DJI_20260930141950_0001_D.MP4'))
      .toBe(Date.UTC(2026, 8, 30, 14, 19, 50))
  })
  it('is null for a name with no stamp', () => {
    expect(parseDjiStamp('clip.mp4')).toBeNull()
    expect(parseDjiStamp('')).toBeNull()
  })
  it('converts to a real instant only when given the offset', () => {
    const local = parseDjiStamp('DJI_20260930141950_0001_D.MP4')!
    expect(toUtc(local, 120)).toBe(Date.UTC(2026, 8, 30, 12, 19, 50))
    expect(toUtc(local, 0)).toBe(local)
  })
})

describe('pairFootage', () => {
  const files = pairFootage(NAMES, TZ)

  it('pairs each clip with its camera proxy', () => {
    expect(files).toHaveLength(3)
    expect(files[0].proxyName).toBe('DJI_20260930141950_0001_D.LRF')
    expect(files[2].proxyName).toBeNull()
  })

  it('ignores the SRT, the dotfile and the proxies themselves', () => {
    expect(files.map((f) => f.videoName).every((n) => n.endsWith('.MP4'))).toBe(true)
  })

  it('places each clip in true UTC', () => {
    expect(files[0].startUtc).toBe(U(14, 19, 50))
  })

  it('orders by TIME, not by name', () => {
    // `_0001` restarts on a second flight, so the names sort wrongly.
    const two = pairFootage([
      'DJI_20260930160000_0001_D.MP4',
      'DJI_20260930080000_0009_D.MP4',
    ], TZ)
    expect(two[0].videoName).toContain('0800')
  })

  it('drops a file with no readable stamp rather than guessing', () => {
    // A guessed second lands on the wrong part of the track, which is worse
    // than the clip not appearing.
    expect(pairFootage(['holiday.mp4'], TZ)).toEqual([])
  })

  it('plays the proxy when there is one, the original when there is not', () => {
    expect(playableName(files[0])).toBe('DJI_20260930141950_0001_D.LRF')
    expect(playableName(files[2])).toBe('DJI_20260930144334_0004_D.MP4')
  })

  it('counts the proxies, because "review is slow" has one likely cause', () => {
    expect(proxyCount(files)).toBe(2)
  })
})

describe('fileAt', () => {
  const files = pairFootage(NAMES, TZ).map((f, i) => ({ ...f, durationSec: i === 0 ? 297 : 26 }))

  it('finds the file holding an instant, and how far in', () => {
    const hit = fileAt(files, U(14, 21, 50))
    expect(hit?.file.videoName).toContain('141950')
    expect(hit?.offsetSec).toBeCloseTo(120, 3)
  })

  it('is null in a gap — the drone was on the deck', () => {
    expect(fileAt(files, U(14, 35, 0))).toBeNull()
  })

  it('does not let an unmeasured file swallow a seek', () => {
    // Treating "no duration yet" as "covers everything" would open the wrong
    // clip for every press until the metadata arrived.
    const unmeasured = pairFootage(NAMES, TZ)
    expect(fileAt(unmeasured, U(14, 21, 50))).toBeNull()
  })

  it('allows a little slack at the very start of a clip', () => {
    // Clicking the first pixel of a green band means "play this", not "nothing".
    expect(fileAt(files, U(14, 19, 49))).not.toBeNull()
    expect(fileAt(files, U(14, 19, 40))).toBeNull()
  })

  it('stops at the end of a clip rather than running past it', () => {
    expect(fileAt(files, U(14, 24, 46))).not.toBeNull()  // 297s runs to 14:24:47
    expect(fileAt(files, U(14, 24, 47))).toBeNull()
  })
})

describe('nextFileFrom', () => {
  const files = pairFootage(NAMES, TZ)
  it('finds where filming picks up again after a gap', () => {
    expect(nextFileFrom(files, U(14, 30, 0))?.videoName).toContain('144334')
  })
  it('is null past the last clip', () => {
    expect(nextFileFrom(files, U(23, 0, 0))).toBeNull()
  })
})
