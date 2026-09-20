import { describe, it, expect } from 'vitest'
import { isGpx, parseGpx, parseGpxTime } from '../gpxParse'
import { detectLogFormat, parseLog } from '../logParse'

const gpx = (points: string, extra = '') => `<?xml version="1.0"?>
<gpx version="1.1" creator="test"><trk><name>Training</name>${extra}<trkseg>
${points}
</trkseg></trk></gpx>`

// ~10 m apart each second heading due north: 19.4 kn.
const pt = (i: number, lat: number, lon = 2.57, inner = '') =>
  `<trkpt lat="${lat}" lon="${lon}"><time>2026-02-08T11:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}Z</time>${inner}</trkpt>`

describe('parseGpxTime', () => {
  it('reads a Z stamp', () => {
    expect(parseGpxTime('2026-02-08T11:56:40Z')).toBe(Date.UTC(2026, 1, 8, 11, 56, 40))
  })
  it('treats a zoneless stamp as UTC, per the spec', () => {
    expect(parseGpxTime('2026-02-08T11:56:40')).toBe(Date.UTC(2026, 1, 8, 11, 56, 40))
  })
  it('honours an explicit offset', () => {
    expect(parseGpxTime('2026-02-08T12:56:40+01:00')).toBe(Date.UTC(2026, 1, 8, 11, 56, 40))
  })
  it('rejects junk', () => {
    expect(parseGpxTime('nope')).toBeNull()
    expect(parseGpxTime(null)).toBeNull()
  })
})

describe('isGpx', () => {
  it('recognises a track', () => {
    expect(isGpx(gpx(pt(0, 39.5)))).toBe(true)
  })
  it('does not claim other formats', () => {
    expect(isGpx('timestamp,latitude,longitude,sog_kts\n1,2,3,4')).toBe(false)
    expect(isGpx('<gpx></gpx>')).toBe(false)        // no points
    expect(isGpx('')).toBe(false)
  })

  it('refuses a marks or route file — GPX, but not a logfile', () => {
    // 35 of 41 GPX files in a real Downloads folder were marks or routes.
    // Accepting them would report the format as understood and then find no
    // rows, which is exactly the mislabelling this change is about.
    const marks = '<?xml version="1.0"?><gpx version="1.1">' +
      '<wpt lat="50.1" lon="-1.2"><name>Mark 1</name></wpt>' +
      '<wpt lat="50.2" lon="-1.3"><name>Mark 2</name></wpt></gpx>'
    expect(isGpx(marks)).toBe(false)
    const route = '<?xml version="1.0"?><gpx version="1.1"><rte>' +
      '<rtept lat="50.1" lon="-1.2"/><rtept lat="50.2" lon="-1.3"/></rte></gpx>'
    expect(isGpx(route)).toBe(false)
  })
})

describe('parseGpx', () => {
  const text = gpx(Array.from({ length: 10 }, (_, i) => pt(i, 39.5 + i * 0.0001)).join('\n'))
  const r = parseGpx(text)

  it('reads every point', () => {
    expect(r.rows).toHaveLength(10)
    expect(r.rejected).toBe(0)
    expect(r.name).toBe('Training')
  })

  it('derives sog and cog from position, and says that it did', () => {
    expect(r.derivedMotion).toBe(true)
    expect(r.rows[5].cog).toBeCloseTo(0, 0)          // heading due north
    expect(r.rows[5].sog).toBeGreaterThan(20)        // ~11 m/s
    expect(r.rows[5].sog).toBeLessThan(25)
  })

  it('measures the rate', () => {
    expect(r.rateHz).toBeCloseTo(1, 1)
  })

  it('prefers speed and course from the file over differencing', () => {
    const withMotion = gpx(Array.from({ length: 5 }, (_, i) =>
      pt(i, 39.5 + i * 0.0001, 2.57, '<speed>3.0</speed><course>123.0</course>')).join('\n'))
    const p = parseGpx(withMotion)
    expect(p.derivedMotion).toBe(false)
    expect(p.rows[1].sog).toBeCloseTo(3 * 1.94384, 3)   // m/s -> kn
    expect(p.rows[1].cog).toBeCloseTo(123, 3)
  })

  it('leaves course null when the boat is barely moving', () => {
    // Differencing a bearing from GPS jitter invents a heading.
    const still = gpx(Array.from({ length: 5 }, (_, i) => pt(i, 39.5)).join('\n'))
    const p = parseGpx(still)
    expect(p.rows[2].cog).toBeNull()
    expect(p.rows[2].sog).toBeCloseTo(0, 3)
  })

  it('handles self-closing points and skips ones with no time', () => {
    const mixed = gpx([
      pt(0, 39.5),
      '<trkpt lat="39.6" lon="2.57"/>',          // no time
      pt(2, 39.7),
    ].join('\n'))
    const p = parseGpx(mixed)
    expect(p.rows).toHaveLength(2)
    expect(p.rejected).toBe(1)
  })

  it('sorts out-of-order points', () => {
    const outOfOrder = gpx([pt(5, 39.5), pt(1, 39.6), pt(3, 39.7)].join('\n'))
    const p = parseGpx(outOfOrder)
    expect(p.rows.map((x) => x.utc)).toEqual([...p.rows.map((x) => x.utc)].sort((a, b) => a - b))
  })

  it('returns empty for rubbish rather than throwing', () => {
    expect(parseGpx('').rows).toHaveLength(0)
    expect(parseGpx('<gpx></gpx>').rows).toHaveLength(0)
  })
})

describe('logParse integration', () => {
  const text = gpx(Array.from({ length: 10 }, (_, i) => pt(i, 39.5 + i * 0.0001)).join('\n'))

  it('auto-detects gpx from content', () => {
    expect(detectLogFormat(text)).toBe('gpx')
  })

  it('has no venue offset of its own — GPX times are UTC', () => {
    const p = parseLog(text)
    expect(p.format).toBe('gpx')
    expect(p.rows).toHaveLength(10)
    expect(p.tzOffsetMin).toBeNull()     // so upload must fall back to position
    expect(p.rateHz).toBeCloseTo(1, 1)
  })
})
