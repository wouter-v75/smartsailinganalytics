import { describe, it, expect } from 'vitest'
import { gunsFromLog, gunConfidence, type GunRow } from '../gunFromLog'
import { detectDay } from '../detect'

// ─────────────────────────────────────────────────────────────────────────────
// A gun is a sound and no track records it — but Expedition's own countdown is
// logged, so the gun is READ rather than detected: utc + tmGun.
//
// The value of these tests is not the arithmetic, it is the agreement. Every
// row of a sequence names the same instant, and that is what makes a wrong
// assumption produce NO gun instead of a wrong one.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 9, 9, 10, 0, 0)
const GUN = Date.UTC(2026, 9, 9, 10, 5, 0)

/** A countdown to `gun`, one row per `stepSec`, from `fromSec` before it. */
const countdown = (
  gun: number, fromSec: number, toSec: number, stepSec = 1,
  f: (secToGun: number) => number = (s) => s
): GunRow[] => {
  const out: GunRow[] = []
  for (let s = fromSec; s >= toSec; s -= stepSec) {
    out.push({ utc: gun - s * 1000, tmGun: f(s) })
  }
  return out
}

const idle = (from: number, n: number, stepSec = 10): GunRow[] =>
  Array.from({ length: n }, (_, i) => ({ utc: from + i * stepSec * 1000, tmGun: null }))

describe('gunsFromLog', () => {
  it('reads the gun off a five-minute countdown', () => {
    const guns = gunsFromLog(countdown(GUN, 300, 0))
    expect(guns).toHaveLength(1)
    expect(guns[0].utc).toBe(GUN)
    expect(guns[0].raceNum).toBe(1)
    expect(guns[0].rows).toBeGreaterThan(200)
    expect(guns[0].spreadMs).toBe(0)
    expect(guns[0].confidence).toBeGreaterThanOrEqual(0.85)
  })

  it('reads it from a coarse log too — 6 s between rows', () => {
    // Half the season is logged at ~6 s. A 5-minute sequence is then 50 rows,
    // which is plenty; the floor is 6 rows over 20 s.
    const guns = gunsFromLog(countdown(GUN, 300, 0, 6))
    expect(guns).toHaveLength(1)
    expect(guns[0].utc).toBe(GUN)
  })

  it('survives a row whose countdown is nonsense', () => {
    // The median, not the mean: one corrupt cell cannot move the answer.
    const rows = countdown(GUN, 300, 0)
    rows[120] = { utc: rows[120].utc, tmGun: 9999 }
    const guns = gunsFromLog(rows)
    expect(guns).toHaveLength(1)
    expect(guns[0].utc).toBe(GUN)
  })

  it('finds a gun per race, and numbers them in order', () => {
    const second = GUN + 90 * 60_000
    const rows = [
      ...countdown(GUN, 300, 0),
      ...idle(GUN + 60_000, 100, 30),
      ...countdown(second, 300, 0),
    ]
    const guns = gunsFromLog(rows)
    expect(guns.map((g) => g.utc)).toEqual([GUN, second])
    expect(guns.map((g) => g.raceNum)).toEqual([1, 2])
  })

  it('treats one gun seen either side of a log gap as one gun', () => {
    const rows = [...countdown(GUN, 300, 200), ...countdown(GUN, 120, 0)]
    const guns = gunsFromLog(rows)
    expect(guns).toHaveLength(1)
    expect(guns[0].utc).toBe(GUN)
  })
})

describe('what it refuses, which is the point', () => {
  it('finds NOTHING when the timer counts the wrong way', () => {
    // If `tmGun` counted UP from the gun rather than down to it, utc + tmGun
    // moves at twice the clock rate and no two rows agree. A wrong assumption
    // about the sign therefore produces no gun, never a gun in the wrong place.
    const guns = gunsFromLog(countdown(GUN, 300, 0, 1, (s) => -s))
    expect(guns).toEqual([])
  })

  it('finds nothing in a timer somebody left frozen', () => {
    // A constant countdown while the clock advances names a different instant
    // every row — which is exactly what it is: not a countdown.
    const rows = Array.from({ length: 400 }, (_, i) => ({ utc: T0 + i * 1000, tmGun: 240 }))
    expect(gunsFromLog(rows)).toEqual([])
  })

  it('finds nothing in a log that never carried the channel', () => {
    // Every log before the parser kept tmGun, and every boat whose Expedition
    // does not log it. "No guns" has to mean "nothing to say".
    expect(gunsFromLog(idle(T0, 500, 1))).toEqual([])
    expect(gunsFromLog([])).toEqual([])
    expect(gunsFromLog(null)).toEqual([])
  })

  it('will not name a gun from a couple of seconds of countdown', () => {
    // Four rows agreeing over three seconds is not a sequence.
    expect(gunsFromLog(countdown(GUN, 3, 0))).toEqual([])
  })

  it('ignores a countdown to something hours away', () => {
    // 20 minutes is the widest sequence it will believe; a timer set for the
    // afternoon's second race while the first one sails is not this race.
    expect(gunsFromLog(countdown(GUN, 3600, 3300))).toEqual([])
  })

  it('is unmoved by a few seconds of jitter, but says the agreement is looser', () => {
    const jittered = countdown(GUN, 300, 0, 1, (s) => s + (s % 3 === 0 ? 1 : 0))
    const guns = gunsFromLog(jittered)
    expect(guns).toHaveLength(1)
    expect(Math.abs(guns[0].utc - GUN)).toBeLessThanOrEqual(1000)
    expect(guns[0].spreadMs).toBeGreaterThan(0)
  })
})

