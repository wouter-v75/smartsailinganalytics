// src/lib/__tests__/expeditionExportParse.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Expedition's log-viewer export: SI units, magnetic bearings, dotted UTC.
//
// It is an ALTERNATIVE. The first block here is the one that matters most — the
// detector must never claim a file one of the existing parsers handles, which is
// checked against each of their real headers rather than asserted in a comment.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { isExpeditionExport, parseDottedUtc, parseExpeditionExport } from '../expeditionExportParse'
import { detectLogFormat, parseLog } from '../logParse'

// ° is the degree sign as the single high byte the file actually contains.
const D = '°'
const HEADER = [
  'Date/Time (UTC)', `True Wind Direction ${D}M`, 'True Wind Speed m/s', `True Wind Angle ${D}`,
  'Apparent Wind Speed m/s', `Apparent Wind Angle ${D}`, `Magnetic Variation ${D}`,
  `Heel ${D}`, 'Bow Position latitude', 'Bow Position longitude', 'Boat Speed m/s',
  'Speed Over Ground m/s', `Course Over Ground ${D}M`, `Heading ${D}M`,
  'Barometric Pressure Pa', 'Target Boat Speed m/s', 'Mast Base ', 'Alarms', 'User events',
].join(',')

//        t              twd   tws  twa  aws  awa  var  heel  lat        lon      bsp  sog  cog  hdg  baro   tgt  mastbase
const ROW = '30.09.2026 11:44:26.970,212.4,8.2,42.1,9.6,38.0,3.5,18.4,43.2712,6.6401,5.1,5.3,215.0,210.0,101300,5.4,12.5,,'
const FILE = [HEADER, ROW].join('\r\n') + '\r\n'

describe('it does not claim anybody else’s file', () => {
  const others: Array<[string, string]> = [
    ['flat-ole', 'Utc,Lat,Lon,Bsp,Tws,Twa\n45930.5,43.2,6.6,8.1,12.0,40'],
    ['flat-local', 'Datetime,Lat,Lon,Bsp,Tws\n2026-09-07 10:20:38,43.2,6.6,8.1,12.0'],
    ['flat-local (split clock)', 'UtcDate,UtcTime,Lat,Lon,Bsp,Tws\n07/09/2026,10:20:38,43.2,6.6,8.1,12.0'],
    ['vakaros', 'timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim\n2026-02-08T11:56:40.049+0100,39.5,2.5,0.4,266.1,245.8,-1.8,7.7'],
    ['log-v3', '!log=v3\n!1,Bsp\n1,8.1'],
  ]
  for (const [name, text] of others) {
    it(`leaves the ${name} log alone`, () => {
      expect(isExpeditionExport(text)).toBe(false)
      expect(detectLogFormat(text)).not.toBe('exp-export')
    })
  }

  it('claims its own', () => {
    expect(isExpeditionExport(FILE)).toBe(true)
    expect(detectLogFormat(FILE)).toBe('exp-export')
  })

  it('wants more than the one column, so a stray CSV is not claimed', () => {
    expect(isExpeditionExport('Date/Time (UTC),Something Else\n30.09.2026 11:44:26.970,1')).toBe(false)
  })

  it('reads the header whatever the degree sign decoded to', () => {
    // The byte reads as °, ∞ or U+FFFD depending on the encoding used; normLabel
    // strips all three, so detection and mapping cannot depend on which.
    for (const glyph of ['°', '∞', '�']) {
      expect(isExpeditionExport(FILE.split(D).join(glyph))).toBe(true)
    }
  })
})

describe('parseDottedUtc', () => {
  it('reads the dotted stamp as UTC', () => {
    expect(parseDottedUtc('30.09.2026 11:44:26.970')).toBe(Date.UTC(2026, 8, 30, 11, 44, 26, 970))
  })
  it('is null for the layouts other parsers own', () => {
    expect(parseDottedUtc('30/09/2026 11:44:26')).toBeNull()
    expect(parseDottedUtc('2026-09-30 11:44:26')).toBeNull()
    expect(parseDottedUtc('')).toBeNull()
  })
})

