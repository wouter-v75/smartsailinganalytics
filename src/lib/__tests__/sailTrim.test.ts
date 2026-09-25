import { describe, it, expect } from 'vitest'
import {
  mastAxisFromEdges, mastAxisFromPoints, cameraRollDeg, horizontalDir,
  mmPerPxFromReference, rangeMmFrom, mmPerPxAtDepth, solvePsi,
  measureTarget, intersectPolyline, leechTargets, runChecks,
  imageHeelDeg, effectiveHeelDeg, psiFromHeelShortening,
  type Px, type Calibration,
  tackFromTwa, leewardSign,
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
