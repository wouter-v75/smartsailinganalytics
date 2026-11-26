// src/lib/sailchart/grid.ts
// ─────────────────────────────────────────────────────────────────────────────
// The OLD sail-chart format → curved shapes.
//
// Before crossover charts were drawn as shapes, nav computers took a TABLE: one
// row per TWS, one column per TWA, a sail name in every cell (Ryujin's "Fast
// Exit Crossover … Transposed for Nav" is one). Tab, comma or semicolon
// separated, blank top-left cell:
//
//          40   45   50  …  145
//     5    J0   J0   J0  …  A1
//     6    J0   …
//
// The table is accepted either way round — whichever header holds the larger
// numbers is the TWA axis — because "transposed for nav" says these files exist
// in both orientations.
//
// CONVERSION. Each cell stands for the rectangle half-way to its neighbours
// (the outer cells extend half a step beyond the table, so a 40-145 table
// covers 37.5-147.5). For each sail, every 4-connected block of cells becomes
// ONE shape; a sail used in two separate places (A3.5 at 10-17 kn and again at
// 27-28 kn on Ryujin's chart) becomes two shapes with the same name, which
// matching links to the same inventory sails.
//
// The block's outline is a staircase. Control points go at the MIDDLE of each
// stair step, which puts them on the diagonal the staircase approximates, and
// half a cell in from each end of a long straight edge, which keeps a corner
// within half a cell of where the table puts it. Points that add nothing are
// then dropped (Douglas-Peucker, 0.4 cell — on Ryujin's 528-cell table 0.2
// keeps all 528 inside their own sail at up to 31 points a shape, 0.4 keeps
// 526 at up to 23, 0.5 drops to 524 and lets 17 into a neighbour), so the result is a handful of
// points a person can drag, and the Catmull-Rom outline through them is the
// smooth edge the table only implied.
//
// Holes are ignored: the outer outline is kept. A sail entirely enclosed by
// another is a separate shape drawn on top, which is how the XML charts do it.
// ─────────────────────────────────────────────────────────────────────────────

import { type ChartPoint, type ChartSail, type SailChart, NEW_SAIL_COLOURS, newSailId } from './model'

export interface SailGrid {
  /** TWA of each column, ascending. */
  twa: number[]
  /** TWS of each row, ascending. */
  tws: number[]
  /** cells[row][col] = sail name, or '' for none. */
  cells: string[][]
}

const EMPTY = /^(|-+|—|none|n\/a|x)$/i

/** Parse the table. Throws when it is not one. */
export function parseSailGrid(text: string): SailGrid {
  const src = (text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) || ''
  const lines = src.split(/\r?\n/).filter(l => l.trim() && !/^[!#]/.test(l.trim()))
  if (lines.length < 3) throw new Error('Sail table too short — need a header row and at least two rows')
  const sep = lines.some(l => l.includes('\t')) ? /\t/ : lines.some(l => /[,;]/.test(l)) ? /[,;]/ : /\s+/
  const rows = lines.map(l => l.split(sep).map(c => c.trim()))
  // Whitespace-separated rows lose a blank top-left cell; put it back.
  if (sep.source === '\\s+' && rows[0][0] !== '' && !Number.isNaN(Number(rows[0][0])) &&
      rows[0].length === rows[1].length - 1) rows[0].unshift('')

  const head = rows[0].slice(1).map(Number)
  if (head.length < 2 || head.some(v => !Number.isFinite(v))) throw new Error('Sail table header must be numbers (TWA or TWS)')
  const body = rows.slice(1).filter(r => r.length > 1 && Number.isFinite(Number(r[0])) && r[0] !== '')
  if (body.length < 2) throw new Error('Sail table needs at least two numbered rows')
  const keys = body.map(r => Number(r[0]))
  const grid = body.map(r => head.map((_, j) => (EMPTY.test(r[j + 1] ?? '') ? '' : (r[j + 1] ?? '').trim())))
  if (!grid.some(r => r.some(Boolean))) throw new Error('Sail table has no sail names in it')

  // Larger numbers are the angles.
  const headIsTwa = Math.max(...head) > Math.max(...keys)
  let twa = headIsTwa ? head : keys
  let tws = headIsTwa ? keys : head
  let cells = headIsTwa ? grid : head.map((_, j) => grid.map(r => r[j]))
  if (Math.max(...twa) > 180 || Math.min(...tws) < 0) throw new Error('Sail table axes are out of range (TWA 0-180, TWS ≥ 0)')

  // Ascending on both axes.
  const order = (v: number[]) => v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]).map(p => p[1])
  const ro = order(tws), co = order(twa)
  tws = ro.map(i => tws[i]); twa = co.map(j => twa[j])
  cells = ro.map(i => co.map(j => cells[i][j]))
  return { twa, tws, cells }
}

