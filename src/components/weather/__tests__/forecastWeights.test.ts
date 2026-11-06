// The forecast generator's model list and per-venue weights.
//
// Two classes of bug are pinned here, and both have happened:
//
// 1. A MODEL IN A LIST THAT IS NOT THE RIGHT LIST. modelCoverage.test.ts
//    already guards MODEL_ORDER (the fetch) against COMPARE_ORDER (the
//    picker). The deck's own list was a THIRD one, and HRDPS and GFS were in
//    the other two and not in it — fetched at San Juan on every run and then
//    dropped, silently, with HRDPS the best-bracketing model at that venue.
// 2. A WEIGHT THAT DOES NOT ADD UP TO WHAT WAS ASKED FOR. Once a venue states
//    its weights as a budget ("SSA 0.8, HRRR 0.8, HRDPS and ECMWF 0.6, rest
//    0.3") the numbers have to be exactly that, including the part nobody
//    says out loud: the SSA-Race pair is ONE forecast at two resolutions, so
//    counting both spends 1.6 on it.

import { describe, expect, it } from 'vitest'
import {
  DECK_MODELS, DEFAULT_WEIGHTS, DEFAULT_OTHER, VENUE_WEIGHTS,
  SSA_FAMILY, weightTableFor, weightsFor, weightNote,
} from '../forecastWeights'
// @ts-expect-error — plain JS module, no types
import { MODELS, MODEL_ORDER, COMPARE_ORDER } from '../openMeteo'

const SAN_JUAN = 'san-juan'
// Every model that returns data at San Juan, measured live and recorded in
// modelCoverage.test.ts, plus the two SSA-Race domains the box publishes there.
const AT_SAN_JUAN = ['ICONRACE', 'ICONRACE_1KM', 'ECMWF', 'ICON', 'HRRR', 'HRDPS', 'NAM', 'GFS']

describe('the deck list is not a third list that forgets models', () => {
  it('names only models that exist', () => {
    for (const k of DECK_MODELS) expect(MODELS[k], k).toBeTruthy()
  })

  it('is a subset of the picker, so the deck never uses an unofferable model', () => {
    const extra = DECK_MODELS.filter((k) => !COMPARE_ORDER.includes(k))
    expect(extra, `in the deck but not in COMPARE_ORDER: ${extra.join(', ')}`).toEqual([])
  })

  it('is a subset of the fetch order, so every deck model is actually fetched', () => {
    // DMI is the known gap recorded in modelCoverage.test.ts: shown in Compare,
    // absent from MODEL_ORDER. It predates this file; recorded, not tolerated
    // silently.
    const unfetched = DECK_MODELS.filter((k) => !MODEL_ORDER.includes(k))
    expect(unfetched).toEqual(['DMI'])
  })

  it('includes HRDPS and GFS — the two that were being dropped', () => {
    expect(DECK_MODELS).toContain('HRDPS')
    expect(DECK_MODELS).toContain('GFS')
  })

  it('gives every deck model an explicit default weight', () => {
    // Not for tidiness: a model missing here silently lands on DEFAULT_OTHER
    // (0.5), which would have put HRDPS — a 2.5 km model — below NAM at 3.0.
    const unweighted = DECK_MODELS.filter((k) => DEFAULT_WEIGHTS[k] == null)
    expect(unweighted, `no DEFAULT_WEIGHTS entry: ${unweighted.join(', ')}`).toEqual([])
  })
})

