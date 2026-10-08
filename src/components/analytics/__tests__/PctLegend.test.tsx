import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import PctLegend from '../PctLegend'
import { pctColour } from '../../../lib/pctScale'

describe('PctLegend', () => {
  it('says which end is good, because colour cannot', () => {
    // The one thing nobody can guess: "dark green is better than light green"
    // is a convention, and on a dark UI the dark end is the quieter one, which
    // argues the opposite.
    render(<PctLegend />)
    expect(screen.getByText(/deeper green is faster, red is slower/i)).toBeTruthy()
    expect(screen.getByText(/100 is on it/i)).toBeTruthy()
  })

  it('marks the numbers the stops were specified at', () => {
    render(<PctLegend />)
    for (const v of ['85', '90', '95', '100', '105', '110']) {
      expect(screen.getByText(v), v).toBeTruthy()
    }
  })

  it('names only the columns it is placed beside', () => {
    // The Starts table has two of the three; labelling it with all three would
    // send somebody hunting for a %Pol column that is not there.
    const { container } = render(<PctLegend label="BSP_trg% · VMG%" />)
    expect(container.textContent).toContain('BSP_trg% · VMG%')
    expect(container.textContent).not.toContain('%Pol')
  })

  it('draws its gradient FROM the scale, not from a second copy of the stops', () => {
    // A hand-written gradient is the thing that silently stops matching the
    // cells it explains the moment a stop moves.
    const { container } = render(<PctLegend />)
    const bar = Array.from(container.querySelectorAll('div')).find(
      (d) => (d as HTMLElement).style.background?.includes('linear-gradient'),
    ) as HTMLElement
    expect(bar).toBeTruthy()
    const css = bar.style.background.toLowerCase()
    // Sampled at every whole percent from 80, so each stop's own colour appears.
    for (const v of [85, 90, 95, 105, 110]) {
      expect(css, `${v}`).toContain(pctColour(v)!.toLowerCase())
    }
  })
})
