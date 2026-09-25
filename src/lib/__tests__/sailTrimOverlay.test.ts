import { describe, it, expect } from 'vitest'
import {
  buildAnnotation, footOnAxis, isAnnotation, annotationHeadline, annotationFields,
  drawSailTrimAnnotation, type SailTrimAnnotation,
} from '../sailTrimOverlay'
import type { Measurement } from '../sailTrim'

const measurement = (key: string, label: string, boat: number, world: number): Measurement => ({
  key, label,
  boatFrameMm: boat, boatFrameSigmaMm: 14,
  worldHorizontalMm: world, worldHorizontalSigmaMm: 15,
  naiveMm: boat * 1.03,
  mmPerPxUsed: 6.2, depthScaleApplied: true, rollApplied: true,
})

const axis = { low: { x: 100, y: 900 }, high: { x: 140, y: 100 } }

const build = (defn: 'boat' | 'world' = 'boat'): SailTrimAnnotation => buildAnnotation({
  version: 'sailtrim-test',
  imageSize: { w: 1000, h: 1000 },
  defn,
  axis,
  measurements: [
    measurement('leechSpr2', 'Jib leech @ reference height', 1479, 1610),
    measurement('clew', 'Jib clew', -1103, -1200),
    measurement('boom', 'Boom', 2210, 2404),
  ],
  points: { leechSpr2: { x: 340, y: 400 }, clew: { x: 300, y: 700 }, boom: { x: 460, y: 820 } },
  colours: { leechSpr2: '#4ADE80', clew: '#FB923C', boom: '#F87171' },
  psiDeg: 0.42, psiMeasured: true, heelDeg: 22.7,
  measuredAt: 1_700_000_000_000,
})

// ── a recording 2D context ──────────────────────────────────────────────────
// Enough of the interface for the drawing to run, and it remembers every point
// it was asked to touch, which is the only thing worth asserting: WHERE the
// annotation lands. jsdom has no canvas implementation.
interface Op { op: string; args: number[] }
function fakeCtx(w: number, h: number) {
  const ops: Op[] = []
  const rec = (op: string) => (...args: number[]) => { ops.push({ op, args }) }
  const ctx = {
    canvas: { width: w, height: h },
    ops,
    font: '', textAlign: '', textBaseline: '',
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '',
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    stroke: rec('stroke'), fill: rec('fill'), fillRect: rec('fillRect'),
    setLineDash: () => { /* dash pattern is not asserted */ },
    fillText: (t: string, x: number, y: number) => { ops.push({ op: `fillText:${t}`, args: [x, y] }) },
    strokeText: (t: string, x: number, y: number) => { ops.push({ op: `strokeText:${t}`, args: [x, y] }) },
    measureText: (t: string) => ({ width: t.length * 6 }),
  }
  return ctx as unknown as CanvasRenderingContext2D & { ops: Op[] }
}

const texts = (ctx: { ops: Op[] }) =>
  ctx.ops.filter((o) => o.op.startsWith('fillText:')).map((o) => o.op.slice('fillText:'.length))

describe('footOnAxis', () => {
  it('lands on the axis line, perpendicular to it', () => {
    const p = { x: 500, y: 500 }
    const f = footOnAxis(axis, p)
    // Collinear with the axis: the cross product of (f − low) and (high − low) is zero.
    const cross = (f.x - axis.low.x) * (axis.high.y - axis.low.y)
      - (f.y - axis.low.y) * (axis.high.x - axis.low.x)
    expect(Math.abs(cross)).toBeLessThan(1e-6)
    // And the line from the foot to the point is perpendicular to the axis.
    const dot = (p.x - f.x) * (axis.high.x - axis.low.x) + (p.y - f.y) * (axis.high.y - axis.low.y)
    expect(Math.abs(dot)).toBeLessThan(1e-6)
  })

  it('returns the point itself when it is already on the axis', () => {
    const mid = { x: (axis.low.x + axis.high.x) / 2, y: (axis.low.y + axis.high.y) / 2 }
    const f = footOnAxis(axis, mid)
    expect(f.x).toBeCloseTo(mid.x, 9)
    expect(f.y).toBeCloseTo(mid.y, 9)
  })
})

