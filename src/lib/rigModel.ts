// src/lib/rigModel.ts
// ─────────────────────────────────────────────────────────────────────────────
// The handful of rig dimensions SailTrim needs, and where they came from.
//
// This is the whole difference between a number of pixels and a number of
// millimetres. Everything else in the tool — the pose, the misalignment, the
// depth correction, the horizon — works on the picture alone. None of it can
// tell you how big anything is without ONE known length.
//
// There are only three kinds of number in here:
//
//   scaleRefs   lengths that are NOT foreshortened seen from astern, so they
//               can set the image scale. Anything athwartships qualifies —
//               spreader tip to tip — but so does anything up the mast, since
//               the mast lies in the plane perpendicular to the line of sight:
//               P, the mainsail hoist between the black bands, is five times
//               the baseline of a spreader and is on every IRC certificate.
//               A fore-and-aft length — mast chord, boom length, J — is useless
//               for this: from astern it projects to almost nothing.
//
//   depths      how far forward of the mast each target sits. Forward positive,
//               so the boom is negative. These feed the depth correction and
//               the misalignment correction.
//
//   baselines   the fore-and-aft separation between two points on the boat's
//               CENTREPLANE — bow to transom, forestay tack to gooseneck. This
//               is what turns two clicks into ψ.
//
// PROVENANCE IS PART OF THE DATA. Every value says whether it came from the rig
// designer or is somebody's estimate, and an estimate carries a fat sigma that
// propagates into every measurement made with it. A tool that cannot tell you
// which of its numbers are real is worse than one that admits it has none.
//
// Stored per boat. Local for now; `boats.rig_model` is the column it belongs
// in, and the migration for it is written (0090) but deliberately not applied.
// ─────────────────────────────────────────────────────────────────────────────

export type Provenance = 'designer' | 'measured' | 'derived' | 'estimate'
//   designer  off the rig drawing
//   measured  somebody measured it on the boat — an IRC measurer, say
//   derived   worked out from measured numbers, carrying the working's error
//   estimate  a guess, and the sigma says so

export interface RigValue {
  mm: number
  /** 1σ, in mm. An estimate should say so here, not just in `source`. */
  sigmaMm: number
  source: Provenance
}

export interface ScaleRef extends RigValue {
  key: string
  label: string
  /** Fore-and-aft offset of the reference itself from the mast, forward
   *  positive. Spreaders are at the mast, so 0. */
  depthMm: number
}

export interface Baseline extends RigValue {
  key: string
  label: string
}

export interface RigModel {
  boat: string
  updatedAt: string
  scaleRefs: ScaleRef[]
  baselines: Baseline[]
  /** Fore-and-aft offsets from the mast for each target, forward positive. */
  depths: Record<'leech' | 'clew' | 'boom', RigValue>
  /** Camera side: sensor width in mm along the long edge. 36 = full frame. */
  sensorWidthMm: number
  /** How far the jib's clew sits ABOVE ITS TACK, mm — derived from the
   *  certificate. Not a measurement input: it is what lets the tool draw a
   *  "the clew is about this high" guide, which is the one thing that stops
   *  you marking the wrong sail's edge. */
  clewHeightMm?: number
  notes: string
}

const v = (mm: number, sigmaMm: number, source: Provenance = 'estimate'): RigValue => ({ mm, sigmaMm, source })

/**
 * A starting point for a maxi of roughly Northstar's size, with every number
 * marked as the guess it is. Replace each one as the rig designer's drawing
 * arrives; the tool will stop apologising for it in the report as you do.
 */
export function defaultRigModel(boat = ''): RigModel {
  return {
    boat,
    updatedAt: new Date().toISOString(),
    scaleRefs: [
      { key: 'spreader2', label: 'Spreader 2, tip to tip', ...v(6000, 600), depthMm: 0 },
      { key: 'spreader1', label: 'Spreader 1, tip to tip', ...v(7000, 700), depthMm: 0 },
      { key: 'spreader3', label: 'Spreader 3, tip to tip', ...v(5000, 500), depthMm: 0 },
      { key: 'mastwidth', label: 'Mast width, athwartships', ...v(300, 40), depthMm: 0 },
      // The one a tape measure can reach. Everything above it is up the rig and
      // has to come off a drawing or a certificate; the wheels are at waist
      // height on the dock, and they are athwartships, which is the direction
      // an astern camera resolves best. That makes them the first scale
      // reference that can be MEASURED for a rival as well as for us.
      //
      // The catch, and it is the whole reason ScaleRef carries a depth: they
      // are ~10 m abaft the mast, so they image larger than anything in the
      // mast plane. Left uncorrected that biases every measurement on the frame
      // by depth/range — ~4 % at 260 m. `depthMm` must be real for this one.
      { key: 'wheels', label: 'Steering wheels, centre to centre', ...v(0, 0), depthMm: -10000 },
      { key: 'custom', label: 'Something else (type the length)', ...v(0, 0), depthMm: 0 },
    ],
    baselines: [
      { key: 'bow-transom', label: 'Forestay tack → transom centre', ...v(21000, 2000) },
      { key: 'tack-mast', label: 'Forestay tack → mast (J)', ...v(8000, 800) },
      // Also dockside-measurable, and both ends are unambiguous centreplane
      // points that stay visible from astern under way.
      { key: 'mast-transom', label: 'Mast (at deck) → transom centre', ...v(0, 0) },
      { key: 'custom', label: 'Something else (type the separation)', ...v(0, 0) },
    ],
    // Fore-and-aft offsets from the mast, forward positive. These are the
    // numbers to get from a certificate rather than from here: the first cut
    // of this file guessed the clew at +8 m FORWARD, and the six Maxi 72
    // certificates put it about a metre ABAFT the mast — a 100 %-LP jib's clew
    // lands on the mast, which is what "100 %" means. Nine metres of error, and
    // it is the multiplier on ψ, so it mattered. What is left here is a Maxi
    // 72 shape, still flagged as the guesswork it is.
    depths: {
      leech: v(-400, 700),
      clew: v(-1100, 900),
      boom: v(-10000, 1500),
    },
    sensorWidthMm: 36,
    notes: '',
  }
}

