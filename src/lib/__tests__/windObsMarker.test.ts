import { describe, it, expect } from 'vitest'
import { obsMarkerHtml, obsTooltipLines, ageOpacity, obsLegend } from '../windObsMarker'
import { parseMetar, parseFfvl, type WindObs } from '../windObs'

const NOW = Date.parse('2026-10-18T09:00:00Z')
const metarAt = (iso: string, extra: Record<string, unknown> = {}): WindObs =>
  parseMetar([{ icaoId: 'LFTH', name: 'Toulon/Hyères', obsTime: Date.parse(iso) / 1000, wdir: 320, wspd: 12, lat: 43.094, lon: 6.146, elev: 3, ...extra }])[0]

describe('ageOpacity', () => {
  it('fades a station as it goes quiet, so a stale barb does not look confident', () => {
    expect(ageOpacity(metarAt('2026-10-18T08:55:00Z'), NOW)).toBe(1)
    const mid = ageOpacity(metarAt('2026-10-18T08:10:00Z'), NOW)
    expect(mid).toBeLessThan(1)
    expect(mid).toBeGreaterThan(0.3)
    expect(ageOpacity(metarAt('2026-10-18T06:00:00Z'), NOW)).toBe(0.3)
  })
})

describe('obsMarkerHtml', () => {
  it('points the BARB at the wind source and prints the speed to 1 dp', () => {
    const h = obsMarkerHtml(metarAt('2026-10-18T08:55:00Z'), NOW)
    expect(h).toContain('rotate(320 22 22)')
    expect(h).toContain('>12.0<')
    // 12 kn rounds to 10: one full barb on the shaft, and no half.
    expect((h.match(/<path/g) || []).length).toBe(2)   // shaft + one full feather
  })

  it('draws a RING, not a barb, when the direction is variable', () => {
    // A variable wind has a speed but no direction. An arrow would invent one.
    const vrb = metarAt('2026-10-18T08:55:00Z', { wdir: 'VRB' })
    const h = obsMarkerHtml(vrb, NOW)
    expect(h).toContain('<circle')
    expect(h).not.toContain('rotate(')
  })

  it('colours by network', () => {
    expect(obsMarkerHtml(metarAt('2026-10-18T08:55:00Z'), NOW)).toContain('#3B82F6')
  })
})

describe('obsTooltipLines', () => {
  it('is five labelled facts, a header and a prompt — and nothing else', () => {
    const l = obsTooltipLines(metarAt('2026-10-18T08:30:00Z', { wgst: 21 }), NOW)
    expect(l).toHaveLength(7)
    expect(l[0]).toContain('Toulon/Hyères')
    expect(l[1]).toBe('Wind    12.0 kn')
    // True AND magnetic: magnetic is what the boat's compass reads and what a
    // crew calls a shift in. Hyeres is +3.1 E, so 320 true is 317 magnetic.
    expect(l[2]).toBe('Dir     320°T / 317°M')
    expect(l[3]).toBe('Gust    21.0 kn')
    expect(l[4]).toBe('Age     30 min')
    expect(l[5]).toBe('Height  10 m')
    expect(l[6]).toBe('Click to see data graph')
  })

  it('no longer editorialises', () => {
    // All of this was true and worth knowing ONCE; none of it was worth
    // re-reading every time the pointer crossed a barb.
    const hill = obsTooltipLines(metarAt('2026-10-18T08:55:00Z', { elev: 79, icaoId: 'LFMC', name: 'Le Luc' }), NOW).join('\n')
    expect(hill).not.toContain('reads the hill')
    expect(hill).not.toContain('reads low')
    expect(hill).not.toContain('directly comparable')
    expect(hill).not.toContain('not corrected')
  })

  it('shows -- for a height the network does not publish, not a blank', () => {
    // The one line that separates "this station disagrees with the model" from
    // "this station is not measuring the same quantity". A dash is an answer;
    // an empty space is a missing one.
    const [beacon] = parseFfvl([{ idbalise: 12, latitude: 43.1, longitude: 6.2, vitesseVentMoy: 18.52, directVentMoy: 315, date: '2026-10-18 09:55:00' }])
    const l = obsTooltipLines({ ...beacon, t: '2026-10-18T08:55:00Z' }, NOW)
    expect(l[5]).toBe('Height  --')
  })

  it('shows -- for a missing gust rather than implying calm', () => {
    const l = obsTooltipLines(metarAt('2026-10-18T08:55:00Z'), NOW)
    expect(l[3]).toBe('Gust    --')
  })

  it('still flags a stale reading in the age line', () => {
    const l = obsTooltipLines(metarAt('2026-10-18T06:00:00Z'), NOW)
    expect(l[4]).toContain('stale')
  })

  it('says variable rather than inventing a bearing', () => {
    const vrb = metarAt('2026-10-18T08:55:00Z', { wdir: 'VRB' })
    expect(obsTooltipLines(vrb, NOW)[2]).toBe('Dir     variable')
  })
})

describe('obsLegend', () => {
  it('lists only the networks actually on screen, commonest first', () => {
    const obs = [
      ...parseMetar([
        { icaoId: 'A', obsTime: NOW / 1000, wdir: 10, wspd: 10, lat: 43, lon: 6 },
        { icaoId: 'B', obsTime: NOW / 1000, wdir: 20, wspd: 10, lat: 43.1, lon: 6.1 },
      ]),
      ...parseFfvl([{ idbalise: 1, latitude: 43, longitude: 6, vitesseVentMoy: 10, date: '2026-10-18 09:00:00' }]),
    ]
    const leg = obsLegend(obs)
    expect(leg.map((l) => l.key)).toEqual(['metar', 'beacon'])
    expect(leg[0].n).toBe(2)
    expect(obsLegend([])).toEqual([])
  })
})
