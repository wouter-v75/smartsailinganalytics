import { describe, expect, it } from 'vitest'
import { parsePortlog, parsePortlogLatestUrl, OBS_SOURCES, PORTLOG_CLOCK_TOL_SEC } from '../windObs'
import { portlogInReach, PORTLOG_SEA_SITES, PORTLOG_REACH_NM } from '../obsSources'

// Shapes taken from the real feed on 22 Oct 2026 — three levels deep, keyed by
// number at each, and every record repeating its site's name and position.
const NOW_SEC = 1792700250
const NOW_MS = NOW_SEC * 1000

function rec(over: Record<string, unknown> = {}) {
  return {
    idSite: 3306,
    Site_Code: 'ABPS-TW06',
    Site_Name: 'Bramble',
    Site_Cluster: 'Southampton',
    Latitude: 50.79,
    Longitude: -1.286,
    idDataset: 5,
    Dataset_Name: 'Met',
    DateTime: NOW_SEC - 57,
    Age: 57,
    Received: NOW_SEC - 50,
    TimeOut: 360,
    ...over,
  }
}

/** One site with the three wind parameters under the Met dataset. */
function bramble(over: { wind?: Record<string, unknown>; dir?: Record<string, unknown>; gust?: Record<string, unknown> | null } = {}) {
  const met: Record<string, unknown> = {
    '50002': rec({ idParameter: 50002, Parameter_Name: 'Wind Speed', Units: 'Knots', Value: 21.5592331416, ...over.wind }),
    '50003': rec({ idParameter: 50003, Parameter_Name: 'Wind Direction', Units: 'Deg', Value: 182.1, ...over.dir }),
  }
  if (over.gust !== null) {
    met['50006'] = rec({ idParameter: 50006, Parameter_Name: 'Gust Speed', Units: 'Knots', Value: 24.045342909, ...over.gust })
  }
  return { '3306': { '5': met } }
}

