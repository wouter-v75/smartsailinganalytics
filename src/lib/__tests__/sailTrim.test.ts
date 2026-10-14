import { describe, it, expect } from 'vitest'
import {
  mastAxisFromEdges, mastAxisFromPoints, cameraRollDeg, horizontalDir,
  mmPerPxFromReference, rangeMmFrom, mmPerPxAtDepth, solvePsi, focalSensitivity, focalForSensor,
  measureTarget, intersectPolyline, leechTargets, runChecks,
  imageHeelDeg, effectiveHeelDeg, psiFromHeelShortening,
  type Px, type Calibration,
  tackFromTwa, leewardSign,
  centreplaneFoot,
  unbiasAthwartshipsScale,
  effectiveSeparationMm,
} from '../sailTrim'
import {
  makeCamera, RIG, MAST_HALF_WIDTH, SPREADER_HALF, SPREADER_Z, TACK, TRANSOM,
  type Rig,
} from './support/rigCamera'

const DEG = Math.PI / 180

function buildCalibration(
  rig: Rig,
  opts: { psiBaseline?: boolean; heelKnown?: boolean; tack?: 'port' | 'stbd' | null } = {},
): Calibration {
  const P = makeCamera(rig)
  const axis = mastAxisFromEdges([
    { port: P(0, -MAST_HALF_WIDTH, 5_000), stbd: P(0, MAST_HALF_WIDTH, 5_000) },
    { port: P(0, -MAST_HALF_WIDTH, 30_000), stbd: P(0, MAST_HALF_WIDTH, 30_000) },
  ])!
  const mmPerPxAtMast = mmPerPxFromReference(
    P(0, -SPREADER_HALF, SPREADER_Z), P(0, SPREADER_HALF, SPREADER_Z), 2 * SPREADER_HALF,
  )!
  const rangeMm = rangeMmFrom(
    { widthMm: rig.sensorWidthMm, focalLengthMm: rig.focalMm, imageLongEdgePx: rig.imgW },
    mmPerPxAtMast,
  )
  const psi = solvePsi(
    opts.psiBaseline === false ? null : {
      aft: P(TRANSOM.x, 0, TRANSOM.z),
      fwd: P(TACK.x, 0, TACK.z),
      separationMm: TACK.x - TRANSOM.x,
    },
    axis.across, mmPerPxAtMast, opts.heelKnown === false ? null : rig.heelDeg,
    { clickSigmaPx: 1.5 },
  )
  return {
    axis, mmPerPxAtMast, scaleRelSigma: 0.002, rangeMm, psi,
    heelDeg: opts.heelKnown === false ? null : rig.heelDeg,
    heelSigmaDeg: 0.5, clickSigmaPx: 1.5,
    // The synthetic rig is heeled to starboard, i.e. sailing on port tack.
    tack: opts.tack === undefined ? 'port' : opts.tack,
  }
}

describe('sailTrim — scale and range', () => {
  it('recovers ~6 mm/px and ~260 m from the 6 Sept shooting geometry', () => {
    const cal = buildCalibration(RIG)
    // 6.2 mm/px is what the 1905 mm dimension measures out at on the originals.
    expect(cal.mmPerPxAtMast).toBeGreaterThan(5.9)
    expect(cal.mmPerPxAtMast).toBeLessThan(6.3)
    expect(cal.rangeMm! / 1000).toBeCloseTo(260, 0)
  })

  it('a point forward of the mast is FARTHER from an astern camera, so it scales up', () => {
    // 8 m forward at 260 m range ⇒ +3.1 % mm-per-pixel
    expect(mmPerPxAtDepth(6.0, 8_000, 260_000)).toBeCloseTo(6.0 * (268 / 260), 6)
    // and the boom, aft, scales down
    expect(mmPerPxAtDepth(6.0, -4_000, 260_000)).toBeLessThan(6.0)
    // no range ⇒ no correction
    expect(mmPerPxAtDepth(6.0, 8_000, null)).toBe(6.0)
  })
})

