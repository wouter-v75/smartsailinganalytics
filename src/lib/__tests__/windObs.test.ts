import { describe, it, expect } from 'vitest'
import {
  parseMetar, parseFfvl, isoFromFfvl, to10m, obs10mKn, ageMinutes, isStale, withinNm, OBS_SOURCES,
  parseMfCsv, parseMfMarine, parseMfStationList, latestPerStation, isoFromMf,
} from '../windObs'

// Captured live from aviationweather.gov on 2026-10-18, bbox around St Tropez.
// Trimmed to the fields the adapter reads, values untouched.
const METAR_LIVE = [
  { icaoId: 'LFMD', obsTime: 1792306800, wdir: 360, wspd: 5, lat: 43.544, lon: 6.953, elev: 2, name: 'Cannes/Mandelieu Arpt, PA, FR' },
  { icaoId: 'LFMC', obsTime: 1792306800, wdir: 'VRB', wspd: 1, lat: 43.383, lon: 6.386, elev: 79, name: 'Le Luc Arpt, PA, FR' },
  { icaoId: 'LFTH', obsTime: 1792306800, wdir: 320, wspd: 6, wgst: 18, lat: 43.094, lon: 6.146, elev: 3, name: 'Toulon/Hyères Arpt, PA, FR' },
]

describe('parseMetar', () => {
  it('reads the live payload', () => {
    const o = parseMetar(METAR_LIVE)
    expect(o.map((x) => x.id)).toEqual(['metar:LFMD', 'metar:LFMC', 'metar:LFTH'])
    expect(o[0]).toMatchObject({ source: 'metar', twsKn: 5, twdDeg: 360, heightM: 10, surface: 'land', elevM: 2 })
    expect(o[0].t).toBe('2026-10-18T07:00:00.000Z')
    expect(o[2].gustKn).toBe(18)
  })

  it('does not point a VARIABLE wind at north', () => {
    // wdir comes back as the STRING "VRB" — Number("VRB") is NaN, and a NaN that
    // reaches the map draws a barb pointing somewhere definite and wrong.
    const vrb = parseMetar(METAR_LIVE)[1]
    expect(vrb.twdDeg).toBeNull()
    expect(vrb.twsKn).toBe(1)          // the SPEED is still a real measurement
  })

  it('reports a northerly as 360, not 0 — caught live at Cannes', () => {
    // wdir 360 through a bare modulo becomes 0, and the tooltip reads "from 0°".
    // 000 is only ever calm in a METAR, so the two must not collapse together.
    expect(parseMetar(METAR_LIVE)[0].twdDeg).toBe(360)
    expect(parseMetar([{ icaoId: 'N', obsTime: 1792306800, wdir: 0, wspd: 7, lat: 43, lon: 6 }])[0].twdDeg).toBe(360)
  })

  it('treats 00000KT as calm, not as a northerly', () => {
    const calm = parseMetar([{ icaoId: 'XXXX', obsTime: 1792306800, wdir: 0, wspd: 0, lat: 43, lon: 6 }])[0]
    expect(calm.twsKn).toBe(0)
    expect(calm.twdDeg).toBeNull()
  })

  it('drops rows that carry no wind at all, and survives junk', () => {
    expect(parseMetar([{ icaoId: 'NOWIND', obsTime: 1792306800, lat: 43, lon: 6 }])).toHaveLength(0)
    expect(parseMetar([{ icaoId: 'NOPOS', obsTime: 1792306800, wspd: 9 }])).toHaveLength(0)
    expect(parseMetar([])).toHaveLength(0)
    expect(parseMetar(null as never)).toHaveLength(0)
    expect(parseMetar([null, 'x', 42] as never)).toHaveLength(0)
  })
})

describe('to10m', () => {
  it('leaves a 10 m reading alone', () => {
    expect(to10m(12, 10, 'land')).toBeCloseTo(12, 12)
    expect(to10m(12, 10, 'sea')).toBeCloseTo(12, 12)
  })

  it('scales a mast reading DOWN and a low one UP', () => {
    expect(to10m(12, 20, 'land')!).toBeLessThan(12)
    expect(to10m(12, 4, 'land')!).toBeGreaterThan(12)
  })

  it('corrects less over water, because the sea is smoother', () => {
    // Same 20 m mast: over a rough land surface the profile is steeper, so the
    // step down to 10 m is bigger.
    const land = 12 - to10m(12, 20, 'land')!
    const sea = 12 - to10m(12, 20, 'sea')!
    expect(land).toBeGreaterThan(sea)
  })

  it('refuses to correct what it cannot know', () => {
    // A guessed height is worse than no correction: it looks like a measurement.
    expect(to10m(12, null, 'land')).toBeNull()
    expect(to10m(12, 0, 'land')).toBeNull()
    expect(to10m(null, 10, 'land')).toBeNull()
    expect(to10m(-1, 10, 'land')).toBeNull()
    expect(to10m(12, 0.001, 'land')).toBeNull()      // below the roughness length
  })

  it('obs10mKn is null for a station with no published height', () => {
    const [beacon] = parseFfvl([{ idbalise: 7, latitude: 43.1, longitude: 6.2, vitesseVentMoy: 37, directVentMoy: 270, date: '2026-10-18 09:00:00' }])
    expect(beacon.heightM).toBeNull()
    expect(obs10mKn(beacon)).toBeNull()
    expect(beacon.twsKn).toBeCloseTo(37 * 0.539957, 6)   // as measured, still there
  })
})

