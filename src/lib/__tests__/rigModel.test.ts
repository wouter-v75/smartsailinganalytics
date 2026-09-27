import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  defaultRigModel, missingFrom, isComplete, scaleRelSigma,
  loadRigModel, saveRigModel, listRigModels, rigModelFor,
  exportRigModel, importRigModel,
  luffDepthMm,
  migrateRigModel, deriveBaselines, depthFor,
  HEIGHT_TAGS, STRIPE_TAGS, SPREADER_TAGS, heightMarkKey, migrateHeightMarks, stationsFor,
  type RigModel, type RigValue,
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

describe('migrateRigModel — a stored model gains fields added since', () => {
  it('fills in a field the stored model predates', () => {
    // The bug: a model saved before `widths` existed was returned verbatim, so
    // the sail girths were missing for ever — and twist, which divides by them,
    // silently showed nothing at all.
    const old = defaultRigModel('Northstar 76') as RigModel & { widths?: unknown }
    delete old.widths
    const m = migrateRigModel(old)
    expect(m.widths).toBeDefined()
  })

  it('keeps the operator’s own edits — the default only fills gaps', () => {
    const stored = defaultRigModel('Northstar 76')
    stored.scaleRefs = stored.scaleRefs.map((r) =>
      r.key === 'spreader2' ? { ...r, mm: 6240, sigmaMm: 5, source: 'designer' as const } : r)
    stored.depths = { ...stored.depths, boom: { mm: -10330, sigmaMm: 150, source: 'measured' } }
    const m = migrateRigModel(stored)
    expect(m.scaleRefs.find((r) => r.key === 'spreader2')!.mm).toBe(6240)
    expect(m.depths.boom.mm).toBe(-10330)
    expect(m.depths.boom.source).toBe('measured')
  })

  it('fills a DEPTH added since, without disturbing the ones stored', () => {
    const stored = defaultRigModel('X') as RigModel
    // a model from before the main's leech had its own depth
    const depths = { ...stored.depths } as Record<string, unknown>
    delete depths.mainLeech
    const m = migrateRigModel({ ...stored, depths: depths as RigModel['depths'] })
    expect(m.depths.mainLeech).toBeDefined()
    expect(m.depths.leech).toEqual(stored.depths.leech)
  })

  it('is what loadRigModel hands back, so the migration is not optional', () => {
    const stored = defaultRigModel('Northstar 76') as RigModel & { widths?: unknown }
    delete stored.widths
    window.localStorage.setItem('ssa-rig-models-v1',
      JSON.stringify({ 'northstar 76': stored }))
    expect(loadRigModel('Northstar 76')!.widths).toBeDefined()
    expect(rigModelFor('Northstar 76').widths).toBeDefined()
    window.localStorage.removeItem('ssa-rig-models-v1')
  })
})

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