describe('the default table is byte-for-byte what every other venue had', () => {
  // The whole point of making weights per venue was that no EXISTING deck
  // moves. These are the numbers from the single flat WEIGHTS object.
  const BEFORE: Record<string, number> = {
    ICONRACE: 7.0, ICONRACE_1KM: 8.5, AROME: 8.5, METNO: 8.5,
    HRRR: 8.5, NAM: 3.0, ECMWF: 1.3, ICON: 1.3, ARPEGE: 0.9, ITALIA: 1.5, DMI: 1.0,
  }
  for (const [k, v] of Object.entries(BEFORE)) {
    it(`${k} is still ${v}`, () => expect(DEFAULT_WEIGHTS[k]).toBe(v))
  }

  it('a venue with no table of its own gets exactly those weights', () => {
    const w = weightsFor('porto-cervo', ['ICONRACE_1KM', 'AROME', 'ECMWF', 'ARPEGE'])
    expect(w).toEqual({ ICONRACE_1KM: 8.5, AROME: 8.5, ECMWF: 1.3, ARPEGE: 0.9 })
  })

  it('and does NOT de-duplicate the SSA pair, which is the behaviour it had', () => {
    const w = weightsFor('porto-cervo', ['ICONRACE_1KM', 'ICONRACE'])
    expect(w.ICONRACE).toBe(7.0)
    expect(w.ICONRACE_1KM).toBe(8.5)
  })

  it('an unnamed model falls to 0.5, the old `|| 0.5`', () => {
    expect(weightTableFor(null).other).toBe(DEFAULT_OTHER)
    expect(weightsFor(null, ['CURRENTS'])).toEqual({ CURRENTS: 0.5 })
  })
})

describe('San Juan Islands — SSA + HRRR 0.8, HRDPS + ECMWF 0.6, rest 0.3', () => {
  const w = weightsFor(SAN_JUAN, AT_SAN_JUAN, { prefer: 'ICONRACE_1KM' })

  // The ordering is the assertion, not the numbers: HRRR is the venue's best
  // measured model (2.79 kn raw rmse against ECMWF's 3.77 over 4.8 years) and
  // must not sit below ECMWF again, which is where it started.
  it('puts HRRR level with SSA at 0.8, ABOVE ECMWF', () => {
    expect(w.HRRR).toBe(0.8)
    expect(w.ICONRACE_1KM).toBe(0.8)
    expect(w.HRRR).toBeGreaterThan(w.ECMWF)
  })

  it('puts HRDPS and ECMWF at 0.6', () => {
    expect(w.HRDPS).toBe(0.6)
    expect(w.ECMWF).toBe(0.6)
  })

  it('keeps the two North American mesoscale models above both globals', () => {
    for (const g of ['ECMWF', 'ICON', 'GFS']) {
      expect(w.HRRR).toBeGreaterThan(w[g])
      expect(w.HRDPS).toBeGreaterThanOrEqual(w[g])
    }
  })

  it('puts every other model at 0.3 — named or not', () => {
    expect(w.ICON).toBe(0.3)
    expect(w.NAM).toBe(0.3)
    expect(w.GFS).toBe(0.3)
    // ARPEGE has no data here, but the outlook page asks for it anyway.
    expect(weightsFor(SAN_JUAN, ['ARPEGE']).ARPEGE).toBe(0.3)
  })

  it('spends 0.8 on SSA in TOTAL, not 0.8 twice', () => {
    // The 1 km nest is driven by the 2 km parent: same model, same ICs, the
    // inner domain reading the outer one's boundaries. Counting both would
    // give one forecast 1.6 of a ~3.4 budget — half the ensemble.
    const ssa = SSA_FAMILY.reduce((a, k) => a + (w[k] ?? 0), 0)
    expect(ssa).toBe(0.8)
  })

  it('keeps the NEST and zeroes the parent', () => {
    expect(w.ICONRACE_1KM).toBe(0.8)
    expect(w.ICONRACE).toBe(0)
  })

  it('keeps whichever member the deck made its primary model', () => {
    // A weight of 0 on the deck's own headline model would drop it out of its
    // own band (weightedBand filters w > 0), so the retained member follows
    // the primary pick rather than the other way round.
    const p = weightsFor(SAN_JUAN, AT_SAN_JUAN, { prefer: 'ICONRACE' })
    expect(p.ICONRACE).toBe(0.8)
    expect(p.ICONRACE_1KM).toBe(0)
  })

  it('keeps the parent at full weight when the nest has no data', () => {
    // The nest is +18 h against the parent's +30 h, so late on day 2 only the
    // parent is there. Nothing to de-duplicate, so nothing is zeroed.
    const late = weightsFor(SAN_JUAN, ['ICONRACE', 'HRRR'], { prefer: 'ICONRACE' })
    expect(late.ICONRACE).toBe(0.8)
  })

  it('leaves the whole San Juan ensemble summing to 3.7', () => {
    // 0.8 SSA (the pair, de-duplicated) + 0.8 HRRR + 0.6 HRDPS + 0.6 ECMWF
    // + 0.3 x 3 (ICON, NAM, GFS). Worth pinning, because the share is what
    // the weights actually mean: HRRR alone carries 22 % of this deck, ECMWF
    // 16 %, and the three 0.3 models 24 % between them — more than either.
    const total = AT_SAN_JUAN.reduce((a, k) => a + w[k], 0)
    expect(total).toBeCloseTo(3.7, 10)
    expect(w.HRRR / total).toBeCloseTo(0.216, 3)
    expect(w.ECMWF / total).toBeCloseTo(0.162, 3)
    expect((w.ICON + w.NAM + w.GFS) / total).toBeCloseTo(0.243, 3)
  })
})

