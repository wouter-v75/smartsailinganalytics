// A race course from a GPX file: the start, the marks in order, the finish.
//
// GPX carries a course in one of three shapes and real files use all three:
//   <rte><rtept>  a route — the right shape, and preferred when present;
//   <wpt>         loose waypoints, in file order;
//   <trk><trkpt>  a track someone drew, which is a course only if it is short
//                 (a sailed track has thousands of points and is not a course).
// The first point is the start and the last is the finish. Everything between
// is a MARK the boat must pass within `radiusNm` of, in order. A mark is a
// point to reach, not a line to cross: that is what a GPX waypoint is, and it is
// also what makes leg-by-leg routing exact (see isochrone.ts).
//
// A name containing "gate" or "via" (case-insensitive) is a pass-through point
// rather than a mark; it is still reached in order. The distinction is kept on
// the mark so a later version can route a gate as a line.

import { distNm } from './geo'

export interface Mark { name: string; lat: number; lon: number; radiusNm: number; kind: 'start' | 'mark' | 'via' | 'finish' }
export interface Course { name: string | null; marks: Mark[]; rhumbNm: number }

const PT = (tag: string) =>
  new RegExp(`<${tag}\\b[^>]*?\\blat\\s*=\\s*"([^"]+)"[^>]*?\\blon\\s*=\\s*"([^"]+)"[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'gi')
// Some writers put lon before lat.
const PT_REV = (tag: string) =>
  new RegExp(`<${tag}\\b[^>]*?\\blon\\s*=\\s*"([^"]+)"[^>]*?\\blat\\s*=\\s*"([^"]+)"[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'gi')

function points(text: string, tag: string): { lat: number; lon: number; name: string | null }[] {
  const out: { at: number; lat: number; lon: number; name: string | null }[] = []
  for (const [re, rev] of [[PT(tag), false], [PT_REV(tag), true]] as const) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const a = parseFloat(m[1]), b = parseFloat(m[2])
      const lat = rev ? b : a, lon = rev ? a : b
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (out.some(p => p.at === m!.index)) continue
      const nm = /<name\b[^>]*>([^<]*)<\/name>/i.exec(m[3] || '')
      out.push({ at: m.index, lat, lon, name: nm ? nm[1].trim() || null : null })
    }
  }
  return out.sort((x, y) => x.at - y.at).map(({ lat, lon, name }) => ({ lat, lon, name }))
}

export function parseCourseGpx(text: string, opts: { radiusNm?: number; finishRadiusNm?: number } = {}): Course {
  const radius = opts.radiusNm ?? 0.25
  let pts = points(text, 'rtept')
  if (pts.length < 2) pts = points(text, 'wpt')
  if (pts.length < 2) {
    pts = points(text, 'trkpt')
    if (pts.length > 200) throw new Error(`The GPX holds a ${pts.length}-point TRACK, not a course. Export the course as a route or as waypoints.`)
  }
  if (pts.length < 2) throw new Error('A course needs at least a start and a finish')
  // Consecutive duplicates (a route that repeats a point) are one mark.
  const dedup = pts.filter((p, i) => i === 0 || distNm(p.lat, p.lon, pts[i - 1].lat, pts[i - 1].lon) > 0.01)
  const marks: Mark[] = dedup.map((p, i) => ({
    name: p.name ?? (i === 0 ? 'Start' : i === dedup.length - 1 ? 'Finish' : `WP${i}`),
    lat: p.lat, lon: p.lon,
    radiusNm: i === dedup.length - 1 ? (opts.finishRadiusNm ?? radius) : radius,
    kind: i === 0 ? 'start' : i === dedup.length - 1 ? 'finish' : /\b(gate|via)\b/i.test(p.name ?? '') ? 'via' : 'mark',
  }))
  let rhumb = 0
  for (let i = 1; i < marks.length; i++) rhumb += distNm(marks[i - 1].lat, marks[i - 1].lon, marks[i].lat, marks[i].lon)
  const nm = /<(?:rte|gpx|metadata)\b[^>]*>[\s\S]*?<name\b[^>]*>([^<]*)<\/name>/i.exec(text)
  return { name: nm ? nm[1].trim() || null : null, marks, rhumbNm: rhumb }
}

/** The lat/lon box around the course, padded by `padDeg`. */
export function courseBox(c: Course, padDeg: number) {
  const la = c.marks.map(m => m.lat), lo = c.marks.map(m => m.lon)
  return {
    latMin: Math.min(...la) - padDeg, latMax: Math.max(...la) + padDeg,
    lonMin: Math.min(...lo) - padDeg, lonMax: Math.max(...lo) + padDeg,
  }
}