// ─────────────────────────────────────────────────────────────────────────────
// Mast-to-stern, derived — and the per-sail station keys.
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveBaselines — mast to stern from the two that pin it', () => {
  const withBaselines = (over: Record<string, Partial<RigValue>>): RigModel => {
    const m = defaultRigModel('Test')
    return { ...m, baselines: m.baselines.map((b) => ({ ...b, ...(over[b.key] || {}) })) }
  }
  const mt = (m: RigModel) => m.baselines.find((b) => b.key === 'mast-transom')!

  it('derives it when both inputs are real', () => {
    const out = deriveBaselines(withBaselines({
      'bow-transom': { mm: 20880, sigmaMm: 20, source: 'designer' },
      'tack-mast': { mm: 8860, sigmaMm: 10, source: 'measured' },
    }))
    expect(mt(out).mm).toBe(20880 - 8860)
    expect(mt(out).source).toBe('derived')
    // Errors in quadrature, not added: hypot(20, 10) = 22.
    expect(mt(out).sigmaMm).toBe(22)
  })

  it('leaves it alone while either input is still a guess', () => {
    const out = deriveBaselines(withBaselines({
      'bow-transom': { mm: 20880, sigmaMm: 20, source: 'designer' },
      // tack-mast stays the default estimate
    }))
    expect(mt(out).source).toBe('estimate')
    expect(mt(out).mm).toBe(13000)
  })

  it('never overwrites a number somebody measured', () => {
    // A tape beats arithmetic, and silently replacing it would be the worst kind
    // of helpfulness: the operator would have no way to see it had happened.
    const out = deriveBaselines(withBaselines({
      'bow-transom': { mm: 20880, sigmaMm: 20, source: 'designer' },
      'tack-mast': { mm: 8860, sigmaMm: 10, source: 'measured' },
      'mast-transom': { mm: 12100, sigmaMm: 15, source: 'measured' },
    }))
    expect(mt(out).mm).toBe(12100)
    expect(mt(out).source).toBe('measured')
  })

  it('derives the WHOLE from the two parts — the long baseline for free', () => {
    // The direction that matters most: tack-to-transom is the longest of the
    // three, and ψ's precision scales with the separation, so a tape at deck
    // level buys the best baseline on the boat.
    const out = deriveBaselines(withBaselines({
      'tack-mast': { mm: 8860, sigmaMm: 200, source: 'measured' },
      'mast-transom': { mm: 12100, sigmaMm: 50, source: 'measured' },
    }))
    const bow = out.baselines.find((b) => b.key === 'bow-transom')!
    expect(bow.mm).toBe(8860 + 12100)
    expect(bow.source).toBe('derived')
    expect(bow.sigmaMm).toBe(Math.round(Math.hypot(200, 50)))   // 206, not 250
  })

  it('derives J from the whole and the after part', () => {
    const out = deriveBaselines(withBaselines({
      'bow-transom': { mm: 20960, sigmaMm: 20, source: 'designer' },
      'mast-transom': { mm: 12100, sigmaMm: 50, source: 'measured' },
    }))
    const j = out.baselines.find((b) => b.key === 'tack-mast')!
    expect(j.mm).toBe(20960 - 12100)
    expect(j.source).toBe('derived')
  })

  it('fills only ONE — two unknowns are not determined by one equation', () => {
    // One sum cannot pin two missing terms. Filling either from the single known
    // value would be inventing a number with a provenance tag on it.
    const out = deriveBaselines(withBaselines({
      'mast-transom': { mm: 12100, sigmaMm: 50, source: 'measured' },
    }))
    expect(out.baselines.find((b) => b.key === 'bow-transom')!.source).toBe('estimate')
    expect(out.baselines.find((b) => b.key === 'tack-mast')!.source).toBe('estimate')
  })

  it('refuses a nonsense subtraction', () => {
    // J longer than the whole boat means one of them is wrong; a negative
    // baseline would make solvePsi produce a confident wrong answer.
    const out = deriveBaselines(withBaselines({
      'bow-transom': { mm: 8000, sigmaMm: 20, source: 'designer' },
      'tack-mast': { mm: 8860, sigmaMm: 10, source: 'measured' },
    }))
    expect(mt(out).source).toBe('estimate')
  })
})

describe('height stations — per sail for stripes, shared for spreaders', () => {
  it('gives each sail its own stripe key', () => {
    expect(heightMarkKey('main', 'stripe50')).toBe('h:main:stripe50')
    expect(heightMarkKey('jib', 'stripe50')).toBe('h:jib:stripe50')
    expect(heightMarkKey('main', 'stripe50')).not.toBe(heightMarkKey('jib', 'stripe50'))
  })

  it('gives both sails the SAME spreader key', () => {
    expect(heightMarkKey('main', 'spr2')).toBe('h:spr2')
    expect(heightMarkKey('jib', 'spr2')).toBe('h:spr2')
  })

  it('splits the tags without losing any', () => {
    expect([...STRIPE_TAGS, ...SPREADER_TAGS].map((t) => t.key).sort())
      .toEqual(HEIGHT_TAGS.map((t) => t.key).sort())
  })

  it('migrates a pre-split shot onto the jib', () => {
    // The jib, not the main: the shared stations were marked against the jib's
    // leech in practice, so assigning them to the main would move every stored
    // stripe measurement to a different height.
    const out = migrateHeightMarks({
      'h:stripe50': [{ x: 1, y: 2 }],
      'h:spr2': [{ x: 3, y: 4 }],
      'leech:jib': [{ x: 5, y: 6 }],
    })
    expect(Object.keys(out).sort()).toEqual(['h:jib:stripe50', 'h:spr2', 'leech:jib'])
    expect(out['h:jib:stripe50']).toEqual([{ x: 1, y: 2 }])
    // A spreader is shared, so its key is untouched.
    expect(out['h:spr2']).toEqual([{ x: 3, y: 4 }])
  })

  it('leaves already-migrated marks alone', () => {
    const once = migrateHeightMarks({ 'h:stripe25': [{ x: 1, y: 1 }] })
    expect(migrateHeightMarks(once)).toEqual(once)
  })
})

