import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PerfChartsSection from '../analytics/PerfChartsSection'
import { polarFromData } from '../../lib/polarFile'
import targetsV14 from '../../data/targets-v1.4.json'

const T0 = Date.UTC(2026, 8, 11, 10, 18, 59)

// 12 phases: 8 upwind (alternating tacks), 4 downwind; race guns before phase 0 and 6.
const phaseDefs = Array.from({ length: 12 }, (_, i) => ({
  utc: T0 + i * 30_000, endUtc: T0 + (i + 1) * 30_000, mode: i < 8 ? 1 : 8,
  twa: (i < 8 ? 40 : 150) * (i % 2 ? -1 : 1), tws: 19 + i * 0.5,
}))
const rows = phaseDefs.flatMap(p => Array.from({ length: 30 }, (_, k) => ({
  utc: p.utc + k * 1000, tws: p.tws, twa: p.twa, awa: p.twa * 0.6, bsp: p.mode === 1 ? 11.5 : 21, sog: 11,
  heel: 20, trim: -0.8, forestay: 16, vsPerfPct: 97, upDflctPct: p.mode === 8 ? 26 : null,
})))
const xmlData = {
  phases: phaseDefs.map(({ utc, endUtc, mode }) => ({ utc, endUtc, mode })),
  sailsUpEvents: [{ utc: T0 - 60_000, sails: ['MAIN_B 2026', 'J4_A 2026'] }],
  raceGuns: [{ utc: T0 - 1000, raceNum: 5 }, { utc: T0 + 6 * 30_000 - 1000, raceNum: 6 }],
}
const charts = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-chart]')).map(e => e.getAttribute('data-chart'))

