// What the poller KEEPS, which is a different question from what it fetches.
//
// These exist because the idle radius had its priority backwards and nothing
// noticed for three days. On 25 Oct 2026 the Oslofjord stations told the story
// by themselves: Horten-Nykirke at 3.0 nm was still recording every half hour,
// and Gullholmen at 3.1 nm had stopped dead at 23 Oct 06:23 — a tenth of a
// mile between a continuous trace and none. Svenner fyr (3.7 nm) and
// Strømtangen fyr (5.6 nm) had stopped at the same instant, and Færder fyr
// (11.6 nm) had never recorded a row at all.
//
// Every one of those is `fit` tier. The nineteen PWS that kept their trace are
// `display`. A lighthouse is by nature the furthest station out, so a small
// radius cuts exactly the ones worth most — and `fit` is the permission to be
// fitted against, so those rows ARE the MOS training set.

import { describe, expect, it } from 'vitest'
import { nearAnyVenue, VENUE_NM } from '../obsSources'
import { IDLE_NM, type VenueDecision } from '../obsActivation'
import type { WindObs } from '../windObs'

const VIKSFJORD = { lat: 59.03, lon: 10.15 }

const venue = (mode: 'dense' | 'idle'): VenueDecision => ({
  key: 'viksfjord',
  name: 'Viksfjord / Larvik',
  lat: VIKSFJORD.lat,
  lon: VIKSFJORD.lon,
  mode,
  radiusNm: mode === 'dense' ? VENUE_NM : IDLE_NM,
  reason: 'test',
} as VenueDecision)

/** A station n nm due east of the venue, with the given id. */
const at = (id: string, nm: number): WindObs => ({
  id,
  source: 'synop',
  name: id,
  lat: VIKSFJORD.lat,
  // A degree of longitude is 60 nm × cos(lat); east keeps latitude fixed.
  lon: VIKSFJORD.lon + nm / (60 * Math.cos((VIKSFJORD.lat * Math.PI) / 180)),
  t: '2026-10-25T06:00:00Z',
  twsKn: 12,
} as WindObs)

const ids = (obs: WindObs[]) => obs.map((o) => o.id).sort()

describe('nearAnyVenue when the venue is IDLE', () => {
  it('keeps a fit-tier lighthouse well outside the idle radius', () => {
    // The measured case. Færder is 11.6 nm out — nearly four times IDLE_NM —
    // and is the best-attested station in the Norwegian list.
    const kept = nearAnyVenue([at('frost:SN27500', 11.6)], [venue('idle')])
    expect(ids(kept)).toEqual(['frost:SN27500'])
  })

  it('keeps the three that silently stopped on 23 Oct 2026', () => {
    const kept = nearAnyVenue([
      at('frost:SN17280', 3.1),   // Gullholmen — dropped by 0.1 nm
      at('frost:SN29950', 3.7),   // Svenner fyr
      at('frost:SN17000', 5.6),   // Strømtangen fyr
    ], [venue('idle')])
    expect(ids(kept)).toEqual(['frost:SN17000', 'frost:SN17280', 'frost:SN29950'])
  })

  it('still drops a display-tier PWS outside the idle radius', () => {
    // The whole point: the gardens are what idle mode is entitled to shed.
    // A wlmap id is `display`, so 3.7 nm puts it out.
    const kept = nearAnyVenue([at('wlmap:abc', 3.7)], [venue('idle')])
    expect(kept).toEqual([])
  })

  it('keeps a display-tier PWS INSIDE the idle radius', () => {
    const kept = nearAnyVenue([at('wlmap:abc', 2.5)], [venue('idle')])
    expect(ids(kept)).toEqual(['wlmap:abc'])
  })

  it('does not keep a fit-tier station beyond VENUE_NM', () => {
    // The bound that stops this swallowing the global metar and ndbc networks:
    // every `metar:` id is fit by class, and there are thousands of them.
    const kept = nearAnyVenue([
      at('metar:ENGM', VENUE_NM - 1),
      at('metar:EGLL', VENUE_NM + 5),
    ], [venue('idle')])
    expect(ids(kept)).toEqual(['metar:ENGM'])
  })

  it('keeps an inland frost station only inside the idle radius', () => {
    // SN27780 Tjølling is 1.2 nm out and probation since the tier was
    // inverted — so it is kept on DISTANCE, not on tier, and an equally
    // inland one further out is not.
    const kept = nearAnyVenue([
      at('frost:SN27780', 1.2),
      at('frost:SN4685', 20),   // Gardermoen - Vardåsen, 445 m, probation
    ], [venue('idle')])
    expect(ids(kept)).toEqual(['frost:SN27780'])
  })
})

describe('nearAnyVenue when the venue is DENSE', () => {
  it('keeps everything in range whatever its tier', () => {
    const kept = nearAnyVenue([
      at('wlmap:abc', 30),
      at('frost:SN27500', 11.6),
      at('piou:1777', 55),
    ], [venue('dense')])
    expect(ids(kept)).toEqual(['frost:SN27500', 'piou:1777', 'wlmap:abc'])
  })

  it('drops what is past the dense radius too', () => {
    expect(nearAnyVenue([at('wlmap:abc', VENUE_NM + 10)], [venue('dense')])).toEqual([])
  })
})

describe('de-duplication across venues', () => {
  it('returns one row per station however many venues reach it', () => {
    const a = venue('idle')
    const b = { ...venue('idle'), key: 'other' } as VenueDecision
    const kept = nearAnyVenue([at('frost:SN27500', 11.6)], [a, b])
    expect(kept).toHaveLength(1)
  })
})