describe('buildAnnotation', () => {
  it('takes the boat-frame number for defn "boat" and the world one for "world"', () => {
    expect(build('boat').targets.map((t) => t.mm)).toEqual([1479, -1103, 2210])
    expect(build('world').targets.map((t) => t.mm)).toEqual([1610, -1200, 2404])
    expect(build('boat').targets.map((t) => t.sigmaMm)).toEqual([14, 14, 14])
    expect(build('world').targets.map((t) => t.sigmaMm)).toEqual([15, 15, 15])
  })

  it('drops a measurement with no point to draw to', () => {
    const a = buildAnnotation({
      version: 'v', imageSize: { w: 100, h: 100 }, defn: 'boat', axis,
      measurements: [measurement('clew', 'Jib clew', 1103, 1200)],
      points: { clew: null }, colours: {},
      psiDeg: 0, psiMeasured: false, heelDeg: null,
    })
    expect(a.targets).toEqual([])
  })

  it('copies its points, so later edits to the marks cannot reach a saved annotation', () => {
    const live = { x: 340, y: 400 }
    const a = buildAnnotation({
      version: 'v', imageSize: { w: 100, h: 100 }, defn: 'boat', axis,
      measurements: [measurement('clew', 'Jib clew', 1103, 1200)],
      points: { clew: live }, colours: {},
      psiDeg: 0, psiMeasured: false, heelDeg: null,
    })
    const before = { ...a.axis!.low }
    axis.low.x = -999
    expect(a.axis!.low).toEqual(before)
    axis.low.x = 100 // put it back for the other tests
  })
})

describe('isAnnotation', () => {
  it('accepts what buildAnnotation produced, and survives a JSON round trip', () => {
    const a = build()
    expect(isAnnotation(a)).toBe(true)
    expect(isAnnotation(JSON.parse(JSON.stringify(a)))).toBe(true)
  })

  it('rejects the shapes that actually arrive when something has gone wrong', () => {
    expect(isAnnotation(null)).toBe(false)
    expect(isAnnotation('{}')).toBe(false)
    expect(isAnnotation({ targets: [] })).toBe(false)                      // no imageSize
    expect(isAnnotation({ imageSize: { w: 0, h: 0 }, targets: [] })).toBe(false)
    expect(isAnnotation({ imageSize: { w: 10, h: 10 } })).toBe(false)      // no targets
    expect(isAnnotation({
      imageSize: { w: 10, h: 10 },
      targets: [{ point: { x: 1, y: 2 }, foot: { x: 1, y: 2 }, mm: NaN }],
    })).toBe(false)
    expect(isAnnotation({
      imageSize: { w: 10, h: 10 },
      targets: [{ point: { x: 1 }, foot: { x: 1, y: 2 }, mm: 5 }],
    })).toBe(false)
  })

  it('accepts an empty target list — a calibration with nothing marked yet is valid', () => {
    expect(isAnnotation({ imageSize: { w: 10, h: 10 }, targets: [] })).toBe(true)
  })
})

describe('annotationHeadline', () => {
  it('names the targets it has, unsigned while the tack is unknown', () => {
    expect(annotationHeadline(build())).toBe('leech 1479 · clew 1103 · boom 2210 mm')
  })

  it('leaves out what was not marked', () => {
    const a = build()
    a.targets = a.targets.filter((t) => t.key !== 'clew')
    expect(annotationHeadline(a)).toBe('leech 1479 · boom 2210 mm')
  })

  it('says so rather than printing a bare "mm" when nothing was measured', () => {
    const a = build()
    a.targets = []
    expect(annotationHeadline(a)).toBe('no measurements')
  })
})

