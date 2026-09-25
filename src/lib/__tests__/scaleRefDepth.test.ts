// src/lib/__tests__/scaleRefDepth.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Referring a scale measured off the mast plane back TO the mast plane.
//
// Every reference the tool had until now sat at the mast — spreaders, mast
// width, P up the mast itself — so "mm per pixel at the reference" and "at the
// mast" were the same number and `ScaleRef.depthMm` was carried but never read.
// The steering wheels break that: they are about ten metres abaft the mast,
// nearer an astern camera, and so image larger. Taken as the mast's scale they
// read every measurement on the frame LOW by depth/range.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { mmPerPxAtMastFromRef, rangeMmFrom, type SensorSpec } from '../sailTrim'
import { defaultRigModel, rigModelFor, withMeasured } from '../rigModel'

/** The 5 Sept rig: a 100 mm lens, full frame, 6000 px wide, ~260 m off. */
const SENSOR: SensorSpec = { widthMm: 36, focalLengthMm: 254, imageLongEdgePx: 6000 }
const NO_FOCAL: SensorSpec = { ...SENSOR, focalLengthMm: 0 }

describe('mmPerPxAtMastFromRef', () => {
  it('leaves a reference in the mast plane exactly alone', () => {
    const r = mmPerPxAtMastFromRef(6.2, 0, SENSOR)
    expect(r.mmPerPxAtMast).toBe(6.2)
    expect(r.corrected).toBe(true)
    expect(r.rangeMm).toBeCloseTo(rangeMmFrom(SENSOR, 6.2)!, 6)
  })

  it('scales UP for a reference abaft the mast — it is nearer, so it images larger', () => {
    const atWheels = 6.2
    const rangeToWheels = rangeMmFrom(SENSOR, atWheels)!
    const r = mmPerPxAtMastFromRef(atWheels, -10_000, SENSOR)
    expect(r.corrected).toBe(true)
    // Depth is FORWARD-positive, so wheels at −10 m are 10 m NEARER the astern
    // camera than the mast: the mast's range is the wheels' plus ten metres, and
    // being farther it gives more mm per pixel.
    expect(r.mmPerPxAtMast).toBeGreaterThan(atWheels)
    expect(r.rangeMm).toBeCloseTo(rangeToWheels + 10_000, 6)
    // Exactly the ratio of the two ranges.
    expect(r.mmPerPxAtMast).toBeCloseTo(atWheels * (rangeToWheels + 10_000) / rangeToWheels, 9)
  })

  it('scales DOWN for a reference forward of the mast', () => {
    const r = mmPerPxAtMastFromRef(6.2, +8_000, SENSOR)
    expect(r.mmPerPxAtMast).toBeLessThan(6.2)
    expect(r.corrected).toBe(true)
  })

  it('is worth about 4 % at the range these frames are shot from', () => {
    // The whole reason this function exists. 6.2 mm/px at 254 mm on full frame
    // is ~260 m; wheels 10 m abaft the mast are 10/260 nearer.
    const atWheels = 6.2
    const range = rangeMmFrom(SENSOR, atWheels)!
    expect(range / 1000).toBeGreaterThan(200)
    expect(range / 1000).toBeLessThan(320)
    const r = mmPerPxAtMastFromRef(atWheels, -10_000, SENSOR)
    const biasPct = 100 * (r.mmPerPxAtMast - atWheels) / atWheels
    expect(biasPct).toBeGreaterThan(3)
    expect(biasPct).toBeLessThan(6)
    // On a 1500 mm measurement that is tens of millimetres — several times the
    // ±14 mm the rest of the tool achieves.
    expect(1500 * biasPct / 100).toBeGreaterThan(45)
  })

  it('says so, rather than guessing, when there is no focal length to get a range from', () => {
    const r = mmPerPxAtMastFromRef(6.2, -10_000, NO_FOCAL)
    expect(r.corrected).toBe(false)
    expect(r.rangeMm).toBeNull()
    // Hands back the uncorrected scale — a wrong number the caller KNOWS is
    // wrong beats a made-up correction it does not.
    expect(r.mmPerPxAtMast).toBe(6.2)
  })

  it('needs no focal length when the reference is at the mast anyway', () => {
    const r = mmPerPxAtMastFromRef(6.2, 0, NO_FOCAL)
    expect(r.corrected).toBe(true)
    expect(r.mmPerPxAtMast).toBe(6.2)
  })

  it('refuses a correction that would put the mast behind the camera', () => {
    // A depth larger than the range is nonsense — a mistyped sign or metres for
    // millimetres. Better uncorrected and flagged than negative.
    const r = mmPerPxAtMastFromRef(6.2, 500_000, SENSOR)
    expect(r.corrected).toBe(false)
    expect(r.mmPerPxAtMast).toBe(6.2)
  })
})

