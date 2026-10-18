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
  it('rotates the arrow to the wind SOURCE and prints the speed', () => {
    const h = obsMarkerHtml(metarAt('2026-10-18T08:55:00Z'), NOW)
    expect(h).toContain('rotate(320deg)')
    expect(h).toContain('>12<')
  })

  it('draws a RING, not an arrow, when the direction is variable', () => {
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
  it('says a 10 m station is directly comparable', () => {
    const l = obsTooltipLines(metarAt('2026-10-18T08:55:00Z'), NOW)
    expect(l[0]).toContain('Toulon/Hyères')
    expect(l[1]).toBe('12.0 kn from 320°')
    expect(l.join('\n')).toContain('directly comparable')
  })

  it('refuses to imply a correction it could not make', () => {
    // No published mast height -> no 10 m number, and the tooltip says why.
    const [beacon] = parseFfvl([{ idbalise: 12, latitude: 43.1, longitude: 6.2, vitesseVentMoy: 18.52, directVentMoy: 315, date: '2026-10-18 09:55:00' }])
    const l = obsTooltipLines({ ...beacon, t: '2026-10-18T08:55:00Z' }, NOW).join('\n')
    expect(l).toContain('height not published')
    expect(l).not.toContain('at 10 m')
  })

  it('warns when the station is up a hill rather than on the water', () => {
    const hill = obsTooltipLines(metarAt('2026-10-18T08:55:00Z', { elev: 79, icaoId: 'LFMC', name: 'Le Luc' }), NOW).join('\n')
    expect(hill).toContain('reads the hill, not the course')
    const coast = obsTooltipLines(metarAt('2026-10-18T08:55:00Z'), NOW).join('\n')
    expect(coast).toContain('reads low')
  })

  it('reports the gust and the age', () => {
    const l = obsTooltipLines(metarAt('2026-10-18T08:30:00Z', { wgst: 21 }), NOW).join('\n')
    expect(l).toContain('gusting 21')
    expect(l).toContain('30 min old')
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