describe('parseFfvl', () => {
  it('converts km/h to knots and joins the metadata on balise id', () => {
    const o = parseFfvl(
      [{ idbalise: 12, latitude: 43.12, longitude: 6.14, vitesseVentMoy: 18.52, vitesseVentMax: 27.78, directVentMoy: 315, date: '2026-10-18 09:05:00' }],
      [{ idBalise: 12, nom: 'Hyères plage', altitude: 4 }],
    )
    expect(o).toHaveLength(1)
    expect(o[0].name).toBe('Hyères plage')
    expect(o[0].elevM).toBe(4)
    expect(o[0].twsKn).toBeCloseTo(10, 2)
    expect(o[0].gustKn).toBeCloseTo(15, 2)
    expect(o[0].source).toBe('beacon')
  })

  it('still reports a beacon whose metadata is missing', () => {
    const o = parseFfvl([{ idbalise: 99, latitude: 43, longitude: 6, vitesseVentMoy: 10, date: '2026-10-18 09:05:00' }])
    expect(o[0].name).toBe('FFVL 99')
    expect(o[0].elevM).toBeNull()
  })
})

describe('isoFromFfvl', () => {
  it('does not read a zone-less local stamp as UTC', () => {
    // Paris is +2 in October BST/CEST; read as UTC the beacon looks 2 h fresher
    // than it is, then goes abruptly stale. Same trap as the log exports.
    expect(isoFromFfvl('2026-10-18 09:05:00', 2)).toBe('2026-10-18T07:05:00.000Z')
    expect(isoFromFfvl('2026-10-18 09:05:00', 0)).toBe('2026-10-18T09:05:00.000Z')
  })
  it('returns null rather than an Invalid Date', () => {
    expect(isoFromFfvl('not a time')).toBeNull()
  })
})

describe('age and staleness', () => {
  const now = Date.parse('2026-10-18T09:00:00Z')
  const at = (iso: string) => parseMetar([{ icaoId: 'A', obsTime: Date.parse(iso) / 1000, wdir: 10, wspd: 10, lat: 43, lon: 6 }])[0]

  it('measures age in minutes', () => {
    expect(ageMinutes(at('2026-10-18T08:30:00Z'), now)).toBeCloseTo(30, 6)
  })
  it('calls a station stale once it is lying rather than reporting', () => {
    expect(isStale(at('2026-10-18T08:30:00Z'), now)).toBe(false)
    expect(isStale(at('2026-10-18T06:00:00Z'), now)).toBe(true)
  })
})

describe('withinNm', () => {
  it('keeps the nearby stations, nearest first, and drops the far ones', () => {
    const o = parseMetar(METAR_LIVE)
    // Measured from point 1: Le Luc 14.3 nm, Cannes 20.1, Hyeres 25.6.
    const near = withinNm(o, 43.275, 6.678, 30)          // point 1, St Tropez
    expect(near.map((x) => x.id)).toEqual(['metar:LFMC', 'metar:LFMD', 'metar:LFTH'])
    expect(withinNm(o, 43.275, 6.678, 15).map((x) => x.id)).toEqual(['metar:LFMC'])
    expect(withinNm(o, 43.275, 6.678, 1)).toHaveLength(0)
    const d = near.map((x) => Math.hypot((x.lat - 43.275) * 60, (x.lon - 6.678) * 60 * Math.cos(43.275 * Math.PI / 180)))
    expect([...d].sort((a, b) => a - b)).toEqual(d)
  })
})

describe('OBS_SOURCES', () => {
  it('ranks our own boat above a buoy above a rooftop', () => {
    expect(OBS_SOURCES.ours.trust).toBeGreaterThan(OBS_SOURCES.buoy.trust)
    expect(OBS_SOURCES.buoy.trust).toBeGreaterThan(OBS_SOURCES.metar.trust)
    expect(OBS_SOURCES.metar.trust).toBeGreaterThan(OBS_SOURCES.pws.trust)
  })
  it('gives every source a distinct colour, since that is the whole legend', () => {
    const cols = Object.values(OBS_SOURCES).map((s) => s.colour)
    expect(new Set(cols).size).toBe(cols.length)
  })
})

