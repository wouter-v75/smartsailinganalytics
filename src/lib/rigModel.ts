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

/**
 * The two kinds of station, which behave differently and must not be conflated.
 *
 * A DRAFT STRIPE belongs to a SAIL. The main's 50 % stripe and the jib's are at
 * half of two different hoists, so they are at two different heights up the
 * mast — metres apart on a rig like Northstar's. Reading both leeches at one
 * "50 %" line therefore measures the jib somewhere that is not its half height,
 * and hands `STATION_FRACTION` a fraction that is only true for one of them.
 * That is a wrong number rather than a missing one, which is why it is worth the
 * extra clicks.
 *
 * A SPREADER belongs to the RIG. It is one place on the mast whatever sail is
 * up, both leeches are legitimately read across it, and "mast → leech at
 * spreader 2" is the speed team's own measurement. So spreaders stay a single
 * shared set: marking them per sail would be the same click twice.
 */
export const STRIPE_TAGS = HEIGHT_TAGS.filter((t) => t.key.startsWith('stripe'))
export const SPREADER_TAGS = HEIGHT_TAGS.filter((t) => t.key.startsWith('spr'))

export const isStripeTag = (k: string): boolean => k.startsWith('stripe')

/**
 * Where a station's mark is kept. Per sail for a stripe, shared for a spreader.
 *
 * One function so the step that COLLECTS the mark and the code that READS it
 * cannot drift apart — they were one shared key each before, and a mismatch here
 * shows up as a leech that silently has no crossings rather than as an error.
 */
export const heightMarkKey = (sail: string, tag: string): string =>
  isStripeTag(tag) ? `h:${sail}:${tag}` : `h:${tag}`

/**
 * Bring a saved set of marks onto the per-sail station keys.
 *
 * Shots saved before the split carry one `h:stripe50` for both sails. The jib
 * keeps them, because the shared stations were in practice marked against the
 * jib's leech — it is the lower, nearer edge and the one the speed team reads.
 * Assigning them to the main instead would silently move every stored stripe
 * measurement to a different height.
 */
export function migrateHeightMarks<T>(marks: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(marks)) {
    const m = /^h:(stripe\d+)$/.exec(k)
    out[m ? `h:jib:${m[1]}` : k] = v
  }
  return out
}

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
      { key: 'mast-transom', label: 'Mast (at deck) → transom centre (stern)', ...v(13000, 2200) },
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
  widths?: { main?: SailWidths; jib?: SailWidths }
}> = {
  'northstar 76': {
    scaleRefs: {
      // Measured on the dock, 2026-09. ±10 mm is a tape across two wheel
      // centres — the wheels themselves are the fuzzy part, not the tape.
      wheels: { mm: 3375, sigmaMm: 10, source: 'measured' },
    },
    baselines: {
      // Mast at deck → transom centre, tape, 2026-09. ±50 mm is not the tape
      // over 12 m: it is the two ENDS. "The mast at deck" is a 300 mm section
      // and "transom centre" is a curve, so where you hook and where you read
      // are each worth tens of millimetres. Tighten it here if the endpoints
      // were pinned down more carefully than that.
      'mast-transom': { mm: 12100, sigmaMm: 50, source: 'measured' },
      // J off Northstar III's endorsed certificate (50945, GBR76X) — the same
      // ±200 mm the certificate reader applies, so a pasted cert and this agree
      // rather than one quietly overriding the other.
      //
      // With these two, deriveBaselines fills tack-to-transom at 20 960 ± 206 —
      // the longest baseline on the boat, and the one ψ is most precise across.
      'tack-mast': { mm: 8860, sigmaMm: 200, source: 'measured' },
    },
    // Off Northstar III's own endorsed certificate (50945, GBR76X), tabulated
    // in §8.2 of the doc. Here rather than behind a paste because they are
    // measured, endorsed and not going to change — and because twist divides by
    // them, so a tool that has them is a tool that works out of the box.
    widths: {
      main: { foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: 3.63 },  // E, MHW, MTW, MUW
      jib: { foot: 8.96, half: 4.90, threeQuarter: 2.66, upper: 1.48 },    // HLP, HHW, HTW, HUW
    },
  },
}
// The certificate names the boat NORTHSTAR III; the app calls it Northstar 76.
MEASURED['northstar iii'] = MEASURED['northstar 76']

/**
 * Fill in whichever baseline the other two already determine.
 *
 * The three are one sum: (forestay tack → transom) = J + (mast → stern). Know any
 * two and the third is arithmetic, to a few tens of millimetres — yet the model
 * shipped with all three as separate fields and a comment suggesting a human do
 * the subtraction, so a boat could carry a 21 000 ± 2000 mm guess next to two
 * numbers that pin it to ±206.
 *
 * It is worth doing in every direction, not just for mast-to-stern, because ψ's
 * precision scales with the SEPARATION of the two landmarks: tack-to-transom is
 * the longest of the three and so the best baseline on the boat. Deriving it is
 * how a tape measure at deck level buys a 21 m baseline up the rig.
 *
 * Only ever fills an ESTIMATE, and only from inputs that are better than one. An
 * operator who typed a tape reading has better information than this arithmetic
 * and must not have it silently replaced. Errors add in quadrature and the result
 * is marked `derived`, so the report keeps saying it is working rather than
 * measurement.
 */
