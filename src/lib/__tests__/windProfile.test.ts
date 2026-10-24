// The numbers in "paper" below come from an independently derived table in
// research_notes/.../height_correction_and_profiles.md, computed with COARE 3.5
// roughness and the same psi functions. This module uses plain Charnock, so the
// two agree to within 0.004 rather than exactly — and that residual IS the
// roughness scheme, which is the thing the module header says barely matters.
//
// These are the tests that would catch a sign error in the stability term, and
// a sign error there is the whole ballgame: it turns the largest correction in
// the model into the smallest one, in a direction that still looks plausible.

import { describe, expect, it } from 'vitest'
import {
  psiM, psiH, charnockZ0, solveSurfaceLayer, profileRatio, neutralRatio,
  transferWind, mastheadWind, STABLE_SURFACE_LAYER_M,
} from '../windProfile'

const KN = 0.514444
const layerFor = (u10kn: number, dT: number) => solveSurfaceLayer(u10kn * KN, dT)
const ratio10to30 = (u10kn: number, dT: number) => {
  const l = layerFor(u10kn, dT)
  return profileRatio(30, 10, l.z0, l.lengthM)
}

describe('psi functions', () => {
  it('are zero at neutral', () => {
    expect(psiM(0)).toBe(0)
    expect(psiH(0)).toBe(0)
  })

  it('are negative on the stable side and positive on the unstable side', () => {
    // Sign convention: U(z) = (u*/k)[ln(z/z0) - psiM(z/L) + ...], so a NEGATIVE
    // psiM steepens the profile. Stable must steepen it.
    expect(psiM(0.5)).toBeLessThan(0)
    expect(psiM(-0.5)).toBeGreaterThan(0)
  })

  it('reproduce the published DISAGREEMENT between the stable forms', () => {
    // The published claim is a 6 % spread at z/L = 0.5 between
    // Beljaars-Holtslag and the linear psi_m = -5z, rising further at z/L = 1.
    // Only the SPREAD is asserted, not either absolute ratio: the absolute
    // value depends on z0, and the source computed theirs with COARE 3.5
    // roughness at a particular wind speed rather than the fixed z0 used here.
    const z0 = 1e-4
    const spread = (zOverL: number) => {
      const L = 10 / zOverL
      const bh = profileRatio(30, 10, z0, L)
      const linear = (() => {
        const f = (z: number) => Math.log(z / z0) + 5 * (z / L)
        return f(30) / f(10)
      })()
      return { bh, linear, frac: linear / bh - 1 }
    }
    const half = spread(0.5)
    expect(half.linear).toBeGreaterThan(half.bh)
    expect(half.frac).toBeGreaterThan(0.04)
    // And it widens, which is why the choice of stable form matters more the
    // more stable it gets.
    expect(spread(1).frac).toBeGreaterThan(half.frac)
  })

  it('saturate on the unstable side', () => {
    // The whole unstable range is worth ~5 %: from z/L -0.1 to -2 the ratio
    // barely moves. That is why the unstable branch is the one to ignore.
    const z0 = 1e-4
    const a = profileRatio(30, 10, z0, 10 / -0.1)
    const b = profileRatio(30, 10, z0, 10 / -2)
    expect(Math.abs(a - b)).toBeLessThan(0.04)
  })
})

describe('charnockZ0', () => {
  it('gives a marine roughness of the right order', () => {
    expect(charnockZ0(0.135)).toBeGreaterThan(1e-5)
    expect(charnockZ0(0.135)).toBeLessThan(1e-3)
  })

  it('grows with friction velocity', () => {
    expect(charnockZ0(0.4)).toBeGreaterThan(charnockZ0(0.15))
  })
})

describe('the neutral profile barely depends on roughness', () => {
  it('moves the 10->30 m ratio only a few percent across the whole marine range', () => {
    // 1.084 at 5 kn to about 1.10 at 30 kn. Stability is the term to get right;
    // Charnock is a detail, and this test is what stops anyone "improving" it.
    const light = neutralRatio(30, 10, charnockZ0(layerFor(5, 0).uStarMs))
    const fresh = neutralRatio(30, 10, charnockZ0(layerFor(30, 0).uStarMs))
    expect(light).toBeGreaterThan(1.07)
    expect(fresh).toBeLessThan(1.12)
    expect(fresh - light).toBeLessThan(0.04)
  })
})

