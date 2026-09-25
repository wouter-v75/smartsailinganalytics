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

import type { SailWidths } from './sailTwist'

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
  /**
   * Which way the reference LIES, which decides whether ψ foreshortens it.
   *
   * A vertical length — P between the black bands, anything up the mast — is
   * unaffected: rotating the camera about a vertical axis does not shorten a
   * vertical line. An athwartships one images at cos ψ of its true extent, so a
   * scale derived from it is too big by sec ψ and drags ψ itself with it. That
   * is 3.5 % at 15° and 6.4 % at 20°, and it is correctable exactly once the
   * tool knows which kind it is holding — see `unbiasAthwartshipsScale`.
   */
  orientation?: 'athwartships' | 'vertical'
}

export interface Baseline extends RigValue {
  key: string
  label: string
}

// ── the heights a leech is measured AT ──────────────────────────────────────
// A leech is a curve; "the leech" is not a number until you say at what height.
// The speed team says it two ways — by draft stripe and by spreader — so both
// are here, and a measurement carries which one it is. Without the tag a
// measurement cannot be compared with the same measurement from another day,
// which is the only thing anybody wants to do with it.

export const HEIGHT_TAGS = [
  { key: 'stripe25', label: '25 % stripe', short: '25 %' },
  { key: 'stripe50', label: '50 % stripe', short: '50 %' },
  { key: 'stripe75', label: '75 % stripe', short: '75 %' },
  { key: 'spr1', label: 'Spreader 1', short: 'spr 1' },
  { key: 'spr2', label: 'Spreader 2', short: 'spr 2' },
  { key: 'spr3', label: 'Spreader 3', short: 'spr 3' },
] as const

export type HeightTag = (typeof HEIGHT_TAGS)[number]['key']

export const heightShort = (k: string): string =>
  HEIGHT_TAGS.find((t) => t.key === k)?.short ?? k

/** The two sails a leech can belong to. */
export const LEECH_SAILS = [
  { key: 'main', label: 'Main leech', colour: '#38BDF8' },
  { key: 'jib', label: 'Jib leech', colour: '#4ADE80' },
] as const
export type LeechSail = (typeof LEECH_SAILS)[number]['key']

/** …and the luff at the other end of the same chord. */
export const LUFF_SAILS = [
  { key: 'main', label: 'Main luff (the mast)', colour: '#60A5FA' },
  { key: 'jib', label: 'Jib luff (the forestay)', colour: '#86EFAC' },
] as const

/**
 * How far FORWARD of the mast a sail's luff sits at a fraction of its hoist.
 *
 * This is why a luff cannot simply be measured like a leech and subtracted: it
 * is at a different DEPTH, so it images at a different scale and ψ displaces it
 * by a different amount. The jib's is the worst case — the forestay runs from a
 * tack J forward of the mast to a masthead directly above it, so at a quarter
 * hoist it is still three-quarters of J forward. On Northstar that is 6.6 m.
 *
 * The main's luff is the mast, which is what the tool's own axis follows, so it
 * is at depth zero by construction. Mast rake tilts it aft with height — about
 * 2°, half a metre at mid-hoist — which is small enough to leave for now and
 * large enough to write down.
 */
export function luffDepthMm(
  sail: 'main' | 'jib',
  fraction: number | null,
  m: RigModel,
): { mm: number; sigmaMm: number } {
  if (sail === 'main') return { mm: 0, sigmaMm: 400 }
  const j = m.baselines.find((b) => b.key === 'tack-mast')
  const jMm = j && j.mm > 0 ? j.mm : 8_600
  // No fraction (a spreader height) ⇒ take mid-luff and own the spread.
  const f = fraction == null ? 0.5 : fraction
  return {
    mm: jMm * (1 - f),
    sigmaMm: fraction == null ? jMm * 0.3 : Math.max(200, (j?.sigmaMm ?? 200)),
  }
}

