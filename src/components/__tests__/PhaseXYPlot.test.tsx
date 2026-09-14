import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PhaseXYPlot from '../analytics/PhaseXYPlot'
import type { PhaseStat } from '../../lib/phaseStats'

// 12:18:59 venue time (UTC+2) on 11 Sep 2026.
const T0 = Date.UTC(2026, 8, 11, 10, 18, 59)
const phase = (i: number, tack: 'port' | 'stbd', tws: number, bsp: number): PhaseStat => ({
  utc: T0 + i * 30_000, endUtc: T0 + (i + 1) * 30_000, mode: 'up', tack,
  sails: ['MAIN_B 2026', 'J4_A 2026'], sailCombo: 'J4_A 2026', race: 1, n: 5,
  mean: { tws, bsp }, max: {},
})
const phases = [phase(0, 'stbd', 21.2, 11.03), phase(1, 'port', 23.1, 11.88), phase(2, 'port', 24.4, 11.73), phase(3, 'port', 25.9, 12.03)]

const dots = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-phase]'))

describe('PhaseXYPlot', () => {
  it('draws one dot per phase, port as triangles, with the tack legend', () => {
    const { container } = render(<PhaseXYPlot phases={phases} yKey="bsp" tzOffsetMin={120} />)
    expect(dots(container)).toHaveLength(4)
    expect(container.querySelectorAll('polygon[data-tack="port"]')).toHaveLength(3)
    expect(container.querySelectorAll('circle[data-tack="stbd"]')).toHaveLength(1)
    expect(screen.getByText(/Port tack · 3/)).toBeTruthy()
    expect(screen.getByText(/Stbd tack · 1/)).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('BSP vs TWS, 4 phases')
  })

  it('veils the other tack and shows the phase on hover', () => {
    const { container } = render(<PhaseXYPlot phases={phases} yKey="bsp" tzOffsetMin={120} />)
    const stbdDot = container.querySelector('circle[data-tack="stbd"]')!
    fireEvent.mouseEnter(stbdDot)
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('12:18:59 · Stbd')
    expect(tip.textContent).toContain('BSP 11.03 kn')
    expect(tip.textContent).toContain('J4_A 2026 · 5 samples')
    // veil + the hovered tack redrawn on top
    expect(container.querySelector('rect[opacity="0.62"]')).toBeTruthy()
    expect(container.querySelectorAll('circle[data-tack="stbd"][stroke="#fff"]')).toHaveLength(1)
    fireEvent.mouseLeave(stbdDot)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('redraws the hovered tack with its trend, without duplicate React keys', () => {
    // Seen in the app: hovering a tack WITH a trend line rendered a second <line> under
    // the same key ("trport"), which React warns about and may drop on update.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(<PhaseXYPlot phases={phases} yKey="bsp" />)
    expect(screen.getByText(/Port tack · 3 · R² \d\.\d\d/)).toBeTruthy()   // 3 port phases → trend
    fireEvent.mouseEnter(container.querySelector('polygon[data-tack="port"]')!)
    expect(err.mock.calls.flat().join(' ')).not.toMatch(/same key/)
    err.mockRestore()
  })

  it('jumps to the phase on click', () => {
    const onSelectUtc = vi.fn()
    const { container } = render(<PhaseXYPlot phases={phases} yKey="bsp" onSelectUtc={onSelectUtc} tzOffsetMin={120} />)
    expect(screen.getByText(/hover to highlight · click to jump/)).toBeTruthy()
    fireEvent.click(container.querySelectorAll('polygon[data-tack="port"]')[1])
    expect(onSelectUtc).toHaveBeenCalledWith(T0 + 2 * 30_000)
    // a tap also opens the tooltip (no hover on touch screens)
    expect(screen.getByRole('tooltip').textContent).toContain('12:19:59 · Port')
  })

  it('draws the polar target line and marks the playing phase', () => {
    const targetLine = [{ x: 20, y: 11.5 }, { x: 26, y: 11.6 }]
    const { container } = render(
      <PhaseXYPlot phases={phases} yKey="bsp" targetLine={targetLine} activeUtc={T0 + 45_000} />
    )
    expect(container.querySelector('polyline')).toBeTruthy()
    expect(screen.getByText('polar')).toBeTruthy()
    expect(container.querySelector('circle[r="7"]')).toBeTruthy()
  })

  it('can drop the trend lines and widen the x-axis to the polar curve', () => {
    // Speed vs TWA: dots at 21–26 "TWA" here, curve out to 180°.
    const curve = [{ x: 30, y: 9 }, { x: 90, y: 16 }, { x: 180, y: 14 }]
    const { container } = render(
      <PhaseXYPlot phases={phases} yKey="bsp" showTrend={false} targetLine={curve} targetLabel="polar 20 kn" />
    )
    expect(container.querySelectorAll('line[stroke-dasharray="5,3"]')).toHaveLength(0)
    expect(screen.queryByText(/R²/)).toBeNull()
    expect(screen.getByText('polar 20 kn')).toBeTruthy()
    // The x-axis spans the curve: every curve point lies inside the plot area
    // (pad.l 36 … width 400 − pad.r 8), not off to the right of the dots' range.
    const xs = container.querySelector('polyline')!.getAttribute('points')!.split(' ').map(p => Number(p.split(',')[0]))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(36)
    expect(Math.max(...xs)).toBeLessThanOrEqual(392)
    const ticks = Array.from(container.querySelectorAll('svg text')).map(t => Number(t.textContent)).filter(Number.isFinite)
    expect(ticks).toContain(150)
  })

  it('draws season reference curves, clipped to the day’s wind range', () => {
    // dots span TWS 21.2–25.9 → a season curve from 18 to 28 kn keeps only 22, 24 and 26 kn
    const refCurves = [
      { label: '2026', color: '#F8FAFC', points: [18, 20, 22, 24, 26, 28].map((x, i) => ({ x, y: 11 + i * 0.2 })) },
      { label: '2025', color: '#FBBF24', points: [{ x: 10, y: 9 }, { x: 12, y: 9.5 }] },   // nothing in range
    ]
    const { container } = render(<PhaseXYPlot phases={phases} yKey="bsp" refCurves={refCurves} />)
    const g = container.querySelector('[data-ref="2026"]')!
    expect(g.textContent).toBe('2026')
    expect(g.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3)
    expect(container.querySelector('[data-ref="2025"]')).toBeNull()
  })

  it('says so when there is nothing to plot', () => {
    render(<PhaseXYPlot phases={[]} yKey="bsp" />)
    expect(screen.getByText('No data')).toBeTruthy()
  })
})
