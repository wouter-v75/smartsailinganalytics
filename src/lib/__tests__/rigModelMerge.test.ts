// src/lib/__tests__/rigModelMerge.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The merge that silently did nothing. Seeding Northstar 76 with the designer's
// datums left the stored model untouched, and because both sides then agreed,
// every audit of every frame came back "ok".
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { better, betterRef, mergeModels } from '../rigModelMerge'
import { MERGE_RANK, SELECTION_RANK, defaultRigModel, type RigModel, type ScaleRef } from '../rigModel'

const ref = (over: Partial<ScaleRef>): ScaleRef => ({
  key: 'wheels', label: 'Wheels', mm: 3375, sigmaMm: 10,
  source: 'measured', depthMm: -10_000, orientation: 'athwartships', ...over,
})

describe('the two rankings answer two different questions', () => {
  it('believes the DESIGNER over a tape when they disagree about the same dimension', () => {
    expect(MERGE_RANK.designer).toBeGreaterThan(MERGE_RANK.measured)
  })

  it('leaves them level when CHOOSING a reference, so sigma decides', () => {
    // Capricorno's mast-to-transom is off a drawing at 12 600 ±2010 — 16 %, and
    // ψ's error is proportional to it. A rank that preferred "designer" would
    // take it over a certificate J at 2.1 % for no better reason than its stamp.
    expect(SELECTION_RANK.designer).toBe(SELECTION_RANK.measured)
  })

  it('still puts both above arithmetic and a guess', () => {
    for (const R of [MERGE_RANK, SELECTION_RANK]) {
      expect(R.measured).toBeGreaterThan(R.derived)
      expect(R.derived).toBeGreaterThan(R.estimate)
    }
  })
})

describe('better — one dimension, two claims', () => {
  it('takes the designer over the tape: the Northstar 76 mast-to-transom', () => {
    const tape = { key: 'mast-transom', mm: 12_100, sigmaMm: 50, source: 'measured' }
    const sheet = { key: 'mast-transom', mm: 12_650, sigmaMm: 150, source: 'designer' }
    expect(better(tape, sheet)!.mm).toBe(12_650)
    // …whichever way round they arrive.
    expect(better(sheet, tape)!.mm).toBe(12_650)
  })

  it('gives a tie to what is already stored', () => {
    const a = { key: 'x', mm: 100, sigmaMm: 1, source: 'measured' }
    const b = { key: 'x', mm: 200, sigmaMm: 1, source: 'measured' }
    expect(better(a, b)!.mm).toBe(100)
  })

  it('ignores a number that is not there at all', () => {
    const real = { key: 'x', mm: 100, sigmaMm: 1, source: 'estimate' }
    expect(better({ key: 'x', mm: 0, sigmaMm: 0, source: 'designer' }, real)!.mm).toBe(100)
    expect(better(undefined, real)!.mm).toBe(100)
  })
})

describe('betterRef — a scale reference is two facts with one stamp', () => {
  it('keeps the tape-measured LENGTH and takes the designer DEPTH', () => {
    // The exact case: 3375 rim to rim really was measured, the -10 000 beside it
    // never was. Deciding them together made -7392 a tie it lost.
    const stored = ref({ mm: 3375, source: 'measured', depthMm: -10_000 })
    const designer = ref({ mm: 3375, source: 'measured', depthMm: -7392, depthSource: 'designer' })
    const out = betterRef(stored, designer)
    expect(out.mm).toBe(3375)
    expect(out.source).toBe('measured')
    expect(out.depthMm).toBe(-7392)
    expect(out.depthSource).toBe('designer')
  })

  it('does NOT move a depth that is no better attested', () => {
    const stored = ref({ depthMm: -10_000 })
    const other = ref({ depthMm: -8000 })
    expect(betterRef(stored, other).depthMm).toBe(-10_000)
  })

  it('falls back to the record\'s own source when a depth claims none', () => {
    // Old rows have no depthSource at all, and must keep behaving as before.
    const stored = ref({ depthMm: -10_000, source: 'estimate' })
    const measured = ref({ depthMm: -7392, source: 'measured' })
    expect(betterRef(stored, measured).depthMm).toBe(-7392)
    expect(betterRef(stored, measured).depthSource).toBe('measured')
  })
})

