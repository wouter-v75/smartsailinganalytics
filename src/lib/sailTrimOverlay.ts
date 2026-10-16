// src/lib/sailTrimOverlay.ts
// ─────────────────────────────────────────────────────────────────────────────
// The finished sail-geometry annotation: a small, serialisable record of WHAT
// TO DRAW on a photograph, and the code that draws it.
//
// Why a record rather than re-running the geometry: the measurement happens once,
// on the machine where somebody clicked, with that boat's rig model and that
// day's heel loaded. Everyone else — every other device, the Timeline, a coach on
// a phone — only needs the picture with three lines on it. Handing them the marks
// and asking them to re-derive would need the rig model to travel too, and would
// silently give a different answer the day a default changed. So the geometry is
// resolved to pixels and millimetres at measurement time and travels as data.
// Same lesson as photo enrichment: if it is not baked in and shipped, it works
// only for the person who did it.
//
// Points are in the ORIGINAL frame's pixel coordinates, and `imageSize` says
// which frame that is, so the same record draws correctly on the full-resolution
// original, on a 480 px thumbnail and into a PDF.
// ─────────────────────────────────────────────────────────────────────────────

import type { Px, Measurement } from './sailTrim'

export interface AnnotationTarget {
  key: string
  label: string
  /** The marked (or derived) target point, in original-image pixels. */
  point: Px
  /** Its foot on the mast axis — the other end of the line that is measured. */
  foot: Px
  /** The distance the label shows, mm, signed as measured. */
  mm: number
  sigmaMm: number
  /**
   * The fore-and-aft depth `mm` was corrected with, mm, forward positive.
   *
   * `mm` is a CORRECTED athwartships offset — the raw image offset with d·sinψ
   * taken out — so recovering the raw offset means subtracting the same d. This
   * records which d that was, at the moment of measuring. Absent on frames saved
   * before 2026-09-27, where it has to be inferred from the rig model and the
   * rig model has moved since.
   */
  depthMm?: number
  depthSigmaMm?: number
  colour: string
}

/**
 * A sail's shape at one station: the chord, the width it was divided by, and
 * the angle that came out. Carried so the photo can SHOW the shape, not just
 * the positions — twist was computed in the tool and then left behind, which
 * meant it never reached the photo it was measured on.
 */
export interface AnnotationChord {
  sail: 'main' | 'jib'
  tag: string
  /** Fraction of hoist. */
  fraction: number
  /** Leech minus luff, mm. The luff term is zero when it was not marked. */
  chordMm: number
  /** The sail's width there, m, and where the number came from. */
  widthM: number
  widthSource: 'certificate' | 'interpolated'
  /** The chord's angle to the BOAT'S MIDLINE. Kept because it is what was
   *  actually measured and carries no datum error — but it is a SHEETING angle,
   *  not twist, and must not be presented as one. */
  angleDeg: number
  angleSigmaDeg: number
  /**
   * THE STRIPE'S TWIST, in the North / Sail Vision sense: the chord angle
   * referenced to this sail's own FOOT (the clew-to-tack plane), zero at the
   * foot and opening positive with height. See `stripeTwists`.
   *
   * Absent on frames saved before v0.5, where only `angleDeg` existed and the
   * table labelled it "Twist" — which it never was.
   */
  twistFromFootDeg?: number
  twistFromFootSigmaDeg?: number
  /** False when no clew/boom was marked and the lowest stripe stood in as the
   *  datum, in which case every twist here is understated. */
  twistDatumIsFoot?: boolean
  /** The luff's own offset from the centreplane — forestay SAG for a jib —
   *  or null when the luff was not marked and the chord assumed it was zero. */
  luffMm: number | null
  /**
   * How that luff term was arrived at. `fitted` means the luff was not visible
   * at THIS height — most of it is hidden behind the sails from astern — and
   * the sag was fitted from wherever it was visible, pinned to zero at the tack
   * and the masthead. One visible point is worth nearly as much as all of it.
   */
  luffSource?: 'measured' | 'fitted' | 'assumed-zero'
}

