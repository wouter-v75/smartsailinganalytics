import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import AskChart from '../analytics/AskChart'

const scatter = (over: Record<string, unknown> = {}) => ({
  kind: 'scatter' as const, title: 'BSP vs TWS', xType: 'number' as const,
  xLabel: 'TWS', yLabel: 'BSP', unit: 'kn', xUnit: 'kn',
  series: [{
    label: 'Port', n: 40,
    points: Array.from({ length: 20 }, (_, i) => ({ x: 8 + i * 0.5, y: 9 + i * 0.2 })),
    trend: { slope: 0.4, intercept: 5.8, r2: 0.91, x0: 8, x1: 17.5 },
  }],
  ...over,
})

const svg = (spec: ReturnType<typeof scatter>) =>
  render(<AskChart spec={spec as never} />).container.querySelector('svg')!

describe('AskChart — the reference lines', () => {
  it('draws a polar that runs through the data, labelled at its end', () => {
    const s = svg(scatter({
      refLines: [{ label: 'polar', dashed: true, points: Array.from({ length: 10 }, (_, i) => ({ x: 8 + i, y: 10 + i * 0.3 })) }],
    }))
    expect(s.querySelector('polyline')).toBeTruthy()
    expect(Array.from(s.querySelectorAll('text')).map(t => t.textContent)).toContain('polar')
  })

  // Clamping a line that misses the frame produces a flat rule along the edge,
  // which reads as data and is not. Found by rendering it and looking.
  it('draws nothing for a reference that misses the y range entirely', () => {
    const s = svg(scatter({
      refLines: [{ label: 'polar', dashed: true, points: Array.from({ length: 10 }, (_, i) => ({ x: 8 + i, y: 0.4 })) }],
    }))
    expect(s.querySelector('polyline')).toBeNull()
    expect(Array.from(s.querySelectorAll('text')).map(t => t.textContent)).not.toContain('polar')
  })

  it('keeps the dots in frame when a reference widens the axis', () => {
    const withRef = svg(scatter({
      refLines: [{ label: 'polar', dashed: true, points: [{ x: 8, y: 14 }, { x: 17, y: 16 }] }],
    }))
    const ys = Array.from(withRef.querySelectorAll('circle')).map(c => Number(c.getAttribute('cy')))
    expect(ys.every(y => y >= 0 && y <= 170)).toBe(true)
  })

  it('shows n and R² beside each series, never a trend on its own', () => {
    const { container } = render(<AskChart spec={scatter() as never} />)
    expect(container.textContent).toContain('40')
    expect(container.textContent).toContain('R² 0.91')
  })

  it('draws the trend only across the span it was fitted to', () => {
    const s = svg(scatter())
    const line = s.querySelector('line[stroke-dasharray]')!
    expect(Number(line.getAttribute('x1'))).toBeLessThan(Number(line.getAttribute('x2')))
  })
})

// A polar and a season median, or an ideal and the linkage built to match it,
// finish in the same place and printed their names on top of each other.
describe('AskChart — two references ending together', () => {
  const twoRefs = {
    kind: 'scatter' as const, title: 'x', xType: 'number' as const,
    xLabel: 'helm', yLabel: 'diff', unit: '°', xUnit: '°',
    series: [{ label: 'measured', n: 8, points: [{ x: 1, y: 0 }, { x: 15, y: -1.8 }] }],
    refLines: [
      { label: 'ideal', color: '#F59E0B', dashed: true, points: [{ x: 1, y: 0 }, { x: 15, y: 1.32 }] },
      { label: 'recommended', color: '#22C55E', points: [{ x: 1, y: 0 }, { x: 15, y: 1.31 }] },
    ],
  }
  it('separates the labels instead of overprinting them', () => {
    const s = render(<AskChart spec={twoRefs as never} />).container.querySelector('svg')!
    const ys = Array.from(s.querySelectorAll('text'))
      .filter(t => ['ideal', 'recommended'].includes(t.textContent || ''))
      .map(t => Number(t.getAttribute('y')))
    expect(ys).toHaveLength(2)
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(9)
  })
})
