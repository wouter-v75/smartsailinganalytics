// The poll cadence, and the one source whose budget depends on it.
//
// Met Office Land Observations allows 360 calls a day and returns 48 hourly
// rows per call, so it is fetched once an hour however often the poller runs.
// That gate used to be a bare `getUTCMinutes() >= 15` — the cadence written
// down where nobody would look for it. It happened to be right at 0,30; at
// :15,:45 it would have fired never, and a source returning nothing for ever
// is invisible to tsc, to lint and to every test that checks a parser.

import { describe, expect, it } from 'vitest'
import { POLL_EVERY_MIN, isHourlySlot } from '../obsSources'

/** The minutes past the hour an aligned cron fires at, for a given cadence. */
const slots = (everyMin: number) =>
  Array.from({ length: 60 / everyMin }, (_, i) => i * everyMin)

describe('isHourlySlot', () => {
  it('fires exactly once an hour at every cadence that divides the hour', () => {
    for (const everyMin of [1, 5, 10, 15, 20, 30, 60]) {
      const fires = slots(everyMin).filter((m) => isHourlySlot(new Date(Date.UTC(2026, 9, 22, 11, m)), everyMin))
      expect(fires, `cadence ${everyMin} min fired ${fires.length} times in the hour`).toHaveLength(1)
      // And it is the run that starts the hour, not an arbitrary one.
      expect(fires[0]).toBe(0)
    }
  })

  it('is true at the top of the hour and false at the other runs', () => {
    expect(isHourlySlot(new Date(Date.UTC(2026, 9, 22, 11, 0)), 30)).toBe(true)
    expect(isHourlySlot(new Date(Date.UTC(2026, 9, 22, 11, 30)), 30)).toBe(false)
  })

  it('reads UTC, not the machine’s local time', () => {
    // A box on CEST would otherwise gate on the wrong hour boundary — the same
    // local-time-for-UTC mistake that shifts a whole sailing day.
    const topOfUtcHour = new Date(Date.UTC(2026, 9, 22, 11, 5))
    expect(isHourlySlot(topOfUtcHour, 30)).toBe(true)
  })

  it('tolerates a late cron within the slot', () => {
    // cron fires at :00 but the box is busy and the request lands at :07.
    expect(isHourlySlot(new Date(Date.UTC(2026, 9, 22, 11, 7)), 30)).toBe(true)
  })
})

describe('POLL_EVERY_MIN', () => {
  it('divides the hour, so an aligned cron exists at all', () => {
    // If it did not, no schedule would put exactly one run in the first
    // POLL_EVERY_MIN minutes of every hour and the gate above would drift.
    expect(60 % POLL_EVERY_MIN).toBe(0)
    expect(POLL_EVERY_MIN).toBeGreaterThan(0)
    expect(POLL_EVERY_MIN).toBeLessThanOrEqual(60)
  })

  it('leaves several polls inside the staleness window', () => {
    // A cadence longer than OBS_STALE_MIN would make the stored layer blink
    // empty between runs: the map would lose every stored-only source.
    const OBS_STALE_MIN = 90
    expect(POLL_EVERY_MIN).toBeLessThan(OBS_STALE_MIN / 2)
  })
})