describe('the venue tables are well formed', () => {
  it('names only models the deck can actually use', () => {
    for (const [venue, t] of Object.entries(VENUE_WEIGHTS)) {
      for (const k of Object.keys(t.models)) {
        expect(DECK_MODELS, `${venue} weights ${k}, which is not in DECK_MODELS`)
          .toContain(k)
      }
    }
  })

  it('never states a negative or non-finite weight', () => {
    for (const [venue, t] of Object.entries(VENUE_WEIGHTS)) {
      expect(t.other, `${venue} other`).toBeGreaterThan(0)
      for (const [k, v] of Object.entries(t.models)) {
        expect(Number.isFinite(v) && v >= 0, `${venue} ${k} = ${v}`).toBe(true)
      }
    }
  })

  it('de-duplicates only where it says so', () => {
    // dedupeSsa zeroes a model. Any venue that sets it has to MEAN it, because
    // a 0 is invisible on screen: the model still appears in the comparison
    // table, it just stops voting.
    const dedupers = Object.entries(VENUE_WEIGHTS)
      .filter(([, t]) => t.dedupeSsa).map(([v]) => v)
    expect(dedupers).toEqual(['san-juan'])
  })
})

describe('weightNote — the weights said out loud on the deck', () => {
  const LABELS: Record<string, string> = {
    ICONRACE: 'SSA-Race 2 km', ICONRACE_1KM: 'SSA-Race 1 km', ECMWF: 'ECMWF',
    HRRR: 'HRRR', HRDPS: 'HRDPS', ICON: 'ICON', NAM: 'NAM', GFS: 'GFS',
  }
  const label = (k: string) => LABELS[k] || k

  it('groups equal weights and orders them heaviest first', () => {
    const w = weightsFor(SAN_JUAN, AT_SAN_JUAN, { prefer: 'ICONRACE_1KM' })
    const note = weightNote(w, label)
    expect(note).toBe(
      'Model weights — SSA-Race 1 km / HRRR 0.8 · ECMWF / HRDPS 0.6 · ICON / NAM / GFS 0.3'
      + ' · not weighted: SSA-Race 2 km',
    )
  })

  it('names the de-duplicated model, because it is still drawn on the charts', () => {
    // A reader seeing the SSA-Race 2 km line on the comparison page and no
    // movement in the band is owed the reason.
    const w = weightsFor(SAN_JUAN, ['ICONRACE', 'ICONRACE_1KM'], { prefer: 'ICONRACE_1KM' })
    expect(weightNote(w, label)).toContain('not weighted: SSA-Race 2 km')
  })

  it('says nothing at all rather than something empty', () => {
    expect(weightNote({})).toBe('')
    expect(weightNote({ ICONRACE: 0 })).toBe('')
  })

  it('ignores a broken weight instead of printing NaN on the deck', () => {
    expect(weightNote({ ECMWF: Number.NaN, HRRR: 0.6 }, label))
      .toBe('Model weights — HRRR 0.6')
  })
})
