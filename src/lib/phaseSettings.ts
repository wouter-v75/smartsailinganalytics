// Settings for the phases SSA builds itself (src/lib/buildPhases.ts), as opposed to
// the 30 s phases that arrive in the KND event file.
//
// The defaults are the ones that are actually published by tools doing this work,
// not invented here:
//   • 30 s blocks — Owen Clarke's inshore phase length running the KND toolchain,
//     and Njord's "better for season-level trend analysis and polar comparisons"
//     setting (their other option is 10 s, for trim work).
//   • a guard either side of every manoeuvre — Njord's documented baseline is 20 s, and a
//     TP52 study excluded a whole window length either side. The default here is one phase
//     length, which is both the TP52 setting and the invariant Polar Recorder enforces
//     (cooldown >= stability window): with a shorter guard a phase can begin inside the
//     wake of the manoeuvre it was meant to skip.
//   • drift vs spread — signalk-autopolar's gate, the clearest published statement of
//     the idea: a block is spoiled when the numbers GO AWAY (the end of the block no
//     longer looks like its start), not when they are merely noisy. Spread is what
//     gets averaged, so its limits are guard rails, not the test.
//   • AWA, never heading — under a wind-mode autopilot a 30° shift turns the boat 30°
//     while the point of sail, and so the performance, is unchanged.
//
// Every number is per boat (Boat config): a 37 m maxi and a sportsboat do not hold
// the same angles, and the thresholds are the whole difference between a clean
// reference dataset and a polluted one.

export interface PhaseGate {
  awaDriftMaxDeg: number    // mean(last third) − mean(first third): the point of sail moved
  awaSpreadMaxDeg: number   // max − min over the block: guard rail only
  twsDriftMaxKn: number     // the wind is building or dying through the block
  twsSpreadMaxKn: number
  bspDriftMaxKn: number     // still accelerating — not the steady state a polar describes
  bspSpreadMaxKn: number
  rotMaxDegS: number        // MEAN |rate of turn|, not a peak: one slew off a wave is fine
  minBspKn: number          // parked, or drifting in the pre-start
  minTwsKn: number
  minTwaDeg: number         // head to wind: nothing to learn, and TWA is noisy there
}

export interface PhaseSettings {
  phaseLenS: number         // block length
  guardBeforeS: number      // dropped before a manoeuvre / mark rounding / sail change
  guardAfterS: number       // and after it
  minCoverage: number       // 0–1: rows present vs rows the block should hold
  maxGapS: number           // a hole longer than this spoils the block
  manoeuvrePhases: boolean  // emit tacks and gybes as phases of their own (calibration)
  manoeuvreWindowS: number  // their length, centred on the manoeuvre
  gate: PhaseGate
}

export const DEFAULT_GATE: PhaseGate = {
  awaDriftMaxDeg: 15, awaSpreadMaxDeg: 45,
  twsDriftMaxKn: 3, twsSpreadMaxKn: 8,
  bspDriftMaxKn: 1.5, bspSpreadMaxKn: 2.5,
  rotMaxDegS: 6,
  minBspKn: 3,              // KND's LogCleaner uses BSP > 3 kn to find a log's first real row
  minTwsKn: 3,
  minTwaDeg: 25,
}

export const DEFAULT_SETTINGS: PhaseSettings = {
  phaseLenS: 30,
  guardBeforeS: 30, guardAfterS: 30,
  minCoverage: 0.6,
  maxGapS: 3,
  manoeuvrePhases: true,
  manoeuvreWindowS: 20,     // ±10 s around the apex — the interval published manoeuvre analysis uses
  gate: { ...DEFAULT_GATE },
}

// The block lengths offered in the UI. 30 s matches the event file, so SSA phases and
// KND phases can sit in the same chart; 10 s is the trim-work setting.
export const PHASE_LENGTHS = [10, 20, 30, 60] as const

