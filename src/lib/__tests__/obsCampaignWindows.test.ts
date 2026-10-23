import { describe, expect, it } from 'vitest'
import {
  normaliseLocation, matchVenueByName, campaignWindows, CAMPAIGN_WINDOW_DEFAULTS,
} from '../obsCampaignWindows'
import { VENUES } from '../obsSources'
import { windowCovers } from '../obsActivation'

const CEST = 120 // minutes, a Mediterranean summer session

describe('normaliseLocation', () => {
  it('strips case, accents and punctuation', () => {
    expect(normaliseLocation('Saint-Tropez')).toBe('saint tropez')
    expect(normaliseLocation('SAINT  TROPEZ')).toBe('saint tropez')
    // An en dash, which is what a word processor produces.
    expect(normaliseLocation('Saint–Tropez')).toBe('saint tropez')
    // NFD does NOT decompose these — they are letters, not accented bases.
    // Half the venues here are Norwegian, so getting it wrong is not academic.
    expect(normaliseLocation('Tønsberg')).toBe('tonsberg')
    expect(normaliseLocation('Vesterøy')).toBe('vesteroy')
    expect(normaliseLocation('Bygdøy')).toBe('bygdoy')
    expect(normaliseLocation('Ålesund')).toBe('alesund')
    expect(normaliseLocation('Hvaler Æ')).toBe('hvaler ae')
    expect(normaliseLocation('  ')).toBe('')
  })
})

describe('matchVenueByName', () => {
  it('matches the venue name and the key', () => {
    expect(matchVenueByName('St Tropez', VENUES)).toBe('st-tropez')
    expect(matchVenueByName('st-tropez', VENUES)).toBe('st-tropez')
  })

  it('matches an alias', () => {
    expect(matchVenueByName('Saint-Tropez', VENUES)).toBe('st-tropez')
    expect(matchVenueByName('Les Voiles de Saint-Tropez', VENUES)).toBe('st-tropez')
    expect(matchVenueByName('Costa Smeralda', VENUES)).toBe('porto-cervo')
  })

  it('matches either half of a slashed venue name', () => {
    // "Solent / Cowes" — nobody types the slash.
    expect(matchVenueByName('Cowes', VENUES)).toBe('solent')
    expect(matchVenueByName('Solent', VENUES)).toBe('solent')
    expect(matchVenueByName('San Pedro', VENUES)).toBe('long-beach')
  })

  it('returns null rather than guessing at a near-spelling', () => {
    // A wrong match is worse than no match: it would make the wrong venue
    // dense and leave the real one idle, with everything looking fine.
    expect(matchVenueByName('St Tropeze', VENUES)).toBeNull()
    expect(matchVenueByName('Palma', VENUES)).toBeNull()
    expect(matchVenueByName('', VENUES)).toBeNull()
  })
})

describe('campaignWindows', () => {
  const row = (date: string, over: Record<string, unknown> = {}) => ({
    date, location: 'Saint-Tropez', event: 'Les Voiles de Saint-Tropez',
    tz_offset_minutes: CEST, ...over,
  })

  it('turns a run of session days into one window', () => {
    const { windows } = campaignWindows(
      ['2027-09-27', '2027-09-28', '2027-09-29'].map((d) => row(d)), VENUES)
    expect(windows).toHaveLength(1)
    expect(windows[0].venueKey).toBe('st-tropez')
    expect(windows[0].reason).toBe('calendar: Les Voiles de Saint-Tropez')
  })

  it('covers the whole regatta including the first morning, in LOCAL time', () => {
    // The bug this is shaped to avoid: a bare date read as UTC starts the
    // window at 02:00 local, so the first morning is outside it.
    const { windows } = campaignWindows([row('2027-09-27')], VENUES, { padDays: 0 })
    const w = windows[0]
    expect(w.startsAt).toBe('2027-09-26T22:00:00.000Z') // 00:00 CEST on the 27th
    expect(windowCovers(w, Date.parse('2027-09-27T06:00:00+02:00'))).toBe(true)
    expect(windowCovers(w, Date.parse('2027-09-26T23:00:00+02:00'))).toBe(false)
  })

  it('pads by a day either side by default', () => {
    const { windows } = campaignWindows([row('2027-09-27')], VENUES)
    expect(CAMPAIGN_WINDOW_DEFAULTS.padDays).toBe(1)
    // The evening before is when the sea-breeze picture is worth having.
    expect(windowCovers(windows[0], Date.parse('2027-09-26T18:00:00+02:00'))).toBe(true)
    expect(windowCovers(windows[0], Date.parse('2027-09-28T18:00:00+02:00'))).toBe(true)
    expect(windowCovers(windows[0], Date.parse('2027-09-25T12:00:00+02:00'))).toBe(false)
  })

  it('keeps a lay day inside one window but splits a real gap', () => {
    const laid = campaignWindows(
      ['2027-09-27', '2027-09-29'].map((d) => row(d)), VENUES).windows
    expect(laid).toHaveLength(1)
    const apart = campaignWindows(
      ['2027-09-27', '2027-10-20'].map((d) => row(d)), VENUES).windows
    expect(apart).toHaveLength(2)
  })

  it('keeps venues separate', () => {
    const { windows } = campaignWindows([
      row('2027-09-27'),
      row('2027-06-10', { location: 'Porto Cervo', event: 'Maxi Yacht Rolex Cup' }),
    ], VENUES)
    expect(windows.map((w) => w.venueKey).sort()).toEqual(['porto-cervo', 'st-tropez'])
  })

  it('REPORTS a location it cannot match instead of dropping it', () => {
    // A regatta with no dense network and nothing to say so is the failure
    // this whole derivation exists to remove.
    const { windows, unmatched } = campaignWindows([
      row('2027-09-27'),
      row('2027-05-01', { location: 'Palma', event: 'Palma Vela' }),
      row('2027-05-02', { location: 'Palma', event: 'Palma Vela' }),
    ], VENUES)
    expect(windows).toHaveLength(1)
    expect(unmatched).toEqual([{ location: 'Palma', sessions: 2 }])
  })

  it('names the run by its event when the days agree, and counts them when they do not', () => {
    const mixed = campaignWindows([
      row('2027-09-27', { event: 'Practice' }),
      row('2027-09-28', { event: 'Les Voiles' }),
    ], VENUES).windows
    expect(mixed[0].reason).toMatch(/2 session/)
  })

  it('falls back to UTC when a session carries no offset', () => {
    const { windows } = campaignWindows(
      [row('2027-09-27', { tz_offset_minutes: null })], VENUES, { padDays: 0 })
    expect(windows[0].startsAt).toBe('2027-09-27T00:00:00.000Z')
  })

  it('ignores rows with no date or no location', () => {
    const { windows, unmatched } = campaignWindows([
      row('2027-09-27'),
      { date: null, location: 'Saint-Tropez' },
      { date: '2027-09-28', location: null },
      { date: 'not a date', location: 'Saint-Tropez' },
    ], VENUES)
    expect(windows).toHaveLength(1)
    expect(unmatched).toEqual([])
  })

  it('survives nothing at all', () => {
    expect(campaignWindows(null, VENUES).windows).toEqual([])
    expect(campaignWindows([], VENUES).unmatched).toEqual([])
  })
})
