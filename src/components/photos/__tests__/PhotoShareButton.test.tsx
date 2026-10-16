// src/components/photos/__tests__/PhotoShareButton.test.tsx
import { describe, it, expect } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// The button itself, where it now lives: inside PhotoViewer, beside the
// favourite heart (Wouter, 16 Oct). It was in the Photos tab's own panel first,
// which meant a photo opened from the TIMELINE had no share button at all —
// the timeline uses PhotoLightbox, deliberately a different component. Both
// mount PhotoViewer, so one placement serves both.
// ─────────────────────────────────────────────────────────────────────────────

import { render, screen, fireEvent } from '@testing-library/react'
import PhotoShareButton from '../PhotoShareButton'

describe('PhotoShareButton', () => {
  it('offers the data overlay to a Gold', () => {
    render(<PhotoShareButton role="coach" photoName="IMG_1.JPG" />)
    fireEvent.click(screen.getByTestId('photo-share'))
    expect(screen.getByTestId('photo-share-data')).toBeTruthy()
    expect(screen.queryByTestId('photo-share-denied')).toBeNull()
  })

  it('offers a Silver the photo, and the REASON for the rest', () => {
    // Not a missing button: a missing one looks like a bug, where a stated tier
    // says what it is and what would change it.
    render(<PhotoShareButton role="tl1" photoName="IMG_1.JPG" />)
    fireEvent.click(screen.getByTestId('photo-share'))
    expect(screen.getByTestId('photo-share-plain')).toBeTruthy()
    expect(screen.queryByTestId('photo-share-data')).toBeNull()
    expect(screen.getByTestId('photo-share-denied').textContent).toMatch(/Sailor Gold and up/)
  })

  it('treats an unknown role as Silver, since every gate here is an allow list', () => {
    render(<PhotoShareButton photoName="IMG_1.JPG" />)
    fireEvent.click(screen.getByTestId('photo-share'))
    expect(screen.queryByTestId('photo-share-data')).toBeNull()
  })

  it('says so rather than sharing a blank when the overlay has not drawn', async () => {
    // `composed` returning null is the real case: compositing is the first
    // thing iOS Safari refuses at its canvas-memory cap, and an empty canvas
    // would share a blank JPEG.
    render(<PhotoShareButton role="coach" photoName="IMG_1.JPG" composed={() => null} />)
    fireEvent.click(screen.getByTestId('photo-share'))
    fireEvent.click(screen.getByTestId('photo-share-data'))
    expect(await screen.findByText(/has not finished drawing/)).toBeTruthy()
  })
})
