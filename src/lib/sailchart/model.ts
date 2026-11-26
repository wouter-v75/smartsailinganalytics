// src/lib/sailchart/model.ts
// ─────────────────────────────────────────────────────────────────────────────
// A boat's SAIL CHART (crossover chart): which sail to carry at each TWA × TWS.
//
// One document per boat, stored whole in `boat_sailcharts.chart` (0106). Every
// sail on it is a closed smooth shape drawn through its control points, in the
// TWA (x, degrees) × TWS (y, knots) plane — the same layout Expedition, the
// Sailing Performance crossover tool and PredictWind use. North's charts put the
// axes the other way round, which crews regularly ask to invert; this does not.
//
// Import/export is Expedition's `<crossoverchart>` XML, so a chart can go from
// SSA back into the nav computer and round-trip without losing a field we read:
//
//   <element name="J3" group="Headsails" type="NotSet">
//     <colour R="0" G="255" B="0" />
//     <alias val="J3-A;J3-B" />
//     <bezierpoints><point tws="19.4" twa="53.4" /> … </bezierpoints>
//     <shapeopacity val="40" /> <linepattern val="Solid" /> <linewidth val="2" />
//     <labelposition tws="18.2" twa="68.6" />
//   </element>
//
// Despite the tag name the points are points ON the outline, not Bézier handles:
// drawn as handles the published charts come out visibly smaller than their
// labels. So they are drawn as a closed Catmull-Rom curve THROUGH the points
// (geometry.ts), which is also what makes "drag this point" mean what it shows.
//
// The parser is regex-based on purpose: it runs in the browser, in vitest and in
// a route alike, with no DOMParser to depend on. The format is flat enough.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartPoint { twa: number; tws: number }

export interface ChartSail {
  /** Stable local id — names are not unique enough to key edits on. */
  id: string
  name: string
  /** Headsails / Spinnakers / Staysails / Furlers … as the chart groups them. */
  group: string
  /** '#rrggbb' */
  colour: string
  /** Sail names the nav computer reports for this chart shape (J3-A, J3-B …). */
  alias: string[]
  points: ChartPoint[]
  /** 0-100, the fill opacity. */
  opacity: number
  dashed: boolean
  lineWidth: number
  label: ChartPoint | null
  visible: boolean
  /** Inventory sails this shape stands for. Empty = not linked (yet). */
  sailIds: string[]
  /** Fields from the source file we do not edit, carried for the round trip. */
  extra?: { createdBy?: string; dateCreated?: string; type?: string; straight?: boolean }
}

export interface SailChart {
  version: 1
  fileName: string | null
  importedAt: string | null
  sails: ChartSail[]
}

export const EMPTY_CHART: SailChart = { version: 1, fileName: null, importedAt: null, sails: [] }

let seq = 0
export const newSailId = () =>
  `cs_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`

const num = (s: string | undefined | null): number => (s == null || s === '' ? NaN : Number(s))
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
export const rgbToHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return [128, 128, 128]
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)
  return m ? decodeXml(m[1]) : null
}
const child = (body: string, name: string): string | null => {
  const m = new RegExp(`<${name}\\b[^>]*?/?>`, 'i').exec(body)
  return m ? m[0] : null
}
const childVal = (body: string, name: string): string | null => {
  const t = child(body, name)
  return t ? attr(t, 'val') : null
}
const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const encodeXml = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const validPoint = (p: ChartPoint) =>
  Number.isFinite(p.twa) && Number.isFinite(p.tws) && p.twa >= 0 && p.twa <= 180 && p.tws >= 0 && p.tws <= 80

