// The tier is a PERMISSION, not a weighting. These tests exist mostly to stop
// the fitting set quietly growing: the failure this guards against is a new
// source, or a garden station, ending up inside `fit` where nothing outside
// would notice.

import { describe, expect, it } from 'vitest'
import { tierFor, fitTierOnly, tierCounts, OBS_TIERS, TIER_EXCEPTIONS, FIT_MAX_SEA_NM } from '../obsTier'
import { DAVIS_MAP_STATIONS } from '../windObsDavisMap'

const obs = (id: string) => ({ id, source: 'pws' as const })

describe('class defaults', () => {
  it('puts the professional marine and aviation networks in fit', () => {
    for (const id of ['portlog:3306', 'ndbc:46053', 'mf-buoy:61001', 'metar:EGHI', 'cco:sandown']) {
      expect(tierFor(obs(id)).tier, id).toBe('fit')
    }
  })

  it('puts compromised-but-real instruments on probation', () => {
    for (const id of ['mf-land:83101001', 'rmn:napoli', 'wf:GBR00001', 'wle:abc', 'club:hillhead', 'mo:gcpvj', 'mf-ship:x']) {
      expect(tierFor(obs(id)).tier, id).toBe('probation')
    }
  })

  it('keeps an unnamed FROST station out of the fit, however good the instrument', () => {
    // Frost is a NATIONAL network: of the 23 stations FROST_SITES names, most
    // are inland — a hilltop at 445 m, three roadside motorway sensors, an
    // airport, a city garden. `frost: 'fit'` as a class default put every one
    // of them in the fitting set, which is the single failure this file exists
    // to prevent, so the default is probation and the open-water ones are
    // promoted by name.
    //
    // This asserts the DEFAULT, using an id deliberately not in the exception
    // list: a station added to FROST_SITES tomorrow must not be fittable until
    // somebody has looked at where it stands.
    const d = tierFor(obs('frost:SN76920'))
    expect(d.tier).toBe('probation')
    expect(d.mayFit).toBe(false)
  })

  it('promotes the Norwegian lighthouses and islands by name', () => {
    // Water on every side and an altitude in single or low double figures.
    for (const id of ['frost:SN27500', 'frost:SN29950', 'frost:SN17000',
                      'frost:SN17280', 'frost:SN30235', 'frost:SN34130',
                      'frost:SN250000']) {
      expect(tierFor(obs(id)).tier, id).toBe('fit')
      expect(tierFor(obs(id)).mayFit, id).toBe(true)
    }
  })

  it('does NOT promote Tjøme, which only looks coastal', () => {
    // On the same island Færder fyr stands off, 6 nm away, and it read 6.9 m/s
    // against Færder's 21.0 in the SE gale of 25 Oct 2026. A map cannot tell
    // you that; a live reading can.
    expect(tierFor(obs('frost:SN27420')).tier).toBe('probation')
  })

  it('puts the garden and sport networks in display', () => {
    for (const id of ['wlmap:abc', 'piou:1777', 'ffvl:42', 'wl:xyz']) {
      expect(tierFor(obs(id)).tier, id).toBe('display')
    }
  })
})

describe('an unknown source is display, never fit', () => {
  it('defaults an unclassified prefix to display and says so', () => {
    // Defaulting a NEW source into the fitting set is the one mistake that
    // cannot be seen from the outside — the fit just quietly gets worse.
    const d = tierFor(obs('brandnew:123'))
    expect(d.tier).toBe('display')
    expect(d.mayFit).toBe(false)
    expect(d.why).toMatch(/unclassified/)
  })

  it('handles an id with no prefix at all', () => {
    expect(tierFor(obs('12345')).tier).toBe('display')
    expect(tierFor(obs('')).tier).toBe('display')
  })
})