// Live test runs: start, let it run, or stop it early.
export const TEST_DURATIONS_MIN = [1, 2, 5, 7] as const
export const DEFAULT_TEST_MIN = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Bounds are deliberately wide — this is a guard against a typo or a stale stored
// object, not a second opinion on the user's settings.
const RANGE: Record<string, [number, number]> = {
  phaseLenS: [5, 300], guardBeforeS: [0, 300], guardAfterS: [0, 300],
  minCoverage: [0, 1], maxGapS: [1, 60], manoeuvreWindowS: [4, 120],
  awaDriftMaxDeg: [1, 90], awaSpreadMaxDeg: [1, 180],
  twsDriftMaxKn: [0.5, 30], twsSpreadMaxKn: [0.5, 40],
  bspDriftMaxKn: [0.1, 20], bspSpreadMaxKn: [0.1, 30],
  rotMaxDegS: [0.5, 60], minBspKn: [0, 30], minTwsKn: [0, 40], minTwaDeg: [0, 90],
}

const numOr = (v: unknown, fallback: number, key: string): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const [lo, hi] = RANGE[key] || [-Infinity, Infinity]
  return clamp(n, lo, hi)
}

// Merge a boat's stored overrides onto the defaults. Anything missing, out of range or
// the wrong type falls back to the default rather than failing: a phase run with one
// odd threshold is recoverable, a crash in the Analytics tab is not.
export function withSettings(extra?: Partial<PhaseSettings> | null): PhaseSettings {
  const g = { ...DEFAULT_GATE, ...(extra?.gate || {}) }
  const gate = Object.fromEntries(
    (Object.keys(DEFAULT_GATE) as (keyof PhaseGate)[]).map(k => [k, numOr(g[k], DEFAULT_GATE[k], k)])
  ) as unknown as PhaseGate
  return {
    phaseLenS: numOr(extra?.phaseLenS, DEFAULT_SETTINGS.phaseLenS, 'phaseLenS'),
    guardBeforeS: numOr(extra?.guardBeforeS, DEFAULT_SETTINGS.guardBeforeS, 'guardBeforeS'),
    guardAfterS: numOr(extra?.guardAfterS, DEFAULT_SETTINGS.guardAfterS, 'guardAfterS'),
    minCoverage: numOr(extra?.minCoverage, DEFAULT_SETTINGS.minCoverage, 'minCoverage'),
    maxGapS: numOr(extra?.maxGapS, DEFAULT_SETTINGS.maxGapS, 'maxGapS'),
    manoeuvrePhases: typeof extra?.manoeuvrePhases === 'boolean' ? extra.manoeuvrePhases : DEFAULT_SETTINGS.manoeuvrePhases,
    manoeuvreWindowS: numOr(extra?.manoeuvreWindowS, DEFAULT_SETTINGS.manoeuvreWindowS, 'manoeuvreWindowS'),
    gate,
  }
}

// Warnings shown beside the settings — the combinations that quietly produce rubbish
// rather than an error. Not fatal: the builder runs whatever it is given.
export function settingsWarnings(s: PhaseSettings): string[] {
  const out: string[] = []
  // Polar Recorder enforces cooldown >= stability window for exactly this reason: with a
  // shorter guard, a block can start inside the wake of the manoeuvre it is meant to skip.
  if (s.guardAfterS < s.phaseLenS) {
    out.push(`The guard after a manoeuvre (${s.guardAfterS} s) is shorter than a phase (${s.phaseLenS} s) — a phase can start inside the manoeuvre's wake.`)
  }
  if (s.phaseLenS < 10) out.push('Phases under 10 s are noise-dominated; 15 s is the shortest length published as usable.')
  if (s.phaseLenS !== 30) out.push('Only 30 s phases line up with the event file — mixing lengths in one comparison is misleading.')
  if (s.minCoverage < 0.5) out.push(`At ${Math.round(s.minCoverage * 100)} % coverage a phase can be averaged from less than half its rows.`)
  return out
}

// A phase is only as good as the log under it. 1 Hz is the analysis-grade standard;
// the cloud copy of a session keeps a row every ~6 s, which is below the 0.33 Hz floor
// published for manoeuvre detection and far too coarse for a 10 s block.
export function resolutionNote(resolutionS: number | null | undefined, phaseLenS: number): string | null {
  if (resolutionS == null) return null
  if (resolutionS > 3) {
    return `This log has a row every ~${resolutionS.toFixed(0)} s — too coarse to build phases from. Load the full-resolution log for this day.`
  }
  const rows = phaseLenS / resolutionS
  if (rows < 10) return `Only ~${rows.toFixed(0)} rows per ${phaseLenS} s phase at this log's resolution.`
  return null
}
