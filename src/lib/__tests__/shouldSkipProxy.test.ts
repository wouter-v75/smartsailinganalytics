import { describe, it, expect } from 'vitest'
import { shouldSkipProxy, PROXY_MAX_HEIGHT, PROXY_MAX_MBPS } from '../video-rendition-sync'

const clip = (height: number, mbps: number, durationSec = 60) => ({
  height, durationSec, bytes: (mbps * 1e6 * durationSec) / 8,
})

describe('shouldSkipProxy', () => {
  it('skips a clip the trim script already made — 720p at ~6 Mbps', () => {
    expect(shouldSkipProxy(clip(720, 6))).toBe(true)
  })

  it('skips smaller still', () => {
    expect(shouldSkipProxy(clip(540, 3))).toBe(true)
  })

  it('does NOT skip a 4K original — that is what the proxy is for', () => {
    expect(shouldSkipProxy(clip(2160, 80))).toBe(false)
    expect(shouldSkipProxy(clip(1080, 20))).toBe(false)
  })

  it('does NOT skip a 720p file that is absurdly fat', () => {
    // an intra-frame export can be 720p and 40 Mbps; re-encoding still pays
    expect(shouldSkipProxy(clip(720, 40))).toBe(false)
  })

  it('transcodes when it cannot measure the source — the safe direction', () => {
    // guessing wrong here costs time; guessing wrong the other way puts a 4K
    // original in front of every phone on the boat
    expect(shouldSkipProxy({ height: null, durationSec: 60, bytes: 1e6 })).toBe(false)
    expect(shouldSkipProxy({ height: 720, durationSec: null, bytes: 1e6 })).toBe(false)
    expect(shouldSkipProxy({ height: 720, durationSec: 60, bytes: null })).toBe(false)
    expect(shouldSkipProxy({ height: 0, durationSec: 60, bytes: 1e6 })).toBe(false)
    expect(shouldSkipProxy({ height: NaN, durationSec: 60, bytes: 1e6 })).toBe(false)
  })

  it('holds the boundaries exactly', () => {
    expect(shouldSkipProxy(clip(PROXY_MAX_HEIGHT, PROXY_MAX_MBPS))).toBe(true)
    expect(shouldSkipProxy(clip(PROXY_MAX_HEIGHT + 1, 6))).toBe(false)
    expect(shouldSkipProxy(clip(PROXY_MAX_HEIGHT, PROXY_MAX_MBPS + 0.1))).toBe(false)
  })

  it('a real day-8 clip: 58 MB, 60 s, 720p', () => {
    expect(shouldSkipProxy({ height: 720, durationSec: 60, bytes: 58e6 })).toBe(true)
  })
})