/** Expedition `<crossoverchart>` XML → a SailChart. Throws when it is not one. */
export function parseCrossoverXml(text: string, fileName: string | null = null): SailChart {
  const src = (text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) || ''
  if (!/<crossoverchart\b/i.test(src)) throw new Error('Not a crossover chart: no <crossoverchart> element')
  const sails: ChartSail[] = []
  const re = /<element\b([^>]*)>([\s\S]*?)<\/element>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const head = m[1], body = m[2]
    const name = (attr(head, 'name') || '').trim()
    if (!name) continue
    const pts: ChartPoint[] = []
    const block = /<bezierpoints\b[^>]*>([\s\S]*?)<\/bezierpoints>/i.exec(body)?.[1] || ''
    const pre = /<point\b[^>]*?\/?>/gi
    let p: RegExpExecArray | null
    while ((p = pre.exec(block))) {
      const pt = { tws: num(attr(p[0], 'tws')), twa: num(attr(p[0], 'twa')) }
      if (validPoint(pt)) pts.push(pt)
    }
    if (pts.length < 3) continue // a shape needs an inside
    const col = child(body, 'colour')
    const colour = col ? rgbToHex(num(attr(col, 'R')) || 0, num(attr(col, 'G')) || 0, num(attr(col, 'B')) || 0) : '#888888'
    const lab = child(body, 'labelposition')
    const label = lab ? { tws: num(attr(lab, 'tws')), twa: num(attr(lab, 'twa')) } : null
    const opacity = num(childVal(body, 'shapeopacity'))
    const lw = num(childVal(body, 'linewidth'))
    sails.push({
      id: newSailId(),
      name,
      group: (attr(head, 'group') || 'Other').trim() || 'Other',
      colour,
      alias: (childVal(body, 'alias') || '').split(';').map(s => s.trim()).filter(Boolean),
      points: pts,
      opacity: Number.isFinite(opacity) ? clamp(opacity, 0, 100) : 40,
      dashed: /dash|dot/i.test(childVal(body, 'linepattern') || ''),
      lineWidth: Number.isFinite(lw) && lw > 0 ? lw : 2,
      label: label && validPoint(label) ? label : null,
      visible: !/^false$/i.test(childVal(body, 'visible') || 'True'),
      sailIds: [],
      extra: {
        createdBy: childVal(body, 'createdby') || undefined,
        dateCreated: childVal(body, 'datecreated') || undefined,
        type: attr(head, 'type') || undefined,
        straight: /^true$/i.test(childVal(body, 'straightline') || ''),
      },
    })
  }
  if (!sails.length) throw new Error('The crossover chart has no sail shapes with 3+ points')
  return { version: 1, fileName, importedAt: new Date().toISOString(), sails }
}

const r1 = (v: number) => String(Math.round(v * 10) / 10)

/** A SailChart → Expedition `<crossoverchart>` XML, for the nav computer. */
export function toCrossoverXml(chart: SailChart): string {
  const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<crossoverchart>', '  <elements>']
  for (const s of chart.sails) {
    const [R, G, B] = hexToRgb(s.colour)
    out.push(
      `    <element name="${encodeXml(s.name)}" group="${encodeXml(s.group)}" type="${encodeXml(s.extra?.type || 'NotSet')}">`,
      `      <createdby val="${encodeXml(s.extra?.createdBy || 'SSA')}" />`,
      `      <datecreated val="${encodeXml(s.extra?.dateCreated || new Date().toISOString().slice(0, 10))}" />`,
      `      <visible val="${s.visible ? 'True' : 'False'}" />`,
      `      <colour R="${R}" G="${G}" B="${B}" />`,
      `      <straightline val="${s.extra?.straight ? 'True' : 'False'}" />`,
      `      <alias val="${encodeXml(s.alias.join(';'))}" />`,
      '      <bezierpoints>',
      ...s.points.map(p => `        <point tws="${r1(p.tws)}" twa="${r1(p.twa)}" />`),
      '      </bezierpoints>',
      '      <shapepattern val="Solid" />',
      `      <shapeopacity val="${Math.round(s.opacity)}" />`,
      `      <linepattern val="${s.dashed ? 'Dash' : 'Solid'}" />`,
      `      <linewidth val="${s.lineWidth}" />`,
    )
    const lab = s.label || centroid(s.points)
    out.push(`      <labelposition tws="${r1(lab.tws)}" twa="${r1(lab.twa)}" />`)
    out.push('      <labelfont size="14" bold="True" italic="False" underline="False" r="0" g="0" b="0" />')
    out.push('    </element>')
  }
  out.push('  </elements>', '</crossoverchart>', '')
  return out.join('\n')
}

