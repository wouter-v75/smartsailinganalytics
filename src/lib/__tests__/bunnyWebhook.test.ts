import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { verifyBunnySignature, cachedStatusFor, lowestVariants } from '../bunnyWebhook'

const secret = 'read-only-key'
const body = '{"VideoLibraryId":133,"VideoGuid":"657bb740-a71b-4529-a012-528021c31a92","Status":3}'
const sign = (b: string, k = secret) => crypto.createHmac('sha256', k).update(b).digest('hex')

describe('verifyBunnySignature', () => {
  it('accepts Bunny\'s signature over the exact raw body', () => {
    expect(verifyBunnySignature(body, sign(body), secret)).toBe(true)
    expect(verifyBunnySignature(body, sign(body).toUpperCase(), secret)).toBe(true)
  })
  it('rejects a re-serialised body, another key, or no signature', () => {
    expect(verifyBunnySignature(JSON.stringify(JSON.parse(body), null, 1), sign(body), secret)).toBe(false)
    expect(verifyBunnySignature(body, sign(body, 'other'), secret)).toBe(false)
    expect(verifyBunnySignature(body, null, secret)).toBe(false)
    expect(verifyBunnySignature(body, 'abc', secret)).toBe(false)
  })
})

describe('cachedStatusFor', () => {
  it('treats both "finished" and "resolution finished" as playable (API 4)', () => {
    expect(cachedStatusFor(3)).toBe(4)
    expect(cachedStatusFor(4)).toBe(4)
  })
  it('maps failure, and in-progress states to not-yet-playable', () => {
    expect(cachedStatusFor(5)).toBe(5)
    expect(cachedStatusFor(0)).toBe(2)
    expect(cachedStatusFor(2)).toBe(3)
  })
  it('ignores events unrelated to playback', () => {
    expect(cachedStatusFor(9)).toBeNull()
    expect(cachedStatusFor(7)).toBeNull()
  })
})

describe('lowestVariants', () => {
  it('picks the lightest rungs to warm, whatever order Bunny lists them in', () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4287731,RESOLUTION=1280x720
720p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2128606,RESOLUTION=854x480
480p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1203366,RESOLUTION=640x360
360p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=910686,RESOLUTION=426x240
240p/video.m3u8`
    expect(lowestVariants(master)).toEqual(['240p/video.m3u8', '360p/video.m3u8'])
  })
})
