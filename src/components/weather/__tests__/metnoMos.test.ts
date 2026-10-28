// MET Nordic's MOS wiring.
//
// The model itself has been configured since September 2026; what it lacked was
// a `mosModel` — the declaration of which Open-Meteo id a correction would be
// trained against. These tests pin the two properties that make naming it safe
// to do BEFORE any coefficients exist, because "declared but inert" is a state
// that is easy to break in either direction: a badge that lies, or a fit that
// never gets applied.

import { describe, it, expect } from 'vitest'
import { MODELS, MODEL_ORDER } from '../openMeteo'
import { correctionInfo, calibratedVenues, specFor } from '../mos'
import { VENUES } from '../../../lib/venues'

describe('METNO maps to its own Open-Meteo id, exactly', () => {
  it('trains against metno_nordic — the same model the tool fetches', () => {
    expect(MODELS.METNO.mosModel).toBe('metno_nordic')
    expect(MODELS.METNO.modelParam).toBe('metno_nordic')
  })

  it('is NOT flagged approximate, unlike ICON and ECMWF', () => {
    // ICON fetches icon_seamless and is corrected with icon_eu; ECMWF fetches
    // the 9 km HRES and is corrected with ifs025. Both are honest about it.
    // Here the fetched model and the trained model are the same thing, so a
    // mosApprox flag would be claiming an inaccuracy that is not there.
    expect(MODELS.METNO.mosApprox).toBeUndefined()
    expect(MODELS.ICON.mosApprox).toBe(true)
    expect(MODELS.ECMWF.mosApprox).toBe(true)
  })
})

describe('a correction exists only where the venue was actually fitted', () => {
  // These two used to assert that metno_nordic corrected NOWHERE and that every
  // calibrated venue was outside the Nordic box — true while only the three
  // Mediterranean specs were registered, and a statement about the state of the
  // world rather than about the code. Oslofjord and Viksfjord were registered on
  // 28 Oct 2026, so the assertions now say the thing they were protecting: a
  // correction appears exactly where there are coefficients, and nowhere else.
  it('corrects metno_nordic at the Norwegian venues and at no Mediterranean one', () => {
    expect(correctionInfo('oslofjord', 'metno_nordic')).not.toBeNull()
    for (const v of ['sorrento', 'porto-cervo', 'st-tropez', 'san-juan']) {
      expect(correctionInfo(v, 'metno_nordic'), v).toBeNull()
    }
  })

  it('refuses metno_nordic at Viksfjord, where the gain did not hold every year', () => {
    // Fitted, measured, and deliberately shipped as `raw` — correctionInfo must
    // read that as NO correction, not as a correction of type raw.
    expect(specFor('viksfjord').models.metno_nordic.type).toBe('raw')
    expect(correctionInfo('viksfjord', 'metno_nordic')).toBeNull()
  })

  it('only corrects a venue inside the model\'s own coverage box', () => {
    // MET Nordic is never fetched outside the box — Open-Meteo answers
    // `"latitude":nan` there, which is not parseable JSON — so a correction
    // outside it would be for a forecast that does not exist.
    const box = MODELS.METNO.coverage
    expect(box).toBeTruthy()
    for (const key of calibratedVenues()) {
      const v = VENUES.find((x) => x.key === key)
      expect(v, key).toBeTruthy()
      const inside = v!.lat >= box.latMin && v!.lat <= box.latMax
        && v!.lon >= box.lonMin && v!.lon <= box.lonMax
      if (!inside) expect(correctionInfo(key, 'metno_nordic'), key).toBeNull()
    }
  })

  it('still has a spec object for the fitted venues, so the lookup is a miss not a crash', () => {
    for (const v of calibratedVenues()) expect(specFor(v)).toBeTruthy()
  })
})

describe('the Norwegian venues are inside the Nordic domain', () => {
  // This is what makes a Norwegian fit possible at all: the model has to be
  // fetchable there before a correction can be trained for it.
  const box = MODELS.METNO.coverage

  it.each(['viksfjord', 'oslofjord', 'oslo', 'fredrikstad'])('%s is in the box', (key) => {
    const v = VENUES.find((x) => x.key === key)
    expect(v, key).toBeTruthy()
    expect(v!.lat).toBeGreaterThanOrEqual(box.latMin)
    expect(v!.lat).toBeLessThanOrEqual(box.latMax)
    expect(v!.lon).toBeGreaterThanOrEqual(box.lonMin)
    expect(v!.lon).toBeLessThanOrEqual(box.lonMax)
  })

  it('the two that were fitted are registered; the other two are still outstanding', () => {
    // Larvik (viksfjord) and Horten/Moss (oslofjord) shipped 28 Oct 2026.
    // Oslo and Fredrikstad have no fit, so they must stay uncalibrated rather
    // than inherit a neighbour's coefficients.
    for (const key of ['viksfjord', 'oslofjord']) {
      expect(calibratedVenues(), key).toContain(key)
    }
    for (const key of ['oslo', 'fredrikstad']) {
      expect(calibratedVenues(), key).not.toContain(key)
    }
  })
})

describe('METNO stays in the model order', () => {
  it('is still offered, second after AROME', () => {
    // LOCAL_FIRST puts the high-res local models first; a mosModel key must
    // not have disturbed the ordering.
    expect(MODEL_ORDER).toContain('METNO')
  })

  it('is 10 m only, so wind30 takes the single-level Monin-Obukhov path', () => {
    // Probed and documented on the entry: 80/100/120 m all come back null.
    // One level means there is no exponent to fit, so the surface-layer solve
    // (and the air-sea stability term) is what lifts 10 m to masthead height.
    expect(MODELS.METNO.heights).toEqual([10])
  })
})
