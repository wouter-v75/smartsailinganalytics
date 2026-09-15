import { describe, it, expect } from 'vitest'
import {
  parseWeightKg, nextSource, sailPatchFrom, mergeSpecs, type SailDraft,
} from '../sailEdit'

const draft = (over: Partial<SailDraft> = {}): SailDraft => ({
  name: 'MAIN_2026',
  category: 'MAIN',
  buildDate: '2026-01-15',
  kind: 'mainsail',
  sailType: 'Mainsail',
  group: 'M',
  weight: '116.6',
  ...over,
})

describe('parseWeightKg', () => {
  it('reads a weight', () => {
    expect(parseWeightKg('116.6')).toBe(116.6)
  })

  it('takes a comma decimal, because European keyboards produce one', () => {
    expect(parseWeightKg('24,5')).toBe(24.5)
  })

  it('tolerates surrounding space', () => {
    expect(parseWeightKg('  62.5 ')).toBe(62.5)
  })

  it('rounds to a tenth, the way a weigh-in sheet does', () => {
    expect(parseWeightKg('49.24')).toBe(49.2)
    expect(parseWeightKg('49.26')).toBe(49.3)
  })

  it('is null for nothing typed — clearing a weight is a thing people do', () => {
    expect(parseWeightKg('')).toBeNull()
    expect(parseWeightKg('   ')).toBeNull()
  })

  it('never yields NaN, which JSONB would happily store', () => {
    for (const bad of ['heavy', '-', '.', 'kg', '1.2.3']) {
      const out = parseWeightKg(bad)
      expect(out === null || Number.isFinite(out)).toBe(true)
    }
    expect(parseWeightKg('heavy')).toBeNull()
  })

  it('refuses zero and negatives — a sail that weighs nothing is a typo', () => {
    expect(parseWeightKg('0')).toBeNull()
    expect(parseWeightKg('-5')).toBeNull()
  })
})

describe('nextSource', () => {
  it('marks a corrected import so the next import cannot silently undo it', () => {
    expect(nextSource('event-file')).toBe('event-file-edited')
  })

  it('leaves an already-corrected row alone rather than stacking suffixes', () => {
    expect(nextSource('event-file-edited')).toBe('event-file-edited')
  })

  it('keeps a hand-made row manual', () => {
    expect(nextSource('manual')).toBe('manual')
  })

  it('calls a row with no source manual, which is what it is', () => {
    expect(nextSource(undefined)).toBe('manual')
    expect(nextSource(null)).toBe('manual')
    expect(nextSource(7)).toBe('manual')
  })
})

describe('sailPatchFrom', () => {
  it('sends the four newly-editable fields', () => {
    const p = sailPatchFrom(draft())
    expect(p.kind).toBe('mainsail')
    expect(p.specs.sail_type).toBe('Mainsail')
    expect(p.specs.sail_group).toBe('M')
    expect(p.specs.weight_kg).toBe(116.6)
  })

  it('upper-cases the group, so "m" and "M" are the same group', () => {
    expect(sailPatchFrom(draft({ group: 'h' })).specs.sail_group).toBe('H')
  })

  it('trims, and turns an emptied field into null rather than ""', () => {
    const p = sailPatchFrom(draft({ category: '  ', sailType: '  ', group: ' ', weight: '' }))
    expect(p.category).toBeNull()
    expect(p.specs.sail_type).toBeNull()
    expect(p.specs.sail_group).toBeNull()
    expect(p.specs.weight_kg).toBeNull()
  })

  it('sends ONLY the keys it edits — design shapes must not travel through a form', () => {
    const p = sailPatchFrom(draft(), { design_shapes: { conditions: [1, 2, 3] } })
    expect(Object.keys(p.specs).sort()).toEqual(['sail_group', 'sail_type', 'source', 'weight_kg'])
    expect(p.specs.design_shapes).toBeUndefined()
  })

  it('carries the source forward from what was stored', () => {
    expect(sailPatchFrom(draft(), { source: 'event-file' }).specs.source).toBe('event-file-edited')
    expect(sailPatchFrom(draft(), {}).specs.source).toBe('manual')
  })

  it('turns an empty build date into null, not an empty string the column rejects', () => {
    expect(sailPatchFrom(draft({ buildDate: '' })).build_date).toBeNull()
  })
})

describe('mergeSpecs', () => {
  const stored = {
    sail_type: 'Mainsail',
    sail_group: 'M',
    weight_kg: 116.6,
    source: 'event-file',
    design_shapes: { conditions: [{ tws: 8 }, { tws: 14 }] },
  }

  it('keeps everything the patch does not mention', () => {
    const out = mergeSpecs(stored, { weight_kg: 118.2 })
    expect(out.design_shapes).toEqual(stored.design_shapes)
    expect(out.sail_type).toBe('Mainsail')
    expect(out.weight_kg).toBe(118.2)
  })

  it('does not lose design shapes when a whole form patch lands', () => {
    // The failure this exists to prevent: saving a weight from a row that was
    // loaded before a shapes import, and deleting the shapes with it.
    const out = mergeSpecs(stored, sailPatchFrom(draft({ weight: '120' })).specs)
    expect(out.design_shapes).toEqual(stored.design_shapes)
  })

  it('can clear a value, because null is a value and not an absence', () => {
    expect(mergeSpecs(stored, { weight_kg: null }).weight_kg).toBeNull()
  })

  it('survives a row whose specs are missing or not an object', () => {
    for (const junk of [null, undefined, 'nope', 7, ['a']]) {
      expect(mergeSpecs(junk, { weight_kg: 1 })).toEqual({ weight_kg: 1 })
    }
  })

  it('does not mutate what was stored', () => {
    mergeSpecs(stored, { weight_kg: 1 })
    expect(stored.weight_kg).toBe(116.6)
  })
})
