// src/lib/__tests__/sailTrimNorthstar.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The whole chain against ground truth, at Northstar 76's real geometry.
//
// Every other test here checks one function. This one marks a synthetic frame
// the way an operator marks a real one — scale off P, ψ from two clicked
// centreplane landmarks, a target clicked on the boom — and runs the result
// through the triangulation, against a FULL PERSPECTIVE camera that knows the
// answer. It is the only test that would catch the parts being individually
// right and collectively wrong.
//
// WHY NORTHSTAR AND NOT BARAKA. Baraka's frames are shot at 22-35 m where every
// correction is large, which is good for finding bugs and useless for checking
// one, because her certificate E carries an unknown amount of outhaul. Northstar
// is 260 m, 8.0° of ψ spread, and her 27 Sep set is the one this project
// recorded as checked. The real frames solved her boom to -9839 mm against an E
// of 10330 — 95.2 %, and nobody could say why.
//
// The synthetic reproduces that number to 3 mm, which is what makes the rest of
// it worth believing: run through the pre-fix path it gives -9836, 95.2 %. So
// the 4.8 % was not marking error or outhaul. It was ψ, inflated 5.5 % by the
// effective-separation bug, and the depth short by exactly that.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { makeCamera, type Rig } from './support/rigCamera'
import {
  mastAxisFromPoints, solvePsi, measureTarget, mmPerPxFromReference, rangeMmFrom,
  type Calibration,
} from '../sailTrim'
import { triangulate, type TriangulateView } from '../sailTrimTriangulate'

const P_MM = 31_440          // mast black bands, off the certificate
const MAST_TRANSOM = 12_650  // the designer's datum, not the tape's 12 100
const E = 10_330             // mainsail foot; the boom's depth, and the answer
const BOOM_Y = 2_210
const ASSUMED_D = -6_000     // the rig model's guess at save time
const SHOTS = [-5.45, -0.34, 2.56]   // the real 27 Sep spread: 8.0°
const HEEL = 11.7

/** Mark one synthetic frame exactly as the tab marks a real one. */
function frame(psiDeg: number, modern: boolean) {
  const rig: Rig = { heelDeg: HEEL, psiDeg, rollDeg: 0, rangeMm: 260_000,
    focalMm: 254, sensorWidthMm: 36, imgW: 6000, imgH: 4000 }
  const C = makeCamera(rig)
  const axis = mastAxisFromPoints(C(0, 0, 3_000), C(0, 0, 30_000))!
  const mmPerPxAtMast = mmPerPxFromReference(C(0, 0, 2_000), C(0, 0, 2_000 + P_MM), P_MM)!
  const rangeMm = rangeMmFrom({ widthMm: 36, focalLengthMm: 254, imageLongEdgePx: 6000 }, mmPerPxAtMast)
  // ψ is SOLVED from two clicked landmarks, never handed in.
  const psi = solvePsi(
    { aft: C(-MAST_TRANSOM, 0, 700), fwd: C(0, 0, 1_550), separationMm: MAST_TRANSOM,
      ...(modern ? { depthFwdMm: 0, depthAftMm: -MAST_TRANSOM } : {}) },
    axis.across, mmPerPxAtMast, HEEL, { clickSigmaPx: 0, ...(modern ? { rangeMm } : {}) },
  )
  const cal: Calibration = { axis, mmPerPxAtMast, scaleRelSigma: 0.002, rangeMm, psi,
    heelDeg: HEEL, heelSigmaDeg: 0.5, clickSigmaPx: 0, tack: 'port' }
  const m = measureTarget(cal, { key: 'boom', label: 'boom',
    point: C(-E, BOOM_Y, 2_500), depthMm: ASSUMED_D, depthSigmaMm: 1_500 })
  const view: TriangulateView = { psiDeg: psi.deg, measuredMm: m.boatFrameMm,
    assumedDepthMm: ASSUMED_D, ...(modern ? { rangeMm, heelDeg: HEEL, leewardSign: 1 } : {}) }
  return { psi: psi.deg, rangeMm, view }
}
const solve = (modern: boolean) => {
  const fs = SHOTS.map((p) => frame(p, modern))
  return { psis: fs.map((f) => f.psi), ranges: fs.map((f) => f.rangeMm!), r: triangulate(fs.map((f) => f.view))! }
}

describe('Northstar 76 — the whole chain against ground truth', () => {
  it('recovers ψ from two clicked landmarks to better than a twentieth of a degree', () => {
    const { psis } = solve(true)
    psis.forEach((p, i) => expect(Math.abs(p - SHOTS[i]), `ψ ${SHOTS[i]}`).toBeLessThan(0.05))
  })

  it('recovers the 260 m range from the scale and the focal length', () => {
    for (const R of solve(true).ranges) expect(Math.abs(R - 260_000)).toBeLessThan(1_500)
  })

  it('puts the boom within 100 mm of E, and athwartships within 5 mm', () => {
    // The depth is the hard one — it is the slope against sin ψ. The
    // athwartships figure is the intercept and lands on the millimetre.
    const { r } = solve(true)
    expect(Math.abs(r.depthMm + E)).toBeLessThan(100)
    expect(Math.abs(r.athwartshipsMm - BOOM_Y)).toBeLessThan(5)
    expect(r.rmsMm).toBeLessThan(1)
    expect(r.baselineDeg).toBeCloseTo(8.0, 1)
  })

  it('REPRODUCES the 95.2 % the real frames gave before the fixes', () => {
    // The check that makes the rest of this trustworthy: the pre-fix path lands
    // on -9836 against the -9839 the actual 27 Sep frames produced. So the
    // synthetic is a faithful model of the real measurement, and the 4.8 % gap
    // was never outhaul or marking error.
    const { r, psis } = solve(false)
    expect(100 * Math.abs(r.depthMm) / E).toBeGreaterThan(94.5)
    expect(100 * Math.abs(r.depthMm) / E).toBeLessThan(96)
    // …and it was ψ: inflated by about 5.5 %, with the depth short by the same.
    expect(Math.abs(psis[0])).toBeGreaterThan(Math.abs(SHOTS[0]) * 1.04)
    // The residual stayed tiny throughout, which is why nothing caught it.
    expect(r.rmsMm).toBeLessThan(1)
  })

  it('the fix moves it the right way, and not past the truth', () => {
    const before = Math.abs(solve(false).r.depthMm)
    const after = Math.abs(solve(true).r.depthMm)
    expect(after).toBeGreaterThan(before)
    expect(after).toBeLessThan(E)       // still short, never overshooting E
  })
})
