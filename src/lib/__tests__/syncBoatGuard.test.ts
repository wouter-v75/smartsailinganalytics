import { describe, it, expect } from 'vitest'
import { daySyncRefusal } from '../syncBoatGuard'

// The guard exists to stop old Northstar 72 footage being re-filed under
// Northstar 76 by a push made on the wrong active boat. What it must NOT do is
// treat a day nobody has created yet as somebody else's — that blocked the
// upload of the day the crew were actually sailing.

const N76 = { team_id: 't1', boat_id: 'b76', boat_name: 'Northstar 76' }
const N72 = { team_id: 't1', boat_id: 'b72', boat_name: 'Northstar 72' }

const sessions = [
  { date: '2026-09-11', ...N76 },
  { date: '2026-09-12', ...N76 },
  { date: '2026-08-01', ...N72 },
]

describe('daySyncRefusal — what it lets through', () => {
  it('lets a day the active boat owns through', () => {
    expect(daySyncRefusal('2026-09-11', sessions, N76)).toBeNull()
  })

  it('LETS TODAY THROUGH when nobody has this day yet', () => {
    // 30 September: the day's log was still in parts on the card, so no session
    // row existed. The guard called it another boat's day and told the crew to
    // switch to the boat they were already on.
    expect(daySyncRefusal('2026-09-30', sessions, N76)).toBeNull()
  })

  it('ignores a legacy row that names no boat', () => {
    // Sessions written before they were workspace-tagged prove nothing either
    // way; counting them as "another boat" would refuse every old day.
    const withLegacy = [...sessions, { date: '2026-07-04' }]
    expect(daySyncRefusal('2026-07-04', withLegacy, N76)).toBeNull()
  })

  it('lets a day through that this boat owns even if another boat sailed it too', () => {
    // Two boats out on the same day is normal in a squad; ours is ours.
    const shared = [...sessions, { date: '2026-08-01', ...N76 }]
    expect(daySyncRefusal('2026-08-01', shared, N76)).toBeNull()
  })

  it('allows the push when there is no day list at all — a fresh device', () => {
    expect(daySyncRefusal('2026-08-01', [], N76)).toBeNull()
    expect(daySyncRefusal('2026-08-01', null, N76)).toBeNull()
  })

  it('allows a missing date rather than inventing a refusal', () => {
    expect(daySyncRefusal(null, sessions, N76)).toBeNull()
  })

  it('does not refuse when the membership has no boat — nothing to compare', () => {
    expect(daySyncRefusal('2026-08-01', sessions, {})).toBeTruthy() // it IS another boat's
    expect(daySyncRefusal('2026-09-30', sessions, {})).toBeNull()   // but this one is nobody's
  })
})

describe('daySyncRefusal — what it refuses, and what it says', () => {
  it('refuses a day that exists under a different boat', () => {
    expect(daySyncRefusal('2026-08-01', sessions, N76)).toMatch(/not uploaded/)
  })

  it('names BOTH boats: whose day it is, and where it would have landed', () => {
    // The first version named only the active boat and then said "switch to
    // that session's boat" without ever saying which — which reads as a
    // contradiction when the boat it does name is the one you are on.
    const msg = daySyncRefusal('2026-08-01', sessions, N76) as string
    expect(msg).toContain('Northstar 72’s session')
    expect(msg).toContain('file it under Northstar 76')
  })

  it('copes when the owning row carries no boat name', () => {
    const anon = [{ date: '2026-08-01', team_id: 't1', boat_id: 'bX' }]
    const msg = daySyncRefusal('2026-08-01', anon, N76) as string
    expect(msg).toContain('another boat’s session')
    expect(msg).toContain('Northstar 76')
  })

  it('falls back to a generic name when the membership has none', () => {
    const msg = daySyncRefusal('2026-08-01', sessions, { team_id: 't1', boat_id: 'bZ' }) as string
    expect(msg).toContain('the active boat')
  })

  it('formats the date with the caller’s formatter', () => {
    expect(daySyncRefusal('2026-08-01', sessions, N76, () => 'Sat 1 Aug')).toContain('Sat 1 Aug')
  })
})

describe('the list it is given', () => {
  it('needs EVERY session, not the active boat’s — a filtered list refuses nothing', () => {
    // The bug in one line: given only the active boat's days, a day that exists
    // elsewhere is invisible and the guard waves it through. Every call site
    // passes getSessions() for this reason.
    const filtered = sessions.filter((s) => s.boat_id === N76.boat_id)
    expect(daySyncRefusal('2026-08-01', filtered, N76)).toBeNull()
    expect(daySyncRefusal('2026-08-01', sessions, N76)).toBeTruthy()
  })
})