/**
 * The sail's DEPTH at one station, solved from SEVERAL frames at once.
 *
 * It sits on EVERY frame that went into it, not just one, because none of them
 * produced it alone: a single view's dot offsets mix how far along the stripe a
 * dot sits with how deep the sail is there, and only the disagreement between
 * views at different ψ separates the two. So each frame carries the answer and
 * names the set it came from.
 */
export interface AnnotationCamber {
  sail: 'main' | 'jib'
  tag: string
  /** Depth as a percentage of chord — the crew's "draft %". */
  camberPct: number
  /** Where it peaks, percent of chord from the luff. Fitted, not trusted: it is
   *  the parameter that goes first when the dots are poorly spread. */
  draftPct: number
  rmsMm: number
  frames: number
  baselineDeg: number
  /** False when no dot got past the deepest part: extrapolated, and reads LOW. */
  reachedPeak: boolean
  /** The frames it was solved from, so the set can be found again. */
  fromFrames: string[]
}

export interface AnnotationTwist {
  sail: 'main' | 'jib'
  from: string
  to: string
  twistDeg: number
  sigmaDeg: number
  /** True when either station's width had to be interpolated. */
  interpolated: boolean
}

/**
 * The scale the frame was measured with — which reference, what length it was
 * given, and the millimetres-per-pixel that came out.
 *
 * Recorded because an annotation's millimetres are meaningless without it and it
 * was not recoverable: three 26 Sep frames of Capricorno were scaled by
 * Northstar's P (31440 mm, not her own 34000), and nothing in the annotation
 * said so — it had to be dug out of the rig snapshot on the save. With this
 * present, a frame states its own scale, and a re-analysis can rescale rather
 * than asking the operator to mark it again.
 */
export interface AnnotationScale {
  /** The reference used: 'P', 'wheels', 'spreader2', … */
  key: string
  /** Its true length as the model gave it, mm, and how well attested. */
  mm: number
  sigmaMm: number
  source: string
  /** How far abaft the mast the reference sits, mm (0 in the mast plane). */
  depthMm: number
  /** Scale referred to the MAST PLANE, mm per pixel — what every target used. */
  mmPerPxAtMast: number
  /** Camera→mast range, mm. Null when no focal length was available, in which
   *  case the depth correction could not be applied at all. */
  rangeMm: number | null
  /** The boat whose rig model supplied all of the above. The one field that
   *  would have caught the Capricorno frames on sight. */
  boat?: string
}

export interface SailTrimAnnotation {
  version: string
  /** The pixel frame `point`/`foot`/`axis` are expressed in. */
  imageSize: { w: number; h: number }
  /** Which of the two definitions the millimetres are. Both were computed; this
   *  says which one is on the picture, because they differ by 1/cos(heel) —
   *  8.6 % at 23° — and a number on a photo with no definition beside it is how
   *  two people come away with different figures from the same frame. */
  defn: 'boat' | 'world'
  axis: { low: Px; high: Px } | null
  targets: AnnotationTarget[]
  psiDeg: number
  psiMeasured: boolean
  /** The heel the geometry actually used, degrees. */
  heelDeg: number | null
  /** The tack, when the log gave one. */
  tack?: 'port' | 'stbd' | null
  /** Chord angle per station, and the twist between them. Present once the
   *  certificate's sail widths are known — they are the denominator. */
  chords?: AnnotationChord[]
  twist?: AnnotationTwist[]
  /** Depth per station, solved from SEVERAL frames. See AnnotationCamber. */
  camber?: AnnotationCamber[]
  /** What turned pixels into millimetres. See AnnotationScale. */
  scale?: AnnotationScale
  /**
   * The two clicks the SCALE was taken from, and the two the ψ baseline was
   * solved across, in the same pixel frame as everything else.
   *
   * Carried so the "sail geometry" view can DRAW the construction rather than
   * describe it: without them a reader is shown millimetres and asked to trust
   * the calibration behind them, and a scale reference whose length was typed
   * wrong is invisible in the numbers it produces. Absent on anything saved
   * before v0.6 — the lines were only ever in the measuring tab's own `marks` —
   * so that view falls back to the mast axis and says what it cannot draw.
   */
  scalePx?: { a: Px; b: Px } | null
  baselinePx?: { a: Px; b: Px } | null
  /**
   * True when `mm` is LEEWARD POSITIVE — so a boom or main leech above the
   * centreline is negative, and the same trim reads the same on either tack.
   * False (or absent) when the tack was unknown and the sign only says which way
   * round the photograph is, in which case it is not shown.
   */
  leewardPositive?: boolean
  measuredAt: number
}