export function deriveBaselines(m: RigModel): RigModel {
  // whole = part + part. Named so the arithmetic below cannot be read backwards.
  const WHOLE = 'bow-transom', PARTS = ['tack-mast', 'mast-transom'] as const
  const get = (k: string) => m.baselines.find((b) => b.key === k)
  const real = (b: Baseline | undefined) => !!b && b.source !== 'estimate' && b.mm > 0

  const whole = get(WHOLE), j = get(PARTS[0]), mt = get(PARTS[1])
  if (!whole || !j || !mt) return m

  let fill: { key: string; mm: number; sigmaMm: number } | null = null
  if (!real(whole) && real(j) && real(mt)) {
    fill = { key: WHOLE, mm: j.mm + mt.mm, sigmaMm: Math.hypot(j.sigmaMm, mt.sigmaMm) }
  } else if (!real(mt) && real(whole) && real(j) && whole.mm > j.mm) {
    fill = { key: PARTS[1], mm: whole.mm - j.mm, sigmaMm: Math.hypot(whole.sigmaMm, j.sigmaMm) }
  } else if (!real(j) && real(whole) && real(mt) && whole.mm > mt.mm) {
    fill = { key: PARTS[0], mm: whole.mm - mt.mm, sigmaMm: Math.hypot(whole.sigmaMm, mt.sigmaMm) }
  }
  if (!fill || !(fill.mm > 0)) return m

  const done = fill
  return {
    ...m,
    baselines: m.baselines.map((b) => (b.key === done.key
      ? { ...b, mm: Math.round(done.mm), sigmaMm: Math.round(done.sigmaMm), source: 'derived' as Provenance }
      : b)),
  }
}

/** Apply the measured numbers for a boat on top of a model. */
export function withMeasured(m: RigModel): RigModel {
  const known = MEASURED[(m.boat || '').trim().toLowerCase()]
  // deriveBaselines even with nothing measured for this boat: the inputs can
  // also arrive from a certificate paste or from the operator typing them, and
  // this is the one place every load path passes through.
  if (!known) return deriveBaselines(m)
  return deriveBaselines({
    ...m,
    scaleRefs: m.scaleRefs.map((r) => ({ ...r, ...(known.scaleRefs?.[r.key] || {}) })),
    baselines: m.baselines.map((b) => ({ ...b, ...(known.baselines?.[b.key] || {}) })),
    widths: { ...(known.widths || {}), ...(m.widths || {}) },
  })
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
  // `withMeasured`, not the bare default: a model stored before a boat's real
  // numbers were known should pick them up, which is the whole point of
  // migrating rather than returning it verbatim.
  const base = withMeasured(defaultRigModel(boat))
  // deriveBaselines AFTER the merge: a stored model may supply the two inputs
  // that pin mast-to-stern down, and merging happens after withMeasured ran.
  return deriveBaselines({
    ...base,
    ...stored,
    depths: { ...base.depths, ...stored.depths },
    widths: { ...(base.widths || {}), ...(stored.widths || {}) },
    scaleRefs: stored.scaleRefs?.length ? stored.scaleRefs : base.scaleRefs,
    baselines: stored.baselines?.length ? stored.baselines : base.baselines,
  })
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

// ── the cloud copy ──────────────────────────────────────────────────────────
// `boats.rig_model`, reached through /api/boats/rig-model. localStorage above is
// the CACHE and the fallback, not the record: a dimension somebody measured on
// the dock has to reach the rest of the team, and a per-browser store cannot do
// that. Same lesson as a photo's instrument data, which is only in the cloud if
// it was put there at import (CLAUDE.md).
//
// Writes are coach-only, per `boats_update`. The route says so in `canEdit`
// rather than letting a viewer discover it from a save that appeared to work.

export interface CloudRigModel {
  rigModel: RigModel | null
  canEdit: boolean
  /** Null when the boat is not found, or not reachable by this caller. */
  boatId: string | null
  /** The boat's name AS STORED. The caller may only have had an id. */
  boat: string | null
}

/**
 * The boat's model from the cloud, brought forward onto the current shape.
 *
 * Returns null on ANY failure — offline, unauthenticated, no such boat — because
 * every caller's fallback is the same: use the local one. Distinguishing the
 * reasons here would only move the decision somewhere that cannot act on it.
 */
export async function fetchRigModel(boat: string, boatId?: string | null): Promise<CloudRigModel | null> {
  if ((!boat.trim() && !boatId) || typeof fetch === 'undefined') return null
  const q = boatId ? `boat_id=${encodeURIComponent(boatId)}` : `boat=${encodeURIComponent(boat)}`
  try {
    const r = await fetch(`/api/boats/rig-model?${q}`)
    if (!r.ok) return null
    const j = await r.json() as { boat?: string | null; rigModel: RigModel | null; canEdit?: boolean; boatId?: string | null }
    const name = j.boat || boat
    return {
      rigModel: j.rigModel ? migrateRigModel(j.rigModel, j.rigModel.boat || name) : null,
      canEdit: j.canEdit === true,
      boatId: j.boatId ?? null,
      boat: j.boat ?? null,
    }
  } catch { return null }
}

/** Store it for the whole team. Resolves to null on success, or a reason. */
export async function putRigModel(boat: string, m: RigModel, boatId?: string | null): Promise<string | null> {
  if ((!boat.trim() && !boatId) || typeof fetch === 'undefined') return 'no boat'
  try {
    const r = await fetch('/api/boats/rig-model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boat, boat_id: boatId || undefined, model: { ...m, updatedAt: new Date().toISOString() } }),
    })
    if (r.ok) return null
    const j = await r.json().catch(() => ({})) as { error?: string }
    return j.error || `HTTP ${r.status}`
  } catch (e) { return e instanceof Error ? e.message : 'network' }
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
