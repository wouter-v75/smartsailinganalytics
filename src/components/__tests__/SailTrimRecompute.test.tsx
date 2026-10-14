// src/components/__tests__/SailTrimRecompute.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Which frames the redo panel OFFERS to redo. That is the whole of its own
// judgement — the numbers come from SailTrimTab, which it drives.
//
// The case that matters most is the one it must leave alone: on 26 Sep a single
// afternoon holds three Northstar frames and three of Capricorno, and redoing a
// Capricorno frame as Northstar is exactly how a boat once got scaled by another
// boat's P.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { SAILTRIM_VERSION } from '../../lib/sailTrim'
import { staleFrames, parseStored, boatOf } from '../photos/SailTrimRecompute'
import { migrateRigModel, type RigModel } from '../../lib/rigModel'

/**
 * The two references these frames were actually measured against.
 *
 * NOT a spreader. The code's default model carries spreader tip-to-tip lengths,
 * but those distances were never correct on this boat — they are `estimate` with
 * a 10 % sigma precisely so `bestScaleKey` filters them out, and a fixture built
 * on one would be asserting against a number nobody believes. P runs UP the rig
 * at depth 0, which is what makes it immune to a wheel-depth change; the wheels
 * are the athwartships reference whose depth the designer corrected.
 */
const refs = (wheelsDepthMm: number) => ([
  { key: 'wheels', label: 'Wheels', mm: 3375, sigmaMm: 10, depthMm: wheelsDepthMm, source: 'measured', depthSource: 'designer', orientation: 'athwartships' },
  { key: 'P', label: 'P, black bands', mm: 31_440, sigmaMm: 20, depthMm: 0, source: 'measured', orientation: 'vertical' },
] as RigModel['scaleRefs'])

/** Stated rather than inherited, so a frame storing 12 650 is NOT stale for
 *  either boat and the two-boat case turns on the wheels alone. */
const baselines = () => ([
  { key: 'mast-transom', label: 'Mast to transom', mm: 12_650, sigmaMm: 150, source: 'designer' },
  { key: 'tack-mast', label: 'Tack to mast', mm: 8_860, sigmaMm: 200, source: 'measured' },
  { key: 'bow-transom', label: 'Tack to transom', mm: 0, sigmaMm: 0, source: 'estimate' },
] as RigModel['baselines'])

const rig = (boat: string, wheelsDepthMm: number): RigModel =>
  migrateRigModel({ scaleRefs: refs(wheelsDepthMm), baselines: baselines() } as RigModel, boat)

/** A boat whose wheel depth has since been corrected to the designer's -7392. */
const northstar = rig('Northstar 76', -7392)
/** …and one that has not moved, so nothing of hers should be offered. */
const capricorno = rig('Capricorno', -7392)

/** The same lengths the model holds, so only the DEPTH is ever in dispute. */
const REF_MM: Record<string, number> = { wheels: 3375, P: 31_440 }

const frame = (over: {
  id: string; boat?: string; scaleKey?: string; depthMm?: number
  baselineMm?: number; marks?: Record<string, unknown>; noMarks?: boolean
}) => {
  const scaleKey = over.scaleKey ?? 'wheels'
  return {
    id: over.id,
    name: `${over.id}.jpg`,
    bunnyPath: `sessions/x/${over.id}.jpg`,
    boat: over.boat ?? 'Northstar 76',
    sailtrim_data: JSON.stringify({
      annotation: {
        version: SAILTRIM_VERSION, imageSize: { w: 6000, h: 4000 }, defn: 'boat',
        axis: { low: { x: 1, y: 2 }, high: { x: 3, y: 4 } },
        targets: [{ key: 'boom', label: 'Boom', point: { x: 1, y: 1 }, foot: { x: 0, y: 0 }, mm: 2210, sigmaMm: 10, colour: '#fff' }],
        psiDeg: 0, psiMeasured: true, heelDeg: 20, measuredAt: 1,
      },
      result: {
        boat: over.boat ?? 'Northstar 76',
        calibration: { mmPerPxAtMast: 12.5, rangeMm: 83_000 },
        marks: {
          marks: over.noMarks ? undefined : (over.marks ?? { 'leech:jib': [{ x: 1, y: 1 }] }),
          scaleKey,
          baselineKey: 'mast-transom',
          rig: {
            boat: over.boat ?? 'Northstar 76',
            // The same length the model holds, so only the DEPTH is in dispute.
            scaleRefs: [{ key: scaleKey, mm: REF_MM[scaleKey] ?? 3375, depthMm: over.depthMm ?? -10_000 }],
            baselines: [{ key: 'mast-transom', mm: over.baselineMm ?? 12_650 }],
          },
        },
      },
    }),
  } as unknown as Record<string, unknown>
}

const rigs = new Map([['northstar 76', northstar], ['capricorno', capricorno]])

describe('parseStored / boatOf', () => {
  it('reads the boat a frame was MEASURED as, not the one it is filed under', () => {
    const p = frame({ id: 'a', boat: 'Capricorno' })
    p.boat = 'Northstar 76'           // filed wrongly; the snapshot is the truth
    expect(boatOf(p, parseStored(p)!)).toBe('Capricorno')
  })

  it('ignores a payload that is corrupt or has no annotation', () => {
    expect(parseStored({ sailtrim_data: '{oops' })).toBeNull()
    expect(parseStored({ sailtrim_data: JSON.stringify({ overlay: true }) })).toBeNull()
    expect(parseStored({})).toBeNull()
  })
})

