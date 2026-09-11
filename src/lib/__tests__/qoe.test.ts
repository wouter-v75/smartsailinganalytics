import { describe, it, expect } from 'vitest'
import { createQoe, platformOf, sanitizeQoe } from '../qoe'

const clock = (start = 1_000) => {
  let t = start
  return { now: () => t, at: (ms: number) => { t = ms } }
}

describe('createQoe', () => {
  it('measures time to first frame from the tap, not from opening the clip', () => {
    const c = clock()
    const q = createQoe({ clip: 'c1', platform: 'iphone' }, c.now)
    c.at(4_000); q.tap()
    c.at(5_200); q.playing()
    c.at(9_200); q.pause()
    const p = q.take()!
    expect(p.outcome).toBe('played')
    expect(p.ttff_ms).toBe(1_200)
    expect(p.watch_ms).toBe(4_000)
  })

  it('counts stalls after the first frame as rebuffering, but not seeks', () => {
    const c = clock()
    const q = createQoe({ clip: 'c1' }, c.now)
    q.tap(); c.at(1_500); q.playing()
    c.at(3_000); q.waiting()            // stall
    c.at(5_000); q.playing()            // 2 s rebuffer
    c.at(6_000); q.seeking(true); q.waiting()
    c.at(9_000); q.seeking(false); q.playing()
    c.at(10_000)
    const p = q.take()!
    expect(p.rebuffer_count).toBe(1)
    expect(p.rebuffer_ms).toBe(2_000)
  })

  it('ends a stall when the viewer pauses', () => {
    const c = clock()
    const q = createQoe({ clip: 'c1' }, c.now)
    q.tap(); c.at(1_100); q.playing()
    c.at(2_000); q.waiting()
    c.at(2_500); q.pause()
    c.at(60_000)
    expect(q.take()!.rebuffer_ms).toBe(500)
  })

  it('reports leaving before the first frame', () => {
    const c = clock()
    const q = createQoe({ clip: 'c1' }, c.now)
    q.tap(); c.at(8_000)
    const p = q.take()!
    expect(p.outcome).toBe('exited_before_start')
    expect(p.ttff_ms).toBeNull()
  })

  it('reports a failure even when the viewer never pressed play', () => {
    const q = createQoe({ clip: 'c1' }, clock().now)
    q.fail('no-link')
    expect(q.take()).toMatchObject({ outcome: 'failed', error: 'no-link' })
  })

  it('sends nothing for a clip that was only looked at', () => {
    expect(createQoe({ clip: 'c1' }, clock().now).take()).toBeNull()
  })

  it('sends once', () => {
    const q = createQoe({ clip: 'c1', autoplay: true }, clock().now)
    expect(q.take()).not.toBeNull()
    expect(q.take()).toBeNull()
  })
})

describe('platformOf', () => {
  it('tells iPhone, iPad (which claims to be a Mac), Android and desktop apart', () => {
    expect(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toBe('iphone')
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ipad')
    expect(platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android')
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('desktop')
  })
})

describe('sanitizeQoe', () => {
  it('keeps known fields, bounded', () => {
    const row = sanitizeQoe({ clip: 'c1', outcome: 'played', ttff_ms: 1234.4, watch_ms: 9e12, error: 'x'.repeat(500), evil: 1 })!
    expect(row.ttff_ms).toBe(1234)
    expect(row.watch_ms).toBe(3_600_000)
    expect(row.error!.length).toBe(200)
    expect(row).not.toHaveProperty('evil')
  })
  it('rejects rows without a clip or a known outcome', () => {
    expect(sanitizeQoe({ outcome: 'played' })).toBeNull()
    expect(sanitizeQoe({ clip: 'c1', outcome: 'maybe' })).toBeNull()
    expect(sanitizeQoe('nope')).toBeNull()
  })
})