// ── Météo-France marine ─────────────────────────────────────────────────────
// Captured live from DPObs v2 /liste-bouees on 2026-10-22 by
// scripts/mf-obs-probe.ts. Header and rows verbatim — including the EMPTY pmer
// cell in the first row, which is the whole reason parseMfCsv may not coerce a
// blank to zero.
const MF_BUOY_CSV = [
  'lat;lon;geo_id_wmo;geo_id_wigos;name;reference_time;insert_time;validity_time;t;td;u;dd;ff;pmer;tmer;haut_vag;per_moy_vag;dir_vag;rafper;per',
  '16.23;-59.16;4100230;0-250-0-97110001;BOUEE_ANTILLES;2026-10-21T02:08:05Z;2026-10-21T02:03:20Z;2026-10-21T02:00:00Z;302.15;297.95;78.0;110.0;3.9;;302.75;1.4;6.0;65.0;5.6;-10',
  '16.23;-59.16;4100230;0-250-0-97110001;BOUEE_ANTILLES;2026-10-21T14:08:04Z;2026-10-21T14:03:22Z;2026-10-21T13:00:00Z;302.25;297.85;77.0;100.0;2.1;101470.0;302.75;1.3;7.0;60.0;3.4;-10',
].join('\n')

// /liste-bateaux, same day. Note it really IS a list: no position, no wind.
const MF_SHIP_LIST_CSV = [
  'geo_id_wmo;geo_id_wigos;name',
  'ADFBKUM;0-22000-0-ADFBKUM;AKNOUL',
  'CNGUSYM;0-22000-0-CNGUSYM;COTES DE LA MANCHE',
].join('\n')

describe('parseMfCsv', () => {
  it('reads the live semicolon header', () => {
    const rows = parseMfCsv(MF_BUOY_CSV)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ lat: 16.23, lon: -59.16, dd: 110, ff: 3.9, rafper: 5.6 })
  })

  it('leaves an EMPTY cell absent rather than reading it as zero', () => {
    // Number('') is 0. A missing sea-level pressure silently becoming 0 Pa is
    // exactly the kind of thing that is never noticed.
    const [first, second] = parseMfCsv(MF_BUOY_CSV)
    expect('pmer' in first).toBe(false)
    expect(second.pmer).toBe(101470)
  })

  it('keeps an id as a STRING, whether it looks numeric or not', () => {
    // geo_id_wmo is "4100230" for a buoy and "ADFBKUM" for a ship. Coercing the
    // first would eat a leading zero and make the two kinds behave differently.
    expect(parseMfCsv(MF_BUOY_CSV)[0].geo_id_wmo).toBe('4100230')
    expect(parseMfCsv(MF_SHIP_LIST_CSV)[0].geo_id_wmo).toBe('ADFBKUM')
  })

  it('survives junk', () => {
    expect(parseMfCsv('')).toHaveLength(0)
    expect(parseMfCsv('only;a;header')).toHaveLength(0)
    expect(parseMfCsv(null as never)).toHaveLength(0)
  })
})

