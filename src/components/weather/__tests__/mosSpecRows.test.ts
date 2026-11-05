// Every registered venue must RENDER, not just exist.
//
// San Juan and Long Beach were in the Venue MOS picker, their specs were
// registered and applied, and the table showed a row per model with a dash in
// every metric column — because it read the Mediterranean field names and
// those venues' fitting scripts wrote different ones. The venue existed, the
// correction worked, and the panel said nothing about it.
//
// So the test is not "is the venue registered" (venueKeys.test.ts has that)
// but "does what we ship produce something to look at". It runs against the
// real bundled specs, so the next venue fitted with a fourth vocabulary fails
// here rather than silently rendering an empty table.

import { describe, expect, it } from 'vitest'
import { calibratedVenues, specFor } from '../mos'
import { modelRows, truthLine, cvScheme, heightNote } from '../mosSpecRows'

const VENUES = calibratedVenues()

describe('every registered venue produces display rows', () => {
  it('has at least one venue to test', () => {
    expect(VENUES.length).toBeGreaterThanOrEqual(7)
  })

  for (const key of VENUES) {
    describe(key, () => {
      const spec = specFor(key)
      const rows = modelRows(spec)

      it('produces one row per model in the spec', () => {
        expect(rows.length).toBe(Object.keys(spec.models).length)
        expect(rows.length).toBeGreaterThan(0)
      })

      it('names a correction form for every model', () => {
        for (const r of rows) {
          expect(r.best, `${key}/${r.id}`).toBeTruthy()
          expect(typeof r.best).toBe('string')
        }
      })

      it('shows a GAIN for every model that ships a correction', () => {
        // The column that was blank. A model with a non-raw form has, by
        // construction, a measured gain that cleared a bar — if the display
        // cannot find it, the number is in a field nobody is reading.
        const shipped = rows.filter((r) => !r.isRaw)
        expect(shipped.length, `${key} ships no correction at all`).toBeGreaterThan(0)
        for (const r of shipped) {
          expect(r.gainPct, `${key}/${r.id} has no gain to show`).not.toBeNull()
          expect(r.gainPct!).toBeGreaterThan(0)
        }
      })

      it('says whether the gain held in every held-out block, where that was recorded', () => {
        // The bar that distinguishes a correction from a coincidence. The
        // Mediterranean specs record it as `holds_every_regatta` and the
        // newest two as `holds_every_block` — but mos-fit.ts (oslofjord,
        // viksfjord) ENFORCED it without writing it down, so there a dash is
        // honest and inventing a "yes" would not be. Asserted per generation
        // so a venue that records it and is not read still fails.
        const RECORDS_IT = ['sorrento', 'porto-cervo', 'st-tropez', 'san-juan', 'long-beach']
        for (const r of rows.filter((x) => !x.isRaw)) {
          if (RECORDS_IT.includes(key)) expect(r.holds, `${key}/${r.id}`).not.toBeNull()
          else expect(r.holds, `${key}/${r.id}`).toBeNull()
        }
      })

      it('describes its truth, its CV scheme and its fit height', () => {
        expect(truthLine(spec), `${key} has no truth line`).toBeTruthy()
        expect(cvScheme(spec)).toMatch(/leave-one-(regatta|year)-out/)
        expect(heightNote(spec)).toBeTruthy()
      })
    })
  }
})

describe('a model that is stored but unreachable is flagged', () => {
  it('marks icon_global NOT APPLIED at the Pacific venues', () => {
    // The one way this panel could mislead rather than merely omit: San Juan's
    // icon_global carries a 25.4 % gain and `MODELS.ICON.mosModel` is
    // `icon_eu`, which does not reach the Pacific — so the coefficients are
    // inert and the table was advertising them.
    for (const key of ['san-juan', 'long-beach']) {
      const rows = modelRows(specFor(key))
      const icon = rows.find((r) => r.id === 'icon_global')
      expect(icon, `${key} has no icon_global row`).toBeTruthy()
      expect(icon!.notApplied, key).toBeTruthy()
      expect(icon!.notApplied, key).toMatch(/icon_eu/)
    }
  })

  it('and leaves the applied models unflagged', () => {
    for (const r of modelRows(specFor('long-beach'))) {
      if (r.id !== 'icon_global') expect(r.notApplied, r.id).toBeNull()
    }
  })
})

describe('the height note follows the spec, not the panel heading', () => {
  it('says "before the lift" for a station venue fitted at 10 m', () => {
    // The heading says 30 m. A 10 m-fitted intercept applied to a 30 m value
    // is wrong by the lift ratio, so the ordering has to be on screen.
    for (const key of ['san-juan', 'long-beach', 'oslofjord', 'viksfjord']) {
      expect(specFor(key).fit_height_m, key).toBe(10)
      expect(heightNote(specFor(key)), key).toMatch(/BEFORE the lift/)
    }
  })

  it('and says the correction applies directly for the 30 m boat-log venues', () => {
    for (const key of ['sorrento', 'porto-cervo', 'st-tropez']) {
      expect(heightNote(specFor(key)), key).toMatch(/applied to the 30 m value/)
    }
  })
})

describe('the CV scheme is per venue, not one hardcoded sentence', () => {
  it('is regatta-blocked for the boat-log venues and year-blocked for the stations', () => {
    for (const key of ['sorrento', 'porto-cervo', 'st-tropez']) {
      expect(cvScheme(specFor(key)), key).toBe('leave-one-regatta-out')
    }
    for (const key of ['san-juan', 'long-beach', 'oslofjord', 'viksfjord']) {
      expect(cvScheme(specFor(key)), key).toMatch(/leave-one-year-out/)
    }
  })
})

