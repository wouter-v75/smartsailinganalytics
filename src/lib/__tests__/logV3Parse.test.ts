import { describe, it, expect } from 'vitest'
import { isLogV3, parseLogV3Header, expandLogV3 } from '../logV3Parse'
import { detectLogFormat, parseLog } from '../logParse'
import { isFlatOleLog } from '../flatLogParse'

// Verbatim from log-2026Sep02.csv (Expedition 12.9.2, Porto Cervo, 2026-09-02).
// Header truncated to the channels the assertions use; the row lines are unedited,
// including the first one, which carries ONLY the timestamp and the four mark
// coordinates — no instruments at all.
const HEAD =
  '!Boat,Utc,BSP,AWA,AWS,TWA,TWS,TWD,Course,Leeway,Set,Drift,HDG,Heel,Trim,Forestay,VMG,ROT,Tm on S,Tm on P,Lat,Lon,COG,SOG,Port lat,Port lon,Stbd lat,Stbd lon\n' +
  '!boat,0,1,2,3,4,5,6,9,10,11,12,13,18,19,22,31,32,34,37,48,49,50,51,163,164,165,166\n' +
  '!v12.9.2\n!log=v3\n'
const ROW_MARKS_ONLY = '0,134328055744581987,163,43.169903,164,5.643753,165,43.169910,166,5.637480'
const ROW_FULL =
  '0,134328055775865592,1,0.000000,2,-146.51,3,12.4098,4,-146.51,5,13.2056,6,271.90,9,058.52,' +
  '10,0.0659,11,356.28,12,0.0000,13,058.42,18,0.7720,19,-0.0960,22,2.897362,31,-0.0000,32,-0.2530,' +
  '34,105100451391,37,684462641975,48,41.135162,49,9.532466,50,060.24,51,0.000000'
const ROW_FULL2 =
  '0,134328055786053447,1,0.000000,2,-146.05,3,12.5100,4,-146.05,5,13.0853,6,272.34,9,058.29,' +
  '10,0.0627,11,356.28,12,0.0000,13,058.23,18,0.7170,19,0.0170,22,2.889098,31,-0.0000,32,0.0590,' +
  '34,114711566350,37,687954703762,48,41.135162,49,9.532466,50,060.06,51,0.000000'
const FILE = HEAD + [ROW_MARKS_ONLY, ROW_FULL, ROW_FULL2].join('\n') + '\n'

describe('detection', () => {
  it('recognises the v3 export', () => {
    expect(isLogV3(FILE)).toBe(true)
    expect(detectLogFormat(FILE)).toBe('log-v3')
  })

  it('pins the regression: flat-OLE rejects it on the leading "!"', () => {
    // This is why it used to fall through to the legacy NMEA parser and yield 0 rows.
    expect(isFlatOleLog(FILE)).toBe(false)
  })

  it('does not claim ordinary CSV or an empty file', () => {
    expect(isLogV3('Utc,BSP,Lat,Lon\n2026-09-02 06:52,0,41.1,9.5')).toBe(false)
    expect(isLogV3('')).toBe(false)
    expect(isLogV3('!v12.9.2\n!log=v3\n')).toBe(false)   // no channel map
  })
})

describe('header', () => {
  it('aligns labels to channel numbers', () => {
    const h = parseLogV3Header(FILE)!
    expect(h.labels[0]).toBe('Utc')
    expect(h.channels[0]).toBe(0)
    expect(h.labels[h.channels.indexOf(48)]).toBe('Lat')
    expect(h.labels[h.channels.indexOf(49)]).toBe('Lon')
    expect(h.labels[h.channels.indexOf(5)]).toBe('TWS')
    expect(h.labels.length).toBe(h.channels.length)
  })

  it('refuses a mismatched pair rather than mapping onto the wrong fields', () => {
    const bad = '!Boat,Utc,BSP,AWA\n!boat,0,1\n!log=v3\n0,123,1,4.5\n'
    expect(parseLogV3Header(bad)).toBeNull()
    expect(isLogV3(bad)).toBe(false)
  })
})