describe('sailTrim — the mast axis', () => {
  it('apparent lean is heel plus camera roll', () => {
    const upright = mastAxisFromPoints({ x: 100, y: 900 }, { x: 100, y: 100 })!
    expect(upright.tiltDeg).toBeCloseTo(0, 6)

    const cal = buildCalibration({ ...RIG, rollDeg: 4 })
    // the mast's apparent lean is heel ± roll — which way depends on which
    // side the boat is heeled and which way the camera was tipped
    expect(Math.abs(Math.abs(cal.axis.tiltDeg) - 23)).toBeCloseTo(4, 0)
    expect(Math.abs(cameraRollDeg(cal.axis, 23)!)).toBeCloseTo(4, 0)
  })

  it('declines to sign the roll when the mast is nearly upright', () => {
    const almost = mastAxisFromPoints({ x: 101, y: 900 }, { x: 100, y: 100 })!
    expect(cameraRollDeg(almost, 23)).toBeNull()
    expect(horizontalDir(almost, 23).rollApplied).toBe(false)
  })

  it('needs two points', () => {
    expect(mastAxisFromEdges([{ port: { x: 0, y: 0 }, stbd: { x: 1, y: 0 } }])).toBeNull()
    expect(mastAxisFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull()
  })
})

describe('sailTrim — misalignment', () => {
  it('recovers ψ from a centreplane baseline', () => {
    for (const psiDeg of [-1.5, -0.4, 0, 0.7, 2.2]) {
      const cal = buildCalibration({ ...RIG, psiDeg })
      expect(cal.psi.measured).toBe(true)
      expect(cal.psi.deg).toBeCloseTo(psiDeg, 1)
    }
  })

  it('a 21 m baseline pins ψ to better than a tenth of a degree', () => {
    const cal = buildCalibration(RIG)
    expect(cal.psi.sigmaDeg).toBeLessThan(0.1)
  })

  it('without a baseline it assumes zero and says so, with an honest sigma', () => {
    const cal = buildCalibration(RIG, { psiBaseline: false })
    expect(cal.psi).toEqual({ deg: 0, sigmaDeg: 1.0, measured: false })
  })
})

describe('sailTrim — the measurement', () => {
  const TARGET = { depthMm: 8_000, athwartMm: 1_900, zMm: SPREADER_Z }
  const target = (rig: Rig) => ({
    key: 'clew', label: 'Jib clew',
    point: makeCamera(rig)(TARGET.depthMm, TARGET.athwartMm, TARGET.zMm),
    depthMm: TARGET.depthMm, depthSigmaMm: 300,
  })

  it('recovers the true athwartships distance, aligned camera', () => {
    const cal = buildCalibration(RIG)
    const m = measureTarget(cal, target(RIG))
    expect(m.boatFrameMm).toBeCloseTo(TARGET.athwartMm, -1) // within 10 mm
    expect(m.depthScaleApplied).toBe(true)
    expect(m.rollApplied).toBe(true)
  })

  it('world-horizontal is boat-frame ÷ cos(heel), exactly', () => {
    const cal = buildCalibration(RIG)
    const m = measureTarget(cal, target(RIG))
    expect(m.worldHorizontalMm).toBeCloseTo(m.boatFrameMm / Math.cos(23 * DEG), -1)
    // ⇒ 8.6 % apart at 23° of heel. This is the §4.4 decision, in one number.
    expect(m.worldHorizontalMm / m.boatFrameMm).toBeCloseTo(1.086, 2)
  })

  it('ψ = 1° costs ~140 mm on a target 8 m forward, and the correction removes it', () => {
    const rig = { ...RIG, psiDeg: 1 }
    const t = target(rig)

    const corrected = measureTarget(buildCalibration(rig), t)
    expect(corrected.boatFrameMm).toBeCloseTo(TARGET.athwartMm, -1)

    // …and what you get if you don't measure ψ: the error the doc predicts.
    const blind = measureTarget(buildCalibration(rig, { psiBaseline: false }), t)
    expect(Math.abs(blind.boatFrameMm - TARGET.athwartMm)).toBeGreaterThan(120)
    expect(Math.abs(blind.boatFrameMm - TARGET.athwartMm)).toBeLessThan(160)
    // and it is honest about it
    expect(blind.boatFrameSigmaMm).toBeGreaterThan(120)
  })

  it('the naive number under-reads forward of the mast by ~d/R', () => {
    const cal = buildCalibration(RIG)
    const m = measureTarget(cal, target(RIG))
    // naive = image-horizontal, mast-plane scale, ψ = 0 — i.e. Rhino.
    const shortfall = m.worldHorizontalMm - m.naiveMm
    expect(shortfall / m.worldHorizontalMm).toBeCloseTo(8_000 / 268_000, 2)
    expect(shortfall).toBeGreaterThan(45)
  })

  it('an unknown camera roll only bites the world-horizontal number', () => {
    const rig = { ...RIG, rollDeg: 3 }
    const known = measureTarget(buildCalibration(rig), target(rig))
    const blind = measureTarget(buildCalibration(rig, { heelKnown: false }), target(rig))
    // boat frame is referenced to the mast itself, so roll cannot touch it
    expect(blind.boatFrameMm).toBeCloseTo(known.boatFrameMm, 3)
    // the horizontal one moves, and the sigma grows to cover it
    expect(Math.abs(blind.worldHorizontalMm - known.worldHorizontalMm)).toBeGreaterThan(20)
    expect(blind.worldHorizontalSigmaMm).toBeGreaterThan(known.worldHorizontalSigmaMm)
  })

  it('the boom, aft of the mast, works with a negative depth', () => {
    const rig = RIG
    const boomPx = makeCamera(rig)(-6_000, 2_400, 3_000)
    const m = measureTarget(buildCalibration(rig), {
      key: 'boom', label: 'Boom', point: boomPx, depthMm: -6_000, depthSigmaMm: 200,
    })
    expect(m.boatFrameMm).toBeCloseTo(2_400, -1)
  })

  it('sigma grows with depth uncertainty and with scale uncertainty', () => {
    const cal = buildCalibration(RIG)
    const base = measureTarget(cal, target(RIG))
    const vague = measureTarget(cal, { ...target(RIG), depthSigmaMm: 2_000 })
    expect(vague.boatFrameSigmaMm).toBeGreaterThan(base.boatFrameSigmaMm)
    // 2 % on a 1,900 mm reading is 38 mm, and it dominates everything else
    const sloppyScale = measureTarget({ ...cal, scaleRelSigma: 0.02 }, target(RIG))
    expect(sloppyScale.boatFrameSigmaMm).toBeGreaterThan(35)
    expect(sloppyScale.boatFrameSigmaMm).toBeGreaterThan(2 * base.boatFrameSigmaMm)
  })

  it('with everything known, sigma is tens of millimetres, not hundreds', () => {
    const cal = buildCalibration(RIG)
    const m = measureTarget(cal, target(RIG))
    expect(m.boatFrameSigmaMm).toBeLessThan(40)
  })
})

describe('sailTrim — the leech is an intersection, not a point', () => {
  it('crosses a polyline with an arbitrary line', () => {
    const poly: Px[] = [{ x: 100, y: 0 }, { x: 120, y: 100 }, { x: 140, y: 200 }]
    const hit = intersectPolyline(poly, { x: 0, y: 50 }, { x: 1, y: 0 })
    expect(hit!.x).toBeCloseTo(110, 6)
    expect(hit!.y).toBeCloseTo(50, 6)
    expect(intersectPolyline(poly, { x: 0, y: 900 }, { x: 1, y: 0 })).toBeNull()
    expect(intersectPolyline([{ x: 1, y: 1 }], { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull()
  })

  it('gives two different leech points for the two definitions', () => {
    const P = makeCamera(RIG)
    const cal = buildCalibration(RIG)
    const spreaderOnMast = P(0, 0, SPREADER_Z)
    // a leech running up and outboard through the spreader-2 region
    const leech = [
      P(7_500, 2_600, SPREADER_Z - 4_000),
      P(7_800, 2_200, SPREADER_Z),
      P(8_100, 1_800, SPREADER_Z + 4_000),
    ]
    const { boatFrame, worldHorizontal } = leechTargets(leech, cal.axis, spreaderOnMast, 23)
    expect(boatFrame).not.toBeNull()
    expect(worldHorizontal).not.toBeNull()
    // Heeled, the two lines diverge, so they meet the leech at different places
    // — which is exactly why the definition has to be settled.
    expect(Math.hypot(boatFrame!.x - worldHorizontal!.x, boatFrame!.y - worldHorizontal!.y))
      .toBeGreaterThan(5)
  })
})

describe('sailTrim — which side of the centreline', () => {
  it('reads the tack off TWA the way the rest of SSA does', () => {
    // manoeuvres.ts and phaseStats.ts both use `twa >= 0 ? stbd : port`.
    // Disagreeing with them here would flip every sign silently.
    expect(tackFromTwa(38)).toBe('stbd')
    expect(tackFromTwa(141)).toBe('stbd')
    expect(tackFromTwa(0)).toBe('stbd')
    expect(tackFromTwa(-38)).toBe('port')
    expect(tackFromTwa(-141)).toBe('port')
    expect(tackFromTwa(null)).toBeNull()
    expect(tackFromTwa(undefined)).toBeNull()
    expect(tackFromTwa(NaN)).toBeNull()
  })

  it('flips only on starboard tack', () => {
    // From astern image-right is starboard. On starboard tack starboard is
    // WINDWARD, so it has to come out negative; on port tack it is already the
    // leeward side and nothing changes.
    expect(leewardSign('stbd')).toBe(-1)
    expect(leewardSign('port')).toBe(1)
    expect(leewardSign(null)).toBe(1)
    expect(leewardSign(undefined)).toBe(1)
  })

  it('gives the SAME trim the same number on either tack', () => {
    // The whole reason the convention exists. A target two metres to leeward is
    // +2000 whichever way the boat is going.
    const P = makeCamera(RIG)
    const toStarboard = P(-1_100, 2_000, 8_000)

    const onPort = measureTarget(buildCalibration(RIG, { tack: 'port' }), {
      key: 't', label: 't', point: toStarboard, depthMm: -1_100, depthSigmaMm: 100,
    })
    const onStbd = measureTarget(buildCalibration(RIG, { tack: 'stbd' }), {
      key: 't', label: 't', point: toStarboard, depthMm: -1_100, depthSigmaMm: 100,
    })

    // On PORT tack, starboard is leeward: positive.
    expect(onPort.boatFrameMm).toBeGreaterThan(0)
    // On STARBOARD tack, the same point is to WINDWARD — above the centreline —
    // and reads negative. This is the boom case the convention was asked for.
    expect(onStbd.boatFrameMm).toBeLessThan(0)
    // Same magnitude, opposite sign.
    expect(onStbd.boatFrameMm).toBeCloseTo(-onPort.boatFrameMm, 6)
    expect(onStbd.worldHorizontalMm).toBeCloseTo(-onPort.worldHorizontalMm, 6)
    expect(onStbd.naiveMm).toBeCloseTo(-onPort.naiveMm, 6)
    // And both are the honest ~2000 mm away from the mast.
    expect(Math.abs(onPort.boatFrameMm)).toBeGreaterThan(1_950)
    expect(Math.abs(onPort.boatFrameMm)).toBeLessThan(2_050)
  })

  it('does not put a sign on an uncertainty', () => {
    const P = makeCamera(RIG)
    const pt = P(-1_100, 2_000, 8_000)
    const m = measureTarget(buildCalibration(RIG, { tack: 'stbd' }), {
      key: 't', label: 't', point: pt, depthMm: -1_100, depthSigmaMm: 100,
    })
    expect(m.boatFrameMm).toBeLessThan(0)
    expect(m.boatFrameSigmaMm).toBeGreaterThan(0)
    expect(m.worldHorizontalSigmaMm).toBeGreaterThan(0)
  })

  it('says the sign is not referred to the boat when the tack is unknown', () => {
    const P = makeCamera(RIG)
    const pt = P(-1_100, 2_000, 8_000)
    const known = measureTarget(buildCalibration(RIG, { tack: 'port' }), {
      key: 't', label: 't', point: pt, depthMm: -1_100, depthSigmaMm: 100,
    })
    const unknown = measureTarget(buildCalibration(RIG, { tack: null }), {
      key: 't', label: 't', point: pt, depthMm: -1_100, depthSigmaMm: 100,
    })
    expect(known.leewardPositive).toBe(true)
    expect(unknown.leewardPositive).toBe(false)
    // Unflipped, so the value is whatever the image said — which is why the
    // display hides the sign in this case rather than printing a fact it has not
    // established.
    expect(unknown.boatFrameMm).toBeCloseTo(known.boatFrameMm, 6)
  })

  it('makes the missing tack a failed check, with the boom named', () => {
    const none = runChecks(buildCalibration(RIG, { tack: null })).find((c) => c.key === 'tack')!
    expect(none.ok).toBe(false)
    expect(none.detail).toMatch(/boom/)
    const stbd = runChecks(buildCalibration(RIG, { tack: 'stbd' })).find((c) => c.key === 'tack')!
    expect(stbd.ok).toBe(true)
    expect(stbd.detail).toMatch(/starboard tack/)
    expect(stbd.detail).toMatch(/LEEWARD POSITIVE/)
  })
})

describe('sailTrim — measured from the CENTREPLANE, not the mast line', () => {
  it('puts the foot on the mast only for a target in the mast plane', () => {
    const P = makeCamera(RIG)
    const cal = buildCalibration(RIG)
    const pt = P(0, 2_000, 8_000)
    const foot = centreplaneFoot(cal, pt, 0)
    // depth 0 ⇒ the centreplane and the mast's line coincide there.
    const onAxis = (cal.axis.high.x - cal.axis.low.x) * (foot.y - cal.axis.low.y)
      - (cal.axis.high.y - cal.axis.low.y) * (foot.x - cal.axis.low.x)
    expect(Math.abs(onAxis)).toBeLessThan(1e-6)
  })

  // A camera a degree off the centreplane — which is every real shot, and the
  // only case where the centreplane and the mast's line are different things.
  const OFF: Rig = { ...RIG, psiDeg: 1 }

  it('moves the foot OFF the mast for a target abaft it, by d·sin psi', () => {
    // The boom is E abaft the mast. The centreplane there is not where the mast
    // is drawn, and the line on the photograph has to end where the number says.
    const P = makeCamera(OFF)
    const cal = buildCalibration(OFF)
    expect(cal.psi.measured).toBe(true)
    expect(Math.abs(cal.psi.deg)).toBeGreaterThan(0.5)    // recovered the 1°

    const boom = P(-10_330, 900, 2_000)
    const atMast = centreplaneFoot(cal, boom, 0)
    const atBoom = centreplaneFoot(cal, boom, -10_330)
    const shiftPx = Math.hypot(atBoom.x - atMast.x, atBoom.y - atMast.y)
    expect(shiftPx).toBeGreaterThan(1)

    // …and it is the displacement the measurement itself applies, so the drawn
    // line and its label agree. Compare the two ways of getting the same mm.
    const m = measureTarget(cal, {
      key: 'boom', label: 'Boom', point: boom, depthMm: -10_330, depthSigmaMm: 150,
    })
    const mmPerPxAtBoom = mmPerPxAtDepth(cal.mmPerPxAtMast, -10_330, cal.rangeMm)
    const drawnMm = Math.hypot(boom.x - m.foot!.x, boom.y - m.foot!.y) * mmPerPxAtBoom
    expect(drawnMm).toBeCloseTo(Math.abs(m.boatFrameMm), 0)
  })

  it('draws a line whose LENGTH is the number — which the mast foot was not', () => {
    // The regression. footOnAxis was what got drawn; for the boom it is short by
    // d·sin psi, so the picture disagreed with its own label. On Northstar's
    // boom at one degree that is ~180 mm.
    const P = makeCamera(OFF)
    const cal = buildCalibration(OFF)
    const boom = P(-10_330, 900, 2_000)
    const m = measureTarget(cal, {
      key: 'boom', label: 'Boom', point: boom, depthMm: -10_330, depthSigmaMm: 150,
    })
    const mmPerPxAtBoom = mmPerPxAtDepth(cal.mmPerPxAtMast, -10_330, cal.rangeMm)
    const onMast = centreplaneFoot(cal, boom, 0)
    const mastMm = Math.hypot(boom.x - onMast.x, boom.y - onMast.y) * mmPerPxAtBoom
    // The two differ by about d·sin psi — 10.33 m at 1° is ~180 mm — and it is
    // the centreplane one that matches the printed number.
    expect(Math.abs(mastMm - Math.abs(m.boatFrameMm))).toBeGreaterThan(100)
  })

  it('says when a baseline was clicked but had no length to measure psi with', () => {
    const cal = { ...buildCalibration(RIG, { psiBaseline: false }), baselineMarkedButUnmeasured: true }
    const c = runChecks(cal).find((x) => x.key === 'psi')!
    expect(c.ok).toBe(false)
    expect(c.detail).toMatch(/MARKED but/)
    expect(c.detail).toMatch(/no length in the rig model/)
    // and names the cost on the boom, which is the target that suffers
    expect(c.detail).toMatch(/180 mm/)

    const never = runChecks(buildCalibration(RIG, { psiBaseline: false })).find((x) => x.key === 'psi')!
    expect(never.detail).toMatch(/no centreplane baseline marked/)
  })
})

describe('sailTrim — a camera WELL off the centreplane', () => {
  // The shots are actually taken 10-20 degrees off, not one. Everything here is
  // measured against the full perspective camera in support/rigCamera, so these
  // are the method's real errors rather than its intentions.
  const CLEW = { y: 1_500, d: -1_100 }
  const BOOM = { y: 900, d: -10_330 }

  /** Calibrate the way the tool does, with either kind of scale reference. */
  function measure(psiDeg: number, ref: 'athwart' | 'vertical') {
    const rig: Rig = { ...RIG, psiDeg }
    const P = makeCamera(rig)
    const axis = mastAxisFromPoints(P(0, 0, 3_000), P(0, 0, 30_000))!
    let mmPerPx = ref === 'athwart'
      ? mmPerPxFromReference(P(0, -SPREADER_HALF, SPREADER_Z), P(0, SPREADER_HALF, SPREADER_Z), 2 * SPREADER_HALF)!
      : mmPerPxFromReference(P(0, 0, 2_000), P(0, 0, 29_000), 27_000)!
    const baseline = {
      aft: P(TRANSOM.x, 0, TRANSOM.z), fwd: P(TACK.x, 0, TACK.z),
      separationMm: TACK.x - TRANSOM.x,
    }
    let psi = solvePsi(baseline, axis.across, mmPerPx, rig.heelDeg, { clickSigmaPx: 0 })
    if (ref === 'athwart') {
      const fixed = unbiasAthwartshipsScale(mmPerPx, psi.deg)
      mmPerPx = fixed.mmPerPxAtMast
      psi = solvePsi(baseline, axis.across, mmPerPx, rig.heelDeg, { clickSigmaPx: 0 })
    }
    const cal: Calibration = {
      axis, mmPerPxAtMast: mmPerPx, scaleRelSigma: 0.002,
      rangeMm: rangeMmFrom({ widthMm: rig.sensorWidthMm, focalLengthMm: rig.focalMm, imageLongEdgePx: rig.imgW }, mmPerPx),
      psi, heelDeg: rig.heelDeg, heelSigmaDeg: 0.5, clickSigmaPx: 0, tack: 'port',
    }
    const at = (t: { y: number; d: number }) => measureTarget(cal, {
      key: 'x', label: 'x', point: P(t.d, t.y, 8_000), depthMm: t.d, depthSigmaMm: 0,
    })
    return { psi: cal.psi.deg, clew: at(CLEW), boom: at(BOOM) }
  }

  it('recovers psi to better than a tenth of a degree, out to 25°', () => {
    // The bias an athwartships reference puts in is exact and invertible:
    // sin(psi_measured) = tan(psi_true). Left in, 20° reads as 21.4°.
    for (const psiDeg of [5, 10, 15, 20, 25]) {
      expect(Math.abs(measure(psiDeg, 'athwart').psi - psiDeg)).toBeLessThan(0.1)
    }
    // A vertical reference needs no un-biasing and gets none, so what is left is
    // the projection's own residual: under 0.2° to 15°, 0.6° by 25°. Worth
    // recording rather than smoothing over — it is the better reference for the
    // SCALE and the slightly worse one for psi.
    expect(Math.abs(measure(15, 'vertical').psi - 15)).toBeLessThan(0.2)
    expect(Math.abs(measure(25, 'vertical').psi - 25)).toBeLessThan(0.6)
  })

  it('un-biases an athwartships scale — without it 20° costs 6 % on the clew', () => {
    const rig: Rig = { ...RIG, psiDeg: 20 }
    const P = makeCamera(rig)
    const raw = mmPerPxFromReference(
      P(0, -SPREADER_HALF, SPREADER_Z), P(0, SPREADER_HALF, SPREADER_Z), 2 * SPREADER_HALF)!
    const truth = mmPerPxFromReference(P(0, 0, 2_000), P(0, 0, 29_000), 27_000)!
    // Biased HIGH, by about sec(20°) = 1.064 — not exactly, because a real
    // perspective camera is not a scaled-orthographic one, which is the whole
    // reason a residual survives this correction.
    expect(raw / truth).toBeGreaterThan(1.03)
    expect(raw / truth).toBeLessThan(1.08)
    const fixed = unbiasAthwartshipsScale(raw, Math.asin(Math.tan(20 * Math.PI / 180)) / (Math.PI / 180))
    // Most of it removed: ~5 % out becomes ~1.2 %. Not zero — the leftover is
    // the perspective the scaled-orthographic model does not carry.
    expect(Math.abs(fixed.mmPerPxAtMast / truth - 1)).toBeLessThan(0.02)
    expect(Math.abs(fixed.mmPerPxAtMast / truth - 1))
      .toBeLessThan(Math.abs(raw / truth - 1) / 3)
    expect(fixed.psiDeg).toBeCloseTo(20, 0)
  })

  it('holds the NEAR targets to about 1 % all the way out to 20°', () => {
    // The clew is a metre abaft the mast; it barely feels psi.
    for (const ref of ['athwart', 'vertical'] as const) {
      for (const psiDeg of [5, 10, 15, 20]) {
        const err = Math.abs(measure(psiDeg, ref).clew.boatFrameMm / CLEW.y - 1)
        expect(err).toBeLessThan(0.015)
      }
    }
  })

  it('loses a few per cent on the BOOM, and the sigma now admits it', () => {
    // 10 m abaft the mast is where the small-angle projection shows. This is a
    // MODELLING residual — it does not average away — so the test pins the size
    // rather than pretending it is not there.
    const at15 = measure(15, 'vertical').boom
    const err = Math.abs(at15.boatFrameMm / BOOM.y - 1)
    expect(err).toBeGreaterThan(0.01)
    expect(err).toBeLessThan(0.06)
    // The reported uncertainty covers it, which is the least it can do.
    expect(at15.boatFrameSigmaMm).toBeGreaterThan(Math.abs(at15.boatFrameMm - BOOM.y))
    // and it grows with psi, rather than being a fixed fudge
    const at5 = measure(5, 'vertical').boom
    expect(at5.boatFrameSigmaMm).toBeLessThan(at15.boatFrameSigmaMm)
  })

  it('says out loud that the shot is well off the centreplane', () => {
    const rig: Rig = { ...RIG, psiDeg: 15 }
    const cal = buildCalibration(rig)
    const c = runChecks({ ...cal, psi: { deg: 15, sigmaDeg: 0.1, measured: true } })
      .find((x) => x.key === 'psi-large')!
    expect(c).toBeTruthy()
    expect(c.ok).toBe(false)
    expect(c.detail).toMatch(/small-angle/)
    expect(c.detail).toMatch(/VERTICAL scale reference/)
    // and does NOT nag at the angles the model is comfortable at
    expect(runChecks(buildCalibration(RIG)).find((x) => x.key === 'psi-large')).toBeUndefined()
  })
})

describe('sailTrim — checks', () => {
  it('passes everything when the frame is fully calibrated', () => {
    // Fully calibrated now includes a horizon — that is what makes
    // world-horizontal a measurement rather than an assumption.
    const cal = buildCalibration(RIG)
    // A level-ish camera: the horizon sits where the mast's lean minus the
    // heel puts it, which is the roll — here, near zero.
    const checks = runChecks({
      ...cal,
      horizon: {
        tiltDeg: cal.axis.tiltDeg - Math.sign(cal.axis.tiltDeg) * RIG.heelDeg,
        rms: 1.1, samples: 140,
      },
    })
    expect(checks.filter((c) => !c.ok)).toEqual([])
  })

  it('without a horizon, says so rather than quietly assuming a level camera', () => {
    const failed = runChecks(buildCalibration(RIG)).filter((c) => !c.ok).map((c) => c.key)
    expect(failed).toContain('horizon')
  })

  it('flags a missing baseline, a missing range and a missing heel', () => {
    const cal = buildCalibration(RIG, { psiBaseline: false, heelKnown: false })
    const failed = runChecks({ ...cal, rangeMm: null }).filter((c) => !c.ok).map((c) => c.key)
    expect(failed).toContain('psi')
    expect(failed).toContain('range')
    expect(failed).toContain('horizon')
  })

  it('flags a camera that is far off the centreplane', () => {
    const cal = buildCalibration({ ...RIG, psiDeg: 5 })
    expect(runChecks(cal).find((c) => c.key === 'psi-big')!.ok).toBe(false)
  })
})

describe('sailTrim — the horizon', () => {
  const axis = mastAxisFromPoints({ x: 100, y: 900 }, { x: 100, y: 100 })!   // dead upright

  it('is preferred over the logged heel, and says which it used', () => {
    expect(horizontalDir(axis, 23, null).source).toBe('assumed-level')   // upright mast: cannot sign
    const h = { tiltDeg: -4.8, rms: 1.1, samples: 140 }
    const w = horizontalDir(axis, 23, h)
    expect(w.source).toBe('horizon')
    expect(w.rollApplied).toBe(true)
    // the world-horizontal unit vector points up to the right, as the horizon does
    expect(w.dir.x).toBeCloseTo(Math.cos(-4.8 * DEG), 6)
    expect(w.dir.y).toBeCloseTo(Math.sin(-4.8 * DEG), 6)
  })

  it('reads the heel straight off the picture', () => {
    // The 11:53:00 compilation panel, measured: mast 0.64° left of the frame's
    // vertical, horizon at −23.20°. Logged heel that second: 22.7°.
    const leaning = mastAxisFromPoints({ x: 100, y: 900 }, { x: 91, y: 100 })!
    expect(leaning.tiltDeg).toBeCloseTo(-0.64, 1)
    const heel = imageHeelDeg(leaning, { tiltDeg: -23.20, rms: 1.1, samples: 71 })!
    expect(heel).toBeCloseTo(22.56, 1)
    expect(Math.abs(heel - 22.7)).toBeLessThan(0.2)
  })

  it('has nothing to say without a horizon', () => {
    expect(imageHeelDeg(axis, null)).toBeNull()
    expect(imageHeelDeg(axis, undefined)).toBeNull()
  })

  it('measures the same thing whether the roll comes from the horizon or the heel', () => {
    const rig = { ...RIG, rollDeg: 3 }
    const P = makeCamera(rig)
    const t = {
      key: 'clew', label: 'Jib clew', point: P(8_000, 1_900, SPREADER_Z),
      depthMm: 8_000, depthSigmaMm: 300,
    }
    const cal = buildCalibration(rig)
    const viaHeel = measureTarget(cal, t)
    // The horizon a detector would have found on that frame: heel and roll
    // together put the mast at (heel + roll) in the image, so the horizon sits
    // at the roll.
    const viaHorizon = measureTarget(
      { ...cal, horizon: { tiltDeg: cal.axis.tiltDeg - Math.sign(cal.axis.tiltDeg) * rig.heelDeg, rms: 1, samples: 150 } },
      t,
    )
    expect(viaHorizon.worldHorizontalMm).toBeCloseTo(viaHeel.worldHorizontalMm, 3)
    expect(viaHorizon.rollApplied).toBe(true)
  })

  it('catches a rotated compilation panel', () => {
    // The signature: mast upright in the frame, boat well heeled in the log.
    const cal = { ...buildCalibration(RIG), axis, heelDeg: 22.7 }
    const rotated = runChecks(cal).find((c) => c.key === 'rotated')
    expect(rotated).toBeTruthy()
    expect(rotated!.ok).toBe(false)
    expect(rotated!.detail).toMatch(/compilation/)
  })

  it('reports when the photo and the log disagree about the heel', () => {
    const cal = buildCalibration(RIG)
    const agree = runChecks({ ...cal, horizon: { tiltDeg: cal.axis.tiltDeg - RIG.heelDeg, rms: 1, samples: 150 } })
    expect(agree.find((c) => c.key === 'heel-agree')!.ok).toBe(true)
    const disagree = runChecks({ ...cal, horizon: { tiltDeg: cal.axis.tiltDeg - RIG.heelDeg - 9, rms: 1, samples: 150 } })
    const row = disagree.find((c) => c.key === 'heel-agree')!
    expect(row.ok).toBe(false)
    expect(row.detail).toMatch(/rotated|wrong log row|sail edge/)
  })

  it('offers a rough alignment read, and refuses to pretend it is precise', () => {
    // heel foreshortening: apparent lean = atan(tan(heel)·cos ψ)
    const trueHeel = 22.7
    for (const psi of [0, 8, 16]) {
      const apparent = Math.atan(Math.tan(trueHeel * DEG) * Math.cos(psi * DEG)) / DEG
      expect(psiFromHeelShortening(apparent, trueHeel)!).toBeCloseTo(psi, 0)
    }
    expect(psiFromHeelShortening(5, 0)).toBeNull()       // upright: nothing to foreshorten
  })
})

describe('sailTrim — effective heel', () => {
  it('prefers the photo, falls back to the log, then to nothing', () => {
    const cal = buildCalibration(RIG)
    expect(effectiveHeelDeg({ ...cal, horizon: { tiltDeg: cal.axis.tiltDeg - 19, rms: 1, samples: 100 } }))
      .toBeCloseTo(19, 6)
    expect(effectiveHeelDeg({ ...cal, horizon: null })).toBe(RIG.heelDeg)
    expect(effectiveHeelDeg({ ...cal, horizon: null, heelDeg: null })).toBeNull()
  })
})

describe('a competitor’s heel cannot come from our log', () => {
  // Every instrument reading SSA holds is from our own boat. The logged heel at
  // 12:25 is Northstar's, not Capricorno's, and handing it to a measurement of
  // Capricorno's rig is not an approximation — it is a different boat's number,
  // wrong by however much the two differ. Which upwind in a breeze is plenty,
  // and is exactly when the measurement is worth taking.
  const axis = { low: { x: 1000, y: 5000 }, high: { x: 900, y: 500 }, up: { x: 0, y: 0 }, across: { x: 0, y: 0 }, tiltDeg: -1.3 }
  const cal = (over: Record<string, unknown>) => ({
    axis, mmPerPxAtMast: 6, scaleRelSigma: 0.01, rangeMm: 260_000,
    psi: { deg: 0, sigmaDeg: 1, measured: false }, heelDeg: -5.1, horizon: null,
    ...over,
  } as never)

  it('uses the horizon for a rival when there is one', () => {
    const withHorizon = cal({ isCompetitor: true, horizon: { tiltDeg: -20, rmsPx: 1, columns: 120 } })
    // mast tilt minus horizon tilt: the rival's own lean, off the photograph.
    expect(effectiveHeelDeg(withHorizon)).toBeCloseTo(-1.3 - -20, 6)
  })

  it('returns NULL for a rival with no horizon, rather than our logged heel', () => {
    // Null is the honest answer. A plausible wrong number is the dangerous one.
    expect(effectiveHeelDeg(cal({ isCompetitor: true }))).toBeNull()
  })

  it('still falls back to the log on OUR own boat', () => {
    expect(effectiveHeelDeg(cal({ isCompetitor: false }))).toBe(-5.1)
    expect(effectiveHeelDeg(cal({}))).toBe(-5.1)
  })

  it('prefers the horizon even on our own boat', () => {
    // The photograph beats the log either way: heel moves in waves between the
    // logged sample and the shutter.
    const ours = cal({ horizon: { tiltDeg: -20, rmsPx: 1, columns: 120 } })
    expect(effectiveHeelDeg(ours)).toBeCloseTo(18.7, 6)
  })
})

describe('focalSensitivity — what a wrong focal length costs', () => {
  it('is ZERO for a reference in the mast plane, whatever the range', () => {
    // P runs up the rig at depth 0, so the depth correction is 1 and the focal
    // length cannot reach the answer at all. This turns "I cannot remember the
    // zoom setting" into a reason to scale off P instead of a dead end.
    expect(focalSensitivity(0, 120_000)).toBe(0)
    expect(focalSensitivity(0, null)).toBe(0)
  })

  it('prices the wheels at a realistic range', () => {
    // d = -7392, R = 120 m: a focal length 20 % out moves every millimetre by
    // about 1.2 %.
    const s = focalSensitivity(-7392, 120_000)!
    expect(s * 0.2).toBeCloseTo(0.0116, 3)
  })

  it('costs more the closer the camera is', () => {
    // The correction itself is larger up close, so an error in it is too.
    expect(focalSensitivity(-7392, 60_000)!).toBeGreaterThan(focalSensitivity(-7392, 120_000)!)
  })

  it('says nothing rather than guessing when there is no range', () => {
    // No focal length means no range, which is exactly when this is asked.
    expect(focalSensitivity(-7392, null)).toBeNull()
    expect(focalSensitivity(-7392, 0)).toBeNull()
  })
})

describe('focalForSensor — the focal length and the sensor width are a PAIR', () => {
  const FULL = 36

  it('takes the 35 mm equivalent against a full-frame sensor width', () => {
    // range ∝ focal ÷ sensorWidth, and the equivalent is DEFINED against 36 mm.
    const out = focalForSensor({ focalMm: 5.1, focal35Mm: 93, sensorWidthMm: FULL })
    expect(out.mm).toBe(93)
    expect(out.from).toBe('35mm-equivalent')
  })

  it('is a no-op on a full-frame camera, where the two agree', () => {
    // Why this went unnoticed: the Canon R6m2 is full frame and reports 254 for
    // both, so every frame shot so far was right by luck of the equipment.
    expect(focalForSensor({ focalMm: 254, focal35Mm: 254, sensorWidthMm: FULL }).mm).toBe(254)
  })

  it('would have been 18x out on the iPhone frame', () => {
    // 5.1 ÷ 36 against the true 93 ÷ 36. Range is proportional to that ratio, so
    // the depth correction goes from 1.19 to about 4.4 and every millimetre with
    // it. This is the number the test exists for.
    const wrong = 5.1 / FULL, right = 93 / FULL
    expect(right / wrong).toBeCloseTo(18.2, 1)
    expect(focalForSensor({ focalMm: 5.1, focal35Mm: 93, sensorWidthMm: FULL }).mm).toBe(93)
  })

  it('uses the ACTUAL focal when the sensor width is the real one', () => {
    // Someone who has entered their phone's true sensor width wants the actual
    // focal length beside it — the other consistent pair.
    const out = focalForSensor({ focalMm: 5.1, focal35Mm: 93, sensorWidthMm: 7.0 })
    expect(out.mm).toBe(5.1)
    expect(out.from).toBe('actual')
  })

  it('flags a focal length that cannot belong to a full-frame lens', () => {
    // No equivalent in the EXIF and 5.1 mm against 36: physically absurd for a
    // boat at a hundred metres, and silently makes the range far too short.
    const out = focalForSensor({ focalMm: 5.1, focal35Mm: null, sensorWidthMm: FULL })
    expect(out.suspect).toBe(true)
  })

  it('does not flag a plausible full-frame lens', () => {
    expect(focalForSensor({ focalMm: 254, focal35Mm: null, sensorWidthMm: FULL }).suspect).toBe(false)
    expect(focalForSensor({ focalMm: 24, focal35Mm: null, sensorWidthMm: FULL }).suspect).toBe(false)
  })

  it('says it has nothing rather than guessing', () => {
    const out = focalForSensor({ focalMm: null, focal35Mm: null, sensorWidthMm: FULL })
    expect(out.mm).toBeNull()
    expect(out.from).toBe('none')
  })
})

describe('sailTrim — the baseline\'s two ends are at different scales', () => {
  // THE BUG. psi is read off the image displacement between two centreplane
  // landmarks, and that displacement used to be converted with ONE scale — the
  // mast's. The landmarks are at different depths, so they are at different
  // scales, and using the mast's for both inflates the displacement and psi
  // with it. The inflation is the product of the two ends' depth-scale factors,
  // so it is 1 at infinity and grows as the camera closes.
  //
  // Every existing psi test here shoots from 260 m, where it is 1.3 % and
  // invisible. The frames that exposed it were taken at 25-34 m, where it is
  // 45 % and 30 %.

  it('is the true separation at infinity, and when both ends are at the mast', () => {
    const base = { separationMm: 21_000, depthFwdMm: 9_000, depthAftMm: -12_000 }
    expect(effectiveSeparationMm(base, null)).toBe(21_000)
    expect(effectiveSeparationMm({ separationMm: 1_000, depthFwdMm: 0, depthAftMm: 0 }, 30_000))
      .toBeCloseTo(1_000, 6)
    // 300 m is nearly infinity for a 21 m baseline: just over 1 %.
    expect(effectiveSeparationMm(base, 300_000) / 21_000).toBeCloseTo(1.0113, 3)
  })

  it('divides by the PRODUCT of the two ends\' depth factors', () => {
    // mast -> transom on Baraka: 7.8 m, at the two ranges her frames were shot
    // from. R^2/((R+0)(R-7800)) = 1.453 at 25 m and 1.310 at 33 m.
    //
    // The effective separation is BIGGER than the true one, and that is the
    // whole correction: psi = asin(du / sep), so dividing by a larger number
    // returns a smaller angle. 7.8 m of transom behaves like 11.3 m of baseline
    // at 25 m, because the transom images larger than the mast does.
    const base = { separationMm: 7_800, depthFwdMm: 0, depthAftMm: -7_800 }
    expect(effectiveSeparationMm(base, 25_000)).toBeCloseTo(11_337, 0)
    expect(effectiveSeparationMm(base, 25_000) / 7_800).toBeCloseTo(1.4535, 3)
    expect(effectiveSeparationMm(base, 33_000) / 7_800).toBeCloseTo(1.3095, 3)
  })

  it('falls back to the true separation when the depths are not supplied', () => {
    // Behaviour-preserving for any caller not yet taught to pass them: wrong,
    // but no more wrong than before, and never a crash or a NaN.
    expect(effectiveSeparationMm({ separationMm: 7_800 }, 25_000)).toBe(7_800)
    expect(effectiveSeparationMm({ separationMm: 7_800, depthFwdMm: 0 }, 25_000)).toBe(7_800)
  })

  /** psi as solvePsi reads it off a synthetic frame, with and without the fix. */
  function psiAt(rangeMm: number, psiDeg: number) {
    const rig: Rig = { ...RIG, psiDeg, rangeMm, focalMm: 100 }
    const P = makeCamera(rig)
    const axis = mastAxisFromPoints(P(0, 0, 3_000), P(0, 0, 30_000))!
    // A VERTICAL reference, so the athwartships sec-psi bias is not also in play.
    const mmPerPx = mmPerPxFromReference(P(0, 0, 2_000), P(0, 0, 29_000), 27_000)!
    const ends = { aft: P(TRANSOM.x, 0, TRANSOM.z), fwd: P(TACK.x, 0, TACK.z) }
    const sep = TACK.x - TRANSOM.x
    return {
      before: solvePsi({ ...ends, separationMm: sep }, axis.across, mmPerPx, rig.heelDeg,
        { clickSigmaPx: 0 }).deg,
      after: solvePsi(
        { ...ends, separationMm: sep, depthFwdMm: TACK.x, depthAftMm: TRANSOM.x },
        axis.across, mmPerPx, rig.heelDeg, { clickSigmaPx: 0, rangeMm },
      ).deg,
    }
  }

  it('recovers psi at 60 m, where the old solve is half a degree out', () => {
    const { before, after } = psiAt(60_000, 5)
    // A degree of psi is ~180 mm on a boom at E, so half a degree is not noise.
    expect(Math.abs(before - 5)).toBeGreaterThan(0.3)
    // 0.15 deg, not 0.05: the scaled-orthographic model has its own residual
    // against a full perspective camera, and at 60 m it is about 0.08 deg. That
    // is the floor this correction can reach, and it is 6x smaller than the
    // error it removes.
    expect(Math.abs(after - 5)).toBeLessThan(0.15)
  })

  it('still recovers psi at 260 m, where the old solve was already fine', () => {
    // The guard that this is a correction and not a rewrite: where the bug was
    // invisible, the fix must be invisible too.
    const { before, after } = psiAt(260_000, 5)
    expect(Math.abs(before - 5)).toBeLessThan(0.15)
    expect(Math.abs(after - 5)).toBeLessThan(0.15)
  })

  it('gets WORSE with range, which is why two frames of one trim disagreed', () => {
    // The whole reason this mattered: the error is range-dependent, so a frame
    // at 25 m and a frame at 33 m are biased by different amounts — and a port
    // tack shot from one distance then disagrees with a starboard tack shot from
    // another, with the trim identical on both.
    const near = Math.abs(psiAt(40_000, 4).before - 4)
    const far = Math.abs(psiAt(150_000, 4).before - 4)
    expect(near).toBeGreaterThan(far * 2)
    // Corrected, both come back to the truth, so they no longer disagree.
    expect(Math.abs(psiAt(40_000, 4).after - 4)).toBeLessThan(0.15)
    expect(Math.abs(psiAt(150_000, 4).after - 4)).toBeLessThan(0.15)
  })
})

describe("sailTrim — a scale reference whose DEPTH nobody has measured", () => {
  // runChecks only needs the calibration fields the scale-depth check reads.
  const cal = (over: Partial<Calibration>): Calibration => ({
    axis: mastAxisFromPoints({ x: 100, y: 900 }, { x: 100, y: 100 })!,
    mmPerPxAtMast: 10, scaleRelSigma: 0.002, rangeMm: 40_000,
    psi: { deg: 0, sigmaDeg: 1, measured: false },
    heelDeg: 12, heelSigmaDeg: 0.5, clickSigmaPx: 1.5, tack: 'port',
    ...over,
  })
  const scaleDepth = (c: Calibration) => runChecks(c, []).find((x) => x.key === 'scale-depth')

  it('WARNS even when the depth is being treated as zero', () => {
    // The bug. The check keyed off the depth being non-zero, so a reference
    // carrying 0 because nobody measured it looked identical to one carrying 0
    // because it genuinely sits in the mast plane — and the guess was the one
    // that said nothing at all.
    const c = scaleDepth(cal({ scaleRefDepthMm: 0, scaleRefDepthEstimated: true }))
    expect(c).toBeDefined()
    expect(c!.ok).toBe(false)
    expect(c!.detail).toMatch(/never been measured/i)
  })

  it('says nothing for a reference that really is in the mast plane', () => {
    // P runs up the rig at depth 0, measured. No warning, no noise.
    expect(scaleDepth(cal({ scaleRefDepthMm: 0, scaleRefDepthEstimated: false }))).toBeUndefined()
  })

  it('is content with a MEASURED depth that has a focal length behind it', () => {
    const c = scaleDepth(cal({ scaleRefDepthMm: -7900, scaleDepthUncorrected: false }))
    expect(c!.ok).toBe(true)
    expect(c!.detail).toMatch(/referred back to the mast plane/i)
  })

  it('still reports a known depth that could NOT be corrected', () => {
    // Different failure, different fix: here the depth is known and the focal
    // length is missing, so the message asks for the focal length.
    const c = scaleDepth(cal({ scaleRefDepthMm: -7900, scaleDepthUncorrected: true }))
    expect(c!.ok).toBe(false)
    expect(c!.detail).toMatch(/no focal length/i)
  })

  it('leads with the UNMEASURED depth when both are wrong at once', () => {
    // Entering a focal length would not help: there is no depth to correct.
    const c = scaleDepth(cal({ scaleRefDepthMm: 0, scaleRefDepthEstimated: true, scaleDepthUncorrected: true }))
    expect(c!.ok).toBe(false)
    expect(c!.detail).toMatch(/never been measured/i)
  })
})

describe('sailTrim — the frame has to be big enough to hold the boat', () => {
  const cal = (over: Partial<Calibration>): Calibration => ({
    axis: mastAxisFromPoints({ x: 100, y: 900 }, { x: 100, y: 100 })!,
    mmPerPxAtMast: 7.8, scaleRelSigma: 0.002, rangeMm: 130_000,
    psi: { deg: 0, sigmaDeg: 1, measured: false },
    heelDeg: 11, heelSigmaDeg: 0.5, clickSigmaPx: 1.5, tack: 'port',
    boatLengthMm: 21_510, imageLongEdgePx: 6000,
    ...over,
  })
  const fit = (c: Calibration) => runChecks(c, []).find((x) => x.key === 'frame-extent')

  it('catches the scale marked on the WRONG FEATURE', () => {
    // Northstar's 27 Sep frames: the two marks went on P (31440 mm) with the
    // picker still saying wheels (3375), so every millimetre came out 9x small
    // and the view 7.8 m across — on a boat 23.2 m long that is plainly in it.
    // Nothing else sees this; the frame stays entirely self-consistent.
    const c = fit(cal({ mmPerPxAtMast: 1.3 }))!
    expect(c.ok).toBe(false)
    expect(c.detail).toMatch(/7\.8 m across/)
    expect(c.detail).toMatch(/too small to contain it/)
    expect(c.detail).toMatch(/REFERENCE in the picker/)
  })

  it('catches ALL THREE, where a range test missed two of them', () => {
    // Those frames came back at 21, 22 and 22 m of range against a longest
    // baseline of 21.5 — so "is the camera inside the boat" caught one.
    for (const mm of [1.3, 1.3, 1.2]) expect(fit(cal({ mmPerPxAtMast: mm }))!.ok).toBe(false)
  })

  it('is content with a correctly scaled frame', () => {
    const c = fit(cal({ mmPerPxAtMast: 7.8 }))!
    expect(c.ok).toBe(true)
    expect(c.detail).toMatch(/47 m across/)
  })

  it('does not depend on the lens, which was a zoom', () => {
    // range/mmPerPx is focal/pitch and moves every frame on a zoom, so it could
    // not have been the check. This one never looks at the range at all.
    expect(fit(cal({ mmPerPxAtMast: 7.2, rangeMm: 137_000 }))!.ok).toBe(true)
    expect(fit(cal({ mmPerPxAtMast: 8.0, rangeMm: 134_000 }))!.ok).toBe(true)
  })

  it('says nothing without an image size or a boat length', () => {
    expect(fit(cal({ imageLongEdgePx: undefined }))).toBeUndefined()
    expect(fit(cal({ boatLengthMm: undefined }))).toBeUndefined()
  })
})

describe('sailTrim — ψ that is not a photograph from astern', () => {
  const cal = (over: Partial<Calibration>): Calibration => ({
    axis: mastAxisFromPoints({ x: 100, y: 900 }, { x: 100, y: 100 })!,
    mmPerPxAtMast: 7.8, scaleRelSigma: 0.002, rangeMm: 130_000,
    psi: { deg: 2, sigmaDeg: 0.1, measured: true },
    heelDeg: 11, heelSigmaDeg: 0.5, clickSigmaPx: 1.5, tack: 'port',
    boatLengthMm: 21_510, imageLongEdgePx: 6000,
    ...over,
  })
  const psiBad = (c: Calibration) => runChecks(c, []).find((x) => x.key === 'psi-impossible')
  const fit = (c: Calibration) => runChecks(c, []).find((x) => x.key === 'frame-extent')

  it('refuses a ψ that only exists because the asin saturated', () => {
    // Northstar, 4 Sept: P (31440 mm) declared over marks on the WHEELS (3375),
    // nine times shorter. mm/px came out 32.6 against a true 3.9, and solvePsi
    // — which clamps at ±90 — handed back 77.2° and 57.7°.
    const c = psiBad(cal({ psi: { deg: 77.2, sigmaDeg: 1, measured: true } }))!
    expect(c.ok).toBe(false)
    expect(c.detail).toMatch(/not a photograph taken from astern/)
    expect(c.detail).toMatch(/REFERENCE in the picker/)
  })

  it('says nothing at the angles these shots are actually taken from', () => {
    for (const deg of [0, 2, -6.4, 15, 25]) {
      expect(psiBad(cal({ psi: { deg, sigmaDeg: 0.1, measured: true } })), `${deg}°`).toBeUndefined()
    }
  })

  it('does not fire on an ASSUMED ψ, which is 0 and means nothing', () => {
    expect(psiBad(cal({ psi: { deg: 77, sigmaDeg: 1, measured: false } }))).toBeUndefined()
  })

  it('catches a frame extent that is far too LARGE as well as too small', () => {
    // The same mistake has now been made in both directions in one week: the
    // reference shorter than what was clicked (7.8 m across on 27 Sep) and
    // longer (196 m across on 4 Sept), on a boat of 23 m.
    const big = fit(cal({ mmPerPxAtMast: 32.6 }))!
    expect(big.ok).toBe(false)
    expect(big.detail).toMatch(/far wider than any frame/)
    const small = fit(cal({ mmPerPxAtMast: 1.3 }))!
    expect(small.ok).toBe(false)
    expect(small.detail).toMatch(/too small to contain it/)
  })

  it('still passes the frames that are right', () => {
    // 27 Sep on P: 46 m across. 4 Sept on the wheels: 23 m across.
    expect(fit(cal({ mmPerPxAtMast: 7.7 }))!.ok).toBe(true)
    expect(fit(cal({ mmPerPxAtMast: 3.9 }))!.ok).toBe(true)
  })
})
