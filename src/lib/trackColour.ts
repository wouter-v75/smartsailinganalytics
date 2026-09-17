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

export type TrackColourMode =
  | 'auto' | 'vmg' | 'polbsp' | 'target'                    // against the polar
  | 'sailmode'                                              // upwind / reach / downwind
  | 'bsp' | 'awa' | 'aws' | 'twa' | 'twd' | 'tws' | 'heel' | 'trim' | 'forestay'  // straight off the log

export interface TrackColourModeDef {
  key: TrackColourMode
  label: string
  hint: string
  /** 'pct' needs a polar; 'channel' is a number off the log; 'category' is a state. */
  kind: 'pct' | 'channel' | 'category'
  channel?: string        // the log column, for 'channel'
  unit?: string
  /** A compass direction: 359° and 1° are neighbours, so the scale wraps. */
  cyclic?: boolean
  /** Port and starboard are the same angle for colouring purposes. */
  abs?: boolean
  group: string
}

export const TRACK_COLOUR_MODES: TrackColourModeDef[] = [
  { key: 'auto', label: 'Auto', hint: 'VMG near a VMG angle, boat speed elsewhere', kind: 'pct', unit: '%', group: 'Against the polar' },
  { key: 'vmg', label: 'VMG %', hint: 'Progress to the mark, against the polar’s best', kind: 'pct', unit: '%', group: 'Against the polar' },
  { key: 'polbsp', label: 'Pol BSP %', hint: 'Boat speed against the polar at the angle sailed', kind: 'pct', unit: '%', group: 'Against the polar' },
  { key: 'target', label: 'Target %', hint: 'Boat speed against target boat speed', kind: 'pct', unit: '%', group: 'Against the polar' },
  { key: 'sailmode', label: 'Mode', hint: 'Upwind, reaching or downwind, from the wind angle', kind: 'category', group: 'State' },
  { key: 'bsp', label: 'BSP', hint: 'Boat speed through the water', kind: 'channel', channel: 'bsp', unit: ' kn', group: 'Speed' },
  { key: 'tws', label: 'TWS', hint: 'True wind speed', kind: 'channel', channel: 'tws', unit: ' kn', group: 'Wind' },
  { key: 'aws', label: 'AWS', hint: 'Apparent wind speed', kind: 'channel', channel: 'aws', unit: ' kn', group: 'Wind' },
  { key: 'twa', label: 'TWA', hint: 'True wind angle, port and starboard alike', kind: 'channel', channel: 'twa', unit: '°', abs: true, group: 'Wind' },
  { key: 'awa', label: 'AWA', hint: 'Apparent wind angle, port and starboard alike', kind: 'channel', channel: 'awa', unit: '°', abs: true, group: 'Wind' },
  { key: 'twd', label: 'TWD', hint: 'True wind direction — the scale wraps at north', kind: 'channel', channel: 'twd', unit: '°', cyclic: true, group: 'Wind' },
  { key: 'heel', label: 'Heel', hint: 'Heel angle as logged, either tack', kind: 'channel', channel: 'heel', unit: '°', group: 'Trim' },
  { key: 'trim', label: 'Trim', hint: 'Fore-and-aft trim as logged', kind: 'channel', channel: 'trim', unit: '°', group: 'Trim' },
  { key: 'forestay', label: 'Forestay', hint: 'Forestay load as logged', kind: 'channel', channel: 'forestay', unit: '', group: 'Trim' },
]

export const modeDef = (mode: TrackColourMode): TrackColourModeDef =>
  TRACK_COLOUR_MODES.find(m => m.key === mode) || TRACK_COLOUR_MODES[0]

/** Only the polar modes need a polar; everything else colours a raw channel. */
export const needsPolar = (mode: TrackColourMode): boolean => modeDef(mode).kind === 'pct'

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

// ── Colour ───────────────────────────────────────────────────────────────────
// The track used to have three colours: red under 90 %, green to 110, dark green
// above. That answers "was this good" and nothing else — two beats a knot apart
// look identical. A wide ramp spends the whole spectrum on the range the day
// actually covered, so differences that matter are visible at a glance.

interface Stop { t: number; r: number; g: number; b: number }

// Blue → cyan → green → yellow → orange → red. Ordered by brightness as well as
// hue, so it still reads as a scale in greyscale or to a colour-blind eye.
const RAMP: Stop[] = [
  { t: 0.00, r: 49, g: 84, b: 189 },
  { t: 0.22, r: 34, g: 197, b: 214 },
  { t: 0.45, r: 74, g: 222, b: 128 },
  { t: 0.65, r: 250, g: 232, b: 92 },
  { t: 0.84, r: 251, g: 146, b: 60 },
  { t: 1.00, r: 239, g: 68, b: 68 },
]

const mix = (a: Stop, b: Stop, t: number) => {
  const k = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `rgb(${k(a.r, b.r)},${k(a.g, b.g)},${k(a.b, b.b)})`
}