describe('parseMfMarine', () => {
  it('reads the live buoy row', () => {
    const o = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    expect(o).toHaveLength(2)
    expect(o[0]).toMatchObject({
      id: 'mf-buoy:4100230', source: 'buoy', name: 'BOUEE_ANTILLES',
      lat: 16.23, lon: -59.16, surface: 'sea', twdDeg: 110,
    })
    expect(o[0].twsKn).toBeCloseTo(3.9 * 1.943844, 6)      // 7.6 kn
    expect(o[0].gustKn!).toBeCloseTo(5.6 * 1.943844, 6)    // rafper, not fxi
    expect(o[0].t).toBe('2026-10-21T02:00:00.000Z')
    expect(o[0].trust).toBe(OBS_SOURCES.buoy.trust)
  })

  it('publishes no anemometer height, and sits at sea level', () => {
    // No height = no correction (to10m refuses it), which is the honest answer:
    // MF does not say how high a buoy's anemometer is. elevM is 0 because the
    // thing floats — its ground level IS the water the race is on.
    const [o] = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    expect(o.heightM).toBeNull()
    expect(o.elevM).toBe(0)
    expect(obs10mKn(o)).toBeNull()
  })

  it('reads the same shape as a ship when told to', () => {
    const [o] = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'ship')
    expect(o.id).toBe('mf-ship:4100230')
    expect(o.trust).toBe(OBS_SOURCES.ship.trust)
    expect(OBS_SOURCES.ship.trust).toBeLessThan(OBS_SOURCES.buoy.trust)
  })

  it('names a ship from the list, which is all the list carries', () => {
    const meta = parseMfStationList(MF_SHIP_LIST_CSV)
    const row = [{ geo_id_wmo: 'CNGUSYM', lat: 49.9, lon: -1.2, ff: 6, dd: 250, validity_time: '2026-10-21T13:00:00Z' }]
    const [o] = parseMfMarine(row, 'ship', meta)
    expect(o.name).toBe('COTES DE LA MANCHE')
  })

  it('REFUSES a speed that implies the wrong unit', () => {
    // The corroboration that ff is m/s is that t comes back as 302.15 K and pmer
    // as 101470 Pa — the feed is SI throughout. If it were ever km/h, every
    // speed would be 3.6x too big and still plausible in light airs.
    const fast = parseMfCsv(MF_BUOY_CSV.replace(';3.9;;', ';70;;'))
    expect(parseMfMarine(fast, 'buoy').filter((o) => o.t.endsWith('02:00:00.000Z'))).toHaveLength(0)
  })

  it('drops an implausible GUST without losing the mean wind', () => {
    const [o] = parseMfMarine([{ geo_id_wmo: 'X', lat: 16, lon: -59, ff: 3.9, rafper: 99, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    expect(o.gustKn).toBeNull()
    expect(o.twsKn).toBeCloseTo(3.9 * 1.943844, 6)
  })

  it('treats calm as calm, not as a southerly', () => {
    const [o] = parseMfMarine([{ geo_id_wmo: 'X', lat: 16, lon: -59, ff: 0, dd: 180, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    expect(o.twsKn).toBe(0)
    expect(o.twdDeg).toBeNull()
  })

  it('survives junk and drops rows with no wind, id or position', () => {
    expect(parseMfMarine([], 'buoy')).toHaveLength(0)
    expect(parseMfMarine(null as never, 'buoy')).toHaveLength(0)
    expect(parseMfMarine([null, 'x', 7] as never, 'buoy')).toHaveLength(0)
    expect(parseMfMarine([{ lat: 16, lon: -59, ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')).toHaveLength(0)
    expect(parseMfMarine([{ geo_id_wmo: 'X', ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')).toHaveLength(0)
  })
})

describe('latestPerStation', () => {
  it('keeps the newest reading per buoy, not both', () => {
    // The live file held the SAME buoy at 02:00 and 13:00. Drawing both puts
    // this morning's wind on the map beside this afternoon's.
    const all = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    expect(all).toHaveLength(2)
    const latest = latestPerStation(all)
    expect(latest).toHaveLength(1)
    expect(latest[0].t).toBe('2026-10-21T13:00:00.000Z')
    expect(latest[0].twsKn).toBeCloseTo(2.1 * 1.943844, 6)
  })

  it('leaves distinct stations alone', () => {
    const a = parseMfMarine([{ geo_id_wmo: 'A', lat: 1, lon: 1, ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    const b = parseMfMarine([{ geo_id_wmo: 'B', lat: 2, lon: 2, ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    expect(latestPerStation([...a, ...b])).toHaveLength(2)
  })
})

describe('isoFromMf', () => {
  it('keeps a zoned stamp', () => {
    expect(isoFromMf('2026-10-21T02:00:00Z')).toBe('2026-10-21T02:00:00.000Z')
    expect(isoFromMf('2026-10-21T04:00:00+02:00')).toBe('2026-10-21T02:00:00.000Z')
  })
  it('REFUSES a zone-less stamp rather than assuming UTC', () => {
    // CLAUDE.md's standing trap: every other clock in this project is venue-local
    // even when it is called UTC. If MF ever drops the Z, silence beats a reading
    // that is two hours out and looks fresh.
    expect(isoFromMf('2026-10-21 02:00:00')).toBeNull()
    expect(isoFromMf('not a time')).toBeNull()
  })
})

describe('parseMfStationList', () => {
  it('reads the live ship list', () => {
    const m = parseMfStationList(MF_SHIP_LIST_CSV)
    expect(m.size).toBe(2)
    expect(m.get('ADFBKUM')).toEqual({ name: 'AKNOUL', lat: undefined, lon: undefined })
  })
  it('returns an empty map rather than throwing on junk', () => {
    expect(parseMfStationList('').size).toBe(0)
    expect(parseMfStationList('nothing;useful\n1;2\n').size).toBe(0)
    expect(parseMfStationList(null as never).size).toBe(0)
  })
})
