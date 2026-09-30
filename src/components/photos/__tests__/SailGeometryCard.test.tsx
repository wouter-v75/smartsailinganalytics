// src/components/photos/__tests__/SailGeometryCard.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The read-only card in the timeline's photo view, drawn from the SAVED
// annotation. Not the SailTrim editor — that is a different component with its
// own twist panel, and the two disappearing independently is how "I still do
// not see the twist boxes" survived several rounds of fixes to the wrong one.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    expect(within(box).getByText('Accuracy Jib')).toBeTruthy()
    for (const station of ['25 %', '50 %', '75 %', '87.5 %', 'clew']) {
      expect(within(box).getByText(station)).toBeTruthy()
    }
    // 5 stations x (2 angles + 2 drafts + 2 accuracies).
    expect(within(box).getAllByText('—').length).toBe(30)
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
    // 5 stations x (2 angles + 2 drafts + 2 accuracies).
    expect(within(box).getAllByText('—').length).toBe(30)
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
    // 5 stations x 6 cells = 30, less 6: each chord fills its angle and its
    // accuracy. The two DRAFT columns stay dashed — depth needs several frames.
    expect(within(box).getAllByText('—').length).toBe(24)
  })

  it('shows the DRAFT once a multi-view solve has been stored on the frame', () => {
    // The number is written onto every frame that went into it, because none of
    // them produced it alone: one view cannot separate depth from position
    // along the stripe.
    const withCamber = base({
      camber: [{
        sail: 'main', tag: 'stripe50', camberPct: 9.4, draftPct: 49, rmsMm: 51,
        frames: 3, baselineDeg: 8.01, reachedPeak: true,
        fromFrames: ['2026-09-27T11:43:30+00:00', '2026-09-27T11:43:33+00:00', '2026-09-27T11:43:36+00:00'],
      }] as never,
    })
    render(<SailGeometryCard annotation={withCamber} />)
    const box = screen.getByTestId('sailgeom-twist')
    expect(within(box).getByText('9.4 %')).toBeTruthy()
    expect(within(box).getByText(/solved across 3 frames spanning 8.0°/)).toBeTruthy()
  })

  it('marks a draft that never reached the deepest part', () => {
    const withCamber = base({
      camber: [{
        sail: 'jib', tag: 'stripe50', camberPct: 7.1, draftPct: 44, rmsMm: 30,
        frames: 2, baselineDeg: 5.2, reachedPeak: false, fromFrames: [],
      }] as never,
    })
    render(<SailGeometryCard annotation={withCamber} />)
    expect(within(screen.getByTestId('sailgeom-twist')).getByText('7.1 %↓')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The lidar columns. They appear only when the boat HAS a lidar and the frame is
// of that boat, so the hook is mocked at its edge — what is under test here is
// the table, not the fetch.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../useLidarForPhoto', () => ({
  useLidarForPhoto: () => mockPhase,
  MAX_GAP_MS: 45_000,
}))

let mockPhase: { mean: Record<string, number> } | null = null

const withChordsAndCamber = () => base({
  chords: [
    { sail: 'main', tag: 'stripe50', fraction: 0.5, chordMm: 1000, widthM: 7.04, widthSource: 'certificate', angleDeg: 9.9, angleSigmaDeg: 0.3, luffMm: null },
  ] as never,
  camber: [
    { sail: 'main', tag: 'stripe50', camberPct: 10.4, draftPct: 49, rmsMm: 12, frames: 3, baselineDeg: 8, reachedPeak: true, fromFrames: [] },
  ] as never,
})

describe('SailGeometryCard — lidar columns', () => {
  beforeEach(() => { mockPhase = null })

  it('shows no lidar columns at all when there is no lidar', () => {
    // A rival, or a day the unit was off. Dashes would read as a measurement
    // that failed rather than as equipment that was never there.
    render(<SailGeometryCard annotation={withChordsAndCamber()} />)
    expect(screen.queryByText(/Lidar Twist Main/)).toBeNull()
    expect(screen.queryByText(/Lidar Draft Main/)).toBeNull()
  })

  it('adds them beside the photographed numbers when the lidar is there', () => {
    mockPhase = { mean: { mnTw50: 9.4, mnCa50: 11.2, mnDr50: 47.5 } }
    render(<SailGeometryCard annotation={withChordsAndCamber()} sessionDate="2026-09-26" takenUtc="2026-09-26T10:25:28Z" />)
    expect(screen.getByText(/Lidar Twist Main/)).toBeTruthy()
    const row = screen.getByText('50 %').closest('tr')!
    // Photo beside lidar: 9.9° against 9.4°, and 10.4 % against 11.2 %.
    expect(within(row).getByText('9.9°')).toBeTruthy()
    expect(within(row).getByText('9.4°')).toBeTruthy()
    expect(within(row).getByText('10.4 %')).toBeTruthy()
    expect(within(row).getByText('11.2 %')).toBeTruthy()
    // DR is the position of the peak, not the depth — it must not be here.
    expect(within(row).queryByText('47.5 %')).toBeNull()
  })

  it('dashes a stripe the lidar does not reach, without losing the column', () => {
    mockPhase = { mean: { mnTw25: 3.0 } }
    render(<SailGeometryCard annotation={withChordsAndCamber()} sessionDate="2026-09-26" takenUtc="2026-09-26T10:25:28Z" />)
    const row = screen.getByText('50 %').closest('tr')!
    expect(within(row).getByText('9.9°')).toBeTruthy()      // the photo is still there
    expect(screen.getByText(/Lidar Twist Main/)).toBeTruthy()
  })
})
