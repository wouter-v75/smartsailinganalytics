import { describe, it, expect } from 'vitest'
import { reorderMaster, signMaster, verifyMaster, masterPath } from '../hlsMaster'

// The shape Bunny Stream serves today (measured 11 Sept): highest rung first.
const BUNNY_MASTER = `#EXTM3U
#EXT-X-VERSION:4

#EXT-X-STREAM-INF:BANDWIDTH=4287731,AVERAGE-BANDWIDTH=3858757,VIDEO-RANGE=SDR,CODECS="avc1.640020",RESOLUTION=1280x720,FRAME-RATE=50.000,CLOSED-CAPTIONS=NONE
720p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2128606,AVERAGE-BANDWIDTH=1913657,VIDEO-RANGE=SDR,CODECS="avc1.64001f",RESOLUTION=854x480,FRAME-RATE=30.000,CLOSED-CAPTIONS=NONE
480p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1203366,AVERAGE-BANDWIDTH=1095515,VIDEO-RANGE=SDR,CODECS="avc1.64001e",RESOLUTION=640x360,FRAME-RATE=30.000,CLOSED-CAPTIONS=NONE
360p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=910686,AVERAGE-BANDWIDTH=560000,VIDEO-RANGE=SDR,CODECS="avc1.640015",RESOLUTION=426x240,FRAME-RATE=30.000,CLOSED-CAPTIONS=NONE
240p/video.m3u8
`
const BASE = 'https://vz-test.b-cdn.net/0b4a81af-1111-2222-3333-444455556666'

const uris = (m: string) => m.split('\n').filter((l) => l && !l.startsWith('#'))

describe('reorderMaster', () => {
  const out = reorderMaster(BUNNY_MASTER, BASE)

  it('puts a light rung first, so an iPhone no longer starts at 720p', () => {
    expect(uris(out)[0]).toBe(`${BASE}/360p/video.m3u8`)
  })
  it('keeps every rung, so the iPhone can still adapt up to 720p', () => {
    expect(uris(out).sort()).toEqual(
      ['240p', '360p', '480p', '720p'].map((r) => `${BASE}/${r}/video.m3u8`).sort(),
    )
  })
  it('keeps each rung paired with its own STREAM-INF line', () => {
    const lines = out.split('\n')
    const i = lines.indexOf(`${BASE}/720p/video.m3u8`)
    expect(lines[i - 1]).toContain('RESOLUTION=1280x720')
  })
  it('keeps the header', () => {
    expect(out.startsWith('#EXTM3U\n#EXT-X-VERSION:4\n')).toBe(true)
  })
  it('falls back to the lowest rung when none fits the target', () => {
    expect(uris(reorderMaster(BUNNY_MASTER, BASE, 100_000))[0]).toBe(`${BASE}/240p/video.m3u8`)
  })
  it('makes a single-rung media playlist absolute rather than breaking it', () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nvideo0.ts\n#EXT-X-ENDLIST\n'
    expect(uris(reorderMaster(media, BASE))).toEqual([`${BASE}/video0.ts`])
  })
})

describe('signed master link', () => {
  const secret = 'test-secret'
  const guid = '0b4a81af-1111-2222-3333-444455556666'
  const now = 1_800_000_000

  it('verifies its own signature until it expires', () => {
    const { path, expires } = masterPath(guid, secret, 3600, now)
    const q = new URL(path, 'https://app.example').searchParams
    expect(Number(q.get('e'))).toBe(expires)
    expect(verifyMaster(guid, expires, q.get('s')!, secret, now)).toBe(true)
    expect(verifyMaster(guid, expires, q.get('s')!, secret, expires + 1)).toBe(false)
  })
  it('rejects a signature for another clip, a changed expiry or another key', () => {
    const e = now + 60
    const s = signMaster(guid, e, secret)
    expect(verifyMaster('ffffffff-1111-2222-3333-444455556666', e, s, secret, now)).toBe(false)
    expect(verifyMaster(guid, e + 3600, s, secret, now)).toBe(false)
    expect(verifyMaster(guid, e, s, 'other-secret', now)).toBe(false)
    expect(verifyMaster(guid, e, '', secret, now)).toBe(false)
  })
})
