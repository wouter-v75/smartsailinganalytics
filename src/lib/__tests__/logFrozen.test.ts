// src/lib/__tests__/logFrozen.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// A channel that stopped updating but kept being logged.
//
// Baraka, 11 Oct 2026: `twa` held at exactly −53.6 from 08:22:20 to 08:26:24 —
// four minutes, with tws/awa/bsp/vmg frozen with it — then jumped 100° in one
// step. She tacked inside that span. The numbers below are hers.
//
// Why it is worth detecting rather than shrugging at: SailTrim takes the TACK
// from the sign of that stale twa, which put a starboard frame on port and
// flipped the sign of every millimetre on it.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { frozenSpans, frozenReport, frozenAt } from '../logFrozen'

const T = (hhmmss: string) => Date.parse(`2026-10-11T${hhmmss}Z`)

/** The real shape of it: twa frozen while heel tracks the tack. */
const BARAKA = [
  { utc: T('08:22:20'), twa: -53.6, bsp: 6.5, heel: 11.8 },
  { utc: T('08:23:20'), twa: -53.6, bsp: 6.5, heel: 11.4 },
  { utc: T('08:24:20'), twa: -53.6, bsp: 6.5, heel: 9.2 },
  { utc: T('08:25:20'), twa: -53.6, bsp: 6.5, heel: 2.1 },
  { utc: T('08:26:05'), twa: -53.6, bsp: 6.5, heel: -5.0 },
  { utc: T('08:26:24'), twa: -53.6, bsp: 6.5, heel: -8.2 },
  { utc: T('08:26:30'), twa: 46.7, bsp: 4.8, heel: -10.2 },
  { utc: T('08:26:44'), twa: 51.2, bsp: 5.1, heel: -13.5 },
]

describe('frozenSpans', () => {
  it('finds the four-minute twa freeze', () => {
    const [s] = frozenSpans(BARAKA, 'twa')
    expect(s.value).toBe(-53.6)
    expect(s.seconds).toBeCloseTo(244, 0)          // 08:22:20 → 08:26:24
    expect(s.rows).toBe(6)
  })

  it('reports how far HEEL moved, which is what proves the feed is dead', () => {
    // A boat holding −53.6 for four minutes is possible; one doing it while
    // heeling from +11.8 through zero to −8.2 has tacked, so the channel is
    // repeating a stored value rather than measuring.
    const [s] = frozenSpans(BARAKA, 'twa')
    expect(s.witnessRange).toBeCloseTo(20.0, 1)
  })

  it('does not flag a steady boat holding a value briefly', () => {
    const steady = [
      { utc: T('09:00:00'), twa: -42.0, heel: 11.0 },
      { utc: T('09:00:05'), twa: -42.0, heel: 11.1 },
      { utc: T('09:00:10'), twa: -41.2, heel: 11.0 },
    ]
    expect(frozenSpans(steady, 'twa')).toEqual([])
  })

  it('takes its floor from the caller', () => {
    expect(frozenSpans(BARAKA, 'twa', { minSeconds: 300 })).toEqual([])
    expect(frozenSpans(BARAKA, 'twa', { minSeconds: 10 })).toHaveLength(1)
  })

  it('wants BIT-identical, because a live sensor’s last digit moves', () => {
    const jitter = [
      { utc: T('09:00:00'), twa: -42.0, heel: 11.0 },
      { utc: T('09:02:00'), twa: -42.01, heel: 11.0 },
      { utc: T('09:04:00'), twa: -42.0, heel: 11.0 },
    ]
    expect(frozenSpans(jitter, 'twa')).toEqual([])
  })

  it('skips rows with the channel absent instead of treating null as a value', () => {
    // 5 of Baraka's 5403 rows carry only utc and tmGun. A null is a gap, not a
    // reading, and must not join two real spans into one.
    const gappy = [
      { utc: T('09:00:00'), twa: -42.0, heel: 11.0 },
      { utc: T('09:01:00'), twa: null, heel: 11.0 },
      { utc: T('09:02:00'), twa: -42.0, heel: 11.0 },
    ]
    const [s] = frozenSpans(gappy, 'twa', { minSeconds: 30 })
    expect(s.rows).toBe(2)
    expect(s.seconds).toBeCloseTo(120, 0)
  })

  it('catches every wind channel that froze together, worst first', () => {
    const r = frozenReport(BARAKA, { minSeconds: 30 })
    expect(r.map((s) => s.channel).sort()).toEqual(['bsp', 'twa'])
    expect(r[0].seconds).toBeGreaterThanOrEqual(r[1].seconds)
  })
})

describe('frozenAt', () => {
  it('tells a photograph its instruments are stale', () => {
    const spans = frozenReport(BARAKA, { minSeconds: 30 })
    // 08:26:25 — the frame that got labelled port off a frozen twa. It falls in
    // the six seconds BETWEEN the last frozen row (08:26:24) and the feed
    // resuming (08:26:30), so a span ending at the last repeated row would
    // clear it. Its nearest row is the frozen one, so it is stale.
    expect(frozenAt(spans, T('08:26:25')).length).toBeGreaterThan(0)
    // The feed is back by 08:26:31.
    expect(frozenAt(spans, T('08:26:31'))).toEqual([])
  })

  it('ends the staleness when the feed RESUMES, not at the last repeated row', () => {
    const [s] = frozenSpans(BARAKA, 'twa')
    expect(s.toUtc).toBe(T('08:26:24'))
    expect(s.staleUntilUtc).toBe(T('08:26:30'))
  })
})
