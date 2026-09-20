import { describe, it, expect } from 'vitest'
import {
  emptyProvenance, mark, markAll, provenanceAt, isPlottable, isMeasured,
  describeProvenance, coverage, summarise,
} from '../provenance'

const T = (min: number) => Date.UTC(2026, 1, 8, 10, 0) + min * 60_000

describe('mark', () => {
  it('records a range and finds it back', () => {
    const m = mark(emptyProvenance(), 'twd', {
      kind: 'derived', from: T(0), to: T(60), method: 'derived-cog',
    })
    expect(provenanceAt(m, 'twd', T(30))!.kind).toBe('derived')
    expect(provenanceAt(m, 'twd', T(30))!.method).toBe('derived-cog')
  })

  it('is half-open — the end instant belongs to the next range', () => {
    const m = mark(emptyProvenance(), 'twd', { kind: 'derived', from: T(0), to: T(60) })
    expect(provenanceAt(m, 'twd', T(0))).not.toBeNull()
    expect(provenanceAt(m, 'twd', T(60))).toBeNull()
  })

  it('lets a later claim overwrite the overlapping part of an earlier one', () => {
    // The model claims the whole day, then the track-derived estimate wins
    // where the geometry supported one. This ordering is the §13b architecture.
    const m = emptyProvenance()
    mark(m, 'twd', { kind: 'modelled', from: T(0), to: T(180), method: 'open-meteo' })
    mark(m, 'twd', { kind: 'derived', from: T(60), to: T(120), method: 'derived-cog' })
    expect(provenanceAt(m, 'twd', T(30))!.kind).toBe('modelled')
    expect(provenanceAt(m, 'twd', T(90))!.kind).toBe('derived')
    expect(provenanceAt(m, 'twd', T(150))!.kind).toBe('modelled')
    expect(m.twd).toHaveLength(3)          // split into left / new / right
  })

  it('splits an enclosing range in two', () => {
    const m = emptyProvenance()
    mark(m, 'twd', { kind: 'derived', from: T(0), to: T(100) })
    mark(m, 'twd', { kind: 'unavailable', from: T(40), to: T(60), note: 'one tack only' })
    expect(m.twd.map((r) => r.kind)).toEqual(['derived', 'unavailable', 'derived'])
    expect(provenanceAt(m, 'twd', T(50))!.note).toBe('one tack only')
  })

  it('keeps ranges sorted and ignores an empty range', () => {
    const m = emptyProvenance()
    mark(m, 'twd', { kind: 'derived', from: T(60), to: T(90) })
    mark(m, 'twd', { kind: 'derived', from: T(0), to: T(30) })
    expect(m.twd.map((r) => r.from)).toEqual([T(0), T(60)])
    mark(m, 'twd', { kind: 'derived', from: T(10), to: T(10) })
    expect(m.twd).toHaveLength(2)
  })

  it('marks a whole parsed log at once', () => {
    const m = markAll(emptyProvenance(), ['sog', 'cog', 'hdg'], 'measured', T(0), T(60), 'vakaros-csv')
    expect(provenanceAt(m, 'sog', T(1))!.kind).toBe('measured')
    expect(provenanceAt(m, 'hdg', T(1))!.method).toBe('vakaros-csv')
  })
})

describe('provenanceAt', () => {
  it('returns null in a gap — unclaimed is not the same as good', () => {
    const m = emptyProvenance()
    mark(m, 'twd', { kind: 'derived', from: T(0), to: T(30) })
    mark(m, 'twd', { kind: 'derived', from: T(60), to: T(90) })
    expect(provenanceAt(m, 'twd', T(45))).toBeNull()
  })

  it('returns null for an unknown channel or empty map', () => {
    expect(provenanceAt(emptyProvenance(), 'twd', T(0))).toBeNull()
    expect(provenanceAt(null, 'twd', T(0))).toBeNull()
  })

  it('finds the right range among many', () => {
    const m = emptyProvenance()
    for (let i = 0; i < 50; i++) {
      mark(m, 'twd', { kind: i % 2 ? 'derived' : 'unavailable', from: T(i * 10), to: T(i * 10 + 10) })
    }
    expect(provenanceAt(m, 'twd', T(325))!.kind).toBe('unavailable')  // range 32, even
    expect(provenanceAt(m, 'twd', T(315))!.kind).toBe('derived')      // range 31, odd
    expect(provenanceAt(m, 'twd', T(5))!.kind).toBe('unavailable')    // first range
    expect(provenanceAt(m, 'twd', T(495))!.kind).toBe('derived')      // last range
  })
})

describe('isPlottable / isMeasured', () => {
  it('treats unavailable and unclaimed as not plottable', () => {
    expect(isPlottable({ kind: 'unavailable', from: 0, to: 1 })).toBe(false)
    expect(isPlottable(null)).toBe(false)
    expect(isPlottable({ kind: 'derived', from: 0, to: 1 })).toBe(true)
    expect(isPlottable({ kind: 'modelled', from: 0, to: 1 })).toBe(true)
  })

  it('only a measured value may be quoted without a caveat', () => {
    expect(isMeasured({ kind: 'measured', from: 0, to: 1 })).toBe(true)
    expect(isMeasured({ kind: 'derived', from: 0, to: 1 })).toBe(false)
    expect(isMeasured(null)).toBe(false)
  })
})

describe('describeProvenance', () => {
  it('reads as something a coach would accept', () => {
    expect(describeProvenance({ kind: 'measured', from: 0, to: 1, method: 'vakaros-csv' }))
      .toBe('measured (vakaros-csv)')
    expect(describeProvenance({ kind: 'derived', from: 0, to: 1, method: 'derived-cog', confidence: 0.82 }))
      .toBe('derived from the track (derived-cog) · 82%')
    expect(describeProvenance({ kind: 'unavailable', from: 0, to: 1, note: 'one tack only' }))
      .toBe('not measurable — one tack only')
    expect(describeProvenance(null)).toBe('unknown')
  })
})

describe('coverage and summarise', () => {
  const m = emptyProvenance()
  mark(m, 'twd', { kind: 'derived', from: T(0), to: T(60) })
  mark(m, 'twd', { kind: 'unavailable', from: T(60), to: T(80) })
  // T(80)..T(100) deliberately unclaimed

  it('splits a window by kind, counting gaps as unclaimed', () => {
    const c = coverage(m, 'twd', T(0), T(100))
    expect(c.derived).toBeCloseTo(0.6, 5)
    expect(c.unavailable).toBeCloseTo(0.2, 5)
    expect(c.unclaimed).toBeCloseTo(0.2, 5)
    expect(c.measured).toBe(0)
  })

  it('clips to the window asked for', () => {
    const c = coverage(m, 'twd', T(30), T(60))
    expect(c.derived).toBeCloseTo(1, 5)
  })

  it('handles a zero-width or unknown window', () => {
    expect(coverage(m, 'twd', T(0), T(0)).unclaimed).toBe(0)
    expect(coverage(m, 'nope', T(0), T(100)).unclaimed).toBe(1)
  })

  it('summarises pessimistically — derived with gaps is not "derived"', () => {
    expect(summarise(m, 'twd', T(0), T(100))).toBe('60% derived, 40% unavailable')
  })

  it('says "measured" only when it is measured throughout', () => {
    const full = markAll(emptyProvenance(), ['sog'], 'measured', T(0), T(100), 'vakaros-csv')
    expect(summarise(full, 'sog', T(0), T(100))).toBe('measured')
  })

  it('says "not available" when nothing is claimed at all', () => {
    expect(summarise(emptyProvenance(), 'twd', T(0), T(100))).toBe('not available')
  })
})
