import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isVakarosCsv, parseVakarosCsv, parseVakarosStamp,
} from '../vakarosCsvParse'
import { detectLogFormat, parseLog } from '../logParse'
import { effectiveMethods, defaultMethodsForFormat } from '../logProfile'

// 40 real rows from a Vakaros Atlas export (Palma, 8 Feb 2026). The fixture
// keeps its CRLF line endings on purpose — that is the trap being tested.
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures/vakaros-atlas-sample.csv'), 'utf8')

describe('parseVakarosStamp', () => {
  it('reads an explicit +HHMM offset without a colon', () => {
    // Date.parse is implementation-defined for `+0100`; this must not depend on it.
    const r = parseVakarosStamp('2026-02-08T11:56:40.049+0100')!
    expect(r.offsetMin).toBe(60)
    expect(r.utc).toBe(Date.UTC(2026, 1, 8, 10, 56, 40, 49))
  })

  it('handles a colon offset, Z, and a negative offset', () => {
    expect(parseVakarosStamp('2026-02-08T11:56:40+01:00')!.utc)
      .toBe(Date.UTC(2026, 1, 8, 10, 56, 40))
    expect(parseVakarosStamp('2026-02-08T11:56:40Z')!.offsetMin).toBe(0)
    expect(parseVakarosStamp('2026-02-08T11:56:40.000-0330')!.utc)
      .toBe(Date.UTC(2026, 1, 8, 15, 26, 40))
  })

  it('rejects junk rather than returning an invalid date', () => {
    expect(parseVakarosStamp('not a time')).toBeNull()
    expect(parseVakarosStamp('')).toBeNull()
  })
})

describe('isVakarosCsv', () => {
  it('recognises the real header through CRLF', () => {
    expect(isVakarosCsv(FIXTURE)).toBe(true)
  })

  it('does not claim other formats', () => {
    expect(isVakarosCsv('Utc,Lat,Lon,Bsp,Tws\n1,2,3,4,5')).toBe(false)
    expect(isVakarosCsv('!log=v3\n1,2')).toBe(false)
    expect(isVakarosCsv('')).toBe(false)
  })
})

describe('parseVakarosCsv', () => {
  const r = parseVakarosCsv(FIXTURE)

  it('parses every data row', () => {
    expect(r.rows).toHaveLength(40)
    expect(r.rejected.rows).toBe(0)
  })

  it('keeps the trim column — the CRLF trap', () => {
    // Splitting the header without stripping \r names the last column `trim\r`,
    // so `trim` silently reads undefined on every row and the channel looks
    // like garbage rather than missing. That cost a wrong conclusion once.
    expect(r.rows.every((x) => x.trim != null)).toBe(true)
    expect(r.rows[0].trim).toBeCloseTo(7.7, 5)
    expect(r.fields).toContain('trim')
  })

  it('converts the venue-local stamp to true UTC and reports the offset', () => {
    expect(r.tzOffsetMin).toBe(60)
    expect(r.startUtc).toBe(Date.UTC(2026, 1, 8, 10, 56, 40, 49))
    expect(r.endUtc).toBeGreaterThan(r.startUtc)
  })

  it('maps the Vakaros column spellings onto canonical fields', () => {
    const first = r.rows[0]
    expect(first.lat).toBeCloseTo(39.5310307, 6)
    expect(first.lon).toBeCloseTo(2.5704827, 6)
    expect(first.sog).toBeCloseTo(0.4, 5)
    expect(first.cog).toBeCloseTo(266.1, 5)
    expect(first.hdg).toBeCloseTo(245.8, 5)
    expect(first.heel).toBeCloseTo(-1.8, 5)
  })

  it('measures the logging rate rather than assuming one', () => {
    // This device logged at 2 Hz; the other in the same session ran at 10 Hz.
    expect(r.rateHz).toBeCloseTo(2, 1)
  })

  it('never invents bsp from sog', () => {
    // A dinghy has no paddlewheel. Speed over ground is not speed through
    // water, and making them silently equal is the trap this guards.
    expect(r.rows[0]).not.toHaveProperty('bsp')
  })

  it('nulls implausible attitude without dropping the row', () => {
    const rows = FIXTURE.split('\r\n')
    rows[1] = rows[1].replace(/,-1\.8,7\.7$/, ',-173.5,88.0')
    const bad = parseVakarosCsv(rows.join('\r\n'))
    expect(bad.rows).toHaveLength(40)          // row kept
    expect(bad.rows[0].heel).toBeNull()        // attitude rejected
    expect(bad.rows[0].trim).toBeNull()
    expect(bad.rows[0].lat).toBeCloseTo(39.5310307, 6)   // position still good
    expect(bad.rejected.heel).toBe(1)
    expect(bad.rejected.trim).toBe(1)
  })

  it('survives blank lines and an unparseable row', () => {
    const r2 = parseVakarosCsv(FIXTURE + '\r\n\r\nnonsense,1,2,3,4,5,6,7\r\n')
    expect(r2.rows).toHaveLength(40)
    expect(r2.rejected.rows).toBe(1)
  })

  it('returns empty rather than throwing on rubbish', () => {
    expect(parseVakarosCsv('').rows).toHaveLength(0)
    expect(parseVakarosCsv('timestamp\r\n').rows).toHaveLength(0)
  })
})

describe('logParse integration — upload needs no format choice', () => {
  it('auto-detects the format from content alone', () => {
    expect(detectLogFormat(FIXTURE)).toBe('vakaros-csv')
  })

  it('threads through parseLog with the clock and cadence attached', () => {
    const p = parseLog(FIXTURE)
    expect(p.format).toBe('vakaros-csv')
    expect(p.rows).toHaveLength(40)
    expect(p.tzOffsetMin).toBe(60)      // so upload never asks for a timezone
    expect(p.rateHz).toBeCloseTo(2, 1)
    expect(p.startUtc).toBe(Date.UTC(2026, 1, 8, 10, 56, 40, 49))
  })

  it('leaves the instrument formats detecting exactly as before', () => {
    expect(detectLogFormat('!log=v3\nx')).not.toBe('vakaros-csv')
  })
})

describe('per-boat methods', () => {
  it('gives a GPS-only boat derived methods and an instrumented boat measured ones', () => {
    expect(defaultMethodsForFormat('vakaros-csv')).toEqual({
      windDirection: 'derived-cog', windSpeed: 'model',
      polar: 'learned', phases: 'derived',
    })
    expect(defaultMethodsForFormat('flat-ole')).toEqual({
      windDirection: 'measured', windSpeed: 'measured',
      polar: 'measured', phases: 'event-file',
    })
  })

  it('lets a boat override one method without restating the rest', () => {
    const m = effectiveMethods({ methods: { windSpeed: 'measured' } }, 'vakaros-csv')
    expect(m.windSpeed).toBe('measured')       // this boat has a masthead unit
    expect(m.windDirection).toBe('derived-cog') // the rest still derived
    expect(m.polar).toBe('learned')
  })

  it('defaults an existing alias-only profile to the instrumented behaviour', () => {
    // Every N76 boat has a profile with `aliases` and no `methods`.
    const m = effectiveMethods({ aliases: { bsp: ['boatspeed'] } }, 'flat-ole')
    expect(m.windDirection).toBe('measured')
    expect(m.phases).toBe('event-file')
  })
})
