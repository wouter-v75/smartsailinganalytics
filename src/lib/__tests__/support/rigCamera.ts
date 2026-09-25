// src/lib/__tests__/support/rigCamera.ts
// ─────────────────────────────────────────────────────────────────────────────
// A synthetic astern camera, so rigShot can be checked against ground truth.
//
// Boat frame:  x forward, y starboard, z up the mast, origin at the mast heel.
// Heel φ rotates the boat about x. The camera sits astern at range R with its
// optical axis at ψ to the boat's centreplane, optionally rolled by ρ.
//
// FULL PERSPECTIVE — not the scaled-orthographic approximation rigShot.ts uses
// — so the tests also measure what that approximation costs. Not a `.test.ts`,
// so vitest does not try to run it.
// ─────────────────────────────────────────────────────────────────────────────

import type { Px } from '../../rigShot'

export interface Rig {
  heelDeg: number; psiDeg: number; rollDeg: number; rangeMm: number
  focalMm: number; sensorWidthMm: number; imgW: number; imgH: number
}

/** The 6 Sept shooting geometry: R6 II at 254 mm, ~260 m astern, 23° of heel. */
export const RIG: Rig = {
  heelDeg: 23, psiDeg: 0, rollDeg: 0, rangeMm: 260_000,
  focalMm: 254, sensorWidthMm: 36, imgW: 6000, imgH: 4000,
}

/** An N76-ish rig, in boat-frame millimetres. */
export const MAST_HALF_WIDTH = 150      // 300 mm mast, seen athwartships
export const SPREADER_HALF = 3_000      // 6 m tip to tip at spreader 2
export const SPREADER_Z = 20_000
export const TACK = { x: 9_000, z: 1_500 }     // forestay tack, on the centreplane
export const TRANSOM = { x: -12_000, z: 500 }  // transom centre, on the centreplane

export function makeCamera(rig: Rig) {
  const DEG = Math.PI / 180
  const { rangeMm: R } = rig
  const φ = rig.heelDeg * DEG, ψ = rig.psiDeg * DEG, ρ = rig.rollDeg * DEG
  const k = rig.focalMm / (rig.sensorWidthMm / rig.imgW)   // focal length in pixels
  const cx = rig.imgW / 2, cy = rig.imgH / 2

  const f = [Math.cos(ψ), Math.sin(ψ), 0]
  const r0 = [-Math.sin(ψ), Math.cos(ψ), 0]
  const u0 = [0, 0, 1]
  const r = r0.map((_, i) => r0[i] * Math.cos(ρ) + u0[i] * Math.sin(ρ))
  const u = r0.map((_, i) => -r0[i] * Math.sin(ρ) + u0[i] * Math.cos(ρ))
  const C = [-R * Math.cos(ψ), -R * Math.sin(ψ), 0]

  /** boat-frame (x fwd, y stbd, z up) → image px */
  return (bx: number, by: number, bz: number): Px => {
    const W = [bx, by * Math.cos(φ) - bz * Math.sin(φ), by * Math.sin(φ) + bz * Math.cos(φ)]
    const v = [W[0] - C[0], W[1] - C[1], W[2] - C[2]]
    const d = v[0] * f[0] + v[1] * f[1] + v[2] * f[2]
    const rr = v[0] * r[0] + v[1] * r[1] + v[2] * r[2]
    const uu = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]
    return { x: cx + (rr / d) * k, y: cy - (uu / d) * k }
  }
}
