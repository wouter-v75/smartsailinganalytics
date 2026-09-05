// courseSides.js — favoured-side geometry for the windward/leeward course analysis.
//
// SIDE FRAME (the thing that is easy to get wrong): "left" and "right" are the
// crew's sides, so they depend on which way the boat is facing. analyseCourse()
// measures the course in the UPWIND frame — its cross axis is positive to the
// right LOOKING UPWIND — and every raw signal here inherits that frame:
// twsLeftRight (+ = more wind right looking upwind) and bendDeg (+ = veers up the
// beat = right bend looking upwind).
//
// That frame is correct for the beat. On the run the crew faces the other way, so
// the same patch of water is called the opposite side. The physics is computed
// once, upwind-framed, and only the LABEL is flipped, at the point where it turns
// into a side a sailor is told to sail to (vmgSides().dn). Anything upwind-framed
// stays upwind-framed; enrichCourse() ships a `sideFrame` map so downstream
// consumers — the deck table and the AI brief — can never quietly mix the two.

import { polarVMGTarget, polarInterp } from '../../lib/polarCalc'

// Human text for the TWS gradient across the course.
export function gradientText(course) {
  if (!course) return null
  const parts = []
  if (course.twsLeftRight != null && Math.abs(course.twsLeftRight) >= 0.5) parts.push(`+${Math.abs(course.twsLeftRight)} kt ${course.twsLeftRight > 0 ? 'right' : 'left'}`)
  if (course.twsTopBottom != null && Math.abs(course.twsTopBottom) >= 0.5) parts.push(`+${Math.abs(course.twsTopBottom)} kt ${course.twsTopBottom > 0 ? 'top' : 'bottom'}`)
  return parts.length ? parts.join(' · ') : 'even across course'
}

// Favoured side from the two INDEPENDENT signals, using the team's rule:
//   - a bend favours the side it bends TO (right bend -> R, left bend -> L)
//   - pressure favours the side with MORE wind (twsLeftRight > 0 -> R, < 0 -> L)
// Agree -> that side. Conflict -> 'Neutral' (right for bend, left for pressure —
// never collapse to one). One signal only -> that side. Returns R|L|Neutral|null.
// ONE FRAME FOR THE WHOLE COURSE: left and right always mean looking UPWIND, on
// both legs. So "the right side" names the same patch of water whether the boat is
// beating or running, and a brief, a table and a bullet can be read together without
// anyone asking which leg is being talked about.
//
// The alternative — naming each leg as the crew faces it — is arguably truer to what
// you see over the bow, but it makes the SAME water swap name between the beat and
// the run, and that ambiguity costs more on the water than the added realism buys.
// Kept exported (and tested) because it is the one place that inversion is written
// down, should the convention ever be revisited.
export const flipSide = (s) => (s === 'R' ? 'L' : s === 'L' ? 'R' : s)

export function favouredSide(c) {
  if (!c) return null
  const bendSide = c.bend === 'right' ? 'R' : c.bend === 'left' ? 'L' : null
  const presSide = (c.twsLeftRight != null && Math.abs(c.twsLeftRight) >= 0.5)
    ? (c.twsLeftRight > 0 ? 'R' : 'L') : null
  if (bendSide && presSide) return bendSide === presSide ? bendSide : 'Neutral'
  return bendSide || presSide || null
}

const VMG_D2R = Math.PI / 180
// Quantitative favoured side per LEG, from the boat's polar targets. Per side (L/R):
// pressure enters as the target VMG at that side's TWS (downwind this rises steeply
// with wind, so pressure dominates downwind); the bend enters as the VMG change for a
// half-bend angle shift, weighted by each leg's angle sensitivity (upwind TWA ~42 deg
// vs 180-downwind TWA ~30 deg) so the bend moves the downwind number far less. Upwind
// and downwind use their OWN targets and are computed independently. Bendfavoured side
// is a one-sided bonus to the side that plays it (right bend -> right) on both legs;
// downwind the steep VMG-vs-TWS polar means pressure usually wins anyway. Returns { up:{side,gain}, dn:{side,gain} } in kn, or null (no polar).
export function vmgSides(c, polar) {
  if (!c || !polar?.entries?.length) return null
  const grad = c.twsLeftRight ?? 0
  const base = c.centreKt ?? ((c.twsRight != null && c.twsLeft != null) ? (c.twsRight + c.twsLeft) / 2 : null)
  let twsR = c.twsRight, twsL = c.twsLeft
  if (twsR == null || twsL == null) {
    if (base == null) return null
    twsR = base + grad / 2; twsL = base - grad / 2
  }
  const baseT = base ?? (twsR + twsL) / 2
  const bend = c.bendDeg ?? 0
  const half = Math.abs(bend) / 2
  const bendR = bend > 4 ? 1 : bend < -4 ? -1 : 0   // +1 -> right favoured by the bend
  const tR = polarVMGTarget(polar, twsR)
  const tL = polarVMGTarget(polar, twsL)
  const tB = polarVMGTarget(polar, baseT)
  const leg = (vmgR, vmgL, theta, bspBase) => {
    const bendMag = half > 0 ? bspBase * (Math.cos((theta - half) * VMG_D2R) - Math.cos(theta * VMG_D2R)) : 0
    const r = vmgR + (bendR > 0 ? bendMag : 0)   // one-sided: the side that PLAYS the
    const l = vmgL + (bendR < 0 ? bendMag : 0)   // bend gains; the other just misses out
    const diff = r - l
    return { side: Math.abs(diff) < 0.05 ? 'Neutral' : diff > 0 ? 'R' : 'L', gain: Math.round(Math.abs(diff) * 100) / 100 }
  }
  const bspUp = polarInterp(polar, baseT, tB.up) || (tB.upVMG / (Math.cos(tB.up * VMG_D2R) || 1))
  const bspDn = polarInterp(polar, baseT, tB.down) || (tB.downVMG / (Math.cos((180 - tB.down) * VMG_D2R) || 1))
  const dn = leg(tR.downVMG, tL.downVMG, 180 - tB.down, bspDn)
  // Both legs are reported in the UPWIND frame. `leg` already computes in that frame
  // (tR/tL are the right/left sides looking upwind), so the downwind side needs no
  // relabelling — it names the same water as the upwind side of the same name.
  return { up: leg(tR.upVMG, tL.upVMG, tB.up, bspUp), dn }
}

// Enrich a course snapshot for the AI: explicit pressure side/kt + favoured side(s),
// so the model never has to interpret the SIGNED gradient itself. fav = qualitative;
// favUp/favDn = VMG-favoured side per leg from the polar (null when no polar loaded).
export function enrichCourse(c, polar) {
  if (!c) return null
  const has = c.twsLeftRight != null && Math.abs(c.twsLeftRight) >= 0.5
  const v = vmgSides(c, polar)
  // EVERY side field is upwind-framed, favDn included. `sideFrame` still ships in the
  // payload so the model is told the frame outright rather than inferring it.
  return { ...c, pressureSide: has ? (c.twsLeftRight > 0 ? 'right' : 'left') : 'even', pressureKt: c.twsLeftRight != null ? Math.abs(c.twsLeftRight) : null, fav: favouredSide(c),
    sideFrame: { bend: 'looking upwind', twsLeftRight: 'looking upwind', pressureSide: 'looking upwind', fav: 'looking upwind', favUp: 'looking upwind', favDn: 'looking upwind' },
    favUp: v?.up?.side ?? null, favUpGain: v?.up?.gain ?? null, favDn: v?.dn?.side ?? null, favDnGain: v?.dn?.gain ?? null }
}

