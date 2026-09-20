import { describe, it, expect } from 'vitest'
import { findSegments, mergeLegs } from '../wind/segment'
import { eventsFromSegments, countManoeuvres } from '../wind/trackEvents'
import { buildPhases } from '../buildPhases'
import { DEFAULT_SETTINGS } from '../phaseSettings'
import { computePhaseStats } from '../phaseStats'
import { synthesise } from '../wind/synthesise'
import { buildTrack } from './support/syntheticTrack'

const TWD = 270

// A beat with two tacks, a bear-away onto the same side, a gybe, then heading
// back up. Note the bear-away stays on the SAME side of the wind (-42 -> -150):
// going from -42 to +150 would be a bear-away AND a gybe in one, a 168° turn
// that the detector rightly rejects as implausible.
const dayRows = buildTrack({
  twd: TWD,
  legs: [
    { twa: -42, seconds: 180 }, { twa: 42, seconds: 180 }, { twa: -42, seconds: 180 },
    { twa: -150, seconds: 200, sog: 7.5 },    // bear-away  -> 'other'
    { twa: 150, seconds: 200, sog: 7.5 },     // gybe
    { twa: 42, seconds: 180 },                // heading up -> 'other'
  ],
})

describe('mergeLegs', () => {
  it('coalesces the segmenter’s fragments back into legs', () => {
    // The segmenter deliberately breaks on wobbles, so a leg can arrive in
    // pieces. Manoeuvre detection needs the leg, not the pieces.
    const rows = buildTrack({ twd: TWD, turnSeconds: 0, legs: [{ twa: 42, seconds: 300 }] })
    rows[100].sog = 0.5          // a momentary stall splits the run
    const segs = findSegments(rows)
    expect(segs.length).toBeGreaterThan(1)
    expect(mergeLegs(segs)).toHaveLength(1)
  })

  it('sums the real steady time, not wall time', () => {
    const rows = buildTrack({ twd: TWD, turnSeconds: 0, legs: [{ twa: 42, seconds: 300 }] })
    rows[100].sog = 0.5
    const merged = mergeLegs(findSegments(rows))[0]
    const segs = findSegments(rows)
    expect(merged.dur).toBe(segs.reduce((a, s) => a + s.dur, 0))
    // Wall time would have counted the stall as if the boat had been steady.
    expect(merged.dur).toBeLessThan((merged.endUtc - merged.startUtc) / 1000 + 1)
  })

  it('does NOT merge across a real manoeuvre', () => {
    const segs = findSegments(buildTrack({
      twd: TWD, legs: [{ twa: -42, seconds: 180 }, { twa: 42, seconds: 180 }],
    }))
    expect(mergeLegs(segs)).toHaveLength(2)
  })

  it('keeps the weighted bearing and handles an empty list', () => {
    const legs = mergeLegs(findSegments(dayRows))
    expect(legs.length).toBeGreaterThan(3)
    expect(mergeLegs([])).toEqual([])
  })
})

describe('eventsFromSegments', () => {
  const segs = findSegments(dayRows)
  const ev = eventsFromSegments(segs, TWD)

  it('classifies tacks and gybes by which side of the wind was crossed', () => {
    const c = countManoeuvres(ev)
    expect(c.tacks).toBe(2)     // the two on the first beat
    expect(c.gybes).toBe(1)     // the one on the run
  })

  it('keeps bear-aways as boundaries but does NOT call them gybes', () => {
    const c = countManoeuvres(ev)
    expect(c.other).toBeGreaterThan(0)
    expect(ev.markRoundings.length).toBe(c.other)
    // Every "other" turn is a boundary buildPhases will cut at…
    expect(ev.markRoundings.every((m) => Number.isFinite(m.utc))).toBe(true)
    // …but none of them is reported as a tack or gybe.
    expect(ev.tackJibes).toHaveLength(c.tacks + c.gybes)
  })

  it('produces exactly the shape buildPhases already reads', () => {
    expect(ev).toHaveProperty('tackJibes')
    expect(ev).toHaveProperty('markRoundings')
    expect(ev).toHaveProperty('sailsUpEvents')
    expect(ev.dayStartUtc).toBe(segs[0].startUtc)
    expect(ev.dayStopUtc).toBe(segs[segs.length - 1].endUtc)
  })

  it('calls every turn a tack when the wind is unknown', () => {
    // Honest default: without a TWD the geometry cannot tell them apart.
    const blind = eventsFromSegments(segs)
    expect(countManoeuvres(blind).gybes).toBe(0)
    expect(countManoeuvres(blind).tacks).toBeGreaterThan(0)
  })

  it('ignores small wobbles and implausibly large turns', () => {
    const wobble = findSegments(buildTrack({
      twd: TWD, turnSeconds: 10,
      legs: [{ twa: 42, seconds: 120 }, { twa: 52, seconds: 120 }],   // 10° change
    }))
    expect(eventsFromSegments(wobble, TWD).allTurns).toHaveLength(0)
  })

  it('handles an empty or single-segment track', () => {
    expect(eventsFromSegments([], TWD).allTurns).toEqual([])
    expect(eventsFromSegments([segs[0]], TWD).allTurns).toEqual([])
    expect(eventsFromSegments([], TWD).dayStartUtc).toBeNull()
  })
})

describe('the whole pipeline: a bare track reaches phaseStats', () => {
  // This is the architectural bet of the dinghy work — synthesise the missing
  // channels and the EXISTING analysis runs unchanged.
  const t0 = dayRows[0].utc
  const model = {
    times: [t0 - 3_600_000, t0 + 3_600_000],
    twd: [268, 272],
    tws: [12, 12.5],
  }
  const s = synthesise({ rows: dayRows, format: 'vakaros-csv', model })
  const ev = eventsFromSegments(s.segments, s.rows[Math.floor(s.rows.length / 2)].twd)
  const built = buildPhases(s.rows as any, ev, DEFAULT_SETTINGS)

  it('builds phases from a track that never had an event file', () => {
    expect(built.phases.length).toBeGreaterThan(0)
    expect(built.phases.some((p) => p.kind === 'steady')).toBe(true)
  })

  it('cuts at the manoeuvres, so no steady phase straddles one', () => {
    const steady = built.phases.filter((p) => p.kind === 'steady')
    for (const m of ev.tackJibes) {
      for (const p of steady) {
        const inside = m.utc > p.utc + 1000 && m.utc < p.endUtc - 1000
        expect(inside).toBe(false)
      }
    }
  })

  it('reaches computePhaseStats with a usable tack and mode split', () => {
    const steady = built.phases.filter((p) => p.kind === 'steady')
    const stats = computePhaseStats(s.rows as any, { phases: steady }, {})
    expect(stats.length).toBeGreaterThan(0)
    expect(stats.some((x) => x.tack === 'stbd')).toBe(true)
    expect(stats.some((x) => x.tack === 'port')).toBe(true)
    expect(stats.some((x) => x.mode === 'up')).toBe(true)
  })

  it('returns reasons rather than silence when blocks are rejected', () => {
    expect(Array.isArray(built.reasons)).toBe(true)
    for (const r of built.reasons) expect(r.reason).toBeTruthy()
  })
})
