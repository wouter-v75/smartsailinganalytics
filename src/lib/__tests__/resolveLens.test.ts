// src/lib/__tests__/resolveLens.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where a frame's focal length comes from when the file does not have one.
//
// This is the silent-failure path, which is why it is tested at all. A focal
// length turns a scale into a RANGE; without a range SailTrim applies NO depth
// correction and NO effective-separation correction to psi, and says so nowhere
// a number is read. The frame still produces millimetres. Five of Northstar
// 76's six measured frames on 5 Sept 2026 were measured like that, and their
// boom agreed to 73 mm across all six — which reads as precision and is
// agreement between two different sets of maths.
//
// The cause is mundane: SailTrim is handed the CLOUD copy, which is a re-export
// with the EXIF stripped. The camera original has it, so it is recorded on the
// photo row at import and this is the fallback that reaches it.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { resolveLens } from '../sailTrim'

/** 5 Sept 2026, the frames this was built for. Full frame, so FocalLength IS
 *  the 35 mm equivalent and the camera writes no separate one. */
const R6M2 = { camera: 'Canon EOS R6m2', lensModel: 'RF100-500mm F4.5-7.1 L IS USM', focalMm: 100, focal35Mm: null }
const STRIPPED = { camera: null, lensModel: null, focalMm: null, focal35Mm: null }

describe('resolveLens', () => {
  it('uses the recorded lens when the file has been stripped', () => {
    const r = resolveLens(STRIPPED, R6M2, 36)
    expect(r.mm).toBe(100)
    expect(r.source).toBe('recorded')
    expect(r.camera).toBe('Canon EOS R6m2')
  })

  it('prefers the FILE when it has a focal length of its own', () => {
    // The recorded copy was matched to the row by capture TIME, and a 17 fps
    // burst can hold a zoom — six originals stamped 12:46:37 span 114-118 mm.
    // The file in front of you is not a guess about which frame it is.
    const r = resolveLens({ ...R6M2, focalMm: 118 }, { ...R6M2, focalMm: 114 }, 36)
    expect(r.mm).toBe(118)
    expect(r.source).toBe('file')
  })

  it('reports no source at all rather than inventing one', () => {
    const r = resolveLens(STRIPPED, null, 36)
    expect(r.mm).toBeNull()
    expect(r.source).toBe('none')
    expect(r.from).toBe('none')
  })

  it('falls back for the NAMES independently of the focal length', () => {
    // A re-export can keep the camera model and lose the rest. The name is
    // still worth showing, and it must not drag a focal length along with it.
    const r = resolveLens({ camera: 'Canon EOS R6m2', focalMm: null, focal35Mm: null }, R6M2, 36)
    expect(r.source).toBe('recorded')
    expect(r.mm).toBe(100)
    expect(r.lensModel).toBe('RF100-500mm F4.5-7.1 L IS USM')
  })

  it('still pairs the focal length with the right sensor width', () => {
    // resolveLens only chooses the SOURCE; which EXIF field goes with which
    // sensor width is focalForSensor's job and must survive the delegation.
    // A phone's 5.6 mm actual against a 36 mm sensor is the trap it guards.
    const phone = { camera: 'Fairphone 6', lensModel: null, focalMm: 5.6, focal35Mm: null }
    const r = resolveLens(STRIPPED, phone, 36)
    expect(r.source).toBe('recorded')
    expect(r.suspect).toBe(true)
  })

  it('takes a zero or negative focal length as absent, not as a value', () => {
    // `Number('')` is 0, and a 0 that reaches rangeMmFrom makes no range at all
    // while looking like an answer.
    expect(resolveLens({ focalMm: 0, focal35Mm: 0 }, R6M2, 36).mm).toBe(100)
    expect(resolveLens({ focalMm: -5, focal35Mm: null }, R6M2, 36).source).toBe('recorded')
  })
})
