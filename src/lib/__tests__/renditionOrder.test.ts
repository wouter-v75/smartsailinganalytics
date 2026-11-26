import { describe, it, expect } from 'vitest'
import { renditionOrder } from '../renditionOrder'

describe('renditionOrder', () => {
  it('reaches for the original first on auto — desktop behaviour, unchanged', () => {
    expect(renditionOrder('auto')).toEqual(['originalHls', 'originalMp4', 'proxy', 'legacy'])
    expect(renditionOrder('original')).toEqual(['originalHls', 'originalMp4', 'proxy', 'legacy'])
  })

  it('puts the proxy first under prefer=proxy — unchanged', () => {
    expect(renditionOrder('proxy')).toEqual(['proxy', 'originalHls', 'originalMp4', 'legacy'])
  })

  it('hlsOnly asks for HD first, then the proxy, and keeps the MP4 as a floor', () => {
    // The whole point: HD when the ladder exists, the 720p proxy when it does
    // not, and the single-bitrate original only when nothing else is there.
    expect(renditionOrder('auto', true)).toEqual(['originalHls', 'proxy', 'originalMp4', 'legacy'])
  })

  it('NEVER drops a step — every order can still reach every form', () => {
    // This is the guard the design turns on. Removing originalMp4 for mobile
    // would silently un-play the ~370 rows that have an original and no proxy.
    const all: string[] = ['originalHls', 'proxy', 'originalMp4', 'legacy']
    for (const order of [
      renditionOrder('auto'),
      renditionOrder('auto', true),
      renditionOrder('proxy'),
      renditionOrder('proxy', true),
      renditionOrder('original', true),
    ]) {
      expect([...order].sort()).toEqual([...all].sort())
    }
  })

  it('hlsOnly changes nothing under prefer=proxy, which already leads with it', () => {
    expect(renditionOrder('proxy', true)).toEqual(renditionOrder('proxy', false))
  })

  it('demotes originalMp4 below the proxy ONLY when hlsOnly is set', () => {
    const plain = renditionOrder('auto', false)
    const hls = renditionOrder('auto', true)
    expect(plain.indexOf('originalMp4')).toBeLessThan(plain.indexOf('proxy'))
    expect(hls.indexOf('originalMp4')).toBeGreaterThan(hls.indexOf('proxy'))
  })
})
