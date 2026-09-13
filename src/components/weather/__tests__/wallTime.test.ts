import { describe, it, expect } from 'vitest'
import { wallHour, wallDay, formatWall, nowInTz } from '../venueTz'

// These must hold whatever zone the machine running them is in — the bug was
// precisely that the answer depended on it (Newport viewed from Amsterdam).

describe('wall-clock model times', () => {
  const nyNine = '2026-09-13T09:00'   // Open-Meteo, asked for America/New_York

  it('reads the hour from the digits, not through the browser zone', () => {
    expect(wallHour(nyNine, 'America/New_York')).toBe(9)
    expect(wallHour('2026-09-13T18:00', 'Europe/Rome')).toBe(18)
  })

  it('labels 09:00 as 09:00 — it used to print 03:00 from an Amsterdam laptop', () => {
    expect(formatWall(nyNine, 'America/New_York', { hour: '2-digit', minute: '2-digit' })).toBe('09:00')
    expect(formatWall(nyNine, 'America/New_York', { weekday: 'short', hour: '2-digit', minute: '2-digit' })).toBe('Sun 09:00')
  })

  it('keeps the date of a late-evening row', () => {
    expect(wallDay('2026-09-13T23:00', 'America/New_York')).toBe('2026-09-13')
  })

  it('converts a string that DOES carry a zone (an SSA-Race UTC grid)', () => {
    expect(wallHour('2026-09-13T13:00Z', 'America/New_York')).toBe(9)
    expect(formatWall('2026-09-13T13:00Z', 'America/New_York', { hour: '2-digit', minute: '2-digit' })).toBe('09:00')
    expect(wallDay('2026-09-14T02:00Z', 'America/New_York')).toBe('2026-09-13')
  })

  it("gives the venue's own now", () => {
    const at = new Date('2026-09-13T13:40:00Z')   // 09:40 in Newport, 15:40 in Amsterdam
    expect(nowInTz('America/New_York', at)).toEqual({ day: '2026-09-13', hour: 9 })
    expect(nowInTz('Europe/Amsterdam', at)).toEqual({ day: '2026-09-13', hour: 15 })
  })
})