describe('parsePortlog', () => {
  it('reads Bramble off the live shape', () => {
    const [o] = parsePortlog(bramble(), { nowMs: NOW_MS })
    expect(o.id).toBe('portlog:3306')
    expect(o.name).toBe('Bramble')
    expect(o.source).toBe('port')
    expect(o.twsKn).toBeCloseTo(21.56, 2)
    expect(o.twdDeg).toBeCloseTo(182.1, 1)
    expect(o.gustKn).toBeCloseTo(24.05, 2)
    expect(o.lat).toBeCloseTo(50.79, 3)
    expect(o.lon).toBeCloseTo(-1.286, 3)
    expect(o.t).toBe(new Date((NOW_SEC - 57) * 1000).toISOString())
    expect(o.trust).toBe(OBS_SOURCES.port.trust)
  })

  it('claims no anemometer height, because the network publishes none', () => {
    // A guessed height is worse than none: the correction would then look like
    // a measurement.
    const [o] = parsePortlog(bramble(), { nowMs: NOW_MS })
    expect(o.heightM).toBeNull()
    expect(o.elevM).toBeNull()
  })

  it('ranks above a METAR and below a buoy', () => {
    expect(OBS_SOURCES.port.trust).toBeGreaterThan(OBS_SOURCES.metar.trust)
    expect(OBS_SOURCES.port.trust).toBeLessThan(OBS_SOURCES.buoy.trust)
    expect(OBS_SOURCES.port.trust).toBeGreaterThan(OBS_SOURCES.pws.trust)
  })

  it('finds the parameters wherever the dataset ids put them', () => {
    // The dataset id is not something we should depend on.
    const split = {
      '3306': {
        '5': { '50002': rec({ Units: 'Knots', Value: 18 }) },
        '9': { '50003': rec({ Units: 'Deg', Value: 200 }) },
        '11': { '50006': rec({ Units: 'Knots', Value: 25 }) },
      },
    }
    const [o] = parsePortlog(split, { nowMs: NOW_MS })
    expect(o.twsKn).toBe(18)
    expect(o.twdDeg).toBe(200)
    expect(o.gustKn).toBe(25)
  })

  describe('units are read, never assumed', () => {
    it('converts m/s when the feed says m/s', () => {
      // The same feed publishes Max 15 Minute Gust in m/s while its five
      // siblings are in Knots, so a hardcoded unit is a 2x error waiting.
      const [o] = parsePortlog(bramble({ wind: { Units: 'm/s', Value: 10 } }), { nowMs: NOW_MS })
      expect(o.twsKn).toBeCloseTo(19.44, 2)
    })

    it('refuses a unit it does not recognise rather than guessing knots', () => {
      expect(parsePortlog(bramble({ wind: { Units: 'furlongs/fortnight', Value: 20 } }), { nowMs: NOW_MS })).toEqual([])
      expect(parsePortlog(bramble({ wind: { Units: null, Value: 20 } }), { nowMs: NOW_MS })).toEqual([])
    })

    it('drops a gust whose unit is unreadable without losing the wind', () => {
      const [o] = parsePortlog(bramble({ gust: { Units: 'bananas', Value: 30 } }), { nowMs: NOW_MS })
      expect(o.twsKn).toBeCloseTo(21.56, 2)
      expect(o.gustKn).toBeNull()
    })

    it('refuses a speed past the plausible ceiling', () => {
      expect(parsePortlog(bramble({ wind: { Units: 'Knots', Value: 400 } }), { nowMs: NOW_MS })).toEqual([])
    })
  })

  describe('the clock is checked against itself', () => {
    it('accepts a record whose Age matches now minus DateTime', () => {
      expect(parsePortlog(bramble(), { nowMs: NOW_MS })).toHaveLength(1)
    })

    it('refuses an hour of disagreement — the local-time-read-as-UTC mistake', () => {
      // DateTime an hour behind what Age says: exactly what a venue offset
      // applied to one field and not the other looks like.
      const shifted = bramble({ wind: { DateTime: NOW_SEC - 57 - 3600 } })
      expect(parsePortlog(shifted, { nowMs: NOW_MS })).toEqual([])
      // And an hour the other way.
      expect(parsePortlog(bramble({ wind: { DateTime: NOW_SEC - 57 + 3600 } }), { nowMs: NOW_MS })).toEqual([])
    })

    it('tolerates ordinary caching, which freezes Age while DateTime ages', () => {
      // A response cached ten minutes: Age still says 57, the stamp is older.
      const cached = bramble({ wind: { DateTime: NOW_SEC - 57 - 600 } })
      expect(parsePortlog(cached, { nowMs: NOW_MS })).toHaveLength(1)
      // The tolerance sits between the two cases on purpose.
      expect(PORTLOG_CLOCK_TOL_SEC).toBeGreaterThan(600)
      expect(PORTLOG_CLOCK_TOL_SEC).toBeLessThan(3600)
    })

    it('still parses a record with no Age to check against', () => {
      const noAge = bramble({ wind: { Age: null } })
      expect(parsePortlog(noAge, { nowMs: NOW_MS })).toHaveLength(1)
    })

    it('refuses a record with no usable DateTime', () => {
      expect(parsePortlog(bramble({ wind: { DateTime: 0 } }), { nowMs: NOW_MS })).toEqual([])
      expect(parsePortlog(bramble({ wind: { DateTime: null } }), { nowMs: NOW_MS })).toEqual([])
    })
  })

  describe('direction', () => {
    it('is taken only when the feed says degrees', () => {
      const [o] = parsePortlog(bramble({ dir: { Units: 'radians', Value: 3 } }), { nowMs: NOW_MS })
      expect(o.twdDeg).toBeNull()
      expect(o.twsKn).toBeCloseTo(21.56, 2)
    })

    it('wraps into 0..360', () => {
      expect(parsePortlog(bramble({ dir: { Value: 365 } }), { nowMs: NOW_MS })[0].twdDeg).toBeCloseTo(5, 6)
      expect(parsePortlog(bramble({ dir: { Value: -10 } }), { nowMs: NOW_MS })[0].twdDeg).toBeCloseTo(350, 6)
    })

    it('is null when the site reports none', () => {
      const noDir = { '3306': { '5': { '50002': rec({ Units: 'Knots', Value: 12 }) } } }
      expect(parsePortlog(noDir, { nowMs: NOW_MS })[0].twdDeg).toBeNull()
    })
  })

  describe('surface', () => {
    it('is sea for a site in the fairway', () => {
      const [o] = parsePortlog(bramble(), { nowMs: NOW_MS, seaSites: PORTLOG_SEA_SITES })
      expect(o.surface).toBe('sea')
    })

    it('is land for a mast up in the docks', () => {
      const dock = {
        '3310': {
          '5': {
            '50002': rec({ Site_Code: 'ABPS-TW10', Site_Name: 'Town Quay', Latitude: 50.892496, Longitude: -1.405461, Units: 'Knots', Value: 14.5 }),
          },
        },
      }
      const [o] = parsePortlog(dock, { nowMs: NOW_MS, seaSites: PORTLOG_SEA_SITES })
      expect(o.surface).toBe('land')
    })

    it('only ever emits the two values the table allows', () => {
      // wind_observations.surface is CHECK (surface IN ('sea','land')), so a
      // third value would be rejected at insert and lost for that poll.
      for (const o of parsePortlog(bramble(), { nowMs: NOW_MS, seaSites: PORTLOG_SEA_SITES })) {
        expect(['sea', 'land']).toContain(o.surface)
      }
    })
  })

  describe('rubbish in', () => {
    it('survives the shapes a feed change could produce', () => {
      expect(parsePortlog(null)).toEqual([])
      expect(parsePortlog('nope')).toEqual([])
      expect(parsePortlog([])).toEqual([])
      expect(parsePortlog({ '3306': null })).toEqual([])
      expect(parsePortlog({ '3306': { '5': null } })).toEqual([])
      expect(parsePortlog({ '3306': { '5': {} } })).toEqual([])
    })

    it('refuses a null-island position', () => {
      expect(parsePortlog(bramble({ wind: { Latitude: 0, Longitude: 0 } }), { nowMs: NOW_MS })).toEqual([])
      expect(parsePortlog(bramble({ wind: { Latitude: null } }), { nowMs: NOW_MS })).toEqual([])
    })

    it('falls back to the site code, then the id, for a nameless site', () => {
      expect(parsePortlog(bramble({ wind: { Site_Name: '  ' } }), { nowMs: NOW_MS })[0].name).toBe('ABPS-TW06')
      expect(parsePortlog(bramble({ wind: { Site_Name: null, Site_Code: null } }), { nowMs: NOW_MS })[0].name).toBe('Port-Log 3306')
    })

    it('skips a site with no wind parameter at all, such as a tide-only gauge', () => {
      const tideOnly = { '3302': { '1': { '10003': rec({ Parameter_Name: 'Observed', Units: 'm', Value: 4.587 }) } } }
      expect(parsePortlog(tideOnly, { nowMs: NOW_MS })).toEqual([])
    })
  })
})

