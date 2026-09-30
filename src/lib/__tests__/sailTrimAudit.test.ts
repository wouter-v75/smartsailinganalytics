// src/lib/__tests__/sailTrimAudit.test.ts
import { describe, it, expect } from 'vitest'
import { scaleDrift, rangeToRefMm, driftNote, type StoredScale } from '../sailTrimAudit'

/** A Northstar 76 frame as it was stored before the designer's datums: wheels
 *  guessed at -10 000 mm abaft the mast, camera 83 m from the mast. */
const stored: StoredScale = {
  key: 'wheels', mm: 3375, depthMm: -10_000,
  mmPerPxAtMast: 12.5, rangeMm: 83_000, boat: 'Northstar 76',
}

describe('rangeToRefMm — undoing what the annotation stored', () => {
  it('puts the reference nearer the camera than the mast', () => {
    // The wheels are abaft the mast and the camera is astern, so the wheels are
    // CLOSER: 83 m to the mast, 73 m to the wheels.
    expect(rangeToRefMm(stored)).toBe(73_000)
  })

  it('gives nothing when the frame had no focal length', () => {
    expect(rangeToRefMm({ ...stored, rangeMm: null })).toBeNull()
  })
})

describe('scaleDrift — the wheel depth the designer corrected', () => {
  it('reports the 3 % the -10 000 guess was worth', () => {
    const d = scaleDrift(stored, { mm: 3375, depthMm: -7392 })
    expect(d.stale).toBe(true)
    // (73000 + 7392) / (73000 + 10000) = 0.9686
    expect(d.ratio!).toBeCloseTo(80_392 / 83_000, 6)
    expect(driftNote(d.ratio)).toBe('stored numbers are 3.1 % large')
    expect(d.reasons.join(' ')).toContain('-10000 → -7392')
  })

  it('says nothing about a frame measured on the datums in force today', () => {
    const d = scaleDrift({ ...stored, depthMm: -7392, rangeMm: 80_392 }, { mm: 3375, depthMm: -7392 })
    expect(d.stale).toBe(false)
    expect(d.ratio).toBe(1)
  })

  it('carries a changed reference LENGTH straight through, exactly', () => {
    // Scale is proportional to the reference's true length, so this one is not
    // first-order at all: a 1 % longer wheelbase is 1 % on every millimetre.
    const d = scaleDrift({ ...stored, depthMm: -7392, rangeMm: 80_392 }, { mm: 3408.75, depthMm: -7392 })
    expect(d.ratio!).toBeCloseTo(1.01, 9)
    expect(d.reasons.join(' ')).toContain('length 3375 → 3408.75 mm')
  })

  it('says a depth change did not move a frame that never had a depth correction', () => {
    // No focal length means no range, means the correction was skipped. The
    // stored numbers are what they always were; it is the REDO that will differ.
    const d = scaleDrift({ ...stored, rangeMm: null }, { mm: 3375, depthMm: -7392 })
    expect(d.stale).toBe(true)
    expect(d.ratio).toBe(1)
    expect(d.reasons.join(' ')).toContain('no focal length')
  })

  it('refuses to guess when the reference is not in the model any more', () => {
    const d = scaleDrift(stored, null)
    expect(d.stale).toBe(false)
    expect(d.ratio).toBeNull()
    expect(d.reasons.join(' ')).toContain('cannot tell')
  })

  it('combines a length change and a depth change', () => {
    const d = scaleDrift(stored, { mm: 3408.75, depthMm: -7392 })
    expect(d.ratio!).toBeCloseTo(1.01 * (80_392 / 83_000), 9)
    expect(d.reasons).toHaveLength(2)
  })
})

describe('driftNote', () => {
  it('reads the way an operator wants it', () => {
    expect(driftNote(0.969)).toBe('stored numbers are 3.1 % large')
    expect(driftNote(1.004)).toBe('stored numbers are 0.4 % small')
    expect(driftNote(1)).toBe('no material change')
    expect(driftNote(null)).toBe('unknown')
  })
})
