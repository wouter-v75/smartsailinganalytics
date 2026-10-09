import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
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

  // ── What a mismatched pair means, and what it does not ──────────────────
  //
  // This used to refuse ANY file whose two header lines were different lengths,
  // on the grounds that the alignment could not be trusted. Baraka GP's export
  // is exactly that file — 352 labels, 194 numbers, the number line ending in a
  // dangling comma — and refusing it meant the whole log read as 'unknown'.
  //
  // Length was never the real question. Alignment runs from the LEFT, so a
  // short number line costs the tail and cannot disturb the head. The danger is
  // a line that lost an entry in the MIDDLE: that stays well-formed, stays
  // strictly increasing, and shifts every field after the gap onto its
  // neighbour's values. A length check never caught that one — equal lengths
  // were waved straight through. Known channel numbers do catch it, and they
  // are what decides now.

  it('reads the verified prefix when the number line is short, and says what it could not map', () => {
    const short = '!Boat,Utc,BSP,AWA\n!boat,0,1\n!log=v3\n0,123,1,4.5\n'
    const h = parseLogV3Header(short)!
    expect(h).not.toBeNull()
    expect(h.labels).toEqual(['Utc', 'BSP'])
    expect(h.channels).toEqual([0, 1])
    // Not dropped silently: AWA has no number, so a sparse row cannot say which
    // cell is AWA, and whoever is missing it can be told why.
    expect(h.unmapped).toEqual(['AWA'])
    expect(h.allLabels).toEqual(['Utc', 'BSP', 'AWA'])
  })

  it('REFUSES a map shifted by a missing entry, which is the case that matters', () => {
    // Channel 1 gone from the middle: BSP now sits against 2, AWA against 3 —
    // every instrument reading its neighbour's values. Both lines are the same
    // length, so the old length check passed this through.
    const shifted = '!Boat,Utc,BSP,AWA,AWS\n!boat,0,2,3,4\n!log=v3\n0,123,2,4.5\n'
    expect(parseLogV3Header(shifted)).toBeNull()
    expect(isLogV3(shifted)).toBe(false)
    expect(parseLog(shifted).format).toBe('unknown')
  })

  it('refuses a channel list that does not increase — not a channel list at all', () => {
    expect(parseLogV3Header('!Boat,Utc,BSP,AWA\n!boat,0,2,2\n!log=v3\n0,1\n')).toBeNull()
  })

  it('needs two known channels before it believes the alignment', () => {
    // Nothing recognisable to check against: no claim is made on the file.
    const unknown = '!Boat,Foo,Bar,Baz\n!boat,3,7,9\n!log=v3\n3,1\n'
    expect(parseLogV3Header(unknown)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Baraka GP, 2026-10-08. The two header lines verbatim, from the fixture.
// ─────────────────────────────────────────────────────────────────────────────
describe('Baraka GP', () => {
  const HEADER = readFileSync(
    resolve(__dirname, 'fixtures/baraka-gp-header.csv'), 'utf8'
  ).replace(/\n$/, '')
  const BARAKA = `${HEADER}\n!v12.9.2\n!log=v3\n`

  it('is recognised, trailing comma and all', () => {
    expect(isLogV3(BARAKA)).toBe(true)
    expect(detectLogFormat(BARAKA)).toBe('log-v3')
  })

  it('pairs its labels onto the channel numbers two other files agree on', () => {
    const h = parseLogV3Header(BARAKA)!
    expect(h.labels[0]).toBe('Utc')
    expect(h.channels[0]).toBe(0)
    expect(h.labels[h.channels.indexOf(48)]).toBe('Lat')
    expect(h.labels[h.channels.indexOf(49)]).toBe('Lon')
    expect(h.labels[h.channels.indexOf(50)]).toBe('COG')
    expect(h.labels[h.channels.indexOf(51)]).toBe('SOG')
    // It logs 7 and 8, which the N76 does not — the lists are per-boat, which
    // is the whole reason they have to be checked rather than assumed.
    expect(h.labels[h.channels.indexOf(7)]).toBe('RudderFwd')
  })

  it('reports the 158 channels its truncated number line cannot reach', () => {
    const h = parseLogV3Header(BARAKA)!
    expect(h.channels.length).toBe(194)
    expect(h.allLabels.length).toBe(352)
    expect(h.unmapped.length).toBe(158)
    // The ones worth knowing about: targets, start burns, batten positions.
    expect(h.unmapped).toContain('Targ Bsp')
    expect(h.unmapped).toContain('StBsToP')
    expect(h.unmapped).toContain('V0 P')
    // And the ones that still arrive, which is most of what the app reads.
    expect(h.labels).toContain('Heel')
    expect(h.labels).toContain('TWS')
    expect(h.labels).toContain('RH')
  })

  it('carries its sparse rows through to real instrument values', () => {
    const h = parseLogV3Header(BARAKA)!
    const ch = (name: string) => h.channels[h.labels.indexOf(name)]
    // 2026-10-08 09:05 UTC, as a Windows FILETIME.
    const t = (Date.UTC(2026, 9, 8, 9, 5) + 11644473600000) * 10000
    const row = [
      `${ch('Utc')},${t}`, `${ch('BSP')},9.42`, `${ch('TWS')},14.80`,
      `${ch('TWA')},-42.10`, `${ch('Heel')},22.40`, `${ch('Lat')},43.169903`,
      `${ch('Lon')},5.643753`, `${ch('RH')},61.0`,
    ].join(',')
    const r = parseLog(`${BARAKA}${row}\n`)
    expect(r.format).toBe('log-v3')
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].bsp).toBeCloseTo(9.42, 2)
    expect(r.rows[0].tws).toBeCloseTo(14.8, 2)
    expect(r.rows[0].heel).toBeCloseTo(22.4, 2)
    expect(r.rows[0].lat).toBeCloseTo(43.169903, 5)
    expect(r.rows[0].rh).toBeCloseTo(61, 1)
    expect(new Date(r.rows[0].utc).toISOString().slice(0, 16)).toBe('2026-10-08T09:05')
  })

  it('reads a DENSE row too — one value per label, map or no map', () => {
    // If the export writes a value per column instead of channel/value pairs,
    // the channel numbers stop mattering: the labels are the column order, so
    // all 352 are readable, truncated number line and all.
    const h = parseLogV3Header(BARAKA)!
    const t = (Date.UTC(2026, 9, 8, 9, 5) + 11644473600000) * 10000
    const cells = h.allLabels.map((l) =>
      l === 'Utc' ? String(t)
      : l === 'BSP' ? '9.42'
      : l === 'TWS' ? '14.80'
      : l === 'Targ Bsp' ? '9.80'          // beyond the number line; dense reaches it
      : l === 'Lat' ? '43.169903'
      : l === 'Lon' ? '5.643753'
      : '0'
    )
    const r = parseLog(`${BARAKA}${cells.join(',')}\n`)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].bsp).toBeCloseTo(9.42, 2)
    expect(r.rows[0].tws).toBeCloseTo(14.8, 2)
    expect(r.rows[0].vsTarget).toBeCloseTo(9.8, 2)
    expect(r.rows[0].lat).toBeCloseTo(43.169903, 5)
  })

  it('does not read a dense file as pairs, or a sparse one as dense', () => {
    const h = parseLogV3Header(BARAKA)!
    const t = (Date.UTC(2026, 9, 8, 9, 5) + 11644473600000) * 10000
    // A decimal in an even cell is what gives a dense row away: 9.42 is not a
    // channel number, so the pairs reading cannot survive it.
    const dense = h.allLabels.map((l) => (l === 'Utc' ? String(t) : l === 'BSP' ? '9.42' : '0'))
    const out = expandLogV3(`${BARAKA}${dense.join(',')}\n`).split('\n')
    expect(out[0].split(',').length).toBe(352)
    const sparse = expandLogV3(`${BARAKA}0,${t},1,9.42\n`).split('\n')
    expect(sparse[0].split(',').length).toBe(194)
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

  it('without the channel map it is UNRECOGNISED — no longer mislabelled as NMEA', () => {
    // Strip the `!boat,0,1,2,…` line: detection cannot see v3, and isFlatOleLog
    // still rejects the leading `!`.
    //
    // It used to land on 'flat-nmea', because that was the fallback for anything
    // unrecognised — so a v3 log with a missing map was reported as a legacy N72
    // export, uploaded, badged "log", and showed zero rows and an empty chart
    // with nothing to say the format had not been understood. 'flat-nmea' now
    // requires a POSITIVE match, so this reads as what it is: unknown.
    const noMap = FILE.split('\n').filter((l) => !/^!boat,/.test(l)).join('\n')
    expect(isLogV3(noMap)).toBe(false)
    const legacy = parseLog(noMap)
    expect(legacy.format).toBe('unknown')
    expect(legacy.rows.length).toBe(0)
  })

  it('detects v3 by STRUCTURE, not by the literal "Boat" token', () => {
    // A differently-named leading token must still parse — the map is what matters.
    const renamed = FILE.replace('!Boat,', '!Vessel,').replace('!boat,', '!vessel,')
    expect(detectLogFormat(renamed)).toBe('log-v3')
    expect(parseLog(renamed).rows.length).toBeGreaterThan(0)
  })
})
