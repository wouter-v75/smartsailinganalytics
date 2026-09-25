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
  colour: string
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
      foot: footOnAxis(args.axis, point),
      mm: args.defn === 'world' ? m.worldHorizontalMm : m.boatFrameMm,
      sigmaMm: args.defn === 'world' ? m.worldHorizontalSigmaMm : m.boatFrameSigmaMm,
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
    measuredAt: args.measuredAt ?? Date.now(),
  }
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
  const bit = (key: string, name: string) => {
    const t = a.targets.find((x) => x.key === key)
    return t ? `${name} ${Math.round(Math.abs(t.mm))}` : null
  }
  const parts = [bit('leechSpr2', 'leech'), bit('clew', 'clew'), bit('boom', 'boom')].filter(Boolean)
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
  for (const t of a.targets) out[`sailtrim_${t.key}_mm`] = Math.abs(t.mm).toFixed(0)
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
export function drawSailTrimAnnotation(
  ctx: CanvasRenderingContext2D,
  a: SailTrimAnnotation,
  opts: { labels?: boolean; y?: number } = {},
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
      'rgba(56,189,248,0.55)', 1.1, [9, 7],
    )
  }

  for (const t of a.targets) {
    const p = P(t.point), f = P(t.foot)
    stroke(f, p, t.colour, 2)
    // A tick across each end, so the line's ends are unambiguous at a glance.
    const dx = p.x - f.x, dy = p.y - f.y
    const L = Math.hypot(dx, dy) || 1
    const n = { x: -dy / L, y: dx / L }
    const tick = 5 * u
    for (const q of [f, p]) {
      stroke({ x: q.x - n.x * tick, y: q.y - n.y * tick }, { x: q.x + n.x * tick, y: q.y + n.y * tick }, t.colour, 2)
    }
    if (!labels) continue
    const text = `${Math.round(Math.abs(t.mm))}`
    ctx.font = `700 ${Math.max(11, 22 * u)}px system-ui, -apple-system, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    const mid = { x: (p.x + f.x) / 2, y: (p.y + f.y) / 2 - 5 * u }
    ctx.lineWidth = 3.5 * u
    ctx.strokeStyle = 'rgba(2,10,20,0.85)'
    ctx.strokeText(text, mid.x, mid.y)
    ctx.fillStyle = t.colour
    ctx.fillText(text, mid.x, mid.y)
  }

  if (!labels) return
  // A caption, because three bare numbers on a photograph do not say what they
  // are measured from, in which frame, or whether the misalignment that moves a
  // clew by 17 mm per degree per metre was measured or assumed.
  const fs = Math.max(10, 15 * u)
  const caption = [
    a.defn === 'world' ? 'world-horizontal from mast axis' : 'athwartships from mast axis',
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
