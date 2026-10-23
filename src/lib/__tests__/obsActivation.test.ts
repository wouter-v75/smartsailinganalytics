import { describe, expect, it } from 'vitest'
import {
  venueMode, decideVenues, windowCovers, pollRadiusNm, unknownForceKeys,
  parseForceParam, IDLE_NM, FORCE_ALL, type ActivationWindow,
} from '../obsActivation'
import { VENUES } from '../obsSources'
import { GRADED_DEFAULTS } from '../obsDensity'

const NOW = Date.parse('2026-09-28T12:00:00Z')
const win = (over: Partial<ActivationWindow> = {}): ActivationWindow => ({
  venueKey: 'st-tropez',
  startsAt: '2026-09-25T00:00:00+02:00',
  endsAt: '2026-10-04T23:59:00+02:00',
  reason: 'Les Voiles de Saint-Tropez',
  ...over,
})

describe('windowCovers', () => {
  it('covers an instant inside it', () => {
    expect(windowCovers(win(), NOW)).toBe(true)
  })

  it('does not cover before or after', () => {
    expect(windowCovers(win(), Date.parse('2026-09-24T12:00:00Z'))).toBe(false)
    expect(windowCovers(win(), Date.parse('2026-10-05T12:00:00Z'))).toBe(false)
  })

  it('honours the offset in the stored timestamp', () => {
    // 00:00+02:00 is 22:00Z the previous day. Read as UTC the window would
    // start two hours late, which on the first morning of a regatta is the
    // morning you wanted it.
    expect(windowCovers(win(), Date.parse('2026-09-24T22:30:00Z'))).toBe(true)
  })

  it('covers nothing when the dates are unreadable', () => {
    // Failing CLOSED is the cheap direction: a missing dense set is visible on
    // the map, an accidental one is only visible on someone's rate limit.
    expect(windowCovers(win({ startsAt: 'nonsense' }), NOW)).toBe(false)
    expect(windowCovers(win({ endsAt: '' }), NOW)).toBe(false)
  })

  it('covers nothing when it ends before it starts', () => {
    expect(windowCovers(win({ startsAt: '2026-10-04T00:00:00Z', endsAt: '2026-09-25T00:00:00Z' }), NOW)).toBe(false)
  })
})

describe('venueMode', () => {
  it('is idle with no windows and no force', () => {
    expect(venueMode('st-tropez')).toBe('idle')
    expect(venueMode('st-tropez', { windows: [], force: [], nowMs: NOW })).toBe('idle')
  })

  it('is dense inside a window', () => {
    expect(venueMode('st-tropez', { windows: [win()], nowMs: NOW })).toBe('dense')
  })

  it('leaves OTHER venues idle during a regatta somewhere else', () => {
    expect(venueMode('solent', { windows: [win()], nowMs: NOW })).toBe('idle')
  })

  it('is dense when forced, which is the "when I say so" path', () => {
    expect(venueMode('solent', { force: ['solent'], nowMs: NOW })).toBe('dense')
  })

  it('forces everything with "all"', () => {
    for (const v of VENUES) expect(venueMode(v.key, { force: [FORCE_ALL], nowMs: NOW })).toBe('dense')
  })

  it('matches keys regardless of case or stray spaces', () => {
    expect(venueMode('st-tropez', { force: ['  St-Tropez '], nowMs: NOW })).toBe('dense')
    expect(venueMode('st-tropez', { windows: [win({ venueKey: 'ST-TROPEZ' })], nowMs: NOW })).toBe('dense')
  })

  it('never lets the force list switch a window OFF', () => {
    // Force ADDS. The window is the deliberate decision and must win: a cron
    // line naming one venue must not turn off a regatta in progress elsewhere.
    expect(venueMode('st-tropez', { windows: [win()], force: ['solent'], nowMs: NOW })).toBe('dense')
  })
})