export function centroid(points: ChartPoint[]): ChartPoint {
  if (!points.length) return { twa: 90, tws: 10 }
  return {
    twa: points.reduce((a, p) => a + p.twa, 0) / points.length,
    tws: points.reduce((a, p) => a + p.tws, 0) / points.length,
  }
}

/** Whatever came back from the table → a SailChart, dropping what cannot be drawn. */
export function normaliseSailChart(raw: any): SailChart {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sails)) return { ...EMPTY_CHART, sails: [] }
  const sails: ChartSail[] = []
  for (const s of raw.sails) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) continue
    const points = (Array.isArray(s.points) ? s.points : [])
      .map((p: any) => ({ twa: Number(p?.twa), tws: Number(p?.tws) }))
      .filter(validPoint)
    if (points.length < 3) continue
    const label = s.label && validPoint({ twa: Number(s.label.twa), tws: Number(s.label.tws) })
      ? { twa: Number(s.label.twa), tws: Number(s.label.tws) } : null
    sails.push({
      id: typeof s.id === 'string' && s.id ? s.id : newSailId(),
      name: s.name.trim(),
      group: typeof s.group === 'string' && s.group.trim() ? s.group.trim() : 'Other',
      colour: /^#[0-9a-f]{6}$/i.test(s.colour) ? s.colour : '#888888',
      alias: Array.isArray(s.alias) ? s.alias.map(String).map((x: string) => x.trim()).filter(Boolean) : [],
      points,
      opacity: Number.isFinite(Number(s.opacity)) ? clamp(Number(s.opacity), 0, 100) : 40,
      dashed: !!s.dashed,
      lineWidth: Number(s.lineWidth) > 0 ? Number(s.lineWidth) : 2,
      label,
      visible: s.visible !== false,
      sailIds: Array.isArray(s.sailIds) ? Array.from(new Set(s.sailIds.filter((x: any) => typeof x === 'string' && x))) : [],
      extra: s.extra && typeof s.extra === 'object' ? s.extra : undefined,
    })
  }
  return {
    version: 1,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : null,
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : null,
    sails,
  }
}

/** Default palette for sails added in the app, cycled by count. */
export const NEW_SAIL_COLOURS = ['#2563eb', '#16a34a', '#dc2626', '#eab308', '#f97316', '#d946ef', '#06b6d4', '#64748b']

/**
 * A starting shape for a sail added by hand: an 8-point ellipse where that KIND
 * of sail usually lives, so the first drag is a refinement, not a hunt across
 * the chart. Upwind headsails near the target angle, downwind sails deep,
 * reachers and staysails in between.
 */
export function defaultShape(kind: string | null | undefined, group: string, centre?: ChartPoint): ChartPoint[] {
  const k = `${kind || ''} ${group}`.toLowerCase()
  const c = centre || (
    /spinnaker|gennaker|asym|kite/.test(k) ? { twa: 140, tws: 14 }
      : /code|reach|furler|stay/.test(k) ? { twa: 105, tws: 12 }
        : { twa: 50, tws: 12 })
  const rx = 14, ry = 4
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI
    return { twa: clamp(c.twa + rx * Math.cos(a), 0, 180), tws: Math.max(0, c.tws + ry * Math.sin(a)) }
  })
}

export function groupForKind(kind: string | null | undefined): string {
  const k = (kind || '').toLowerCase()
  if (/spinnaker|gennaker/.test(k)) return 'Spinnakers'
  if (/staysail/.test(k)) return 'Staysails'
  if (/code/.test(k)) return 'Furlers'
  if (/main/.test(k)) return 'Mainsails'
  return 'Headsails'
}
