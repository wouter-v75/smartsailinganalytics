import { describe, it, expect } from 'vitest'
import {
  snapTag, snapAll, nextDetection, candidateScore, compatibleSlugs,
  DEFAULT_SNAP_OPTIONS,
} from '../snap'
import type { Detection } from '../detect'

const T0 = Date.parse('2026-09-11T12:00:00Z')
const S = (secs: number) => T0 + secs * 1000

const det = (secs: number, slug = 'tack', over: Partial<Detection> = {}): Detection => ({
  key: `k:${slug}:${secs}`,
  slug: slug as Detection['slug'],
  label: slug,
  t0: S(secs), t1: S(secs) + 20,
  segmentKey: 'r1', raceNum: 1,
  confidence: 0.8, producer: 'manoeuvres',
  ...over,
})

const tag = (secs: number, slug = 'tack') => ({ t0: S(secs), t1: S(secs), slug })

describe('snapTag — people press late', () => {
  it('prefers the detection BEFORE the press over an equally near one after', () => {
    // 4 s before vs 4 s after. Symmetric "nearest" would call this a tie;
    // pressing late means the earlier one is almost always what was meant.
    const out = snapTag(tag(100), [det(96), det(104)])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.detection.t0).toBe(S(96))
  })

  it('reaches a long way back but barely forward', () => {
    expect(snapTag(tag(100), [det(75)]).ok).toBe(true)     // 25 s back — fine
    expect(snapTag(tag(100), [det(110)]).ok).toBe(false)   // 10 s forward — too far
  })

  it('declines outside the radius, and says why', () => {
    const out = snapTag(tag(100), [det(20)])
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toContain('30s')
      expect(out.reason).toContain('tack')
    }
  })

  it('declines when nothing of that kind exists at all, and says so differently', () => {
    const out = snapTag(tag(100, 'gybe'), [det(99, 'tack')])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('No gybe detected on this day')
  })

  it('reports the move rather than performing it', () => {
    const out = snapTag(tag(100), [det(96)])
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.fromT0).toBe(S(100))
      expect(out.result.toT0).toBe(S(96))
      expect(out.result.deltaMs).toBe(-4000)
    }
  })

  it('aims at the anchor it is told to', () => {
    const d = det(96, 'tack', { t0: S(96), t1: S(120) })
    const start = snapTag(tag(100), [d], { anchor: 'start' })
    const end = snapTag(tag(100), [d], { anchor: 'end' })
    const mid = snapTag(tag(100), [d], { anchor: 'middle' })
    if (start.ok && end.ok && mid.ok) {
      expect(start.result.toT0).toBe(S(96))
      expect(end.result.toT0).toBe(S(120))
      expect(mid.result.toT0).toBe(S(108))
    } else throw new Error('expected all three to snap')
  })

  it('breaks a tie on the detector’s own confidence', () => {
    const weak = det(96, 'tack', { key: 'weak', confidence: 0.3 })
    const strong = det(96, 'tack', { key: 'strong', confidence: 0.95 })
    const out = snapTag(tag(100), [weak, strong])
    if (out.ok) expect(out.result.detection.key).toBe('strong')
    else throw new Error('expected a snap')
  })

  it('prefers an exact kind over a family member', () => {
    const out = snapTag(tag(100, 'mark'), [det(94, 'topmark'), det(95, 'mark')])
    if (out.ok) expect(out.result.detection.slug).toBe('mark')
    else throw new Error('expected a snap')
  })

  it('lets a catch-all tag land on anything', () => {
    expect(compatibleSlugs('review')).toBeNull()
    const out = snapTag(tag(100, 'review'), [det(97, 'gybe')])
    expect(out.ok).toBe(true)
  })

  it('honours strict mode', () => {
    expect(snapTag(tag(100, 'review'), [det(97, 'gybe')], { strict: true }).ok).toBe(false)
    expect(snapTag(tag(100, 'mark'), [det(97, 'topmark')], { strict: true }).ok).toBe(false)
  })

  it('honours an explicit slug list', () => {
    const out = snapTag(tag(100, 'review'), [det(97, 'gybe'), det(98, 'tack')], { slugs: ['tack'] })
    if (out.ok) expect(out.result.detection.slug).toBe('tack')
    else throw new Error('expected a snap')
  })

  it('survives junk', () => {
    expect(snapTag(tag(100), []).ok).toBe(false)
    expect(snapTag({ t0: NaN, t1: NaN, slug: 'tack' }, [det(96)]).ok).toBe(false)
  })

  it('has a back window six times the forward one', () => {
    // The asymmetry is the whole point; guard it against a well-meaning tidy-up.
    expect(DEFAULT_SNAP_OPTIONS.backMs).toBeGreaterThan(DEFAULT_SNAP_OPTIONS.fwdMs * 3)
  })
})