describe('the STABLE table — warm air over cooler water', () => {
  // Every row independently derived; this module must land on them.
  // Rows inside MOST's stated range are held to 2 decimal places. The
  // strongly stable rows — z/L at 10 m above about 1 — are held to 1, because
  // the source itself says the ratios there "should be read as 'the profile
  // becomes steep and MOST stops being quantitative', not as a precise
  // number". Demanding 3-figure agreement in a regime both implementations
  // call non-quantitative would be a test pretending to more than it has.
  const rows: Array<[number, number, number, number]> = [
    [6, 1, 1.343, 2], [6, 2, 1.412, 1],
    [10, 1, 1.209, 2], [10, 2, 1.297, 2], [10, 3, 1.353, 2], [10, 5, 1.403, 1],
    [15, 2, 1.191, 2], [20, 2, 1.150, 2], [20, 5, 1.217, 2],
  ]
  for (const [u10, dT, paper, dp] of rows) {
    it(`${u10} kn, +${dT} K -> ratio ${paper}${dp === 1 ? ' (strongly stable: a bound)' : ''}`, () => {
      expect(ratio10to30(u10, dT)).toBeCloseTo(paper, dp)
    })
  }

  it('flags every row the source called non-quantitative', () => {
    // If a row needs the loose tolerance above, the module must also be
    // telling callers not to trust it to 3 figures.
    for (const [u10, dT] of [[6, 2], [10, 5]] as number[][]) {
      const t = mastheadWind(u10, 10, 30, dT)
      expect(t.quality, `${u10} kn +${dT} K`).not.toBe('ok')
    }
  })

  it('costs 2.1 kn at the masthead on an ordinary offshore morning', () => {
    // The headline number: 10 kn, +2 K. Neutral says 10.84 at 30 m; the truth
    // is 12.97. If this test fails the stability term is not being applied.
    const t = mastheadWind(10, 10, 30, 2)
    expect(t.kn).toBeCloseTo(12.97, 1)
    expect(t.neutralKn).toBeCloseTo(10.84, 1)
    expect(t.kn - t.neutralKn).toBeCloseTo(2.1, 1)
    expect(t.regime).toBe('stable')
  })

  it('bites hardest in light air and fades as the wind builds', () => {
    // Mechanical mixing wins: 2.1 kn at 10 kn, under 1 kn at 20 kn.
    const light = mastheadWind(10, 10, 30, 2)
    const fresh = mastheadWind(20, 10, 30, 2)
    expect(light.kn - light.neutralKn).toBeGreaterThan(1.5)
    expect(fresh.kn - fresh.neutralKn).toBeLessThan(1.2)
    expect(light.ratio).toBeGreaterThan(fresh.ratio)
  })
})

describe('the UNSTABLE table — cold air over warmer water', () => {
  const rows: Array<[number, number, number]> = [
    [10, -2, 1.048], [10, -5, 1.040], [20, -5, 1.071],
  ]
  for (const [u10, dT, paper] of rows) {
    it(`${u10} kn, ${dT} K -> ratio ${paper}`, () => {
      expect(ratio10to30(u10, dT)).toBeCloseTo(paper, 2)
    })
  }

  it('is worth well under a knot, so it is the branch to ignore if one must', () => {
    const t = mastheadWind(10, 10, 30, -2)
    expect(t.regime).toBe('unstable')
    expect(Math.abs(t.kn - t.neutralKn)).toBeLessThan(0.8)
  })
})

describe('the sign of deltaK', () => {
  it('POSITIVE is stable and increases the masthead wind', () => {
    // Getting this backwards turns the largest correction into the smallest,
    // in a direction that still looks plausible. Hence a test of its own.
    const stable = mastheadWind(10, 10, 30, 2)
    const unstable = mastheadWind(10, 10, 30, -2)
    expect(stable.kn).toBeGreaterThan(stable.neutralKn)
    expect(unstable.kn).toBeLessThan(unstable.neutralKn)
    expect(stable.kn).toBeGreaterThan(unstable.kn)
  })

  it('puts the Obukhov length positive when stable', () => {
    expect(layerFor(10, 2).lengthM).toBeGreaterThan(0)
    expect(layerFor(10, -2).lengthM).toBeLessThan(0)
    expect(layerFor(10, 0).lengthM).toBe(Infinity)
  })
})

describe('honesty about where the theory stops', () => {
  it('flags a strongly stable masthead as a bound, not a number', () => {
    const t = mastheadWind(6, 10, 30, 3)
    expect(['marginal', 'beyond-theory']).toContain(t.quality)
    expect(t.uncertainty).toBeGreaterThan(0.1)
    expect(t.note).toBeTruthy()
  })

  it('says so when a stable target is above a stable surface layer', () => {
    const t = mastheadWind(15, 10, 30, 2)
    expect(t.quality).not.toBe('ok')
    expect(t.note).toMatch(new RegExp(String(STABLE_SURFACE_LAYER_M)))
  })

  it('is comfortable close to the surface in mild stability', () => {
    const t = mastheadWind(20, 10, 12, 1)
    expect(t.quality).toBe('ok')
    expect(t.uncertainty).toBeLessThanOrEqual(0.05)
  })

  it('treats a MISSING temperature as a low-biased guess, not a neutral one', () => {
    // The point that matters: no data is not the same as no stability.
    const t = mastheadWind(10, 10, 30, null)
    expect(t.kn).toBeCloseTo(t.neutralKn, 6)
    expect(t.quality).toBe('marginal')
    expect(t.uncertainty).toBeGreaterThan(0.05)
    expect(t.note).toMatch(/LOW/)
  })
})

describe('degenerate inputs', () => {
  it('returns something sane for zero or nonsense wind', () => {
    expect(solveSurfaceLayer(0, 2).uStarMs).toBe(0)
    expect(solveSurfaceLayer(NaN, 2).lengthM).toBe(Infinity)
    expect(mastheadWind(0, 10, 30, 2).kn).toBe(0)
  })

  it('is the identity when the heights match', () => {
    expect(profileRatio(10, 10, 1e-4, 50)).toBeCloseTo(1, 10)
    expect(mastheadWind(12, 10, 10, 2).kn).toBeCloseTo(12, 6)
  })

  it('refuses impossible geometry rather than returning Infinity', () => {
    expect(profileRatio(30, 0, 1e-4, Infinity)).toBe(1)
    expect(profileRatio(30, 10, 0, Infinity)).toBe(1)
  })

  it('goes DOWN as well as up', () => {
    // The report's recommendation is to push the model down to the station,
    // not lift the station up, so the downward direction has to work.
    const l = layerFor(10, 2)
    const down = profileRatio(10, 30, l.z0, l.lengthM)
    const up = profileRatio(30, 10, l.z0, l.lengthM)
    expect(down).toBeCloseTo(1 / up, 6)
    expect(down).toBeLessThan(1)
  })
})
