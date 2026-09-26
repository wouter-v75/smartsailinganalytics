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
    // Same table as the SailTrim panel: 5 stations x (2 sails + 2 accuracies).
    expect(within(box).getByText('Accuracy Main')).toBeTruthy()
    expect(within(box).getByText('Accuracy jib')).toBeTruthy()
    for (const station of ['25 %', '50 %', '75 %', '87.5 %', 'clew']) {
      expect(within(box).getByText(station)).toBeTruthy()
    }
    expect(within(box).getAllByText('—').length).toBe(20)
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
    // The between-station twist, under the table.
    expect(within(box).getByText(/25\u219250 \+6\.14°/)).toBeTruthy()
    expect(within(box).getByText(/50\u219275 \+7\.26°/)).toBeTruthy()
    expect(within(box).queryByText(/Reopen it in SailTrim/)).toBeNull()
    // No chords in this fixture, so the table itself is still all dashes — the
    // twist rows and the chord table come from two different arrays.
    expect(within(box).getAllByText('—').length).toBe(20)
  })

  it('fills the table from the saved chord angles', () => {
    const withChords = base({
      chords: [
        { sail: 'jib', tag: 'stripe25', fraction: 0.25, leechMm: 1221, angleDeg: 10.15, angleSigmaDeg: 0.19, widthM: 6.93, widthSource: 'interpolated' },
        { sail: 'jib', tag: 'stripe50', fraction: 0.50, leechMm: 1373, angleDeg: 16.30, angleSigmaDeg: 0.24, widthM: 4.90, widthSource: 'certificate' },
        { sail: 'main', tag: 'clew', fraction: 0, leechMm: -688, angleDeg: -3.82, angleSigmaDeg: 0.13, widthM: 10.33, widthSource: 'certificate' },
      ] as never,
    })
    render(<SailGeometryCard annotation={withChords} />)
    const box = screen.getByTestId('sailgeom-twist')
    // An interpolated width is flagged where it is used, not in a footnote.
    expect(within(box).getByText('10.2°*')).toBeTruthy()
    expect(within(box).getByText('16.3°')).toBeTruthy()
    // The main's clew, on the bottom row, to windward in light air.
    expect(within(box).getByText('-3.8°')).toBeTruthy()
    expect(within(box).getByText('± 0.13')).toBeTruthy()
    // 5 stations x 4 cells = 20, less 6: each chord fills two cells, its angle
    // and its accuracy.
    expect(within(box).getAllByText('—').length).toBe(14)
  })
})
