// src/lib/trackColour.ts
// ─────────────────────────────────────────────────────────────────────────────
// What the colour of the analytics track MEANS.
//
// The track has always been coloured by performance against the polar, with the
// measure chosen automatically: near a VMG angle it compared VMG, off-angle it
// compared boat speed. That is the right default and it stays the default — but
// it makes one map answer three questions at once, and a map that changes its
// question halfway up the beat cannot be used to compare two beats.
//
// So the measure becomes a choice:
//
//   AUTO      what it has always done: VMG near a VMG angle, BSP elsewhere.
//   VMG %     progress towards the mark against the best the polar offers.
//             The honest measure of a beat or a run, and the one that punishes
//             sailing fast in the wrong direction.
//   POL BSP % boat speed against the polar AT THE ANGLE ACTUALLY SAILED. Asks
//             "is the boat going as fast as it should, given how it is being
//             steered" — a trim question, not a tactical one.
//   TARGET %  boat speed against TARGET boat speed: the speed the polar says to
//             sail at the optimum VMG angle. This is the number on the
//             instruments that a helm steers to, so it is the one a debrief
//             argues about.
//
// The three are genuinely different and routinely disagree — a boat two degrees
// low and quick is over 100% on POL BSP, over 100% on TARGET, and under on VMG.
// That disagreement is the information.
//
// Pure — no React, no DOM, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { polarInterp, polarVMGTarget, polarPerf } from './polarCalc'

export type TrackColourMode = 'auto' | 'vmg' | 'polbsp' | 'target'

export const TRACK_COLOUR_MODES: { key: TrackColourMode; label: string; hint: string }[] = [
  { key: 'auto', label: 'Auto', hint: 'VMG near a VMG angle, boat speed elsewhere' },
  { key: 'vmg', label: 'VMG %', hint: 'Progress to the mark, against the polar’s best' },
  { key: 'polbsp', label: 'Pol BSP %', hint: 'Boat speed against the polar at the angle sailed' },
  { key: 'target', label: 'Target %', hint: 'Boat speed against target boat speed' },
]

/** Below this the boat is not sailing, and every ratio becomes noise. */
const MIN_BSP = 0.3
/** The same window polarPerf uses, so 'auto' and the explicit modes agree about
 *  what counts as a sane percentage. */
const clampPct = (v: number): number => Math.max(0, Math.min(150, v))

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export interface PerfRow {
  bsp?: number | null
  twa?: number | null
  tws?: number | null
}

/**
 * The percentage this row scores under `mode`, or null when it cannot be known.
 *
 * null rather than 100: a row with no wind reading is not a row sailing to its
 * polar, and colouring it green would be inventing a measurement. The caller
 * draws those in the neutral blue the track has always used for "no data".
 */
export function trackPct(
  polar: unknown,
  row: PerfRow | null | undefined,
  mode: TrackColourMode = 'auto'
): number | null {
  if (!polar || !row) return null
  const { bsp, twa, tws } = row
  if (!isNum(bsp) || !isNum(twa) || !isNum(tws) || bsp < MIN_BSP) return null

  if (mode === 'auto') {
    const p = polarPerf(polar, bsp, twa, tws)
    return p && isNum(p.pct) ? p.pct : null
  }

  const absA = Math.abs(twa)
  const t = polarVMGTarget(polar, tws)
  // Which end of the course this row belongs to. 90° exactly is a reach and
  // belongs to neither, but it has to be counted somewhere; upwind, because
  // that is the side the angle is measured from.
  const upwind = absA < 90

  if (mode === 'vmg') {
    const targetVmg = upwind ? t.upVMG : t.downVMG
    if (!isNum(targetVmg) || targetVmg <= 0.001) return null
    // Component towards the mark being sailed to — upwind that is cos(TWA),
    // downwind it is cos(180 − TWA), which is why the sign works out positive
    // on both ends of the course.
    const actual = bsp * Math.cos((upwind ? absA : 180 - absA) * Math.PI / 180)
    return clampPct((actual / targetVmg) * 100)
  }

  if (mode === 'polbsp') {
    const target = polarInterp(polar, tws, absA)
    if (!isNum(target) || target <= 0.001) return null
    return clampPct((bsp / target) * 100)
  }

  // target: the speed the polar says to sail AT the optimum VMG angle — the
  // number on the instruments, whatever angle is actually being steered.
  const angle = upwind ? t.up : t.down
  const target = polarInterp(polar, tws, angle)
  if (!isNum(target) || target <= 0.001) return null
  return clampPct((bsp / target) * 100)
}

/** The label a legend shows for a mode. */
export const modeLabel = (mode: TrackColourMode): string =>
  TRACK_COLOUR_MODES.find((m) => m.key === mode)?.label ?? 'Auto'

/** Read a stored preference back, ignoring anything that is not a mode. */
export function toMode(raw: unknown): TrackColourMode {
  return TRACK_COLOUR_MODES.some((m) => m.key === raw) ? (raw as TrackColourMode) : 'auto'
}