describe('per-station exceptions', () => {
  it('demotes Cap Camarat off its class default, with the reason', () => {
    const d = tierFor(obs('mf-land:83101001'))
    expect(d.tier).toBe('probation')
    expect(d.why).toMatch(/cliff-top/i)
  })

  it('separates the Port-Log fairway stations from the ones inside the docks', () => {
    // Same network, same operator, utterly different exposure. This is the
    // case that `trust` alone cannot express.
    expect(tierFor(obs('portlog:3306')).tier).toBe('fit')      // Bramble Bank
    expect(tierFor(obs('portlog:3304')).tier).toBe('fit')      // Nab Tower
    expect(tierFor(obs('portlog:3302')).tier).toBe('probation') // Dock Head
    expect(tierFor(obs('portlog:3310')).tier).toBe('probation') // Town Quay
    expect(tierFor(obs('portlog:3303')).tier).toBe('probation') // Marchwood
  })

  it('gives every exception a reason', () => {
    for (const [id, e] of Object.entries(TIER_EXCEPTIONS)) {
      expect(e.why.trim(), id).not.toBe('')
      expect(OBS_TIERS[e.tier]).toBeTruthy()
    }
  })
})

describe('seaNm can only demote', () => {
  it('drops a fit-tier station that turns out to be inland', () => {
    const near = tierFor(obs('cco:sandown'), { seaNm: 1.5 })
    const far = tierFor(obs('cco:sandown'), { seaNm: 10 })
    expect(near.tier).toBe('fit')
    expect(far.tier).toBe('probation')
    expect(far.why).toMatch(/inland/)
  })

  it('never promotes a garden, however close to the water', () => {
    expect(tierFor(obs('wlmap:abc'), { seaNm: 0.1 }).tier).toBe('display')
    expect(tierFor(obs('piou:1'), { seaNm: 0 }).tier).toBe('display')
  })

  it('ignores a missing or unusable measurement rather than demoting on it', () => {
    for (const seaNm of [undefined, null, NaN]) {
      expect(tierFor(obs('metar:EGHI'), { seaNm }).tier).toBe('fit')
    }
    expect(FIT_MAX_SEA_NM).toBeGreaterThan(0)
  })
})

describe('fitTierOnly', () => {
  it('refuses rather than down-weights', () => {
    const set = [obs('portlog:3306'), obs('wlmap:a'), obs('rmn:napoli'), obs('metar:EGHI')]
    expect(fitTierOnly(set).map((o) => o.id)).toEqual(['portlog:3306', 'metar:EGHI'])
  })

  it('keeps nothing from a set of gardens', () => {
    expect(fitTierOnly([obs('wlmap:a'), obs('wlmap:b')])).toEqual([])
  })
})

describe('against the real registry', () => {
  it('classifies all 301 Davis stations as display', () => {
    // The Met Office's finding on crowd-sourced wind — "the observation
    // rejection rate is too high to be useful" — and KNMI's ~19 % survival
    // make these a display network. If this test ever fails, someone has
    // promoted a garden.
    const counts = tierCounts(DAVIS_MAP_STATIONS.map((s) => ({ id: `wlmap:${s.id}`, source: 'pws' as const })))
    expect(counts.display).toBe(DAVIS_MAP_STATIONS.length)
    expect(counts.fit).toBe(0)
    expect(counts.probation).toBe(0)
  })

  it('leaves the fitting set small, which is the honest outcome', () => {
    // Roughly fifteen stations out of 300-odd can carry a fit. A tier that
    // admitted most of the network would not be doing anything.
    const whole = [
      ...DAVIS_MAP_STATIONS.map((s) => ({ id: `wlmap:${s.id}`, source: 'pws' as const })),
      ...['portlog:3306', 'portlog:3304', 'portlog:3392', 'metar:EGHI', 'metar:LIRN',
        'ndbc:46053', 'cco:sandown', 'frost:SN1', 'mf-buoy:1'].map((id) => obs(id)),
    ]
    const counts = tierCounts(whole)
    expect(counts.fit).toBeLessThan(30)
    expect(counts.fit).toBeGreaterThan(0)
  })
})