describe('units and bearings', () => {
  const { rows } = parseExpeditionExport(FILE)
  const r = rows[0]

  it('converts m/s to knots', () => {
    expect(r.bsp).toBeCloseTo(5.1 * 1.9438444924406, 6)
    expect(r.tws).toBeCloseTo(8.2 * 1.9438444924406, 6)
    expect(r.sog).toBeCloseTo(5.3 * 1.9438444924406, 6)
    expect(r.vsTarget).toBeCloseTo(5.4 * 1.9438444924406, 6)
  })

  it('converts magnetic bearings to true with the row’s own variation', () => {
    // magVar.ts: varDeg is positive east and magnetic = true − varDeg.
    expect(r.twd).toBeCloseTo(212.4 + 3.5, 6)
    expect(r.cog).toBeCloseTo(215.0 + 3.5, 6)
    expect(r.hdg).toBeCloseTo(210.0 + 3.5, 6)
  })

  it('wraps a converted bearing past north', () => {
    const near = FILE.replace(',212.4,', ',358.0,')
    const r2 = parseExpeditionExport(near).rows[0]
    expect(r2.twd).toBeCloseTo(1.5, 6)
  })

  it('leaves relative angles alone — they are not bearings', () => {
    expect(r.twa).toBe(42.1)
    expect(r.awa).toBe(38.0)
    expect(r.heel).toBe(18.4)
  })

  it('converts pascals to hPa, which is what the windweight code reads', () => {
    expect(r.baro).toBeCloseTo(1013, 6)
  })

  it('keeps the variation itself, unconverted', () => {
    expect(r.magvar).toBe(3.5)
  })

  it('carries position through untouched', () => {
    expect(r.lat).toBe(43.2712)
    expect(r.lon).toBe(6.6401)
  })
})

describe('rows', () => {
  it('reads the timestamp as UTC, not as venue-local', () => {
    const { rows, startUtc } = parseExpeditionExport(FILE)
    expect(rows[0].utc).toBe(Date.UTC(2026, 8, 30, 11, 44, 26, 970))
    expect(startUtc).toBe(rows[0].utc)
  })

  it('leaves an empty cell null rather than zero', () => {
    const blank = [HEADER, ROW.replace(',18.4,', ',,')].join('\r\n')
    expect(parseExpeditionExport(blank).rows[0].heel).toBeNull()
  })

  it('leaves a non-numeric cell null', () => {
    const junk = [HEADER, ROW.replace(',18.4,', ',n/a,')].join('\r\n')
    expect(parseExpeditionExport(junk).rows[0].heel).toBeNull()
  })

  it('drops a row it cannot time, and counts it', () => {
    const bad = [HEADER, ROW, 'RaceTimerRolling,false'].join('\r\n')
    const p = parseExpeditionExport(bad)
    expect(p.rows).toHaveLength(1)
    expect(p.skipped).toBe(1)
  })

  it('measures the rate rather than assuming it', () => {
    const rows = [HEADER, ROW,
      ROW.replace('11:44:26.970', '11:44:27.970'),
      ROW.replace('11:44:26.970', '11:44:28.970')].join('\r\n')
    expect(parseExpeditionExport(rows).rateHz).toBe(1)
  })

  it('measures the rate the logger RAN at, ignoring the breaks', () => {
    // Rows-per-span counts the dock and the gaps between races as logging time:
    // a 1 Hz fixture with one 40-minute break measured 0.4 Hz.
    const rows = [HEADER, ROW,
      ROW.replace('11:44:26.970', '11:44:27.970'),
      ROW.replace('11:44:26.970', '11:44:28.970'),
      ROW.replace('30.09.2026 11:44:26.970', '30.09.2026 12:24:28.970'),
      ROW.replace('30.09.2026 11:44:26.970', '30.09.2026 12:24:29.970')].join('\r\n')
    expect(parseExpeditionExport(rows).rateHz).toBe(1)
  })

  it('survives a file with only a header', () => {
    const p = parseExpeditionExport(HEADER)
    expect(p.rows).toEqual([])
    expect(p.startUtc).toBe(0)
  })
})

describe('columns nobody has mapped', () => {
  it('reports them instead of guessing', () => {
    const { unmapped } = parseExpeditionExport(FILE)
    expect(unmapped).toContain('Alarms')
    expect(unmapped).toContain('User events')
  })

  it('does not report the timestamp column, which IS handled', () => {
    expect(parseExpeditionExport(FILE).unmapped).not.toContain('Date/Time (UTC)')
  })

  it('does not report the ones deliberately left out', () => {
    const amb = [HEADER.replace('Alarms', `Course ${D}M`), ROW].join('\r\n')
    expect(parseExpeditionExport(amb).unmapped).not.toContain(`Course ${D}M`)
  })

  it('takes the FIRST column when a label repeats', () => {
    // This export carries `True Wind Direction °M` and a bare `True Wind
    // Direction` further along; the later one must not replace the chosen one.
    const dup = [`${HEADER},True Wind Direction ${D}M`, `${ROW},99.9`].join('\r\n')
    expect(parseExpeditionExport(dup).rows[0].twd).toBeCloseTo(212.4 + 3.5, 6)
  })
})

describe('through parseLog, which is how the app reaches it', () => {
  it('returns the rows, the format and no timezone shift', () => {
    const p = parseLog(FILE)
    expect(p.format).toBe('exp-export')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0].utc).toBe(Date.UTC(2026, 8, 30, 11, 44, 26, 970))
    // The stamps ARE UTC, so unlike flat-local nothing is shifted — passing a
    // venue offset must not move them.
    expect(parseLog(FILE, { tzOffsetMin: 120 }).rows[0].utc).toBe(p.rows[0].utc)
  })
})