describe('the rig model’s new references', () => {
  it('offers the steering wheels as a scale reference, abaft the mast', () => {
    const m = defaultRigModel('Some Maxi')
    const w = m.scaleRefs.find((r) => r.key === 'wheels')!
    expect(w).toBeTruthy()
    expect(w.label).toMatch(/wheels/i)
    expect(w.depthMm).toBeLessThan(0)          // abaft
    expect(w.mm).toBe(0)                        // unknown until measured
    expect(w.source).toBe('estimate')
  })

  it('offers mast → transom centre as a centreplane baseline', () => {
    const m = defaultRigModel('Some Maxi')
    const b = m.baselines.find((x) => x.key === 'mast-transom')!
    expect(b).toBeTruthy()
    expect(b.label).toMatch(/transom/i)
  })

  it('knows Northstar 76’s wheels are 3375 mm, measured', () => {
    const m = rigModelFor('Northstar 76')
    const w = m.scaleRefs.find((r) => r.key === 'wheels')!
    expect(w.mm).toBe(3375)
    expect(w.source).toBe('measured')
    expect(w.sigmaMm).toBeLessThanOrEqual(20)
    // 0.3 % — better than any other reference in the default model.
    expect(w.sigmaMm / w.mm).toBeLessThan(0.005)
  })

  it('is case- and space-insensitive about the boat name', () => {
    for (const name of ['northstar 76', 'NORTHSTAR 76', '  Northstar 76  ']) {
      expect(withMeasured(defaultRigModel(name)).scaleRefs.find((r) => r.key === 'wheels')!.mm).toBe(3375)
    }
  })

  it('carries Northstar 76’s sail widths out of the box, with no certificate pasted', () => {
    // Twist divides a leech offset by the sail's width. Those widths lived
    // behind "paste an IRC certificate", so a browser that had never done it
    // showed no twist at all and did not say why. They are measured, endorsed
    // and not going to change, so they ship.
    const m = rigModelFor('Northstar 76')
    expect(m.widths?.main).toEqual({ foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: 3.63 })
    expect(m.widths?.jib).toEqual({ foot: 8.96, half: 4.90, threeQuarter: 2.66, upper: 1.48 })
    // and under the name the certificate uses too
    expect(rigModelFor('NORTHSTAR III').widths?.jib?.half).toBe(4.90)
  })

  it('gives a boat we have no certificate for no widths, rather than Northstar’s', () => {
    expect(rigModelFor('Jethou').widths?.main).toBeUndefined()
  })

  it('leaves a boat nobody has measured on the honest guesses', () => {
    const m = rigModelFor('Jethou')
    expect(m.scaleRefs.find((r) => r.key === 'wheels')!.mm).toBe(0)
    expect(m.scaleRefs.every((r) => r.key === 'custom' || r.source === 'estimate')).toBe(true)
  })

  it('does not disturb the references that were already there', () => {
    const m = rigModelFor('Northstar 76')
    expect(m.scaleRefs.find((r) => r.key === 'spreader2')!.mm).toBe(6000)
    expect(m.scaleRefs.find((r) => r.key === 'spreader2')!.depthMm).toBe(0)
  })
})
