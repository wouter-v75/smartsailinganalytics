// src/components/timeline/__tests__/PhotoLightbox.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The photo lightbox both timeline views open.
//
// It was two copies, and the copies drifted: DayMedia was handed the THUMBNAIL
// as its full image for a while — which is how photos looked grainy in one view
// and sharp in the other — and only DayTimeline ever gained the line explaining
// that a photo with no cloud original cannot be measured. These are the shared
// behaviours, asserted once.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { installCanvasStub } from '../../__tests__/support/canvasStub'

// Without a 2d context the compose step bails out and the lightbox shows the
// bare image, so these tests were asserting on the chrome around a picture that
// never drew — and jsdom logged six "Not implemented: getContext" lines saying
// so, which read as errors. With the stub the photo actually composes.
let undoCanvas: (() => void) | null = null
beforeAll(() => { undoCanvas = installCanvasStub() })
afterAll(() => { undoCanvas?.(); undoCanvas = null })

// The heart is its own component with its own tests; here it would only load the
// favourites store over the network after the test had finished, which React
// reports as an update outside act(). `available: false` is what a signed-out
// or unsupported client sees, and it renders no heart at all.
vi.mock('@/lib/favourites', async (orig) => {
  const real = await orig<typeof import('@/lib/favourites')>()
  return { ...real, useFavourites: () => ({ available: false, loaded: true, has: () => false, count: 0 }) }
})

vi.mock('@/lib/cdnScript', () => ({
  heicToJpeg: (f: File) => Promise.resolve(f),
  loadExifr: () => Promise.resolve({ parse: () => Promise.resolve({}) }),
  loadJsPdf: () => Promise.resolve(function () { /* unused */ }),
}))

import PhotoLightbox, { type LightboxPhoto } from '../PhotoLightbox'

const photo = (over: Partial<LightboxPhoto> = {}): LightboxPhoto => ({
  id: 'p1', thumb: 'thumb.jpg', original: 'original.jpg', inst: { tws: 9 }, sailTrim: null, ...over,
})

describe('PhotoLightbox', () => {
  it('renders nothing until a photo is opened', () => {
    const { container } = render(<PhotoLightbox photo={null} onClose={() => {}} />)
    expect(container.textContent).toBe('')
  })

  it('offers measuring when there is a cloud original', () => {
    render(<PhotoLightbox photo={photo()} onClose={() => {}} onMeasure={() => {}} />)
    expect(screen.getByText(/Analyse sail geometry/)).toBeTruthy()
  })

  it('says WHY it cannot measure a photo with no original', () => {
    // DayMedia never had this line; it simply showed nothing, which reads as
    // the feature being absent rather than the photo being unmeasurable.
    render(<PhotoLightbox photo={photo({ original: null })} onClose={() => {}} onMeasure={() => {}} />)
    expect(screen.queryByText(/Analyse sail geometry/)).toBeNull()
    expect(screen.getByText(/not in the cloud for this photo/)).toBeTruthy()
  })

  it('hides the measure button from a viewer who may not write', () => {
    render(<PhotoLightbox photo={photo()} onClose={() => {}} onMeasure={null} />)
    expect(screen.queryByText(/Analyse sail geometry/)).toBeNull()
  })

  it('steps through the burst a card stands for', () => {
    const onStep = vi.fn()
    render(<PhotoLightbox photo={photo()} onClose={() => {}}
      burst={{ index: 1, count: 24, timeLabel: '11:50:03', spanLabel: 'a 9s burst', onStep }} />)
    expect(screen.getByText(/frame 2 of 24/)).toBeTruthy()
    fireEvent.click(screen.getByText(/next →/))
    expect(onStep).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByText(/← prev/))
    expect(onStep).toHaveBeenCalledWith(-1)
  })

  it('does not show burst navigation for a single frame', () => {
    render(<PhotoLightbox photo={photo()} onClose={() => {}}
      burst={{ index: 0, count: 1, timeLabel: '11:50:03', onStep: () => {} }} />)
    expect(screen.queryByText(/frame 1 of 1/)).toBeNull()
  })
})

describe('the close button and the user pill', () => {
  // The pill is `fixed top-3 right-3` at z-index 9999. A dialog sits at z-1101
  // and cannot raise itself past it, so a WIDE panel's top right corner is under
  // the pill and its X is unclickable — which happened to the photo viewer and
  // the video dialog independently. `wide` moves the close to the top middle, so
  // the next wide dialog cannot forget.
  it('puts the close in the middle on a wide panel', () => {
    render(<PhotoLightbox photo={photo()} onClose={() => {}} />)
    const close = screen.getByLabelText('Close')
    expect(close.className).toMatch(/left-1\/2/)
    expect(close.className).not.toMatch(/right-3/)
  })
})