describe('confidence', () => {
  it('stays below the event file, which records the gun rather than the timer', () => {
    // The file has the gun the navigator marked; this has the gun the timer was
    // set for, and a timer set two seconds late is two seconds late.
    expect(gunConfidence(300, 0, 300)).toBeLessThan(0.95)
    expect(gunConfidence(300, 0, 300)).toBeGreaterThan(0.8)
  })

  it('marks down a loose agreement and a glimpse of a sequence', () => {
    expect(gunConfidence(10, 4000, 25)).toBeLessThan(gunConfidence(300, 0, 300))
  })
})

describe('through detectDay', () => {
  const rows = countdown(GUN, 300, 0).map((r) => ({
    ...r, bsp: 8, twa: -40, lat: 43.1, lon: 5.6,
  })) as never[]

  it('emits a race start from the log when there is no event file', () => {
    const got = detectDay({ boatId: 'b1', date: '2026-10-09', rows })
    const starts = got.filter((d) => d.slug === 'race-start')
    expect(starts).toHaveLength(1)
    expect(starts[0].producer).toBe('log')
    expect(starts[0].meta?.derived).toBe(true)
    // The same window as the event-file path: a minute of run-in, half a minute after.
    expect(starts[0].t0).toBe(GUN - 60_000)
    expect(starts[0].t1).toBe(GUN + 30_000)
  })

  it('and the gun now SHAPES the day, which is the bigger half', () => {
    // Without guns the whole day is one undivided "Session" and every tag in it
    // belongs to nothing. With one, segmentDay can cut a race out of it.
    const got = detectDay({ boatId: 'b1', date: '2026-10-09', rows })
    expect(got.some((d) => d.segmentKey.startsWith('r'))).toBe(true)
  })

  it('leaves the event file in charge when it has guns of its own', () => {
    const fileGun = GUN + 7_000
    const got = detectDay({
      boatId: 'b1', date: '2026-10-09', rows,
      xml: { raceGuns: [{ utc: fileGun, raceNum: 1 }] },
    })
    const starts = got.filter((d) => d.slug === 'race-start')
    expect(starts).toHaveLength(1)
    expect(starts[0].producer).toBe('eventfile')
    expect(starts[0].meta?.gunUtc).toBe(fileGun)
  })

  it('can be switched off', () => {
    const got = detectDay({ boatId: 'b1', date: '2026-10-09', rows, skipGunDetection: true })
    expect(got.filter((d) => d.slug === 'race-start')).toHaveLength(0)
  })
})

describe('from the file, in the units Expedition actually writes', () => {
  // Expedition writes these timers as 100-NANOSECOND TICKS on some exports: a
  // five-minute countdown arrives as 3e9. Read as seconds it would put the gun
  // ninety-five years out, so the conversion is not a nicety — it is the
  // difference between a start on the track and a start in 2121.
  const FILETIME_EPOCH_MS = 11644473600000
  const ft = (ms: number) => (ms + FILETIME_EPOCH_MS) * 10000

  const csv = (toGun: (secs: number) => number) => {
    const head = 'Utc,Lat,Lon,BSP,TWA,TWS,TmToGun'
    const rows: string[] = []
    for (let s = 300; s >= 0; s -= 2) {
      rows.push([ft(GUN - s * 1000), 43.1, 5.6, 8.2, -41, 12, toGun(s)].join(','))
    }
    return [head, ...rows].join('\n')
  }

  it('reads a countdown in SECONDS and lands the gun on the second', async () => {
    const { parseLog } = await import('../../logParse')
    const { rows } = parseLog(csv((s) => s))
    expect(rows.length).toBeGreaterThan(100)
    expect((rows[0] as Record<string, unknown>).tmGun).toBeCloseTo(300, 3)
    expect(gunsFromLog(rows as never)[0].utc).toBe(GUN)
  })

  it('reads the same countdown in 100-ns TICKS, and gets the same gun', () => 
    import('../../logParse').then(({ parseLog }) => {
      const { rows } = parseLog(csv((s) => s * 1e7))
      expect((rows[0] as Record<string, unknown>).tmGun).toBeCloseTo(300, 3)
      const guns = gunsFromLog(rows as never)
      expect(guns).toHaveLength(1)
      expect(guns[0].utc).toBe(GUN)
      // The failure this guards: unconverted, 3e9 seconds puts the gun in 2121.
      expect(new Date(guns[0].utc).getUTCFullYear()).toBe(2026)
    })
  )
})