describe('candidateScore', () => {
  const o = { ...DEFAULT_SNAP_OPTIONS }

  it('scores a detection before the press above the mirror image after it', () => {
    const before = candidateScore(S(100), det(96), 'tack', o)
    const after = candidateScore(S(100), det(104), 'tack', o)
    expect(before).toBeGreaterThan(after)
  })

  it('returns -1 outside the window or for the wrong kind', () => {
    expect(candidateScore(S(100), det(0), 'tack', o)).toBe(-1)
    expect(candidateScore(S(100), det(96, 'gybe'), 'tack', o)).toBe(-1)
  })

  it('falls off with distance on both sides', () => {
    expect(candidateScore(S(100), det(98), 'tack', o))
      .toBeGreaterThan(candidateScore(S(100), det(80), 'tack', o))
  })
})

describe('snapAll — no crossings, no double-booking', () => {
  it('never gives one detection to two tags', () => {
    // Both tags sit near the same detection; only one may have it.
    const out = snapAll([tag(100), tag(102)], [det(98)])
    const used = out.filter((e) => e.result).map((e) => e.result!.detection.key)
    expect(new Set(used).size).toBe(used.length)
    expect(used).toHaveLength(1)
    expect(out.find((e) => !e.result)!.reason).toBe('Taken by a neighbouring tag')
  })

  it('keeps tags in order — the assignment cannot cross', () => {
    const out = snapAll([tag(100), tag(140)], [det(96), det(136)])
    const matched = out.filter((e) => e.result)
    expect(matched).toHaveLength(2)
    expect(matched[0].result!.detection.t0).toBeLessThan(matched[1].result!.detection.t0)
  })

  it('beats greedy where greedy would cross', () => {
    // Greedy: tag A (t=100) grabs the nearer det at 99; tag B (t=104) is then
    // left with only the det at 98 — earlier than A's, i.e. crossed over.
    const out = snapAll([tag(100), tag(104)], [det(98), det(99)])
    const matched = out.filter((e) => e.result).map((e) => e.result!.detection.t0)
    expect(matched).toEqual([S(98), S(99)])
  })

  it('leaves a tag alone rather than forcing a bad match', () => {
    const out = snapAll([tag(100), tag(500)], [det(98)])
    expect(out[0].result).toBeTruthy()
    expect(out[1].result).toBeNull()
  })

  it('handles a realistic race in order', () => {
    const tags = [tag(60, 'race-start'), tag(200, 'tack'), tag(400, 'tack'), tag(600, 'topmark')]
    const dets = [det(55, 'race-start'), det(190, 'tack'), det(395, 'tack'), det(590, 'topmark')]
    const out = snapAll(tags, dets)
    expect(out.every((e) => e.result)).toBe(true)
    expect(out.map((e) => e.result!.deltaMs)).toEqual([-5000, -10_000, -5000, -10_000])
  })

  it('returns tags in time order even when given out of order', () => {
    const out = snapAll([tag(400), tag(100)], [det(96), det(396)])
    expect(out[0].tag.t0).toBe(S(100))
    expect(out[1].tag.t0).toBe(S(400))
  })

  it('survives empty input', () => {
    expect(snapAll([], [det(96)])).toEqual([])
    const none = snapAll([tag(100)], [])
    expect(none[0].result).toBeNull()
    expect(none[0].reason).toBe('Nothing detected on this day')
  })
})

describe('nextDetection — tab to transient', () => {
  const ds = [det(50), det(100, 'gybe'), det(150)]

  it('walks forward and back', () => {
    expect(nextDetection(ds, S(60))!.t0).toBe(S(100))
    expect(nextDetection(ds, S(120), -1)!.t0).toBe(S(100))
  })

  it('stops at the ends', () => {
    expect(nextDetection(ds, S(200))).toBeNull()
    expect(nextDetection(ds, S(10), -1)).toBeNull()
  })

  it('can walk one kind only', () => {
    expect(nextDetection(ds, S(60), 1, ['tack'])!.t0).toBe(S(150))
  })

  it('never returns the detection you are standing on', () => {
    expect(nextDetection(ds, S(100))!.t0).toBe(S(150))
    expect(nextDetection(ds, S(100), -1)!.t0).toBe(S(50))
  })
})