/** Unit vector up the mast, from the two stored axis points. */
function axisUp(axis: { low: Px; high: Px }): Px {
  const dx = axis.high.x - axis.low.x, dy = axis.high.y - axis.low.y
  const l = Math.hypot(dx, dy) || 1
  return { x: dx / l, y: dy / l }
}

/** Where a target's perpendicular meets the mast axis. */
export function footOnAxis(axis: { low: Px; high: Px }, p: Px): Px {
  const up = axisUp(axis)
  const t = (p.x - axis.low.x) * up.x + (p.y - axis.low.y) * up.y
  return { x: axis.low.x + t * up.x, y: axis.low.y + t * up.y }
}

export function buildAnnotation(args: {
  version: string
  imageSize: { w: number; h: number }
  defn: 'boat' | 'world'
  axis: { low: Px; high: Px }
  measurements: Measurement[]
  /** Measurement key → the point on the picture it was measured to. */
  points: Record<string, Px | null | undefined>
  colours: Record<string, string>
  psiDeg: number
  psiMeasured: boolean
  heelDeg: number | null
  tack?: 'port' | 'stbd' | null
  chords?: AnnotationChord[]
  twist?: AnnotationTwist[]
  scale?: AnnotationScale
  /** The scale's two clicks and the ψ baseline's two, for the geometry view. */
  scalePx?: { a: Px; b: Px } | null
  baselinePx?: { a: Px; b: Px } | null
  measuredAt?: number
}): SailTrimAnnotation {
  const targets: AnnotationTarget[] = []
  for (const m of args.measurements) {
    const point = args.points[m.key]
    if (!point) continue
    targets.push({
      key: m.key,
      label: m.label,
      point,
      // The measurement's OWN foot when it has one: the centreplane at this
      // target's depth, which is what the number is from. Falling back to the
      // mast axis draws a line that disagrees with its own label by d·sinψ.
      foot: m.foot ?? footOnAxis(args.axis, point),
      mm: args.defn === 'world' ? m.worldHorizontalMm : m.boatFrameMm,
      sigmaMm: args.defn === 'world' ? m.worldHorizontalSigmaMm : m.boatFrameSigmaMm,
      depthMm: m.depthMm,
      depthSigmaMm: m.depthSigmaMm,
      colour: args.colours[m.key] || '#38BDF8',
    })
  }
  return {
    version: args.version,
    imageSize: { ...args.imageSize },
    defn: args.defn,
    axis: { low: { ...args.axis.low }, high: { ...args.axis.high } },
    targets,
    psiDeg: args.psiDeg,
    psiMeasured: args.psiMeasured,
    heelDeg: args.heelDeg,
    tack: args.tack ?? null,
    scalePx: args.scalePx ?? null,
    baselinePx: args.baselinePx ?? null,
    leewardPositive: args.tack != null,
    chords: args.chords ?? [],
    twist: args.twist ?? [],
    ...(args.scale ? { scale: args.scale } : {}),
    measuredAt: args.measuredAt ?? Date.now(),
  }
}

