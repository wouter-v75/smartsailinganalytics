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
import { nearAnyVenue, VENUE_NM, ARCHIVE_PREFIXES, archiveOnly } from '../obsSources'
import { tierFor } from '../obsTier'
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

  it('keeps an FFVL balise out to VENUE_NM although it may never be FITTED', () => {
    // The permission to be KEPT and the permission to be FITTED are different
    // things, and FFVL is the case that forced them apart. Its upstream keeps
    // NOTHING — the data.gouv.fr files are overwritten every five minutes and
    // the dataset publishes no archive — so a reading not stored is gone, not
    // merely thinner. And the nearest balise to St Tropez is 26 nm, well
    // outside IDLE_NM, so without this clause the archive would have stayed
    // empty for ever except during a regatta.
    const kept = nearAnyVenue([
      at('ffvl:49', 28.7),                // Mont Lachens, 1658 m
      at('ffvl:155', VENUE_NM + 3),       // and the bound still applies
    ], [venue('idle')])
    expect(ids(kept)).toEqual(['ffvl:49'])
  })

  it('and that balise is still DISPLAY tier, so no fit can take it', () => {
    // The distinction this must never blur. Promoting ffvl to `mayFit` would
    // have archived it too — and put a 1658 m ridge top into a MOS training
    // set, which is the exact error that cost a month of wrong numbers at
    // Svenner. Archived, drawn, never computed from.
    const d = tierFor(at('ffvl:49', 28.7))
    expect(d.tier).toBe('display')
    expect(d.mayFit).toBe(false)
    expect(archiveOnly('ffvl:49')).toBe(true)
  })

  it('does not extend the same courtesy to the other display networks', () => {
    // The rule is "the upstream keeps nothing", not "display tier deserves
    // archiving". Pioupiou and the 301 public Davis stations are display too,
    // and keeping them to 60 nm of fifteen venues is the volume the bound
    // exists to prevent.
    expect(ARCHIVE_PREFIXES).toEqual(['ffvl'])
    const kept = nearAnyVenue([
      at('piou:123', 20),
      at('wlmap:abc', 20),
      at('wl:9', 20),
    ], [venue('idle')])
    expect(kept).toEqual([])
  })

  it('reads the prefix, not a substring of the id', () => {
    expect(archiveOnly('ffvl:49')).toBe(true)
    expect(archiveOnly('wlmap:ffvl')).toBe(false)
    expect(archiveOnly('ffvl')).toBe(false)
    expect(archiveOnly('xffvl:1')).toBe(false)
  })

  it('now keeps an inland PROBATION station out to VENUE_NM, which it did not', () => {
    // THIS TEST ASSERTED THE OPPOSITE until 2 Nov 2026, and the change is the
    // point. The escape hatch from the idle radius was `mayFit`, true only for
    // `fit` — so every probation station beyond 3 nm was dropped. Measured on
    // one fetch with both filters applied to the same stations: of 26
    // Météo-France RADOME stations within 60 nm of a venue, ZERO survived, and
    // the nearest one lost was CAP CAMARAT at 4.1 nm — the station obsSources'
    // own comment calls the single most useful one at St Tropez.
    //
    // Probation is meant to be a STAGE: a station leaves it when somebody
    // checks its siting against its history (that is what TIER_EXCEPTIONS
    // records, and how Cap Camarat and the six Norwegian lighthouses got their
    // entries). With no history kept it could never leave.
    //
    // Gardermoen - Vardåsen is a 445 m hilltop 20 nm out, and it being kept is
    // correct under the new rule even though it will never be fitted against.
    // For frost in particular the extra rows are redundancy rather than
    // insurance — that network keeps its own history back to 1885 and
    // scripts/frost-backfill.ts can refill a gap — but one tier rule is worth
    // more than a per-source exemption saving a few hundred rows a day.
    const kept = nearAnyVenue([
      at('frost:SN27780', 1.2),
      at('frost:SN4685', 20),
      at('frost:SN4780', VENUE_NM + 2),   // and the bound still holds
    ], [venue('idle')])
    expect(ids(kept)).toEqual(['frost:SN27780', 'frost:SN4685'])
  })

  it('keeps Météo-France RADOME, the case that forced the rule', () => {
    // Cap Camarat is 4.1 nm from the Golfe de Saint-Tropez and IDLE_NM is 3,
    // so it was dropped by 1.1 nm — while being both the nearest professional
    // station to the venue and already carrying a TIER_EXCEPTION explaining
    // its siting. It is probation, so it is archived and never fitted.
    const kept = nearAnyVenue([at('mf-land:83101001', 4.1)], [venue('idle')])
    expect(ids(kept)).toEqual(['mf-land:83101001'])
    const d = tierFor(at('mf-land:83101001', 4.1))
    expect(d.mayArchive).toBe(true)
    expect(d.mayFit).toBe(false)
  })

  it('and a display-tier station is still NOT archived on tier alone', () => {
    // The line the new rule must not cross. 250 of the 301 public Davis
    // gardens are within 60 nm of a venue and they are the volume the bound
    // exists for; only the named ARCHIVE_PREFIXES get past it.
    const kept = nearAnyVenue([
      at('wlmap:abc', 20),
      at('piou:2217', 20),
    ], [venue('idle')])
    expect(kept).toEqual([])
    expect(tierFor(at('wlmap:abc', 20)).mayArchive).toBe(false)
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
