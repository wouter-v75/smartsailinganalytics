import { describe, it, expect } from 'vitest'
import { daySyncRefusal } from '../syncBoatGuard'

const days = [{ date: '2026-09-11' }, { date: '2026-09-12' }]

describe('daySyncRefusal', () => {
  it('lets a day the active boat owns through', () => {
    expect(daySyncRefusal('2026-09-11', days, { boat_name: 'Northstar 76' })).toBeNull()
  })

  it('refuses a day belonging to another boat, and names the boat it would land on', () => {
    const msg = daySyncRefusal('2026-08-01', days, { boat_name: 'Northstar 76' })
    expect(msg).toContain('different boat')
    expect(msg).toContain('Northstar 76')
  })

  it('falls back to a generic name when the membership has none', () => {
    expect(daySyncRefusal('2026-08-01', days, {})).toContain('the active boat')
    expect(daySyncRefusal('2026-08-01', days, null)).toContain('the active boat')
  })

  it('formats the date with the caller’s formatter', () => {
    const msg = daySyncRefusal('2026-08-01', days, null, () => 'Sat 1 Aug')
    expect(msg).toContain('Sat 1 Aug')
  })

  it('allows the push when there is no local day list to judge by — a fresh device', () => {
    expect(daySyncRefusal('2026-08-01', [], { boat_name: 'X' })).toBeNull()
    expect(daySyncRefusal('2026-08-01', null, { boat_name: 'X' })).toBeNull()
  })

  it('allows a missing date rather than inventing a refusal', () => {
    expect(daySyncRefusal(null, days, { boat_name: 'X' })).toBeNull()
  })
})
