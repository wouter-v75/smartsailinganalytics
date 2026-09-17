// The two sources of phases — the KND event file and SSA's own builder — and the rules
// for showing them together.
//
// They are never merged into one list in storage. A merge is a decision, and a decision
// has to be reversible: KND's Calibrator stores the fact that a manoeuvre was reviewed,
// and signalk-autopolar keeps hand exclusions in a file beside the measurements rather
// than inside them, precisely so the raw data can be re-judged later. Here the two sets
// stay separate and a `PhaseResolution` records what was chosen.

import type { Phase } from './phaseStats'
import type { BuiltPhase } from './buildPhases'
import type { PhaseSettings } from './phaseSettings'

// A named stretch of the day somebody chose to analyse: a line-up, a two-boat run, a
// timed test. Named through the team's tag vocabulary so runs are findable later —
// Deckman gives every test a name, a start and an end for the same reason.
export interface PhaseRun {
  id: string
  name: string                       // "J1.5 vs J2, race 3 beat"
  tags: string[]                     // from the day's tag list
  from: number
  to: number
  createdAt: number
  createdByUserId?: string | null
  kind: 'selection' | 'test'         // picked off the track, or a timed test run
  plannedS?: number                  // a test's intended length; it can be stopped early
  settings: PhaseSettings            // what built it — thresholds change, this does not
  note?: string
}

export interface SsaPhaseDoc {
  date: string
  runs: PhaseRun[]
  phases: BuiltPhase[]
  updatedAt?: number
}

export type PhaseSource = 'event' | 'ssa' | 'both'
export type MergeMode = 'add' | 'override'

export interface Overlap {
  ssaUtc: number
  eventUtc: number
  overlapMs: number
  pctOfSsa: number                   // how much of the SSA phase is inside an event phase
}

export interface MergeResult {
  phases: (Phase | BuiltPhase)[]     // in time order, ready for computePhaseStats
  keptEvent: number
  keptSsa: number
  droppedEvent: number
  droppedSsa: number
  overlaps: Overlap[]
}

// What was decided, so an upload can be replayed or reversed. Stored with the phases,
// never folded into them.
export interface PhaseResolution {
  mode: MergeMode
  at: number
  byUserId?: string | null
  keptEvent: number
  keptSsa: number
  droppedEvent: number
  droppedSsa: number
}

const span = (p: { utc: number; endUtc: number }) => Math.max(0, p.endUtc - p.utc)

const overlapMs = (a: { utc: number; endUtc: number }, b: { utc: number; endUtc: number }) =>
  Math.max(0, Math.min(a.endUtc, b.endUtc) - Math.max(a.utc, b.utc))

// Every place the two sources cover the same water. The percentage is of the SSA phase,
// because that is the side a person is choosing to keep or drop.
export function findOverlaps(eventPhases: Phase[], ssaPhases: BuiltPhase[]): Overlap[] {
  const out: Overlap[] = []
  for (const s of ssaPhases) {
    for (const e of eventPhases) {
      const ms = overlapMs(s, e)
      if (ms <= 0) continue
      out.push({ ssaUtc: s.utc, eventUtc: e.utc, overlapMs: ms, pctOfSsa: span(s) ? ms / span(s) : 0 })
    }
  }
  return out.sort((a, b) => a.ssaUtc - b.ssaUtc)
}

// Show both sources together without double-counting the same seconds — Expedition
// greys out a span once a test is saved there for exactly this reason.
//
//   'add'      the event file stands; an SSA phase that overlaps one is left out.
//   'override' the SSA phases win where they were built; event phases they touch go.
//
// Manoeuvre phases (tacks and gybes) never take part: they are kept for calibration,
// they are not steady-state data, and they overlap event phases by their nature.
export function mergePhases(
  eventPhases: Phase[] | null | undefined,
  ssaPhases: BuiltPhase[] | null | undefined,
  mode: MergeMode = 'add',
  opts: { minOverlapPct?: number } = {}
): MergeResult {
  const ev = [...(eventPhases || [])].sort((a, b) => a.utc - b.utc)
  const ssa = [...(ssaPhases || [])].sort((a, b) => a.utc - b.utc)
  const steady = ssa.filter(p => p.kind === 'steady')
  const manoeuvres = ssa.filter(p => p.kind !== 'steady')
  // A one-second brush past a neighbouring phase is not a conflict worth a decision.
  const min = opts.minOverlapPct ?? 0.1
  const overlaps = findOverlaps(ev, steady).filter(o => o.pctOfSsa >= min)

  const clashSsa = new Set(overlaps.map(o => o.ssaUtc))
  const clashEvent = new Set(overlaps.map(o => o.eventUtc))

  const keepEvent = mode === 'add' ? ev : ev.filter(e => !clashEvent.has(e.utc))
  const keepSsa = mode === 'add' ? steady.filter(s => !clashSsa.has(s.utc)) : steady

  return {
    phases: [...keepEvent, ...keepSsa, ...manoeuvres].sort((a, b) => a.utc - b.utc),
    keptEvent: keepEvent.length,
    keptSsa: keepSsa.length + manoeuvres.length,
    droppedEvent: ev.length - keepEvent.length,
    droppedSsa: steady.length - keepSsa.length,
    overlaps,
  }
}

// What the charts should draw for the chosen source.
export function phasesForSource(
  source: PhaseSource,
  eventPhases: Phase[] | null | undefined,
  ssaPhases: BuiltPhase[] | null | undefined,
  mode: MergeMode = 'add'
): (Phase | BuiltPhase)[] {
  if (source === 'event') return [...(eventPhases || [])]
  if (source === 'ssa') return [...(ssaPhases || [])]
  return mergePhases(eventPhases, ssaPhases, mode).phases
}

export function resolutionOf(m: MergeResult, mode: MergeMode, byUserId?: string | null): PhaseResolution {
  return {
    mode, at: Date.now(), byUserId: byUserId ?? null,
    keptEvent: m.keptEvent, keptSsa: m.keptSsa, droppedEvent: m.droppedEvent, droppedSsa: m.droppedSsa,
  }
}

// Phases belonging to a run, so one run can be reviewed, re-run or thrown away without
// touching the rest of the day.
export const phasesOfRun = (doc: SsaPhaseDoc | null, runId: string): BuiltPhase[] =>
  (doc?.phases || []).filter(p => p.runId === runId)

export function removeRun(doc: SsaPhaseDoc, runId: string): SsaPhaseDoc {
  return {
    ...doc,
    runs: (doc.runs || []).filter(r => r.id !== runId),
    phases: (doc.phases || []).filter(p => p.runId !== runId),
  }
}

// Adding a run replaces any earlier run with the same id, so re-running a selection
// with different settings does not leave the old phases behind.
export function upsertRun(doc: SsaPhaseDoc | null, run: PhaseRun, phases: BuiltPhase[], date: string): SsaPhaseDoc {
  const base: SsaPhaseDoc = doc || { date, runs: [], phases: [] }
  const tagged = phases.map(p => ({ ...p, runId: run.id }))
  return {
    ...base,
    date,
    runs: [...(base.runs || []).filter(r => r.id !== run.id), run].sort((a, b) => a.from - b.from),
    phases: [...(base.phases || []).filter(p => p.runId !== run.id), ...tagged].sort((a, b) => a.utc - b.utc),
    updatedAt: Date.now(),
  }
}

export const runLabel = (r: PhaseRun): string =>
  r.name?.trim() || (r.kind === 'test' ? 'Test run' : 'Selection')