describe('pollRadiusNm', () => {
  it('is the inner circle when idle and the graded outer when dense', () => {
    expect(pollRadiusNm('idle')).toBe(IDLE_NM)
    expect(pollRadiusNm('dense')).toBe(GRADED_DEFAULTS.outerNm)
  })

  it('honours a venue-specific dense radius', () => {
    expect(pollRadiusNm('dense', 35)).toBe(35)
    // The idle radius is not affected by the dense override.
    expect(pollRadiusNm('idle', 35)).toBe(IDLE_NM)
  })

  it('keeps idle genuinely smaller than dense, or none of this saves anything', () => {
    expect(IDLE_NM).toBeLessThan(GRADED_DEFAULTS.outerNm)
  })
})

describe('decideVenues', () => {
  it('decides every venue and says why each dense one is dense', () => {
    const out = decideVenues(VENUES, { windows: [win()], nowMs: NOW })
    expect(out).toHaveLength(VENUES.length)
    const st = out.find((v) => v.key === 'st-tropez')!
    expect(st.mode).toBe('dense')
    expect(st.reason).toBe('Les Voiles de Saint-Tropez')
    expect(st.radiusNm).toBe(GRADED_DEFAULTS.outerNm)
    const solent = out.find((v) => v.key === 'solent')!
    expect(solent.mode).toBe('idle')
    expect(solent.reason).toBeNull()
    expect(solent.radiusNm).toBe(IDLE_NM)
  })

  it('falls back to the dates when a window has no reason written on it', () => {
    const out = decideVenues(VENUES, { windows: [win({ reason: null })], nowMs: NOW })
    expect(out.find((v) => v.key === 'st-tropez')!.reason).toMatch(/2026-09-25/)
  })

  it('labels a forced venue as forced', () => {
    const out = decideVenues(VENUES, { force: ['solent'], nowMs: NOW })
    expect(out.find((v) => v.key === 'solent')!.reason).toBe('forced')
    expect(decideVenues(VENUES, { force: [FORCE_ALL], nowMs: NOW })[0].reason).toBe('forced: all')
  })

  it('carries each venue’s position through, which is what the sources filter on', () => {
    const out = decideVenues(VENUES, { nowMs: NOW })
    for (const v of out) {
      expect(Number.isFinite(v.lat)).toBe(true)
      expect(Number.isFinite(v.lon)).toBe(true)
      expect(v.name.trim()).not.toBe('')
    }
  })

  it('leaves everything idle by default — the whole point', () => {
    const out = decideVenues(VENUES, { nowMs: NOW })
    expect(out.every((v) => v.mode === 'idle')).toBe(true)
  })
})

describe('unknownForceKeys', () => {
  it('names a typo, because otherwise the regatta is just not covered', () => {
    expect(unknownForceKeys(VENUES, ['st-tropeze', 'solent'])).toEqual(['st-tropeze'])
  })

  it('accepts "all" and ignores blanks', () => {
    expect(unknownForceKeys(VENUES, [FORCE_ALL, '', '  '])).toEqual([])
  })
})

describe('parseForceParam', () => {
  it('splits a domains query on commas and spaces', () => {
    expect(parseForceParam('st-tropez,solent')).toEqual(['st-tropez', 'solent'])
    expect(parseForceParam('st-tropez solent')).toEqual(['st-tropez', 'solent'])
    expect(parseForceParam('st-tropez, solent ,')).toEqual(['st-tropez', 'solent'])
  })

  it('is empty for nothing at all', () => {
    expect(parseForceParam(null)).toEqual([])
    expect(parseForceParam('')).toEqual([])
  })
})

describe('venue keys', () => {
  it('are unique, slug-shaped and stable-looking', () => {
    const keys = VENUES.map((v) => v.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]+$/)
  })

  it('do not collide with the force-all sentinel', () => {
    expect(VENUES.some((v) => v.key === FORCE_ALL)).toBe(false)
  })
})