/** 0–1 across the ramp. Out-of-range values clamp to the ends. */
export function rampColor(t: number): string {
  if (!isNum(t)) return NO_DATA
  const c = Math.max(0, Math.min(1, t))
  for (let i = 1; i < RAMP.length; i++) {
    if (c <= RAMP[i].t) return mix(RAMP[i - 1], RAMP[i], (c - RAMP[i - 1].t) / (RAMP[i].t - RAMP[i - 1].t))
  }
  const last = RAMP[RAMP.length - 1]
  return `rgb(${last.r},${last.g},${last.b})`
}

/** A compass direction has no ends to clamp to, so it gets the colour wheel. */
export function cyclicColor(deg: number): string {
  if (!isNum(deg)) return NO_DATA
  const h = ((deg % 360) + 360) % 360
  // HSL → RGB at fixed saturation and lightness, so only the hue carries meaning.
  const s = 0.62, l = 0.58
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v: number) => Math.round((v + m) * 255)
  return `rgb(${to(r)},${to(g)},${to(b)})`
}

/** No reading is not a bad reading: the track's long-standing "no data" blue. */
export const NO_DATA = '#1E4080'

export type SailMode = 'up' | 'reach' | 'down'

// The same split the performance charts use, so a track coloured by mode and a chart
// grouped by mode are talking about the same water.
export function sailModeOf(twa: number | null | undefined): SailMode | null {
  if (!isNum(twa)) return null
  const a = Math.abs(twa)
  if (a < 70) return 'up'
  if (a > 130) return 'down'
  return 'reach'
}

export const SAIL_MODE_COLOR: Record<SailMode, string> = {
  up: '#22D3EE', reach: '#A78BFA', down: '#FB923C',
}
export const SAIL_MODE_LABEL: Record<SailMode, string> = {
  up: 'Upwind', reach: 'Reaching', down: 'Downwind',
}

export interface ChannelRow extends PerfRow {
  [key: string]: unknown
}

/** What this row is worth under `mode`: a percentage, a channel, or null. */
export function trackValue(
  polar: unknown, row: ChannelRow | null | undefined, mode: TrackColourMode
): number | null {
  const def = modeDef(mode)
  if (!row) return null
  if (def.kind === 'pct') return trackPct(polar, row, mode)
  if (def.kind === 'category') {
    const m = sailModeOf(row.twa as number)
    return m == null ? null : ['up', 'reach', 'down'].indexOf(m)
  }
  const raw = row[def.channel as string]
  if (!isNum(raw)) return null
  return def.abs ? Math.abs(raw) : raw
}

export interface ColourScale {
  mode: TrackColourMode
  lo: number
  hi: number
  cyclic: boolean
  unit: string
  kind: TrackColourModeDef['kind']
}

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))]

/**
 * The range to spend the ramp on, taken from the day itself.
 *
 * The 2nd and 98th percentiles, not the extremes: one spike from a wave or a bad
 * fix would otherwise flatten the whole day into a single colour, which is the
 * failure this is meant to fix.
 */
export function scaleForRows(
  polar: unknown, rows: readonly ChannelRow[] | null | undefined, mode: TrackColourMode
): ColourScale | null {
  const def = modeDef(mode)
  const base: ColourScale = { mode, lo: 0, hi: 1, cyclic: !!def.cyclic, unit: def.unit || '', kind: def.kind }
  if (def.kind === 'category') return { ...base, lo: 0, hi: 2 }
  if (def.cyclic) return { ...base, lo: 0, hi: 360 }
  const vals: number[] = []
  for (const r of rows || []) {
    const v = trackValue(polar, r, mode)
    if (isNum(v)) vals.push(v)
  }
  if (vals.length < 2) return null
  vals.sort((a, b) => a - b)
  let lo = quantile(vals, 0.02), hi = quantile(vals, 0.98)
  if (!(hi > lo)) { lo = vals[0]; hi = vals[vals.length - 1] }
  if (!(hi > lo)) return null
  return { ...base, lo, hi }
}

/** The colour for one value under a scale. */
export function colourFor(value: number | null | undefined, scale: ColourScale | null): string {
  if (!isNum(value) || !scale) return NO_DATA
  if (scale.kind === 'category') {
    const m: SailMode = (['up', 'reach', 'down'] as SailMode[])[Math.round(value)] || 'reach'
    return SAIL_MODE_COLOR[m]
  }
  if (scale.cyclic) return cyclicColor(value)
  return rampColor((value - scale.lo) / ((scale.hi - scale.lo) || 1))
}

export interface LegendStop { color: string; label: string }

/** What the legend under the map shows: the ends and the middle, or the states. */
export function legendStops(scale: ColourScale | null): LegendStop[] {
  if (!scale) return []
  if (scale.kind === 'category') {
    return (['up', 'reach', 'down'] as SailMode[]).map(m => ({ color: SAIL_MODE_COLOR[m], label: SAIL_MODE_LABEL[m] }))
  }
  if (scale.cyclic) {
    return [0, 90, 180, 270].map(d => ({ color: cyclicColor(d), label: `${d}°` }))
  }
  const dp = scale.hi - scale.lo >= 20 ? 0 : 1
  return [0, 0.25, 0.5, 0.75, 1].map(t => ({
    color: rampColor(t),
    label: `${(scale.lo + (scale.hi - scale.lo) * t).toFixed(dp)}${scale.unit}`,
  }))
}
