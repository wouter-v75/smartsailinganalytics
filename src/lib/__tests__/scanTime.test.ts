import { describe, it, expect } from 'vitest'
import { scanLocalParts, scanLocalDateTime, localToScanStamps } from '../scanTime'

const CEST = 120 // minutes east of UTC

describe('localToScanStamps', () => {
  it('writes BOTH stamps from one wall clock, so the pair cannot drift', () => {
    const r = localToScanStamps('2026-09-02', '14:35', CEST)!
    expect(r.captured_local).toBe('2026-09-02 14:35')
    expect(r.captured_at).toBe('2026-09-02T12:35:00.000Z') // 14:35 CEST = 12:35 UTC
  })

  it('round-trips through scanLocalParts — what you type is what you read back', () => {
    for (const [d, t] of [['2026-09-02', '14:35'], ['2026-01-15', '09:05'], ['2026-12-31', '23:59']]) {
      const r = localToScanStamps(d, t, CEST)!
      const p = scanLocalParts({ conditions: { captured_local: r.captured_local } }, CEST)!
      expect(`${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`).toBe(d)
      expect(`${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`).toBe(t)
    }
  })

  it('agrees with the captured_at fallback path — both routes give the same clock', () => {
    const r = localToScanStamps('2026-09-02', '14:35', CEST)!
    // read via captured_local (preferred) and via captured_at (fallback)
    const viaLocal = scanLocalDateTime({ conditions: { captured_local: r.captured_local } }, CEST)
    const viaUtc = scanLocalDateTime({ captured_at: r.captured_at }, CEST)
    expect(viaLocal).toBe(viaUtc)
    expect(viaLocal).toBe('02 Sep 2026, 14:35 CEST')
  })

  it('handles UTC and negative offsets', () => {
    expect(localToScanStamps('2026-09-02', '14:35', 0)!.captured_at).toBe('2026-09-02T14:35:00.000Z')
    // UTC-5: 09:00 local is 14:00 UTC
    expect(localToScanStamps('2026-09-02', '09:00', -300)!.captured_at).toBe('2026-09-02T14:00:00.000Z')
  })

  it('crosses midnight correctly rather than losing a day', () => {
    // 00:30 CEST on the 2nd is 22:30 UTC on the 1st
    const r = localToScanStamps('2026-09-02', '00:30', CEST)!
    expect(r.captured_at).toBe('2026-09-01T22:30:00.000Z')
    expect(r.captured_local).toBe('2026-09-02 00:30')
  })

  it('rejects a rolled-over date instead of silently storing a different day', () => {
    expect(localToScanStamps('2026-02-31', '12:00', CEST)).toBeNull()
    expect(localToScanStamps('2026-13-01', '12:00', CEST)).toBeNull()
  })

  it('rejects malformed input rather than guessing', () => {
    expect(localToScanStamps('', '12:00', CEST)).toBeNull()
    expect(localToScanStamps('2026-09-02', '', CEST)).toBeNull()
    expect(localToScanStamps('02/09/2026', '12:00', CEST)).toBeNull()
    expect(localToScanStamps('2026-09-02', '25:00', CEST)).toBeNull()
    expect(localToScanStamps('2026-09-02', '12:60', CEST)).toBeNull()
  })

  it('accepts a single-digit hour, as a time input may emit', () => {
    expect(localToScanStamps('2026-09-02', '9:05', CEST)!.captured_local).toBe('2026-09-02 09:05')
  })
})
