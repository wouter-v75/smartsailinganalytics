import { describe, it, expect } from 'vitest'
import { isDroneClip } from '../DayTimeline'

describe('isDroneClip — which deck a video belongs in', () => {
  it('recognises the two shapes drone clips actually arrive in', () => {
    // Straight off the card, and after the clip pipeline has renamed a segment.
    expect(isDroneClip({ title: 'DJI_20260903131023_0067_D' })).toBe(true)
    expect(isDroneClip({ title: '20260903130935_topmark_day2_DJI-001' })).toBe(true)
  })

  it('pins the underscore bug: \\b would have failed BOTH of those', () => {
    // Underscore is a word character, so \b(dji)\b matches neither "DJI_2026…"
    // nor "…_DJI-001", and every drone clip would have shown as onboard.
    const wrong = /\b(dji|drone|mavic|osmo)\b/i
    expect(wrong.test('DJI_20260903131023_0067_D')).toBe(false)
    expect(wrong.test('20260903130935_topmark_day2_DJI-001')).toBe(false)
  })

  it('matches the title SSA actually STORES, not just the filename', () => {
    // Import rewrites the name: `pv.name.replace(/\.[^.]+$/,'').replace(/[_-]/g,' ')`,
    // so underscores and hyphens become spaces before this ever runs. Testing only
    // the on-disk filename would have missed whether the stored form still matches.
    const stored = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')
    expect(isDroneClip({ title: stored('20260903123130_topmark_day2_DJI-001.mp4') })).toBe(true)
    expect(isDroneClip({ title: stored('DJI_20260903131023_0067_D.MP4') })).toBe(true)
    expect(isDroneClip({ title: stored('20260904 133735.mp4') })).toBe(false)
  })

  it('leaves RIB and onboard clips in the Videos deck', () => {
    // Today's footage is all RIB — short clips named by wall clock, no vendor.
    expect(isDroneClip({ title: '20260904 133735' })).toBe(false)
    expect(isDroneClip({ title: '20260903_125443' })).toBe(false)
    expect(isDroneClip({ title: '20260904145127_tack_day3_compressed' })).toBe(false)
  })

  it('honours an explicit drone tag, whatever the name', () => {
    expect(isDroneClip({ title: 'Race 2 start', tags: ['drone'] })).toBe(true)
    expect(isDroneClip({ title: 'Race 2 start', tags: ['DRONE'] })).toBe(true)
    expect(isDroneClip({ title: 'Race 2 start', tags: ['topmark'] })).toBe(false)
  })

  it('does not guess from ordinary words', () => {
    for (const t of ['Windward mark', 'Drop practice', 'Mainsail trim', 'Gybe set', ''])
      expect(isDroneClip({ title: t })).toBe(false)
  })

  it('survives a missing title or tags', () => {
    expect(isDroneClip({})).toBe(false)
    expect(isDroneClip({ title: null })).toBe(false)
    expect(isDroneClip({ title: undefined, tags: undefined })).toBe(false)
  })
})
