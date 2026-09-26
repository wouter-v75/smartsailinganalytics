// src/components/photos/__tests__/SailGeometryCard.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The read-only card in the timeline's photo view, drawn from the SAVED
// annotation. Not the SailTrim editor — that is a different component with its
// own twist panel, and the two disappearing independently is how "I still do
// not see the twist boxes" survived several rounds of fixes to the wrong one.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import SailGeometryCard from '../SailGeometryCard'
import type { SailTrimAnnotation } from '../../../lib/sailTrimOverlay'

const base = (over: Partial<SailTrimAnnotation> = {}): SailTrimAnnotation => ({
  version: '1',
  imageSize: { w: 4000, h: 6000 },
  defn: 'boat',
  axis: { low: { x: 1945, y: 5558 }, high: { x: 1603, y: 247 } },
  targets: [
    { key: 'jib@stripe50', label: 'Jib leech @ 50 %', mm: 1373, sigmaMm: 19, colour: '#4ADE80' } as never,
  ],
  psiDeg: 0.4,
  psiMeasured: true,
  heelDeg: 12,
  tack: 'port',
  twist: [],
  ...over,
}) as SailTrimAnnotation

describe('SailGeometryCard — the Twist box', () => {
  it('is present even when the saved annotation carries no twist', () => {
    // The real case: the 26 Sep 12:09 frame was saved with twist: [] because no
    // boat was named, so the widths that twist divides by were never loaded. The
    // box vanished entirely, which looks identical to the card having no twist
    // feature — and the remedy was nowhere on screen.
    render(<SailGeometryCard annotation={base()} />)
    const box = screen.getByTestId('sailgeom-twist')
    expect(box).toBeTruthy()
    expect(within(box).getByText('Twist')).toBeTruthy()
    expect(within(box).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('says why, and what to do about it', () => {
    render(<SailGeometryCard annotation={base()} />)
    const box = screen.getByTestId('sailgeom-twist')
    expect(within(box).getByText(/sail widths/)).toBeTruthy()
    expect(within(box).getByText(/Reopen it in SailTrim and save again/)).toBeTruthy()
  })

  it('shows the numbers when they are there, and no complaint', () => {
    const withTwist = base({
      twist: [
        { sail: 'jib', from: 'stripe25', to: 'stripe50', fromDeg: 10.1, toDeg: 16.3, twistDeg: 6.14, sigmaDeg: 0.3, interpolated: true },
        { sail: 'jib', from: 'stripe50', to: 'stripe75', fromDeg: 16.3, toDeg: 23.5, twistDeg: 7.26, sigmaDeg: 0.5, interpolated: false },
      ] as never,
    })
    render(<SailGeometryCard annotation={withTwist} />)
    const box = screen.getByTestId('sailgeom-twist')
    expect(within(box).getByText('+6.14° ±0.30')).toBeTruthy()
    expect(within(box).getByText('+7.26° ±0.50')).toBeTruthy()
    expect(within(box).queryByText(/Reopen it in SailTrim/)).toBeNull()
    // The main still has no rows, so it keeps its dash rather than vanishing.
    expect(within(box).getAllByText('—').length).toBe(1)
  })
})