/**
 * How a target's millimetres should be written.
 *
 * Signed only when the tack was known and the sign therefore means leeward vs
 * windward. Otherwise unsigned: the raw sign says which way round the picture
 * is, which is not a fact about the boat and should not be printed as one.
 */
export function formatMm(a: SailTrimAnnotation, mm: number): string {
  return a.leewardPositive ? String(Math.round(mm)) : String(Math.round(Math.abs(mm)))
}

/** Reject anything that is not a usable annotation — these arrive from JSON. */
export function isAnnotation(a: unknown): a is SailTrimAnnotation {
  if (!a || typeof a !== 'object') return false
  const o = a as Partial<SailTrimAnnotation>
  if (!o.imageSize || !(o.imageSize.w > 0) || !(o.imageSize.h > 0)) return false
  if (!Array.isArray(o.targets)) return false
  return o.targets.every((t) => t && isPx(t.point) && isPx(t.foot) && Number.isFinite(t.mm))
}

const isPx = (p: unknown): p is Px =>
  !!p && Number.isFinite((p as Px).x) && Number.isFinite((p as Px).y)

/**
 * One line of text for a card, a filename or a photo caption.
 *
 * Absolute values: the sign is a direction in the image, which nobody says out
 * loud — "leech 1479" is what the speed team writes down.
 */
export function annotationHeadline(a: SailTrimAnnotation): string {
  if (!a.targets.length) return 'no measurements'
  // Whatever was measured, in the order it was measured. The old version named
  // three fixed keys, so a frame marked for two leech heights and nothing else
  // came back "no measurements" because it had no clew.
  const shortName = (key: string) =>
    key === 'leechSpr2' ? 'leech'            // measured before the heights were tagged
      : key.includes('@') ? key.replace('@', ' ')
        : key
  const parts = a.targets.slice(0, 4).map((t) => `${shortName(t.key)} ${formatMm(a, t.mm)}`)
  return `${parts.join(' · ')} mm`
}

/**
 * Flat, one-value-per-key fields to hang on a photo's metadata beside the JSON.
 *
 * The same trick SailScan uses: the JSON is what the card renders, but a photo
 * list can only filter and sort on flat fields, so the headline numbers get
 * their own keys.
 */
export function annotationFields(a: SailTrimAnnotation): Record<string, string> {
  const out: Record<string, string> = {
    sailtrim_defn: a.defn,
    sailtrim_psi_deg: a.psiDeg.toFixed(2),
    sailtrim_psi_measured: a.psiMeasured ? '1' : '0',
  }
  if (a.tack) out.sailtrim_tack = a.tack
  out.sailtrim_leeward_positive = a.leewardPositive ? '1' : '0'
  // The scale, flat — so "which frames were scaled by the wrong boat's mast?"
  // is a query over the photo list rather than an archaeology exercise.
  if (a.scale) {
    out.sailtrim_scale_key = a.scale.key
    out.sailtrim_scale_mm = String(Math.round(a.scale.mm))
    out.sailtrim_scale_source = a.scale.source
    out.sailtrim_mm_per_px = a.scale.mmPerPxAtMast.toFixed(4)
    if (a.scale.boat) out.sailtrim_scale_boat = a.scale.boat
  }
  for (const t of a.targets) out[`sailtrim_${t.key}_mm`] = formatMm(a, t.mm)
  // Twist and sag as their own flat fields — a photo list can only filter on
  // these, and "show me the frames where the jib twisted more than 8°" is the
  // question the whole thing exists to answer.
  for (const w of a.twist || []) {
    out[`sailtrim_twist_${w.sail}_${w.from}_${w.to}_deg`] = w.twistDeg.toFixed(2)
  }
  for (const c of a.camber || []) {
    out[`sailtrim_draft_${c.sail}_${c.tag}_pct`] = c.camberPct.toFixed(1)
  }
  for (const c of a.chords || []) {
    if (c.luffMm != null) out[`sailtrim_sag_${c.sail}_${c.tag}_mm`] = Math.round(Math.abs(c.luffMm)).toString()
  }
  return out
}

