import { describe, it, expect } from 'vitest'
import { renditionOrder } from '../renditionOrder'

describe('renditionOrder', () => {
  it('reaches for the original first on auto — desktop behaviour, unchanged', () => {
    expect(renditionOrder('auto')).toEqual(['originalHls', 'originalMp4', 'proxy', 'legacyStream', 'legacy'])
    expect(renditionOrder('original')).toEqual(['originalHls', 'originalMp4', 'proxy', 'legacyStream', 'legacy'])
  })

  it('puts the proxy first under prefer=proxy — unchanged', () => {
    expect(renditionOrder('proxy')).toEqual(['proxy', 'originalHls', 'originalMp4', 'legacyStream', 'legacy'])
  })

  it('hlsOnly asks for HD first, then the proxy, and keeps the MP4 as a floor', () => {
    // The whole point: HD when the ladder exists, the 720p proxy when it does
    // not, and the single-bitrate original only when nothing else is there.
    expect(renditionOrder('auto', true)).toEqual(['originalHls', 'proxy', 'originalMp4', 'legacyStream', 'legacy'])
  })

  it('NEVER drops a step — every order can still reach every form', () => {
    // This is the guard the design turns on. Removing originalMp4 for mobile
    // would silently un-play the ~370 rows that have an original and no proxy.
    const all: string[] = ['originalHls', 'proxy', 'originalMp4', 'legacyStream', 'legacy']
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

  it('tries the legacy era STREAM copy before its storage path', () => {
    // Both belong to the removed upload flow, but on 79 live rows the storage
    // path names an object nothing ever wrote while the Stream guid beside it
    // still plays. Asking Storage first served a signed 404.
    for (const order of [renditionOrder('auto'), renditionOrder('auto', true), renditionOrder('proxy')]) {
      expect(order.indexOf('legacyStream')).toBeLessThan(order.indexOf('legacy'))
    }
  })

  it('keeps BOTH legacy steps last — a real rendition always wins', () => {
    // A clip with a proxy must never be served the legacy copy just because it
    // has one. That was the 69.7 GB migration 0107 had to clear.
    for (const order of [renditionOrder('auto'), renditionOrder('auto', true), renditionOrder('proxy')]) {
      for (const live of ['originalHls', 'originalMp4', 'proxy']) {
        expect(order.indexOf(live)).toBeLessThan(order.indexOf('legacyStream'))
      }
    }
  })

  it('demotes originalMp4 below the proxy ONLY when hlsOnly is set', () => {
    const plain = renditionOrder('auto', false)
    const hls = renditionOrder('auto', true)
    expect(plain.indexOf('originalMp4')).toBeLessThan(plain.indexOf('proxy'))
    expect(hls.indexOf('originalMp4')).toBeGreaterThan(hls.indexOf('proxy'))
  })
})