/** A text file that looks like a sail table rather than XML. */
export const looksLikeSailGrid = (text: string) => !/<\s*crossoverchart\b/i.test(text) && /\d/.test(text)

const edgesOf = (v: number[]): number[] => {
  const n = v.length
  const out = [v[0] - (v[1] - v[0]) / 2]
  for (let i = 1; i < n; i++) out.push((v[i - 1] + v[i]) / 2)
  out.push(v[n - 1] + (v[n - 1] - v[n - 2]) / 2)
  return out
}

type P = [number, number] // [col (x), row (y)] in lattice units

/** 4-connected blocks of cells holding `name`. */
function components(cells: string[][], name: string): boolean[][][] {
  const R = cells.length, Cn = cells[0].length
  const seen = cells.map(r => r.map(() => false))
  const out: boolean[][][] = []
  for (let i = 0; i < R; i++) for (let j = 0; j < Cn; j++) {
    if (seen[i][j] || cells[i][j] !== name) continue
    const mask = cells.map(r => r.map(() => false))
    const stack = [[i, j]]
    seen[i][j] = true
    while (stack.length) {
      const [a, b] = stack.pop()!
      mask[a][b] = true
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = a + da, y = b + db
        if (x >= 0 && x < R && y >= 0 && y < Cn && !seen[x][y] && cells[x][y] === name) { seen[x][y] = true; stack.push([x, y]) }
      }
    }
    out.push(mask)
  }
  return out
}

/** The outer boundary of a mask, as lattice corners in order (interior on the left). */
function outerLoop(mask: boolean[][]): P[] {
  const R = mask.length, Cn = mask[0].length
  const at = (i: number, j: number) => i >= 0 && i < R && j >= 0 && j < Cn && mask[i][j]
  const next = new Map<string, P[]>()
  const add = (a: P, b: P) => {
    const k = `${a[0]},${a[1]}`
    if (!next.has(k)) next.set(k, [])
    next.get(k)!.push(b)
  }
  // Cell (i, j) spans x ∈ [j, j+1], y ∈ [i, i+1]; walk counter-clockwise.
  for (let i = 0; i < R; i++) for (let j = 0; j < Cn; j++) {
    if (!mask[i][j]) continue
    if (!at(i - 1, j)) add([j, i], [j + 1, i])          // bottom, going +x
    if (!at(i, j + 1)) add([j + 1, i], [j + 1, i + 1])  // right, going +y
    if (!at(i + 1, j)) add([j + 1, i + 1], [j, i + 1])  // top, going -x
    if (!at(i, j - 1)) add([j, i + 1], [j, i])          // left, going -y
  }
  const loops: P[][] = []
  while (next.size) {
    const startKey = next.keys().next().value as string
    const start = startKey.split(',').map(Number) as P
    const loop: P[] = [start]
    let cur = start, prevDir: P = [0, 0]
    for (let guard = 0; guard < 100000; guard++) {
      const k = `${cur[0]},${cur[1]}`
      const outs = next.get(k)
      if (!outs?.length) break
      // At a pinch point take the sharpest LEFT turn, which keeps to this block.
      let pick = 0
      if (outs.length > 1) {
        const score = (o: P) => { const d = [o[0] - cur[0], o[1] - cur[1]]; return prevDir[0] * d[1] - prevDir[1] * d[0] }
        pick = outs.reduce((b, o, idx) => (score(o) > score(outs[b]) ? idx : b), 0)
      }
      const nxt = outs.splice(pick, 1)[0]
      if (!outs.length) next.delete(k)
      prevDir = [nxt[0] - cur[0], nxt[1] - cur[1]]
      cur = nxt
      if (cur[0] === start[0] && cur[1] === start[1]) break
      loop.push(cur)
    }
    loops.push(loop)
  }
  const area = (l: P[]) => Math.abs(l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1] }, 0)) / 2
  return loops.reduce((b, l) => (area(l) > area(b) ? l : b), loops[0])
}

