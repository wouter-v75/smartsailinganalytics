import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  defaultRigModel, missingFrom, isComplete, scaleRelSigma,
  loadRigModel, saveRigModel, listRigModels, rigModelFor,
  exportRigModel, importRigModel,
  luffDepthMm, rigModelFor,
} from '../rigModel'

// jsdom 25's localStorage has no clear(); the repo stubs it the same way in
// venueToday.test.ts.
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('luffDepthMm — where a luff sits, fore and aft', () => {
  const m = rigModelFor('Northstar 76')

  it('puts the main’s luff on the mast, because it IS the mast', () => {
    expect(luffDepthMm('main', 0.5, m).mm).toBe(0)
  })

  it('walks the jib’s luff forward as it comes down the forestay', () => {
    // The forestay runs from a tack J forward of the mast to a masthead
    // directly above it, so at a quarter hoist it is still three-quarters of J
    // forward. This is why a luff cannot be measured with the leech's depth.
    const j = m.baselines.find((b) => b.key === 'tack-mast')!.mm
    expect(luffDepthMm('jib', 0.25, m).mm).toBeCloseTo(j * 0.75, 6)
    expect(luffDepthMm('jib', 0.50, m).mm).toBeCloseTo(j * 0.50, 6)
    expect(luffDepthMm('jib', 0.75, m).mm).toBeCloseTo(j * 0.25, 6)
    // Forward of the mast is positive, and it is metres not millimetres of it.
    expect(luffDepthMm('jib', 0.25, m).mm).toBeGreaterThan(5_000)
  })

  it('takes mid-luff when the height has no fraction, and widens for it', () => {
    // A spreader has no canonical fraction of hoist, so the depth is a guess
    // and the sigma says so rather than pretending otherwise.
    const spr = luffDepthMm('jib', null, m)
    const known = luffDepthMm('jib', 0.5, m)
    expect(spr.mm).toBeCloseTo(known.mm, 6)
    expect(spr.sigmaMm).toBeGreaterThan(known.sigmaMm * 2)
    // …and wide enough to matter: metres, not millimetres.
    expect(spr.sigmaMm).toBeGreaterThan(1_000)
  })

  it('still answers for a boat with no J in the model', () => {
    const bare = { ...m, baselines: m.baselines.filter((b) => b.key !== 'tack-mast') }
    expect(luffDepthMm('jib', 0.5, bare).mm).toBeGreaterThan(0)
  })
})

describe('rigModel — provenance', () => {
  it('a fresh model is honest about being guesswork', () => {
    const m = defaultRigModel('Northstar 76')
    expect(isComplete(m)).toBe(false)
    const missing = missingFrom(m)
    expect(missing[0]).toMatch(/scale reference/)
    expect(missing.join(' ')).toMatch(/centreplane baseline/)
    expect(missing.join(' ')).toMatch(/clew/)
    expect(m.scaleRefs.every((s) => s.source === 'estimate')).toBe(true)
  })

  it('stops complaining once the designer\'s numbers are in', () => {
    const m = defaultRigModel('Northstar 76')
    m.scaleRefs[0] = { ...m.scaleRefs[0], mm: 6240, sigmaMm: 5, source: 'designer' }
    m.baselines[0] = { ...m.baselines[0], mm: 20880, sigmaMm: 20, source: 'designer' }
    for (const k of ['leech', 'mainLeech', 'clew', 'boom'] as const) {
      m.depths[k] = { ...m.depths[k], sigmaMm: 50, source: 'designer' }
    }
    expect(missingFrom(m)).toEqual([])
    expect(isComplete(m)).toBe(true)
  })

  it('turns a reference into the relative sigma the measurement needs', () => {
    expect(scaleRelSigma({ key: 'x', label: '', mm: 6000, sigmaMm: 600, source: 'estimate', depthMm: 0 }))
      .toBeCloseTo(0.1, 6)
    expect(scaleRelSigma({ key: 'x', label: '', mm: 6240, sigmaMm: 5, source: 'designer', depthMm: 0 }))
      .toBeCloseTo(0.0008, 4)
    // nothing known ⇒ a deliberately fat default rather than a confident zero
    expect(scaleRelSigma(null)).toBe(0.02)
  })
})

describe('rigModel — storage', () => {
  it('round-trips per boat and keeps them apart', () => {
    const a = defaultRigModel('Northstar 76'); a.notes = 'from the 2026 drawing'
    const b = defaultRigModel('Northstar 72')
    saveRigModel(a); saveRigModel(b)
    expect(loadRigModel('Northstar 76')!.notes).toBe('from the 2026 drawing')
    expect(loadRigModel('northstar 76')!.notes).toBe('from the 2026 drawing')  // case-insensitive
    expect(loadRigModel('Northstar 72')!.notes).toBe('')
    expect(listRigModels().map((m) => m.boat)).toEqual(['Northstar 72', 'Northstar 76'])
  })

  it('falls back to the marked-as-guesswork default for an unknown boat', () => {
    const m = rigModelFor('Bella')
    expect(m.boat).toBe('Bella')
    expect(isComplete(m)).toBe(false)
    expect(loadRigModel('Bella')).toBeNull()
  })

  it('ignores a boat with no name rather than writing a blank key', () => {
    saveRigModel(defaultRigModel('  '))
    expect(listRigModels()).toEqual([])
    expect(loadRigModel('')).toBeNull()
  })
})

describe('rigModel — handing it to someone else', () => {
  it('round-trips through JSON', () => {
    const m = defaultRigModel('Northstar 76')
    m.scaleRefs[0] = { ...m.scaleRefs[0], mm: 6240, sigmaMm: 5, source: 'designer' }
    const back = importRigModel(exportRigModel(m))!
    expect(back.boat).toBe('Northstar 76')
    expect(back.scaleRefs[0].mm).toBe(6240)
    expect(back.scaleRefs[0].source).toBe('designer')
  })

  it('refuses nonsense instead of importing half a model', () => {
    expect(importRigModel('not json')).toBeNull()
    expect(importRigModel('[1,2,3]')).toBeNull()
    expect(importRigModel('{"boat":"x"}')).toBeNull()        // no scaleRefs, no depths
  })

  it('fills the gaps when a partial model is imported', () => {
    const partial = JSON.stringify({
      boat: 'Bella',
      scaleRefs: [{ key: 'spreader2', label: 'Spreader 2', mm: 5800, sigmaMm: 10, source: 'designer', depthMm: 0 }],
      depths: { clew: { mm: 7400, sigmaMm: 60, source: 'designer' } },
    })
    const m = importRigModel(partial)!
    expect(m.scaleRefs).toHaveLength(1)
    expect(m.depths.clew.mm).toBe(7400)
    expect(m.depths.boom.source).toBe('estimate')   // untouched, still a guess
    expect(m.baselines.length).toBeGreaterThan(0)   // filled from the default
    expect(m.sensorWidthMm).toBe(36)
  })
})