describe('staleFrames — what the panel offers', () => {
  it('offers a frame whose wheel depth the designer has since corrected', () => {
    const out = staleFrames([frame({ id: 'a', depthMm: -10_000 })], rigs, '2026-09-27')
    expect(out).toHaveLength(1)
    expect(out[0].boat).toBe('Northstar 76')
    expect(out[0].reasons.join(' ')).toMatch(/scale wheels/)
  })

  it('leaves a frame already measured on the current datums alone', () => {
    const out = staleFrames([frame({ id: 'a', depthMm: -7392 })], rigs, '2026-09-27')
    expect(out).toHaveLength(0)
  })

  it('does NOT flag a P frame on a wheel-depth change — P sits in the mast plane', () => {
    // The check that the correction goes where it should and nowhere else: a
    // reference at depth 0 has no depth correction to get wrong. This is the
    // 26 Sep case, where the frames scale off P.
    const out = staleFrames([frame({ id: 'a', scaleKey: 'P', depthMm: 0 })], rigs, '2026-09-26')
    expect(out).toHaveLength(0)
  })

  it('flags a moved BASELINE even when the scale is untouched, because ψ moves', () => {
    const out = staleFrames([frame({ id: 'a', scaleKey: 'P', depthMm: 0, baselineMm: 12_900 })], rigs, '2026-09-26')
    expect(out).toHaveLength(1)
    expect(out[0].reasons.join(' ')).toMatch(/baseline mast-transom/)
  })

  it('never offers a frame with no clicks — that one needs re-marking', () => {
    // Replaying nothing would save a fresh, emptier answer over a real one.
    expect(staleFrames([frame({ id: 'a', marks: {} })], rigs, '2026-09-27')).toHaveLength(0)
    expect(staleFrames([frame({ id: 'a', noMarks: true })], rigs, '2026-09-27')).toHaveLength(0)
  })

  it('stays silent about a reference the boat no longer has — that is CANNOT TELL', () => {
    // A deliberate omission, not an oversight: with no such reference in the
    // model there is no drift to compute, so the panel cannot say whether the
    // frame is stale. sailtrim-audit.ts reports these as CANNOT TELL; offering
    // to "fix" one would be a guess wearing a button.
    const out = staleFrames([frame({ id: 'a', scaleKey: 'no-such-ref', depthMm: -10_000 })], rigs, '2026-09-27')
    expect(out).toHaveLength(0)
  })

  it('never offers a frame whose boat has no rig model — a guessed boat is worse', () => {
    const out = staleFrames([frame({ id: 'a', boat: 'Someone Else' })], new Map(), '2026-09-27')
    expect(out).toHaveLength(0)
  })

  it('keeps two boats on one day apart', () => {
    // 26 Sep: Northstar's frames moved, Capricorno's did not. Redoing hers as
    // Northstar would scale her by Northstar's rig, which has happened before.
    const day = [
      frame({ id: 'n1', boat: 'Northstar 76', depthMm: -10_000 }),
      frame({ id: 'c1', boat: 'Capricorno', scaleKey: 'P', depthMm: 0 }),
    ]
    const out = staleFrames(day, rigs, '2026-09-26')
    expect(out.map((o) => o.id)).toEqual(['n1'])
    expect(out[0].boat).toBe('Northstar 76')
  })

  it('carries the before-numbers, so a redo that changed nothing is visible', () => {
    const out = staleFrames([frame({ id: 'a', depthMm: -10_000 })], rigs, '2026-09-27')
    expect(out[0].before).toEqual([{ key: 'boom', mm: 2210 }])
  })
})

describe('staleFrames — the MATHS can move, not just the datums', () => {
  /** A frame that is current on every datum, with its version stamp replaced. */
  const versioned = (v: string | null) => {
    const f = frame({ id: 'm', depthMm: -7392 })
    const d = JSON.parse(f.sailtrim_data as string)
    if (v === null) delete d.annotation.version
    else d.annotation.version = v
    f.sailtrim_data = JSON.stringify(d)
    return f
  }

  it('offers a frame measured by an older geometry', () => {
    // solvePsi was corrected after these frames were saved. No datum moved, so
    // both drift checks saw a perfectly current frame and the panel stayed
    // hidden — leaving eleven manual visits to "Edit points…", which is itself
    // only reachable from the card that replaces the measure button.
    const out = staleFrames([versioned('sailtrim-v0.2-horizon')], rigs, '2026-09-27')
    expect(out).toHaveLength(1)
    expect(out[0].reasons.join(' ')).toContain('sailtrim-v0.2-horizon')
    expect(out[0].reasons.join(' ')).toContain(SAILTRIM_VERSION)
  })

  it('leaves a frame measured by the CURRENT geometry alone', () => {
    expect(staleFrames([versioned(SAILTRIM_VERSION)], rigs, '2026-09-27')).toHaveLength(0)
  })

  it('does not flag a frame that carries no version at all', () => {
    // An absent stamp is evidence of nothing, and a redo offered on no evidence
    // is how a panel that means something becomes a panel people dismiss.
    expect(staleFrames([versioned(null)], rigs, '2026-09-27')).toHaveLength(0)
  })
})