/** Staircase corners → control points: mid-step, and half a cell in on long edges. */
function controlPoints(loop: P[]): P[] {
  // Merge collinear runs into polygon vertices.
  const n = loop.length
  const verts: P[] = []
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (cross !== 0) verts.push(b)
  }
  const pts: P[] = []
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length]
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])
    const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1])
    if (len <= 1) pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
    else {
      pts.push([a[0] + ux * 0.5, a[1] + uy * 0.5])
      pts.push([b[0] - ux * 0.5, b[1] - uy * 0.5])
    }
  }
  return simplifyClosed(pts, 0.4)
}

function simplifyClosed(pts: P[], eps: number): P[] {
  if (pts.length <= 4) return pts
  const dist = (p: P, a: P, b: P) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy)
    return L === 0 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / L
  }
  const dp = (seg: P[]): P[] => {
    if (seg.length < 3) return seg
    let idx = 0, max = 0
    for (let i = 1; i < seg.length - 1; i++) { const d = dist(seg[i], seg[0], seg[seg.length - 1]); if (d > max) { max = d; idx = i } }
    if (max <= eps) return [seg[0], seg[seg.length - 1]]
    return [...dp(seg.slice(0, idx + 1)).slice(0, -1), ...dp(seg.slice(idx))]
  }
  // Split the ring at its two mutually furthest points so both halves are open chains.
  let far = 0, fd = -1
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i } })
  const a = dp(pts.slice(0, far + 1)), b = dp([...pts.slice(far), pts[0]])
  const out = [...a.slice(0, -1), ...b.slice(0, -1)]
  return out.length >= 3 ? out : pts
}

export function groupForName(name: string): string {
  const n = name.toUpperCase()
  if (/^(GS|SS)/.test(n) || /STAY/.test(n)) return 'Staysails'
  if (/^(FR|R|C|CODE)\d/.test(n) || /^(FR|CODE)/.test(n)) return 'Furlers'
  if (/^(A|S|MH|BR|G)\d/.test(n)) return 'Spinnakers'
  return 'Headsails'
}

/** A sail table → a SailChart of smooth shapes, one per block of cells. */
export function gridToChart(g: SailGrid, fileName: string | null = null): SailChart {
  const xE = edgesOf(g.twa).map(v => Math.max(0, Math.min(180, v)))
  const yE = edgesOf(g.tws).map(v => Math.max(0, v))
  // lattice → data, interpolating within a cell so half-cell points land half way
  const lerp = (E: number[], u: number) => {
    const i = Math.max(0, Math.min(E.length - 2, Math.floor(u)))
    return E[i] + (E[i + 1] - E[i]) * (u - i)
  }
  const names = Array.from(new Set(g.cells.flat().filter(Boolean)))
  const sails: ChartSail[] = []
  names.forEach((name, k) => {
    const colour = NEW_SAIL_COLOURS[k % NEW_SAIL_COLOURS.length]
    for (const mask of components(g.cells, name)) {
      const lp = controlPoints(outerLoop(mask))
      const points: ChartPoint[] = lp.map(([x, y]) => ({
        twa: Math.round(lerp(xE, x) * 10) / 10,
        tws: Math.round(lerp(yE, y) * 10) / 10,
      }))
      if (points.length < 3) continue
      // label at the centre of the block's own cells, which is always inside it
      let si = 0, sj = 0, cnt = 0
      mask.forEach((r, i) => r.forEach((on, j) => { if (on) { si += i; sj += j; cnt++ } }))
      const ci = Math.round(si / cnt), cj = Math.round(sj / cnt)
      const label = mask[ci]?.[cj] ? { twa: g.twa[cj], tws: g.tws[ci] } : null
      const group = groupForName(name)
      sails.push({
        id: newSailId(), name, group, colour, alias: [], points, opacity: 40,
        dashed: group === 'Staysails', lineWidth: 2, label, visible: true, sailIds: [],
        extra: { createdBy: 'SSA (from sail table)' },
      })
    }
  })
  if (!sails.length) throw new Error('No sail shapes could be built from the table')
  return { version: 1, fileName, importedAt: new Date().toISOString(), sails }
}