/** The DB as it stood: the tape's baseline and the guessed wheel depth. */
const stale = (): RigModel => {
    const m = defaultRigModel('Northstar 76')
    return {
      ...m,
      scaleRefs: [ref({ mm: 3375, source: 'measured', depthMm: -10_000 })],
      baselines: [
        { key: 'mast-transom', label: 'Mast to transom', mm: 12_100, sigmaMm: 50, source: 'measured' },
        { key: 'tack-mast', label: 'Tack to mast', mm: 8_860, sigmaMm: 200, source: 'measured' },
        // The slot has to be there for deriveBaselines to fill it; an estimate
        // is what it is until the two parts are attested.
        { key: 'bow-transom', label: 'Tack to transom', mm: 0, sigmaMm: 0, source: 'estimate' },
      ],
    }
  }
const sheet = (): RigModel => {
    const m = defaultRigModel('Northstar 76')
    return {
      ...m,
      scaleRefs: [ref({ mm: 3375, source: 'measured', depthMm: -7392, depthSource: 'designer' })],
      baselines: [
        { key: 'mast-transom', label: 'Mast to transom', mm: 12_650, sigmaMm: 150, source: 'designer' },
        { key: 'tack-mast', label: 'Tack to mast', mm: 8_860, sigmaMm: 200, source: 'measured' },
        { key: 'bow-transom', label: 'Tack to transom', mm: 0, sigmaMm: 0, source: 'estimate' },
      ],
    }
  }

describe('mergeModels — seeding Northstar 76 over what is already stored', () => {
  it('lands BOTH designer corrections — the whole point', () => {
    const out = mergeModels(stale(), sheet())
    expect(out.scaleRefs.find((r) => r.key === 'wheels')!.depthMm).toBe(-7392)
    expect(out.baselines.find((b) => b.key === 'mast-transom')!.mm).toBe(12_650)
  })

  it('and the derived baseline follows, agreeing with the certificate', () => {
    // 8860 + 12650 = 21510 = transom 23200 − tack 1690, off the designer's sheet.
    const out = mergeModels(stale(), sheet())
    expect(out.baselines.find((b) => b.key === 'bow-transom')!.mm).toBe(21_510)
  })

  it('does not throw away a stored reference the incoming model lacks', () => {
    const current = stale()
    current.scaleRefs.push(ref({ key: 'P', label: 'P', mm: 31_440, sigmaMm: 20, depthMm: 0, source: 'measured' }))
    const out = mergeModels(current, sheet())
    expect(out.scaleRefs.map((r) => r.key).sort()).toEqual(['P', 'wheels'])
  })

  it('is a no-op when there is nothing better to say', () => {
    const out = mergeModels(sheet(), sheet())
    expect(out.scaleRefs.find((r) => r.key === 'wheels')!.depthMm).toBe(-7392)
    expect(out.baselines.find((b) => b.key === 'mast-transom')!.mm).toBe(12_650)
  })
})

describe('supersede — when a stored value claims a provenance it never earned', () => {
  // The tab stamps source:'designer' on whatever is TYPED into a depth box, so
  // Northstar's -10 000 guess wore the same badge as the designer's real -7392.
  // Provenance cannot separate them; only a deliberate instruction can.
  const overclaimed = ref({ mm: 3375, source: 'designer', depthMm: -10_000 })
  const real = ref({ mm: 3375, source: 'measured', depthMm: -7392, depthSource: 'designer' })

  it('leaves the tie to the stored value by default — that is the safe direction', () => {
    expect(betterRef(overclaimed, real).depthMm).toBe(-10_000)
  })

  it('hands an EQUAL claim to the incoming model when asked', () => {
    const out = betterRef(overclaimed, real, true)
    expect(out.depthMm).toBe(-7392)
    expect(out.depthSource).toBe('designer')
  })

  it('never lets it overturn a genuinely better-attested stored value', () => {
    // Superseding resolves ties. It is not --force: a stored measurement still
    // beats an incoming estimate, or the flag would be a quiet data loss.
    const stored = { key: 'x', mm: 100, sigmaMm: 1, source: 'measured' }
    const guess = { key: 'x', mm: 200, sigmaMm: 500, source: 'estimate' }
    expect(better(stored, guess, true)!.mm).toBe(100)
  })

  it('does not delete a stored reference the incoming model has never heard of', () => {
    const current = stale()
    current.scaleRefs.push(ref({ key: 'HLU', label: 'HLU', mm: 30_600, sigmaMm: 150, depthMm: 0, source: 'measured' }))
    const out = mergeModels(current, sheet(), true)
    expect(out.scaleRefs.find((r) => r.key === 'HLU')!.mm).toBe(30_600)
  })

  it('lands the wheel depth through a whole-model merge', () => {
    const current = stale()
    current.scaleRefs = [overclaimed]
    const out = mergeModels(current, sheet(), true)
    expect(out.scaleRefs.find((r) => r.key === 'wheels')!.depthMm).toBe(-7392)
  })
})