describe('missing is for what was never stored, not for what moved', () => {
  it('reports rmse missing only where the spec truly lacks it', () => {
    // san-juan and long-beach never wrote raw_rmse/cv_rmse. Every other venue
    // did, so a dash there would be a reading bug.
    for (const key of ['san-juan', 'long-beach']) {
      expect(modelRows(specFor(key)).every((r) => r.missing.includes('rmse')), key).toBe(true)
    }
    for (const key of ['sorrento', 'porto-cervo', 'st-tropez', 'oslofjord', 'viksfjord']) {
      const withRmse = modelRows(specFor(key)).filter((r) => !r.missing.includes('rmse'))
      expect(withRmse.length, `${key} shows no rmse at all`).toBeGreaterThan(0)
    }
  })

  it('reports dir-agree missing at every station venue and present at the boat ones', () => {
    for (const key of ['san-juan', 'long-beach', 'oslofjord', 'viksfjord']) {
      expect(modelRows(specFor(key)).every((r) => r.agree == null), key).toBe(true)
    }
    for (const key of ['sorrento', 'porto-cervo', 'st-tropez']) {
      expect(modelRows(specFor(key)).some((r) => r.agree != null), key).toBe(true)
    }
  })
})

describe('the written findings agree with what actually ships', () => {
  // THE GUARD THAT WAS MISSING. The prose is hand-written and the specs are
  // refitted, and nothing tied them together: after the 2 Nov 2026 refit the
  // Porto Cervo entry still recommended "ECMWF + sector" and quoted its gain,
  // when the tail audit had just made ECMWF raw there. Sorrento recommended
  // "ICON-EU + diurnal" when it ships sector, and St Tropez recommended a GFS
  // that is not in the spec at all and an AROME that had gone raw.
  //
  // So each venue declares what its prose tells the reader to USE and what it
  // calls RAW, and a refit that changes either breaks this test instead of
  // leaving the site confidently wrong.
  const RECOMMENDS: Record<string, string[]> = {
    sorrento: ['ecmwf_ifs025', 'icon_eu'],
    'porto-cervo': ['meteofrance_arpege_europe', 'icon_eu'],
    'st-tropez': ['icon_eu', 'ecmwf_ifs025'],
    'san-juan': ['gfs_global', 'gfs_hrrr', 'gem_hrdps_continental'],
    'long-beach': ['ncep_nam_conus', 'ecmwf_ifs025', 'gfs_hrrr', 'gfs_global'],
  }
  const SAYS_RAW: Record<string, string[]> = {
    sorrento: ['italia_meteo_arpae_icon_2i', 'meteofrance_arpege_europe'],
    'porto-cervo': ['ecmwf_ifs025', 'meteofrance_arome_france_hd', 'italia_meteo_arpae_icon_2i'],
    'st-tropez': ['meteofrance_arome_france_hd', 'meteofrance_arpege_europe'],
    'san-juan': ['ecmwf_ifs025'],
  }

  for (const [key, ids] of Object.entries(RECOMMENDS)) {
    it(`${key}: everything the prose recommends ships a correction AND is reachable`, () => {
      const rows = modelRows(specFor(key))
      for (const id of ids) {
        const r = rows.find((x) => x.id === id)
        expect(r, `${key} prose names ${id}, which is not in the spec`).toBeTruthy()
        expect(r!.isRaw, `${key} recommends ${id} but it ships raw`).toBe(false)
        expect(r!.notApplied, `${key} recommends ${id} but it is not applied`).toBeNull()
      }
    })
  }

  for (const [key, ids] of Object.entries(SAYS_RAW)) {
    it(`${key}: everything the prose calls raw really is raw`, () => {
      const rows = modelRows(specFor(key))
      for (const id of ids) {
        const r = rows.find((x) => x.id === id)
        expect(r, `${key} prose names ${id}, which is not in the spec`).toBeTruthy()
        expect(r!.isRaw, `${key} says ${id} is raw but it ships ${r!.best}`).toBe(true)
      }
    })
  }

  // Per venue rather than one loop, so a second offender is not hidden behind
  // the first — the first run of this had exactly that, reporting San Juan and
  // stopping before it reached Long Beach's unmentioned GFS.
  for (const key of Object.keys(RECOMMENDS)) {
    it(`${key}: the prose accounts for every model in the spec`, () => {
      // Otherwise a model can be added to a spec and go unmentioned, which is
      // how a reader gets a table row the findings never explain. A model the
      // spec declares unreachable is exempt: its own row says NOT APPLIED.
      const named = new Set([...(RECOMMENDS[key] ?? []), ...(SAYS_RAW[key] ?? [])])
      const unmentioned = modelRows(specFor(key))
        .filter((r) => !named.has(r.id) && !r.notApplied)
        .map((r) => r.id)
      expect(unmentioned, `${key}: in the spec but not in the prose`).toEqual([])
    })
  }
})

describe('tolerates a spec it has never seen', () => {
  it('returns nothing rather than throwing on null or an empty spec', () => {
    expect(modelRows(null)).toEqual([])
    expect(modelRows(undefined)).toEqual([])
    expect(modelRows({ models: {} })).toEqual([])
    expect(truthLine(null)).toBeNull()
    expect(heightNote(null)).toMatch(/30 m/)
  })

  it('falls back to `type` when a spec omits `best`, and to raw when it omits both', () => {
    const [a, b] = modelRows({ models: { x: { type: 'sector' }, y: {} } })
    expect(a.best).toBe('sector')
    expect(a.isRaw).toBe(false)
    expect(b.best).toBe('raw')
    expect(b.isRaw).toBe(true)
  })
})