describe("Northstar 76's baselines, end to end", () => {
  // The whole point of MEASURED: a new device opens the tab and the boat's real
  // numbers are already there, without anyone pasting or typing anything.
  const m = rigModelFor('Northstar 76')
  const b = (k: string) => m.baselines.find((x) => x.key === k)!

  it('has the wheel-to-wheel scale reference measured', () => {
    const w = m.scaleRefs.find((s) => s.key === 'wheels')!
    expect(w.mm).toBe(3375)
    expect(w.source).toBe('measured')
    // ~10 m abaft the mast, which is why it needs a depth at all.
    expect(w.depthMm).toBe(-10_000)
  })

  it('has mast-to-stern and J measured, and tack-to-transom derived from them', () => {
    expect(b('mast-transom').mm).toBe(12_100)
    expect(b('mast-transom').source).toBe('measured')
    expect(b('tack-mast').mm).toBe(8_860)
    expect(b('tack-mast').source).toBe('measured')
    expect(b('bow-transom').mm).toBe(20_960)
    expect(b('bow-transom').source).toBe('derived')
  })

  it('no longer reports a missing baseline', () => {
    // It used to: all three were estimates, so ψ fell back to 0 ± 1° — and a
    // degree of ψ is ±180 mm on a boom at E.
    expect(missingFrom(m).some((x) => x.includes('baseline'))).toBe(false)
  })
})

describe('stationsFor — which stations a sail is read at', () => {
  it('reads the main at its draft stripes only', () => {
    // At spreader height the main's leech is far aft (E is 10.33 m) and close to
    // the centreplane, so the reading is small and noisy — on the 26 Sep frame
    // main@spr1 and main@spr2 came out -281 and +163 mm, two numbers straddling
    // zero — and a spreader carries no fraction of the hoist, so it cannot give
    // twist either.
    expect(stationsFor('main').map((t) => t.key)).toEqual(['stripe25', 'stripe50', 'stripe75', 'stripe87'])
    expect(stationsFor('main').some((t) => t.key.startsWith('spr'))).toBe(false)
  })

  it('reads the jib at stripes AND spreaders', () => {
    // On the jib a spreader height is a real distance out near the tips, and
    // "mast to leech at spreader 2" is the speed team's own measurement.
    expect(stationsFor('jib').map((t) => t.key)).toEqual(HEIGHT_TAGS.map((t) => t.key))
  })

  it('leaves the spreader MARKS shared — this is only about who is read', () => {
    expect(heightMarkKey('main', 'spr2')).toBe(heightMarkKey('jib', 'spr2'))
  })
})

describe('deriveBaselines — a derivation may not feed on its own output', () => {
  const withBaselines = (over: Record<string, Partial<RigValue>>): RigModel => {
    const m = defaultRigModel('Test')
    return { ...m, baselines: m.baselines.map((b) => ({ ...b, ...(over[b.key] || {}) })) }
  }

  it('refuses a DERIVED input', () => {
    // Capricorno's certificate import found this. The parser took J off an
    // estimated tack-to-transom and called the result derived; this then
    // re-derived tack-to-transom from it, handing a guess back with a 'derived'
    // label and a tighter sigma and nothing new behind it.
    const out = deriveBaselines(withBaselines({
      'tack-mast': { mm: 9440, sigmaMm: 200, source: 'measured' },
      'mast-transom': { mm: 11560, sigmaMm: 2010, source: 'derived' },
    }))
    expect(out.baselines.find((b) => b.key === 'bow-transom')!.source).toBe('estimate')
  })

  it('still derives from a drawing', () => {
    const out = deriveBaselines(withBaselines({
      'tack-mast': { mm: 8860, sigmaMm: 200, source: 'measured' },
      'mast-transom': { mm: 12100, sigmaMm: 50, source: 'designer' },
    }))
    const bow = out.baselines.find((b) => b.key === 'bow-transom')!
    expect(bow.mm).toBe(20960)
    expect(bow.source).toBe('derived')
  })
})