describe('parsePortlogLatestUrl', () => {
  // The endpoint takes no plain parameters: `item` is base64 of a query string
  // ending in a PIN that signs it, so the token can only be used as published.
  const page = `
	//Latest URL
	latest_url = "https://abports.port-log.net/latest/GetLatest.php?item=Y2x1c3Rlcj0lNUJzb3V0&SID=plg_abports_southampton";
	latest_tips = false;
`
  it('lifts the signed token off the cluster page', () => {
    expect(parsePortlogLatestUrl(page)).toBe(
      'https://abports.port-log.net/latest/GetLatest.php?item=Y2x1c3Rlcj0lNUJzb3V0&SID=plg_abports_southampton')
  })

  it('returns null rather than a half-built URL when the page changes', () => {
    expect(parsePortlogLatestUrl('<html>nothing here</html>')).toBeNull()
    expect(parsePortlogLatestUrl('latest_url = "https://example.com/other.php";')).toBeNull()
  })
})

describe('portlogInReach', () => {
  it('is true over the Solent', () => {
    expect(portlogInReach(50.766, -1.288, 10)).toBe(true)
    expect(portlogInReach(50.733, -1.533, 20)).toBe(true)
  })

  it('is false over another venue, so panning California asks no British port', () => {
    expect(portlogInReach(33.72, -118.27, 40)).toBe(false)
    expect(portlogInReach(43.275, 6.678, 40)).toBe(false)
    expect(portlogInReach(59.0, 10.3, 40)).toBe(false)
  })

  it('counts the viewport radius, so a wide inland view still reaches', () => {
    const far = 51.9
    expect(portlogInReach(far, -1.288, 5)).toBe(false)
    expect(portlogInReach(far, -1.288, 60)).toBe(true)
    expect(PORTLOG_REACH_NM).toBeGreaterThan(0)
  })
})