/**
 * Numbers somebody has actually measured on a specific boat.
 *
 * The default model above is a generic maxi with every value flagged as a
 * guess, which is right for a boat we know nothing about and wrong for one we
 * have been aboard. These are the measurements, keyed by boat name lowercased,
 * and they are applied on top of the default so a new device starts from the
 * real numbers rather than from the guesswork.
 *
 * Anything in here is `measured`: it came off a tape, not off a drawing. Add to
 * it from the dock — the wheels and the mast-to-transom distance are both a
 * two-minute job with a tape and need no access to the rig.
 */
const MEASURED: Record<string, {
  scaleRefs?: Record<string, Partial<Pick<ScaleRef, 'mm' | 'sigmaMm' | 'depthMm' | 'source'>>>
  baselines?: Record<string, Partial<RigValue>>
}> = {
  'northstar 76': {
    scaleRefs: {
      // Measured on the dock, 2026-09. ±10 mm is a tape across two wheel
      // centres — the wheels themselves are the fuzzy part, not the tape.
      wheels: { mm: 3375, sigmaMm: 10, source: 'measured' },
    },
  },
}

/** Apply the measured numbers for a boat on top of a model. */
export function withMeasured(m: RigModel): RigModel {
  const known = MEASURED[(m.boat || '').trim().toLowerCase()]
  if (!known) return m
  return {
    ...m,
    scaleRefs: m.scaleRefs.map((r) => ({ ...r, ...(known.scaleRefs?.[r.key] || {}) })),
    baselines: m.baselines.map((b) => ({ ...b, ...(known.baselines?.[b.key] || {}) })),
  }
}

/** What still needs a real number, in the order it matters. */
export function missingFrom(m: RigModel): string[] {
  const out: string[] = []
  const anyRealScale = m.scaleRefs.some((s) => s.source !== 'estimate' && s.mm > 0)
  if (!anyRealScale) out.push('a scale reference — without one there are no millimetres, only pixels')
  if (!m.baselines.some((b) => b.source !== 'estimate' && b.mm > 0)) {
    out.push('a centreplane baseline separation — without it ψ cannot be corrected')
  }
  for (const [k, d] of Object.entries(m.depths)) {
    if (d.source === 'estimate') out.push(`the ${k}'s fore-and-aft offset from the mast`)
  }
  return out
}

/** True when every number a measurement leans on is a real one. */
export const isComplete = (m: RigModel): boolean => missingFrom(m).length === 0

/**
 * Relative 1σ on the image scale from a reference: how well the length itself
 * is known. The click noise on the two ends is added separately, by the
 * measurement — this is only the ruler's own uncertainty.
 */
export function scaleRelSigma(ref: ScaleRef | null | undefined): number {
  if (!ref || !(ref.mm > 0)) return 0.02
  return Math.max(0.0005, ref.sigmaMm / ref.mm)
}

// ── storage ─────────────────────────────────────────────────────────────────
// Per boat, in localStorage. Deliberately NOT in `ssa-db`: localStore.js owns
// that schema and is the only file allowed to name a version, and a rig model
// is a handful of numbers that wants to survive independently of it.

const KEY = 'ssa-rig-models-v1'

type Store = Record<string, RigModel>

function readStore(): Store {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(window.localStorage.getItem(KEY) || '{}') as Store } catch { return {} }
}

export function loadRigModel(boat: string): RigModel | null {
  const key = (boat || '').trim().toLowerCase()
  if (!key) return null
  return readStore()[key] ?? null
}

export function saveRigModel(m: RigModel): void {
  const key = (m.boat || '').trim().toLowerCase()
  if (typeof window === 'undefined' || !key) return
  const store = readStore()
  store[key] = { ...m, updatedAt: new Date().toISOString() }
  try { window.localStorage.setItem(KEY, JSON.stringify(store)) } catch { /* private window */ }
}

export function listRigModels(): RigModel[] {
  return Object.values(readStore()).sort((a, b) => a.boat.localeCompare(b.boat))
}

/** Model for a boat, falling back to the marked-as-guesswork default. */
export function rigModelFor(boat: string): RigModel {
  // A stored model wins — somebody has edited it deliberately. Otherwise the
  // default, with anything measured for this boat written over the guesses.
  return loadRigModel(boat) ?? withMeasured(defaultRigModel(boat))
}

// ── serialisation, for handing a model to someone else ──────────────────────

export function exportRigModel(m: RigModel): string {
  return JSON.stringify(m, null, 2)
}

/** Parse, keeping only what is recognisable and filling the rest from default. */
export function importRigModel(text: string): RigModel | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<RigModel>
  if (!Array.isArray(o.scaleRefs) || !o.depths) return null
  const base = defaultRigModel(typeof o.boat === 'string' ? o.boat : '')
  return {
    ...base,
    ...o,
    boat: typeof o.boat === 'string' ? o.boat : base.boat,
    scaleRefs: o.scaleRefs.length ? o.scaleRefs : base.scaleRefs,
    baselines: Array.isArray(o.baselines) && o.baselines.length ? o.baselines : base.baselines,
    depths: { ...base.depths, ...o.depths },
    sensorWidthMm: typeof o.sensorWidthMm === 'number' ? o.sensorWidthMm : base.sensorWidthMm,
    notes: typeof o.notes === 'string' ? o.notes : '',
    updatedAt: new Date().toISOString(),
  }
}