describe('annotationFields', () => {
  it('flattens to one string per key for filtering', () => {
    // No tack on this fixture, so the sign would only say which way round the
    // photograph is — the values come out unsigned and say so.
    expect(annotationFields(build())).toEqual({
      sailtrim_defn: 'boat',
      sailtrim_psi_deg: '0.42',
      sailtrim_psi_measured: '1',
      sailtrim_leeward_positive: '0',
      sailtrim_leechSpr2_mm: '1479',
      sailtrim_clew_mm: '1103',
      sailtrim_boom_mm: '2210',
    })
  })

  it('keeps the SIGN once a tack is known — a boom above the centreline is negative', () => {
    const a = build()
    a.tack = 'stbd'
    a.leewardPositive = true
    const f = annotationFields(a)
    expect(f.sailtrim_tack).toBe('stbd')
    expect(f.sailtrim_leeward_positive).toBe('1')
    // The clew is stored at −1103 and now reports it, rather than flattening to
    // 1103 as it did when the sign was only a fact about the image.
    expect(f['sailtrim_clew_mm']).toBe('-1103')
    expect(f['sailtrim_leechSpr2_mm']).toBe('1479')
  })

  it('records an assumed psi as such — it is the difference between a measurement and a guess', () => {
    const a = build()
    a.psiMeasured = false
    expect(annotationFields(a).sailtrim_psi_measured).toBe('0')
  })
})

describe('drawSailTrimAnnotation', () => {
  it('draws at the stored pixel coordinates when the canvas is the stored frame', () => {
    const ctx = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(ctx, build())
    const pts = ctx.ops.filter((o) => o.op === 'lineTo' || o.op === 'moveTo')
    // The clew mark at (300,700) is touched as itself.
    expect(pts.some((p) => Math.abs(p.args[0] - 300) < 0.01 && Math.abs(p.args[1] - 700) < 0.01)).toBe(true)
  })

  it('scales to a thumbnail: the same record draws at a fifth of the size on a fifth-size canvas', () => {
    const ctx = fakeCtx(200, 200)
    drawSailTrimAnnotation(ctx, build())
    const pts = ctx.ops.filter((o) => o.op === 'lineTo' || o.op === 'moveTo')
    expect(pts.some((p) => Math.abs(p.args[0] - 60) < 0.01 && Math.abs(p.args[1] - 140) < 0.01)).toBe(true)
  })

  it('labels each measurement with its rounded absolute millimetres', () => {
    const ctx = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(ctx, build())
    const t = texts(ctx)
    expect(t).toContain('1479')
    expect(t).toContain('1103')   // −1103 mm reads as 1103 on the picture
    expect(t).toContain('2210')
  })

  it('says which definition the numbers are, and whether psi was measured', () => {
    const boat = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(boat, build('boat'))
    expect(texts(boat).join(' ')).toContain('athwartships from centreplane')

    const world = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(world, build('world'))
    expect(texts(world).join(' ')).toContain('world-horizontal from centreplane')

    const assumed = build()
    assumed.psiMeasured = false
    const ctx = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(ctx, assumed)
    // Shouted, because an assumed psi is worth 17 mm per degree per metre of depth.
    expect(texts(ctx).join(' ')).toContain('ASSUMED')
  })

  it('draws lines but no text when labels are off', () => {
    const ctx = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(ctx, build(), { labels: false })
    expect(texts(ctx)).toEqual([])
    expect(ctx.ops.some((o) => o.op === 'stroke')).toBe(true)
  })

  it('does nothing at all with a malformed record or a zero-size canvas', () => {
    const bad = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(bad, { imageSize: { w: 0, h: 0 }, targets: [] } as unknown as SailTrimAnnotation)
    expect(bad.ops).toEqual([])

    const empty = fakeCtx(0, 0)
    drawSailTrimAnnotation(empty, build())
    expect(empty.ops).toEqual([])
  })

  it('still draws the axis and the caption when there is nothing marked yet', () => {
    const a = build()
    a.targets = []
    const ctx = fakeCtx(1000, 1000)
    drawSailTrimAnnotation(ctx, a)
    expect(ctx.ops.some((o) => o.op === 'stroke')).toBe(true)
  })
})