describe('expansion', () => {
  it('produces fixed columns whose first line no longer starts with "!"', () => {
    const out = expandLogV3(FILE)
    expect(out.startsWith('Utc,BSP,AWA')).toBe(true)
    expect(isFlatOleLog(out)).toBe(true)   // now the existing parser accepts it
  })

  it('places each value under its own channel, not by position', () => {
    const out = expandLogV3(FILE).split('\n')
    const cols = out[0].split(',')
    const row = out[2].split(',')          // ROW_FULL
    expect(row[cols.indexOf('Utc')]).toBe('134328055775865592')
    expect(row[cols.indexOf('TWS')]).toBe('13.2056')
    expect(row[cols.indexOf('AWS')]).toBe('12.4098')
    expect(row[cols.indexOf('Lat')]).toBe('41.135162')
    expect(row[cols.indexOf('Lon')]).toBe('9.532466')
    // The bug a positional read would cause: BSP taking a channel NUMBER as a value.
    expect(row[cols.indexOf('BSP')]).toBe('0.000000')
  })

  it('carries absent channels forward instead of blanking the chart', () => {
    const out = expandLogV3(FILE).split('\n')
    const cols = out[0].split(',')
    // row 1 is marks-only: no TWS in the source line at all
    expect(out[1].split(',')[cols.indexOf('TWS')]).toBe('')      // nothing yet to carry
    // marks are absent from ROW_FULL, so they should persist from the marks-only row
    expect(out[2].split(',')[cols.indexOf('Port lat')]).toBe('43.169903')
  })

  it('can blank instead, when asked', () => {
    const out = expandLogV3(FILE, { carryForward: false }).split('\n')
    const cols = out[0].split(',')
    expect(out[2].split(',')[cols.indexOf('Port lat')]).toBe('')
  })

  it('passes a non-v3 file through untouched', () => {
    const plain = 'Utc,BSP\n2026-09-02 06:52,4.1'
    expect(expandLogV3(plain)).toBe(plain)
  })
})

describe('end to end through parseLog', () => {
  it('yields rows with real values — the whole point', () => {
    const r = parseLog(FILE)
    expect(r.format).toBe('log-v3')
    expect(r.rows.length).toBeGreaterThan(0)
    const withWind = r.rows.find((x: any) => x.tws != null)!
    expect(withWind).toBeDefined()
    expect(withWind.tws).toBeCloseTo(13.2056, 3)
    expect(withWind.lat).toBeCloseTo(41.135162, 5)
    expect(withWind.lon).toBeCloseTo(9.532466, 5)
  })

  it('decodes the FILETIME timestamp to 2026-09-02 06:52 UTC', () => {
    const r = parseLog(FILE)
    const t = new Date(r.rows[r.rows.length - 1].utc)
    expect(t.toISOString().slice(0, 16)).toBe('2026-09-02T06:52')
  })

  it('reproduces the old outcome: without the channel map it falls to NMEA and yields 0 rows', () => {
    // Strip the `!boat,0,1,2,…` line — now there is no map, so detection cannot
    // see v3, isFlatOleLog still rejects the leading `!`, and the file goes to the
    // legacy NMEA parser. That is exactly what happened to every v3 log before
    // this format existed: uploaded, badged "log", zero rows, empty chart.
    const noMap = FILE.split('\n').filter((l) => !/^!boat,/.test(l)).join('\n')
    expect(isLogV3(noMap)).toBe(false)
    const legacy = parseLog(noMap)
    expect(legacy.format).toBe('flat-nmea')
    expect(legacy.rows.length).toBe(0)
  })

  it('detects v3 by STRUCTURE, not by the literal "Boat" token', () => {
    // A differently-named leading token must still parse — the map is what matters.
    const renamed = FILE.replace('!Boat,', '!Vessel,').replace('!boat,', '!vessel,')
    expect(detectLogFormat(renamed)).toBe('log-v3')
    expect(parseLog(renamed).rows.length).toBeGreaterThan(0)
  })
})
