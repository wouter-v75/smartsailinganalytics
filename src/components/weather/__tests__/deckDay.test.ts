// The forecast deck's one definition of "today".
//
// The bug this pins, with the real numbers off the 6 Nov San Juan deck:
// SSA-Race's published grid began 2026-11-05T16:00Z (= 08:00 PST on the 5th)
// while every Open-Meteo model began 2026-11-06T00:00 local. Both readers took
// day 0 from the first row they held, landed on the 5th, and the comparison
// charts were ranged over a day only one model covered — six models in the
// legend, one line drawn, no ±1σ band, and "Details for today" built from
// yesterday.

import { describe, expect, it } from 'vitest'
import { deckDay, dayCoverage, venueToday, indicesOnDay } from '../deckDay'

const PST = 'America/Los_Angeles'
/** Hourly venue-local stamps from `from` (inclusive) for `n` hours. */
function hours(startISO: string, n: number): string[] {
  const out: string[] = []
  const t0 = Date.parse(`${startISO}:00Z`)
  for (let i = 0; i < n; i++) out.push(new Date(t0 + i * 3600000).toISOString().slice(0, 16))
  return out
}

// The exact shapes from that deck.
const SSA_RACE = { lt: hours('2026-11-05T08:00', 40) }   // from 08:00 on the 5th
const OPEN_METEO = { lt: hours('2026-11-06T00:00', 48) } // from 00:00 on the 6th
const AT_0259_PST = new Date('2026-11-06T10:59:00Z')     // 02:59 PST on the 6th

describe('venueToday', () => {
  it('is the venue date, not the viewer or UTC one', () => {
    // 02:59 PST on the 6th is already 10:59 UTC on the 6th — agree here.
    expect(venueToday(PST, AT_0259_PST)).toBe('2026-11-06')
    // 18:00 PST on the 5th is 02:00 UTC on the SIXTH; the venue is still on the 5th.
    expect(venueToday(PST, new Date('2026-11-06T02:00:00Z'))).toBe('2026-11-05')
  })
})

describe('dayCoverage', () => {
  it('counts models per local date, not rows', () => {
    const c = dayCoverage([SSA_RACE, OPEN_METEO, OPEN_METEO])
    expect(c['2026-11-05']).toBe(1)   // SSA-Race alone
    expect(c['2026-11-06']).toBe(3)   // all three
  })

  it('ignores models with no usable stamps', () => {
    expect(dayCoverage([{ lt: [] }, { lt: ['nope'] as string[] }])).toEqual({})
  })
})

describe('deckDay — the regression that emptied the comparison charts', () => {
  const models = [SSA_RACE, OPEN_METEO, OPEN_METEO, OPEN_METEO, OPEN_METEO, OPEN_METEO]

  it('does NOT take the earliest hour any model offers', () => {
    // The old rule, kept here as the thing we must not do again.
    const oldRule = [...new Set(models.flatMap((m) => m.lt.map((t) => t.slice(0, 10))))].sort()[0]
    expect(oldRule).toBe('2026-11-05')
    expect(deckDay(models, PST, AT_0259_PST)).toBe('2026-11-06')
  })

  it('picks the day the most models cover', () => {
    expect(deckDay(models, PST, AT_0259_PST)).toBe('2026-11-06')
  })

  it('never picks a day that has already passed at the venue', () => {
    // Midday on the 6th: the 5th is gone even though SSA-Race still carries it.
    expect(deckDay(models, PST, new Date('2026-11-06T20:00:00Z'))).toBe('2026-11-06')
  })

  it('keeps today when every model covers it — the ordinary morning', () => {
    const all = [{ lt: hours('2026-11-06T00:00', 48) }, { lt: hours('2026-11-06T00:00', 48) }]
    // 09:00 PST on the 6th. Both days are fully covered, so the tie goes to the
    // earlier one: a deck generated before racing is about today, not tomorrow.
    expect(deckDay(all, PST, new Date('2026-11-06T17:00:00Z'))).toBe('2026-11-06')
  })

  it('moves to tomorrow once the venue has rolled past the covered day', () => {
    const only7th = [{ lt: hours('2026-11-07T00:00', 24) }]
    expect(deckDay(only7th, PST, AT_0259_PST)).toBe('2026-11-07')
  })

  it('falls back to the venue date when every model is stale', () => {
    // A product whose last frame is behind us has nothing to say about today.
    // Better an empty deck dated right than a full one dated wrong.
    const stale = [{ lt: hours('2026-11-01T00:00', 24) }]
    expect(deckDay(stale, PST, AT_0259_PST)).toBe('2026-11-06')
  })

  it('falls back to the venue date when handed nothing', () => {
    expect(deckDay([], PST, AT_0259_PST)).toBe('2026-11-06')
  })
})

describe('indicesOnDay', () => {
  it('finds a day that does not start the series', () => {
    // The old loop used `break` on the first row off the day, so a model whose
    // series began EARLIER contributed nothing at all.
    const lt = hours('2026-11-05T08:00', 40)
    const idx = indicesOnDay(lt, '2026-11-06')
    expect(idx.length).toBe(24)
    expect(lt[idx[0]]).toBe('2026-11-06T00:00')
    expect(lt[idx[idx.length - 1]]).toBe('2026-11-06T23:00')
  })

  it('returns nothing for a day the model does not cover', () => {
    expect(indicesOnDay(hours('2026-11-06T00:00', 24), '2026-11-09')).toEqual([])
  })
})
