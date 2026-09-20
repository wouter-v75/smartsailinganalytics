import { describe, it, expect } from 'vitest'
import { synthesise } from '../wind/synthesise'
import { provenanceAt, summarise, isPlottable } from '../provenance'
import { angleDiff } from '../wind/circular'
import { buildTrack, beat } from './support/syntheticTrack'

const TWD = 270
const rows = beat(TWD, { legs: 8, legSeconds: 150 })
const t0 = rows[0].utc
const model = {
  times: [t0 - 3_600_000, t0 + 3_600_000, t0 + 7_200_000],
  twd: [265, 272, 275],
  tws: [11, 12, 13],
}

describe('synthesise writes the channels the app needs', () => {
  const r = synthesise({ rows, format: 'vakaros-csv', model })

  it('derives twd for most of the session', () => {
    expect(r.twdCoverage).toBeGreaterThan(0.5)
    const withTwd = r.rows.filter((x) => x.twd != null)
    expect(withTwd.length).toBeGreaterThan(r.rows.length * 0.5)
  })

  it('gets the wind right', () => {
    const mid = r.rows[Math.floor(r.rows.length / 2)]
    expect(Math.abs(angleDiff(mid.twd!, TWD))).toBeLessThan(6)
  })

  it('picks the GPS-only methods from the format, with no per-boat setup', () => {
    expect(r.methods.windDirection).toBe('derived-cog')
    expect(r.methods.windSpeed).toBe('model')
    expect(r.methods.polar).toBe('learned')
    expect(r.methods.phases).toBe('derived')
  })

  it('takes tws from the model and interpolates it', () => {
    const mid = r.rows[Math.floor(r.rows.length / 2)]
    expect(mid.tws).toBeGreaterThan(11)
    expect(mid.tws).toBeLessThan(13)
  })

  it('signs TWA so that positive means starboard tack', () => {
    // Wind from 270°, boat on 228°: the wind source bears 42° to STARBOARD of
    // the bow, so this is starboard tack and phaseStats needs a POSITIVE TWA.
    const stbd = r.rows.find((x) => x.cog === 228 && x.twa != null)!
    expect(stbd.twa).toBeGreaterThan(0)
    expect(stbd.twa!).toBeCloseTo(42, 0)
    // Boat on 312°: wind 42° to PORT of the bow — port tack, negative TWA.
    const port = r.rows.find((x) => x.cog === 312 && x.twa != null)!
    expect(port.twa).toBeLessThan(0)
    expect(port.twa!).toBeCloseTo(-42, 0)
  })

  it('writes bsp from sog but never pretends it is measured', () => {
    expect(r.rows[0].bsp).toBe(rows[0].sog)
    const p = provenanceAt(r.provenance, 'bsp', rows[10].utc)!
    expect(p.kind).toBe('derived')
    expect(p.note).toMatch(/not speed through water/)
  })
})

describe('provenance follows what actually happened', () => {
  const r = synthesise({ rows, format: 'vakaros-csv', model })

  it('marks the parsed channels measured', () => {
    expect(provenanceAt(r.provenance, 'sog', rows[10].utc)!.kind).toBe('measured')
    expect(provenanceAt(r.provenance, 'cog', rows[10].utc)!.method).toBe('vakaros-csv')
  })

  it('marks derived twd as derived, and as ground wind', () => {
    const mid = r.rows.find((x) => x.twd != null)!
    const p = provenanceAt(r.provenance, 'twd', mid.utc)!
    expect(['derived', 'modelled']).toContain(p.kind)
    if (p.kind === 'derived') expect(p.note).toMatch(/ground wind/)
  })

  it('marks tws as modelled, never measured', () => {
    expect(provenanceAt(r.provenance, 'tws', rows[10].utc)!.kind).toBe('modelled')
  })

  it('summarises the session honestly', () => {
    const s = summarise(r.provenance, 'twd', rows[0].utc, rows[rows.length - 1].utc)
    expect(s).not.toBe('measured')
    expect(s).toMatch(/derived|modelled|unavailable/)
  })
})

describe('an instrumented boat is left completely alone', () => {
  it('keeps measured wind and marks it measured', () => {
    const instr = rows.map((x) => ({ ...x, twd: 271, tws: 12.5 }))
    const r = synthesise({ rows: instr, format: 'flat-ole' })
    expect(r.methods.windDirection).toBe('measured')
    expect(r.rows[0].twd).toBe(271)
    expect(r.rows[0].tws).toBe(12.5)
    expect(provenanceAt(r.provenance, 'twd', instr[5].utc)!.kind).toBe('measured')
    expect(r.estimates).toHaveLength(0)     // no estimation attempted at all
  })
})

describe('when the wind cannot be derived', () => {
  it('falls back to the model and says so', () => {
    // One tack only: no opposite tack, so nothing can be derived.
    const oneTack = buildTrack({ twd: TWD, turnSeconds: 0, legs: [{ twa: 42, seconds: 900 }] })
    const r = synthesise({ rows: oneTack, format: 'vakaros-csv', model })
    expect(r.twdCoverage).toBe(0)
    const p = provenanceAt(r.provenance, 'twd', oneTack[100].utc)!
    expect(p.kind).toBe('modelled')
    expect(r.rows[100].twd).not.toBeNull()
  })

  it('reports unavailable — not zero — with no model and no derivation', () => {
    const oneTack = buildTrack({ twd: TWD, turnSeconds: 0, legs: [{ twa: 42, seconds: 900 }] })
    const r = synthesise({ rows: oneTack, format: 'vakaros-csv' })
    expect(r.rows[100].twd).toBeNull()
    expect(r.rows[100].twa).toBeNull()
    const p = provenanceAt(r.provenance, 'twd', oneTack[100].utc)!
    expect(p.kind).toBe('unavailable')
    expect(isPlottable(p)).toBe(false)
    expect(p.note).toMatch(/no opposite tack/)
  })

  it('handles an empty track without throwing', () => {
    const r = synthesise({ rows: [], format: 'vakaros-csv' })
    expect(r.rows).toEqual([])
    expect(r.twdCoverage).toBe(0)
  })
})

describe('pooling the squad', () => {
  it('lets a boat that cannot self-estimate borrow the fleet’s wind', () => {
    // This boat did one-tack speed tests all session and cannot fit a wind.
    const soloRows = buildTrack({ twd: TWD, turnSeconds: 0, legs: [{ twa: 42, seconds: 900 }] })
    const alone = synthesise({ rows: soloRows, format: 'vakaros-csv' })
    expect(alone.twdCoverage).toBe(0)

    // Its squad-mate was beating up and down at the same time.
    const mate = beat(TWD, { legs: 8, legSeconds: 150, startUtc: soloRows[0].utc })
    const pooled = synthesise({
      rows: soloRows, format: 'vakaros-csv',
      pooledSegments: [...alone.segments, ...synthesise({ rows: mate, format: 'vakaros-csv', model }).segments],
      model,
    })
    expect(pooled.twdCoverage).toBeGreaterThan(0)
    expect(Math.abs(angleDiff(pooled.rows[100].twd!, TWD))).toBeLessThan(8)
  })
})