export interface RigModel {
  boat: string
  updatedAt: string
  scaleRefs: ScaleRef[]
  baselines: Baseline[]
  /** Fore-and-aft offsets from the mast for each target, forward positive.
   *  `leech` is the JIB's; the main's leech is a very different distance aft. */
  depths: Record<'leech' | 'mainLeech' | 'clew' | 'boom', RigValue>
  // NOT here yet, deliberately: a remembered height per tag, so a later frame
  // could draw "spreader 2 is about here" the way it already draws the boom and
  // the clew. It needs a datum that survives between frames, and the only stable
  // one is the mainsail tack — P's lower black band — which is identified only
  // when P is the scale reference. `ScaleRef.depthMm` sat in this file unread
  // for weeks and quietly biased the wheels; one dead field is enough.
  /** Camera side: sensor width in mm along the long edge. 36 = full frame. */
  sensorWidthMm: number
  /**
   * Luff-to-leech widths per sail, metres — the denominator that turns a leech
   * position into a chord ANGLE, and so into twist. Off the certificate:
   * MHW/MTW/MUW and HHW/HTW/HUW, with E and HLP as the foot.
   *
   * The headsail's are for the ONE rated sail. Flying anything else and these
   * are the wrong denominators; §8.3 of the doc is about closing that.
   */
  widths?: { main?: SailWidths; jib?: SailWidths }
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
      { key: 'spreader2', label: 'Spreader 2, tip to tip', ...v(6000, 600), depthMm: 0, orientation: 'athwartships' },
      { key: 'spreader1', label: 'Spreader 1, tip to tip', ...v(7000, 700), depthMm: 0, orientation: 'athwartships' },
      { key: 'spreader3', label: 'Spreader 3, tip to tip', ...v(5000, 500), depthMm: 0, orientation: 'athwartships' },
      { key: 'mastwidth', label: 'Mast width, athwartships', ...v(300, 40), depthMm: 0, orientation: 'athwartships' },
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
      { key: 'wheels', label: 'Steering wheels, centre to centre', ...v(0, 0), depthMm: -10000, orientation: 'athwartships' },
      { key: 'custom', label: 'Something else (type the length)', ...v(0, 0), depthMm: 0 },
    ],
    baselines: [
      { key: 'bow-transom', label: 'Forestay tack → transom centre', ...v(21000, 2000) },
      { key: 'tack-mast', label: 'Forestay tack → mast (J)', ...v(8000, 800) },
      // Also dockside-measurable, and both ends are unambiguous centreplane
      // points that stay visible from astern under way.
      // (tack → transom) − J. A baseline with NO length is worse than no
      // baseline: solvePsi needs a separation, so selecting one silently drops
      // back to ψ = 0 ± 1° — and a degree of ψ is ±180 mm on a boom at E.
      { key: 'mast-transom', label: 'Mast (at deck) → transom centre', ...v(13000, 2200) },
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
      // The main's leech is out near the end of the boom, not a few hundred
      // millimetres abaft the mast like the jib's. E is 10.33 m on Northstar and
      // the leech sweeps forward as it rises, so this is a mid-hoist average
      // with a sigma that admits the spread.
      mainLeech: v(-6000, 2500),
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
  const depthLabel: Record<string, string> = {
    leech: "the jib leech's", mainLeech: "the main leech's", clew: "the clew's", boom: "the boom's",
  }
  for (const [k, d] of Object.entries(m.depths)) {
    if (d.source === 'estimate') out.push(`${depthLabel[k] || `the ${k}'s`} fore-and-aft offset from the mast`)
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

/**
 * A stored model, brought forward onto the CURRENT shape.
 *
 * Without this, a model saved before a field existed never gains it: the store
 * is returned verbatim and the new key is simply absent for ever. That is how
 * `widths` — the sail girths that twist is divided by — stayed missing on a
 * browser that had read a certificate weeks earlier, and why the twist panel
 * showed nothing at all with no explanation.
 *
 * Stored values win wherever they exist, because they are the operator's own
 * edits; the default only fills gaps.
 */
export function migrateRigModel(stored: RigModel, boat = stored.boat): RigModel {
  const base = defaultRigModel(boat)
  return {
    ...base,
    ...stored,
    depths: { ...base.depths, ...stored.depths },
    widths: { ...(base.widths || {}), ...(stored.widths || {}) },
    scaleRefs: stored.scaleRefs?.length ? stored.scaleRefs : base.scaleRefs,
    baselines: stored.baselines?.length ? stored.baselines : base.baselines,
  }
}

export function loadRigModel(boat: string): RigModel | null {
  const key = (boat || '').trim().toLowerCase()
  if (!key) return null
  const stored = readStore()[key]
  return stored ? migrateRigModel(stored, stored.boat || boat) : null
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
  // A stored model wins — somebody has edited it deliberately — but brought
  // forward onto the current shape first, so fields added since it was saved
  // are present rather than silently missing. Otherwise the default, with
  // anything measured for this boat written over the guesses.
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
  const boat = typeof o.boat === 'string' ? o.boat : ''
  const merged = migrateRigModel(o as RigModel, boat)
  return {
    ...merged,
    sensorWidthMm: typeof o.sensorWidthMm === 'number' ? o.sensorWidthMm : merged.sensorWidthMm,
    notes: typeof o.notes === 'string' ? o.notes : '',
    updatedAt: new Date().toISOString(),
  }
}
