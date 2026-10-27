// Every Open-Meteo wind request must ask for a SEA grid cell.
//
// Open-Meteo's `cell_selection` defaults to `land` — "prefer a grid cell on
// land with similar elevation to the requested point" — and for a race area
// that returns a cell ashore. Measured at the venue centres over 1 Jan to
// 20 Oct 2026, mean 10 m wind, land cell against sea cell:
//
//   Porto Cervo  ecmwf_ifs025   41.00,9.50, fifteen miles inland   6.05 vs 12.63 kn
//   St Tropez    ecmwf_ifs025   43.25,6.50, eleven miles inland    5.27 vs  8.71 kn
//   Sorrento     ecmwf_ifs025   the same cell either way           no change
//
// And against Northstar 76's own logged 30 m wind over nine days at Porto
// Cervo, ECMWF went from 5.93 kn rmse (the land cell, with the venue's stored
// correction on top) to 3.04 kn raw on the sea cell. So this is not a tuning
// preference; a missing query parameter was showing half the wind.
//
// There is NO SYMPTOM for this other than the number being wrong, and it
// varies model by model and venue by venue, because which cell you get depends
// on the DEM elevation of the point asked for. That is why it needs a test
// rather than a comment: the day a model is added to MODELS without it, the
// forecast for that model is quietly a different place.

import { describe, expect, it } from 'vitest'
import { MODELS, surfaceUrl } from '../openMeteo'

describe('cell_selection', () => {
  it('is sea for every model in MODELS, at every venue', () => {
    for (const key of Object.keys(MODELS)) {
      for (const [lat, lon] of [[41.135, 9.538], [43.2669, 6.6984], [59.03, 10.15]]) {
        const url = surfaceUrl(key, lat, lon, 'Europe/Rome')
        expect(url, key).toContain('cell_selection=sea')
      }
    }
  })

  it('survives the opts override path, which fetches a blend\'s two halves', () => {
    // ECMWF asks twice — near-term 9 km and extended 0.25° — and a parameter
    // added to only one of them would splice two different places together.
    const a = surfaceUrl('ECMWF', 41.135, 9.538, 'Europe/Rome')
    const b = surfaceUrl('ECMWF', 41.135, 9.538, 'Europe/Rome', { modelParam: 'ecmwf_ifs025', days: 14 })
    expect(a).toContain('cell_selection=sea')
    expect(b).toContain('cell_selection=sea')
    expect(b).toContain('models=ecmwf_ifs025')
  })

  it('appears exactly once, so the last value is not a different one', () => {
    const url = surfaceUrl('ICON', 41.135, 9.538, 'Europe/Rome')
    expect(url.match(/cell_selection=/g)).toHaveLength(1)
  })

  it('asks for 2 m temperature once, not twice', () => {
    // It was pushed twice by a copy-paste, which asks Open-Meteo for the same
    // column twice in every request the app makes.
    const url = surfaceUrl('ICON', 41.135, 9.538, 'Europe/Rome')
    const hourly = new URL(url).searchParams.get('hourly') || ''
    expect(hourly.split(',').filter((p) => p === 'temperature_2m')).toHaveLength(1)
  })
})