describe('merging a certificate into a boat that has been measured', () => {
  // The case: Northstar 76 carried a tape-measured wheel base and mast-to-stern
  // and NO P — the 31 m scale reference that beats a 6 m spreader by an order of
  // magnitude — because its model came from the defaults, never from its own
  // certificate. The certificate has P and J to the centimetre and cannot see
  // the wheels at all. Neither source wins outright; the better-attested value
  // for each dimension does.
  const RANK: Record<string, number> = { measured: 3, designer: 2, derived: 1, estimate: 0 }
  const better = <T extends { mm: number; source: string }>(a: T | undefined, b: T | undefined) => {
    if (!a || !(a.mm > 0)) return b
    if (!b || !(b.mm > 0)) return a
    return (RANK[b.source] ?? 0) > (RANK[a.source] ?? 0) ? b : a
  }

  it('prefers a tape over a derivation', () => {
    const tape = { mm: 12100, sigmaMm: 50, source: 'measured' }
    const derived = { mm: 11560, sigmaMm: 2010, source: 'derived' }
    expect(better(tape, derived)).toBe(tape)
    expect(better(derived, tape)).toBe(tape)
  })

  it('takes a certificate value where there was only a guess', () => {
    const guess = { mm: 0, sigmaMm: 0, source: 'estimate' }
    const cert = { mm: 31440, sigmaMm: 20, source: 'measured' }
    expect(better(guess, cert)).toBe(cert)
  })

  it('keeps what is already stored when the two are equally attested', () => {
    // Somebody put the stored one there on purpose; an import should not churn it.
    const stored = { mm: 8860, sigmaMm: 200, source: 'measured' }
    const incoming = { mm: 8860, sigmaMm: 200, source: 'measured' }
    expect(better(stored, incoming)).toBe(stored)
  })
})

describe('depthFor — one number per sail was never enough', () => {
  // A leech sweeps forward as it rises. Triangulated from three frames 8° apart
  // on 27 Sep, Northstar's main runs -8321 mm at the 25 % stripe to -3536 mm at
  // 87.5 %, against the single -6000 ± 2500 that `depths` holds for all of them.
  const base = defaultRigModel('Northstar 76')

  it('falls back to the sail-wide number when nothing is measured', () => {
    expect(depthFor(base, 'main', 'stripe50').mm).toBe(base.depths.mainLeech.mm)
    expect(depthFor(base, 'jib', 'stripe50').mm).toBe(base.depths.leech.mm)
  })

  it('prefers a station that HAS been measured', () => {
    const m: RigModel = { ...base, stationDepths: {
      'main@stripe25': { mm: -8321, sigmaMm: 12, source: 'measured' },
      'main@stripe87': { mm: -3536, sigmaMm: 12, source: 'measured' },
    } }
    expect(depthFor(m, 'main', 'stripe25').mm).toBe(-8321)
    expect(depthFor(m, 'main', 'stripe87').mm).toBe(-3536)
    // …and still falls back for the stations nobody has solved.
    expect(depthFor(m, 'main', 'stripe50').mm).toBe(base.depths.mainLeech.mm)
  })

  it('keeps the sails apart', () => {
    const m: RigModel = { ...base, stationDepths: { 'main@stripe50': { mm: -6374, sigmaMm: 9, source: 'measured' } } }
    expect(depthFor(m, 'main', 'stripe50').mm).toBe(-6374)
    expect(depthFor(m, 'jib', 'stripe50').mm).toBe(base.depths.leech.mm)
  })

  it('survives a round trip through the store', () => {
    const m: RigModel = { ...base, stationDepths: { 'main@stripe50': { mm: -6374, sigmaMm: 9, source: 'measured' } } }
    expect(depthFor(migrateRigModel(m, 'Northstar 76'), 'main', 'stripe50').mm).toBe(-6374)
  })
})