describe('PerfChartsSection', () => {
  it('shows the upwind grid, with the log’s PolBsp% when the boat has no polar', () => {
    const { container } = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} />)
    const c = charts(container)
    expect(c).toEqual(expect.arrayContaining(['bsp-tws', 'twa-tws', 'heel-tws', 'fsty-tws', 'logPolPct-tws', 'logPolPct-twa']))
    expect(c).not.toContain('vmgPct-tws')
    expect(c).not.toContain('upDflct-tws')
    expect(c).not.toContain('vang-tws')     // no data for it
    expect(screen.getByText(/No polar for this boat/)).toBeTruthy()
    expect(screen.getByText(/8 phases of 30 s · J4_A 2026/)).toBeTruthy()
  })

  it('switches to the downwind grid', () => {
    const { container } = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Downwind · 4/ }))
    expect(charts(container)).toContain('upDflct-tws')
    expect(screen.getByText(/4 phases of 30 s/)).toBeTruthy()
  })

  it('filters by race and tack, naming races after their start guns', () => {
    render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} />)
    const race = screen.getByLabelText('Race') as HTMLSelectElement
    expect(Array.from(race.options).map(o => o.text)).toEqual(['All day', 'Race 5', 'Race 6'])
    fireEvent.change(race, { target: { value: '2' } })
    expect(screen.getByText(/2 phases of 30 s/)).toBeTruthy()     // phases 6 and 7
    fireEvent.change(race, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Tack'), { target: { value: 'port' } })
    expect(screen.getByText(/4 phases of 30 s/)).toBeTruthy()
  })

  it('uses the active polar for BSPpol%, VMG% and the target line', () => {
    const { container } = render(
      <PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={{ polar: polarFromData(targetsV14), name: 'V1.4 Targets' }} />
    )
    const c = charts(container)
    expect(c).toEqual(expect.arrayContaining(['bspPol-tws', 'bspPol-twa', 'vmgPct-tws']))
    expect(c).not.toContain('logPolPct-tws')
    expect(screen.getByText('Polar · V1.4 Targets')).toBeTruthy()
    expect(container.querySelector('[data-chart="bsp-tws"] polyline')).toBeTruthy()
  })

  it('shows speed vs TWA per 2 kn wind band, with the polar curve for each band', () => {
    // TWS 19 … 24.5 kn → bands 20, 22 and 24 kn with 4 phases each.
    const withPolar = render(
      <PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={{ polar: polarFromData(targetsV14), name: 'V1.4 Targets' }} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Speed vs TWA/ }))
    expect(charts(withPolar.container)).toEqual(['bsp-twa-tws20', 'bsp-twa-tws22', 'bsp-twa-tws24'])
    expect(screen.getByText(/12 phases of 30 s/)).toBeTruthy()      // upwind + downwind together
    expect(withPolar.container.querySelectorAll('[data-chart^="bsp-twa"] polyline')).toHaveLength(3)
    expect(screen.getByText('polar 22 kn')).toBeTruthy()
    withPolar.unmount()

    const noPolar = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Speed vs TWA/ }))
    expect(noPolar.container.querySelectorAll('polyline')).toHaveLength(0)
  })

  it('draws the season curves on the X-Y plots, one switch per season', () => {
    const curvesOverride = {
      curves: {
        '2026': { up: { bsp: [{ x: 20, y: 11.2, n: 9 }, { x: 22, y: 11.6, n: 12 }, { x: 24, y: 11.9, n: 8 }] } },
        '2025': { up: { bsp: [{ x: 20, y: 10.9, n: 5 }, { x: 22, y: 11.1, n: 6 }] } },
      },
      sessions: { '2026': 20, '2025': 7 },
      phases: {},
    }
    const { container } = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={curvesOverride} />)
    expect(container.querySelector('[data-chart="bsp-tws"] [data-ref="2026"]')).toBeTruthy()
    expect(container.querySelector('[data-chart="bsp-tws"] [data-ref="2025"]')).toBeTruthy()
    expect(container.querySelector('[data-chart="heel-tws"] [data-ref]')).toBeNull()   // no heel curve stored
    const chip = screen.getByRole('button', { name: /2025 · 7 sessions/ })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-chart="bsp-tws"] [data-ref="2025"]')).toBeNull()
    expect(container.querySelector('[data-chart="bsp-tws"] [data-ref="2026"]')).toBeTruthy()
  })

  it('says when the season table has not been migrated yet', () => {
    render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={{ needsMigration: true }} />)
    expect(screen.getByText('Needs database migrations 0060 + 0061')).toBeTruthy()
  })

  it('uses stored stats from the full log when this device only has the cloud copy', () => {
    // local rows are 1 Hz here, so make them look like the 6 s cloud copy
    const cloudRows = rows.filter((_, i) => i % 6 === 0)
    const storedOverride = {
      date: '2026-09-11', stats_version: 2, polar_id: null, resolution_s: 1,
      phases: [0, 1, 2, 3].map(i => ({
        u: T0 + i * 30_000, e: T0 + (i + 1) * 30_000, m: 'up', t: i % 2 ? 'port' : 'stbd', s: 'J4_A 2026', r: 1, n: 30,
        v: { tws: 20 + i, bsp: 12, twa: 40, heel: 21 }, x: { bsp: 12.5 },
      })),
      manoeuvres: [],
    }
    const { container } = render(
      <PerfChartsSection rows={cloudRows} xmlData={xmlData} polarOverride={null} curvesOverride={null} storedOverride={storedOverride} />
    )
    expect(screen.getByText(/4 phases of 30 s/)).toBeTruthy()                  // the stored 4, not the 8 upwind phases of the log
    expect(container.querySelector('[data-resolution]')!.textContent).toBe('Full log · a row every 1 s')
  })

  it('computes from the log on this device when it is at least as fine as what is stored', () => {
    const storedOverride = { date: '2026-09-11', stats_version: 2, polar_id: null, resolution_s: 6, phases: [], manoeuvres: [] }
    const { container } = render(
      <PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} storedOverride={storedOverride} />
    )
    expect(screen.getByText(/8 phases of 30 s/)).toBeTruthy()
    expect(container.querySelector('[data-resolution]')!.textContent).toBe('Full log · a row every 1 s')
  })

  it('shows written headlines to everyone, and offers to write them only with AI access', () => {
    const headlinesOverride = {
      headlines: { headlines: ['Upwind the tacks were level: Port 98.2 %Pol against Stbd 98.0.'], bottomLine: ['Work on the gybe exit.'], dropped: ['x'] },
      model: 'mistral-medium-3.5-128b', at: '2026-09-14T10:00:00Z',
    }
    const { container, unmount } = render(
      <PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} headlinesOverride={headlinesOverride} />
    )
    const card = container.querySelector('[data-headlines]')!
    expect(card.textContent).toContain('Port 98.2 %Pol against Stbd 98.0')
    expect(card.textContent).toContain('Bottom line')
    expect(card.textContent).toContain('1 sentence with a number not in them was left out')
    unmount()

    const none = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} />)
    expect(none.container.querySelector('[data-headlines]')).toBeNull()        // no AI access, nothing written
    none.unmount()
    const ai = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} canUseAI />)
    expect(ai.container.querySelector('[data-headlines]')!.textContent).toContain('drafted by Mistral on Scaleway (EU)')
  })

  it('shows the KND report tables for the filtered phases', () => {
    const { container } = render(
      <PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={{ polar: polarFromData(targetsV14), name: 'V1.4 Targets' }} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Tables/ }))
    const ids = Array.from(container.querySelectorAll('[data-report]')).map(e => e.getAttribute('data-report'))
    expect(ids).toEqual(expect.arrayContaining(['up-sails', 'up-tws', 'up-twa', 'down-sails', 'loads']))
    const upSails = container.querySelector('[data-report="up-sails"]')!
    expect(upSails.querySelectorAll('tbody tr')).toHaveLength(2)          // port + stbd
    expect(upSails.textContent).toContain('Port')
    expect(upSails.querySelector('thead')!.textContent).toContain('%Pol')
    fireEvent.change(screen.getByLabelText('Tack'), { target: { value: 'stbd' } })
    expect(container.querySelector('[data-report="up-sails"]')!.querySelectorAll('tbody tr')).toHaveLength(1)
  })

  it('lists the tacks with an average row and jumps to one when clicked', () => {
    // one event-file tack in race 5, one before its gun (shown only with "show all"). A single gun:
    // with the test's second gun 3 min later, everything would sit in race 6's 20-minute pre-start.
    const withTacks = {
      ...xmlData,
      raceGuns: [{ utc: T0 - 1000, raceNum: 5 }],
      tackJibes: [{ utc: T0 + 2 * 30_000, isTack: true }, { utc: T0 - 7 * 60_000, isTack: true }],
    }
    const onJump = vi.fn()
    const { container } = render(<PerfChartsSection rows={rows} xmlData={withTacks} polarOverride={null} onJump={onJump} tzOffsetMin={120} />)
    fireEvent.click(screen.getByRole('button', { name: /Tacks & gybes/ }))
    const tacks = container.querySelector('[data-manoeuvres="tacks"]')!
    const body = Array.from(tacks.querySelectorAll('tbody tr[data-utc]'))
    expect(body.map(r => r.getAttribute('data-utc'))).toEqual([String(T0 + 2 * 30_000)])
    expect(tacks.querySelector('tr[data-average]')!.textContent).toContain('AVERAGE · 1 judged')
    fireEvent.click(body[0])
    expect(onJump).toHaveBeenCalledWith(T0 + 2 * 30_000)
    fireEvent.click(screen.getByLabelText(/Also show pre-start/))
    expect(container.querySelectorAll('[data-manoeuvres="tacks"] tbody tr[data-utc]')).toHaveLength(2)
  })

  it('narrows everything to a stretch picked on the GPS track', () => {
    // Phases 0–3 have their midpoints inside the first 2 minutes.
    const { rerender } = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} range={[T0, T0 + 120_000]} />)
    expect(screen.getByRole('button', { name: /Upwind · 4/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Downwind · 0/ })).toBeTruthy()
    expect(screen.getByText(/4 phases of 30 s in the track selection/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Tack'), { target: { value: 'port' } })
    expect(screen.getByText(/2 phases of 30 s in the track selection/)).toBeTruthy()
    rerender(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} range={[T0 + 1000, T0 + 10_000]} />)
    expect(screen.getByText(/No 30 s phase has its midpoint inside the track selection/)).toBeTruthy()
  })

  it('offers the lidar report only when the log has lidar channels', () => {
    render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} curvesOverride={null} />)
    expect(screen.queryByRole('button', { name: /Lidar/ })).toBeNull()
  })

  it('shows the main and jib lidar tables', () => {
    const lidarRows = rows.map(r => ({ ...r, mnCa25: 8, tMnCa25: 5, mnDr50: 45, tMnDr50: 50, jibCa25: 11, tJibCa25: 6 }))
    const { container } = render(<PerfChartsSection rows={lidarRows} xmlData={xmlData} polarOverride={null} curvesOverride={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Lidar/ }))
    const byModeTack = container.querySelector('[data-lidar="lidar-mn-mode-tack"]')!
    expect(byModeTack.textContent).toContain('Upwind')
    expect(container.querySelector('[data-lidar="lidar-mn-overall"]')!.textContent).toContain('+60.0%')   // (8 − 5) / 5
    fireEvent.click(screen.getByRole('button', { name: 'Jib' }))
    expect(container.querySelector('[data-lidar="lidar-jib-overall"]')!.textContent).toContain('+83.3%')  // (11 − 6) / 6
    expect(screen.queryByRole('button', { name: 'Spinnaker' })).toBeNull()
  })

  it('jumps to a phase when a dot is clicked', () => {
    const onJump = vi.fn()
    const { container } = render(<PerfChartsSection rows={rows} xmlData={xmlData} polarOverride={null} onJump={onJump} />)
    fireEvent.click(container.querySelector('[data-chart="bsp-tws"] [data-phase]')!)
    expect(onJump).toHaveBeenCalledWith(expect.any(Number))
  })

  it('explains an event file without phases', () => {
    render(<PerfChartsSection rows={rows} xmlData={{ ...xmlData, phases: [] }} polarOverride={null} />)
    expect(screen.getByText(/No phases in this session’s event file/)).toBeTruthy()
  })
})
