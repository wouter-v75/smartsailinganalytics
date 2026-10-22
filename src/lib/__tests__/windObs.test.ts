import { describe, it, expect } from 'vitest'
import {
  parseMetar, parseFfvl, isoFromFfvl, to10m, obs10mKn, ageMinutes, isStale, withinNm, OBS_SOURCES,
  parseMfMarine, parseMfStationList, isoFromMf,
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
// Field names are the Météo-France/SYNOP convention (dd/ff/fxi). They are NOT
// published for the marine endpoints, so these fixtures are the expected shape
// rather than a captured payload — scripts/mf-obs-probe.ts replaces them with
// the real thing, the way METAR_LIVE above was captured.

const MF_BUOY = [
  { id_station: '6200001', nom_usuel: 'Golfe du Lion', lat: 42.1, lon: 4.7,
    validity_time: '2026-10-22T09:00:00Z', dd: 290, ff: 9.3, fxi: 13.4 },
]

describe('parseMfMarine', () => {
  it('converts m/s to knots and lands on the water', () => {
    const [o] = parseMfMarine(MF_BUOY, 'buoy')
    expect(o).toMatchObject({ id: 'mf-buoy:6200001', source: 'buoy', surface: 'sea', twdDeg: 290 })
    expect(o.twsKn).toBeCloseTo(9.3 * 1.943844, 6)
    expect(o.gustKn!).toBeCloseTo(13.4 * 1.943844, 6)
    expect(o.t).toBe('2026-10-22T09:00:00.000Z')
    expect(o.trust).toBe(OBS_SOURCES.buoy.trust)
  })

  it('publishes no anemometer height, and sits at sea level', () => {
    // No height = no correction (to10m refuses it), which is the honest answer:
    // MF does not say how high a buoy's anemometer is. elevM is 0 because the
    // thing floats -- its ground level IS the water the race is on.
    const [o] = parseMfMarine(MF_BUOY, 'buoy')
    expect(o.heightM).toBeNull()
    expect(o.elevM).toBe(0)
    expect(obs10mKn(o)).toBeNull()
  })

  it('reads the same payload as a ship when told to', () => {
    const [o] = parseMfMarine(MF_BUOY, 'ship')
    expect(o.id).toBe('mf-ship:6200001')
    expect(o.source).toBe('ship')
    expect(o.trust).toBe(OBS_SOURCES.ship.trust)
    expect(OBS_SOURCES.ship.trust).toBeLessThan(OBS_SOURCES.buoy.trust)
  })

  it('REFUSES a speed that implies the wrong unit', () => {
    // The failure this adapter most has to fear: km/h read as m/s multiplies
    // every speed by 3.6 and still looks plausible in light airs. 35 kn of real
    // breeze comes back as 126 kn, so the tripwire is above any sailable wind.
    const kmh = [{ ...MF_BUOY[0], ff: 70 }]              // 70 m/s = 136 kn
    expect(parseMfMarine(kmh, 'buoy')).toHaveLength(0)
    const ok = [{ ...MF_BUOY[0], ff: 25 }]               // 25 m/s = 48.6 kn, a real gale
    expect(parseMfMarine(ok, 'buoy')).toHaveLength(1)
  })

  it('drops an implausible GUST without losing the mean wind', () => {
    const [o] = parseMfMarine([{ ...MF_BUOY[0], fxi: 99 }], 'buoy')
    expect(o.gustKn).toBeNull()
    expect(o.twsKn).toBeCloseTo(9.3 * 1.943844, 6)
  })

  it('treats calm as calm, not as a westerly', () => {
    const [o] = parseMfMarine([{ ...MF_BUOY[0], ff: 0 }], 'buoy')
    expect(o.twsKn).toBe(0)
    expect(o.twdDeg).toBeNull()
  })

  it('places a row from the station list when it omits its own position', () => {
    const meta = new Map([['6200001', { name: 'Golfe du Lion', lat: 42.1, lon: 4.7 }]])
    const bare = [{ id_station: '6200001', validity_time: '2026-10-22T09:00:00Z', ff: 5, dd: 10 }]
    const [o] = parseMfMarine(bare, 'buoy', meta)
    expect([o.lat, o.lon]).toEqual([42.1, 4.7])
    expect(o.name).toBe('Golfe du Lion')
  })

  it('survives junk and drops rows with no wind or no position', () => {
    expect(parseMfMarine([], 'buoy')).toHaveLength(0)
    expect(parseMfMarine(null as never, 'buoy')).toHaveLength(0)
    expect(parseMfMarine([null, 'x', 7] as never, 'buoy')).toHaveLength(0)
    expect(parseMfMarine([{ ...MF_BUOY[0], ff: undefined }], 'buoy')).toHaveLength(0)
    expect(parseMfMarine([{ id_station: 'X', ff: 5, validity_time: '2026-10-22T09:00:00Z' }], 'buoy')).toHaveLength(0)
  })
})

describe('isoFromMf', () => {
  it('keeps a zoned stamp', () => {
    expect(isoFromMf('2026-10-22T09:00:00Z')).toBe('2026-10-22T09:00:00.000Z')
    expect(isoFromMf('2026-10-22T11:00:00+02:00')).toBe('2026-10-22T09:00:00.000Z')
  })
  it('REFUSES a zone-less stamp rather than assuming UTC', () => {
    // CLAUDE.md's standing trap: every other clock in this project is venue-local
    // even when it is called UTC. If MF ever drops the Z, silence beats a reading
    // that is two hours out and looks fresh.
    expect(isoFromMf('2026-10-22 09:00:00')).toBeNull()
    expect(isoFromMf('not a time')).toBeNull()
  })
})

describe('parseMfStationList', () => {
  it('reads a semicolon CSV with comma decimals', () => {
    const csv = 'Id_station;Nom_usuel;Latitude;Longitude\n6200001;Golfe du Lion;42,100;4,700\n'
    const m = parseMfStationList(csv)
    expect(m.get('6200001')).toEqual({ name: 'Golfe du Lion', lat: 42.1, lon: 4.7 })
  })

  it('reads a comma CSV with dot decimals', () => {
    const m = parseMfStationList('id_station,nom,lat,lon\n6200002,Nice,43.5,7.2\n')
    expect(m.get('6200002')).toEqual({ name: 'Nice', lat: 43.5, lon: 7.2 })
  })

  it('returns an empty map rather than throwing on junk', () => {
    expect(parseMfStationList('').size).toBe(0)
    expect(parseMfStationList('nothing;useful\n1;2\n').size).toBe(0)   // no id column
    expect(parseMfStationList(null as never).size).toBe(0)
  })

  it('keeps a station whose position is missing, so the data row can supply it', () => {
    const m = parseMfStationList('id_station;nom\n6200003;Unknown\n')
    expect(m.get('6200003')).toEqual({ name: 'Unknown', lat: undefined, lon: undefined })
  })
})