// ── drawing ─────────────────────────────────────────────────────────────────

/**
 * Draw the annotation into a context whose canvas already holds the photograph.
 *
 * Sized off the canvas, not off the stored frame, so it reads the same whether
 * it is going onto the 6000 px original or a 480 px thumbnail —
 * `min(W,H)/1000`, matching photoOverlay.js so the two overlays look like one
 * thing.
 *
 * Everything is stroked twice, dark and wide underneath: a thin bright line is
 * invisible against a sunlit sky and a thin dark one is invisible against a
 * navy mainsail, and both are in every one of these frames.
 */
/**
 * Which of the three things a reader can be shown.
 *
 *   twist        the shape: each stripe's twist against its sail's own foot, and
 *                the SHEETING angle of the boom and the jib clew (their chord's
 *                angle to the boat's centreline). The default, because it is
 *                what gets trimmed.
 *   measurements the positions: each target's distance from the centreplane.
 *   geometry     the construction the other two rest on — mast axis, scale
 *                reference, ψ baseline — with no numbers over the sails.
 */
export type OverlayView = 'twist' | 'measurements' | 'geometry'

/** The target whose line carries a chord's label. The main's foot chord is
 *  marked at the BOOM and the jib's at its clew, so the two differ. */
function targetKeyForChord(c: AnnotationChord): string {
  return c.tag === 'clew' ? (c.sail === 'jib' ? 'clew' : 'boom') : `${c.sail}@${c.tag}`
}

export function drawSailTrimAnnotation(
  ctx: CanvasRenderingContext2D,
  a: SailTrimAnnotation,
  opts: { labels?: boolean; y?: number; view?: OverlayView } = {},
): void {
  if (!isAnnotation(a)) return
  const W = ctx.canvas.width, H = ctx.canvas.height
  if (!(W > 0) || !(H > 0)) return
  // One factor: the stored frame and the target canvas are the same picture, so
  // scaling by width alone keeps points where they belong even if a rounded
  // height makes the aspect differ in the last decimal.
  const k = W / a.imageSize.w
  const u = Math.min(W, H) / 1000
  const P = (p: Px): Px => ({ x: p.x * k, y: p.y * k })
  const labels = opts.labels !== false
  const view: OverlayView = opts.view ?? 'twist'
  const chords = a.chords || []
  const chordFor = (key: string) => chords.find((c) => targetKeyForChord(c) === key) ?? null

  const stroke = (from: Px, to: Px, colour: string, width: number, dash: number[] = []) => {
    ctx.setLineDash(dash.map((d) => d * u))
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(2,10,20,0.72)'
    ctx.lineWidth = (width + 1.6) * u
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke()
    ctx.strokeStyle = colour
    ctx.lineWidth = width * u
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke()
    ctx.setLineDash([])
  }

  // The mast axis, extended past both ends. The measurements are FROM it, so
  // without it the numbers float over the picture with nothing to be from.
  if (a.axis) {
    const lo = P(a.axis.low), hi = P(a.axis.high)
    const dx = hi.x - lo.x, dy = hi.y - lo.y
    const L = Math.hypot(dx, dy) || 1
    const ext = Math.max(W, H)
    stroke(
      { x: lo.x - (dx / L) * ext, y: lo.y - (dy / L) * ext },
      { x: hi.x + (dx / L) * ext, y: hi.y + (dy / L) * ext },
      'rgba(168,85,247,0.55)', 1.1, [9, 7],   // purple: the mast, as in the tool
    )
  }

  // The construction, in the view that is about the construction. These are the
  // two lines every millimetre on the frame depends on and neither was ever
  // drawn: a scale reference whose length was typed wrong, or a baseline marked
  // across the wrong pair of landmarks, is invisible in the numbers it produces.
  if (view === 'geometry') {
    if (a.scalePx) stroke(P(a.scalePx.a), P(a.scalePx.b), '#FACC15', 2.2)        // yellow, as in the tool
    if (a.baselinePx) stroke(P(a.baselinePx.a), P(a.baselinePx.b), '#F472B6', 2.2) // pink
    if (labels) {
      ctx.font = `700 ${Math.max(10, 18 * u)}px system-ui, -apple-system, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      const tag = (at: Px, text: string, colour: string) => {
        ctx.lineWidth = 3.5 * u
        ctx.strokeStyle = 'rgba(2,10,20,0.85)'
        ctx.strokeText(text, at.x, at.y - 6 * u)
        ctx.fillStyle = colour
        ctx.fillText(text, at.x, at.y - 6 * u)
      }
      if (a.scalePx && a.scale) {
        const m = { x: (P(a.scalePx.a).x + P(a.scalePx.b).x) / 2, y: (P(a.scalePx.a).y + P(a.scalePx.b).y) / 2 }
        tag(m, `${a.scale.key} ${(a.scale.mm / 1000).toFixed(2)} m`, '#FACC15')
      }
      if (a.baselinePx) {
        const m = { x: (P(a.baselinePx.a).x + P(a.baselinePx.b).x) / 2, y: (P(a.baselinePx.a).y + P(a.baselinePx.b).y) / 2 }
        tag(m, `ψ ${a.psiDeg.toFixed(2)}°${a.psiMeasured ? '' : ' ASSUMED'}`, '#F472B6')
      }
    }
  }

  for (const t of a.targets) {
    const p = P(t.point), f = P(t.foot)
    // In the geometry view the targets are context, not the subject: the lines
    // show WHERE it was measured without putting numbers over the sails.
    stroke(f, p, t.colour, view === 'geometry' ? 1.2 : 2)
    // A tick across each end, so the line's ends are unambiguous at a glance.
    const dx = p.x - f.x, dy = p.y - f.y
    const L = Math.hypot(dx, dy) || 1
    const n = { x: -dy / L, y: dx / L }
    const tick = 5 * u
    for (const q of [f, p]) {
      stroke({ x: q.x - n.x * tick, y: q.y - n.y * tick }, { x: q.x + n.x * tick, y: q.y + n.y * tick }, t.colour, 2)
    }
    if (!labels || view === 'geometry') continue
    // TWIST view labels the SHAPE: a stripe's twist against its sail's own
    // foot, and for the foot chords themselves — the boom, the jib clew — the
    // sheeting angle, which is that chord's angle to the boat's centreline.
    //
    // Just the figure, no word for which it is (Wouter, 16 Oct). Where the
    // label SITS says it: a figure on a stripe is that stripe's twist, one on
    // the boom or the clew is where the foot is sheeted, and the view is called
    // Twist on the button that turned it on.
    let text: string
    // In the twist view the label sits BESIDE the stripe point rather than over
    // the middle of its line, and which side depends on the sail AND the tack
    // (Wouter, 16 Oct). The collision it avoids is real: on Baraka's 08:21:55 the
    // main's 25 % stripe and the jib's 50 % land 24 px apart in x and 60 in y,
    // so two centred labels sit on top of each other and neither is readable.
    //
    // The rule (Wouter, 16 Oct, explicitly):
    //
    //     STARBOARD tack   main to the RIGHT of its point, jib to the LEFT
    //     PORT tack        main to the LEFT,                jib to the RIGHT
    //
    // which is the main's figure to WINDWARD and the jib's to LEEWARD, since
    // from astern image-right is starboard: right is windward on starboard tack
    // and leeward on port. It has to follow the tack rather than be fixed,
    // because the sails are on the other side of the picture on the other tack
    // and a fixed side puts both labels over the mainsail on one of them.
    //
    // I had this inverted first, inferring the baseline tack from where
    // Baraka's leech points sat relative to her boom. The pixel geometry does
    // not settle it — both arrangements separate the labels — so it was never
    // mine to infer.
    //
    // With no tack known it draws the port arrangement. That is a presentation
    // choice and nothing downstream reads it, unlike the leeward sign on a
    // measurement, which is refused rather than guessed.
    let at = { x: (p.x + f.x) / 2, y: (p.y + f.y) / 2 - 5 * u }
    let align: CanvasTextAlign = 'center'
    let baseline: CanvasTextBaseline = 'bottom'
    if (view === 'twist') {
      const c = chordFor(t.key)
      if (!c) continue
      // The foot chord's twist against itself is zero by definition, so what is
      // worth showing there is the angle to the centreline instead.
      const deg = c.tag === 'clew' ? c.angleDeg : c.twistFromFootDeg
      if (deg == null) {
        // Pre-v0.5: only the angle to the midline was stored, which is a
        // sheeting angle rather than a twist. Shown, marked `~`, so a reader
        // can tell it apart from the real thing without being told which.
        text = `~${c.angleDeg.toFixed(1)}°`
      } else {
        text = `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`
      }
      // +1 when WINDWARD is image-right, which is starboard tack.
      const windward = a.tack === 'stbd' ? 1 : -1
      const side = c.sail === 'jib' ? -windward : windward
      at = { x: p.x + side * 11 * u, y: p.y }
      align = side < 0 ? 'right' : 'left'
      baseline = 'middle'
    } else {
      text = formatMm(a, t.mm)
    }
    ctx.font = `700 ${Math.max(11, 22 * u)}px system-ui, -apple-system, sans-serif`
    ctx.textAlign = align
    ctx.textBaseline = baseline
    ctx.lineWidth = 3.5 * u
    ctx.strokeStyle = 'rgba(2,10,20,0.85)'
    ctx.strokeText(text, at.x, at.y)
    ctx.fillStyle = t.colour
    ctx.fillText(text, at.x, at.y)
  }

  if (!labels) return
  // A caption, because three bare numbers on a photograph do not say what they
  // are measured from, in which frame, or whether the misalignment that moves a
  // clew by 17 mm per degree per metre was measured or assumed.
  const fs = Math.max(10, 15 * u)
  const caption = [
    a.defn === 'world' ? 'world-horizontal from centreplane' : 'athwartships from centreplane',
    a.leewardPositive
      ? `${a.tack === 'stbd' ? 'stbd' : 'port'} tack, leeward positive`
      : 'unsigned - no tack known',
    `psi ${a.psiDeg.toFixed(2)}° ${a.psiMeasured ? 'measured' : 'ASSUMED'}`,
    a.heelDeg != null ? `heel ${a.heelDeg.toFixed(1)}°` : null,
    a.version,
  ].filter(Boolean).join('  ·  ')
  ctx.font = `${fs}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  const pad = 10 * u
  const tw = ctx.measureText(caption).width
  // Top-left, BELOW the band photoOverlay.js puts the sail names in. It shares
  // that file's scale (min(W,H)/1000) and its constants — pad 14, badge height
  // 0.6 × 74, gap 10 — because the two overlays are burned into one canvas and
  // the four corners are already spoken for: sails top-left, boat and venue
  // top-right, mast settings and the gauge grid along the bottom. The strip is
  // reserved whether or not a sail name is drawn, so the caption does not move
  // about depending on what else the photo happens to know.
  const top = opts.y ?? (14 + 44.4 + 10) * u
  ctx.fillStyle = 'rgba(3,15,26,0.8)'
  ctx.fillRect(pad, top, tw + pad * 1.6, fs * 1.9)
  ctx.fillStyle = '#7DD3FC'
  ctx.fillText(caption, pad * 1.8, top + fs * 1.3)
}
