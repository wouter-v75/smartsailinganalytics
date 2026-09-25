// src/components/__tests__/RigShotTab.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Drives the digitiser the way an operator does — open a frame, click the marks
// in order — and checks the number that comes out on screen.
//
// The frame is synthetic: a known rig projected through a known camera (see
// support/rigCamera.ts), so the assertion is against ground truth rather than
// against the component's own arithmetic. jsdom has no canvas 2D context and no
// image loading, so both are stubbed; nothing else is.
//
// Two jsdom traps, both of which make a click LOOK like it worked while landing
// nowhere: it has no PointerEvent, so fireEvent.pointerDown silently drops
// clientX/clientY and every mark comes out NaN — hence the hand-built
// MouseEvent below. And the canvas has no layout, so `fit` must be pressed
// once the backing store has been given a size, or the view transform is
// computed from jsdom's default 300×150 and the clicks map somewhere else
// entirely.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import {
  makeCamera, RIG, MAST_HALF_WIDTH, SPREADER_HALF, SPREADER_Z, TACK, TRANSOM,
} from '../../lib/__tests__/support/rigCamera'
import type { Px } from '../../lib/rigShot'

// The CDN-loaded libraries are the only thing this component reaches out for.
vi.mock('@/lib/cdnScript', () => ({
  heicToJpeg: (f: File) => Promise.resolve(f),
  loadExifr: () => Promise.resolve({
    parse: () => Promise.resolve({
      DateTimeOriginal: new Date('2026-09-05T11:53:00Z'),
      FocalLength: RIG.focalMm,
      Model: 'Canon EOS R6m2',
      LensModel: 'RF100-500mm F4.5-7.1 L IS USM',
    }),
  }),
}))

import RigShotTab from '../rigshot/RigShotTab'

// ── the canvas the operator clicks on ───────────────────────────────────────
// One image pixel per CSS pixel, origin at the element's top-left, so a click
// at client (x, y) lands on image pixel (x, y) at zoom 1, pan 0.
const CANVAS_W = RIG.imgW
const CANVAS_H = RIG.imgH

beforeAll(() => {
  // @ts-expect-error jsdom has no ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  global.URL.createObjectURL = vi.fn(() => 'blob:rigshot')
  global.URL.revokeObjectURL = vi.fn()
  // jsdom's canvas has no 2D context; the component already tolerates null.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0, top: 0, width: CANVAS_W, height: CANVAS_H,
    right: CANVAS_W, bottom: CANVAS_H, x: 0, y: 0, toJSON: () => ({}),
  })) as never
  // jsdom never fires Image.onload, so the component would never learn the size.
  class FakeImage {
    onload: (() => void) | null = null
    naturalWidth = RIG.imgW
    naturalHeight = RIG.imgH
    set src(_v: string) { setTimeout(() => this.onload?.(), 0) }
  }
  // @ts-expect-error swapping the global constructor
  global.Image = FakeImage
})

beforeEach(() => { vi.clearAllMocks() })

/** The canvas element is the only one in the main pane; the loupe follows it. */
const mainCanvas = (): HTMLCanvasElement =>
  document.querySelectorAll('canvas')[0] as HTMLCanvasElement

/** Backing store = rect = the image, so the view transform is the identity. */
function sizeCanvas() {
  const c = mainCanvas()
  Object.defineProperty(c, 'width', { value: CANVAS_W, configurable: true })
  Object.defineProperty(c, 'height', { value: CANVAS_H, configurable: true })
}

function click(p: Px) {
  const c = mainCanvas()
  // NOT fireEvent.pointerDown: without PointerEvent, jsdom drops clientX/Y.
  // Still routed through fireEvent, which wraps the dispatch in act() — a bare
  // dispatchEvent leaves React's state update unflushed and the next assertion
  // reads a stale DOM.
  for (const type of ['pointerdown', 'pointerup']) {
    fireEvent(c, new MouseEvent(type, { clientX: p.x, clientY: p.y, bubbles: true }))
  }
}

/** Step names repeat in the form below, so scope to the step list. */
const stepButton = (label: string) =>
  within(screen.getByTestId('rigshot-steps')).getByText(label)

/** jsdom has no 2D canvas, so the one-click trace has nothing to trace — the
 *  manual edge flow is the one that can be driven here, and reaching it is
 *  itself worth asserting. */
function useManualMast() {
  fireEvent.click(screen.getByText('mark mast by hand'))
}

async function openAFrame() {
  sizeCanvas()
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([new Uint8Array([0xff, 0xd8])], '_MG_0397.JPG', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(screen.getByText(/_MG_0397/)).toBeTruthy())
  // …and the image load that follows it
  await waitFor(() => expect(screen.getByText(new RegExp(`${RIG.imgW}×${RIG.imgH}`))).toBeTruthy())
  // zoom 1, pan 0 — so a click at client (x, y) IS image pixel (x, y)
  fireEvent.click(screen.getByText('Fit'))
  await waitFor(() => expect(screen.getByText(/· 100%/)).toBeTruthy())
}

describe('RigShotTab', () => {
  it('opens on the prompt to use an original frame, not a compilation', () => {
    render(<RigShotTab />)
    expect(screen.getByText(/Open an astern frame/)).toBeTruthy()
    expect(screen.getByText(/rotated to stand the/)).toBeTruthy()
    // the workflow is visible before anything is loaded, and the mast starts
    // as one click rather than four
    expect(stepButton('Mast')).toBeTruthy()
    expect(stepButton('Jib clew')).toBeTruthy()
    useManualMast()
    expect(stepButton('Mast edges, low')).toBeTruthy()
  })

  it('says so when the frame has no focal length, and fills it in when it has', async () => {
    render(<RigShotTab />)
    await openAFrame()
    expect(screen.getByText(/Canon EOS R6m2 · 254 mm/)).toBeTruthy()
  })

  it('measures a synthetic clew to within a few millimetres of truth', async () => {
    const P = makeCamera(RIG)
    render(<RigShotTab />)
    await openAFrame()

    // heel, as it would come off the log
    const heel = screen.getByPlaceholderText('23.5')
    fireEvent.change(heel, { target: { value: String(RIG.heelDeg) } })

    // ── calibrate ───────────────────────────────────────────────────────────
    useManualMast()
    click(P(0, -MAST_HALF_WIDTH, 5_000))
    click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000))
    click(P(0, MAST_HALF_WIDTH, 30_000))

    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z))
    click(P(0, SPREADER_HALF, SPREADER_Z))

    fireEvent.click(stepButton('Centreplane baseline'))
    click(P(TRANSOM.x, 0, TRANSOM.z))
    click(P(TACK.x, 0, TACK.z))
    fireEvent.change(screen.getByDisplayValue('21000'), {
      target: { value: String(TACK.x - TRANSOM.x) },
    })
    // the default scale reference is the guessed 6 m spreader; the synthetic
    // rig is exactly 6 m tip to tip, so the number is right and the model
    // still, correctly, says it is a guess

    // ── measure ─────────────────────────────────────────────────────────────
    fireEvent.click(stepButton('Jib clew'))
    click(P(8_000, 1_900, SPREADER_Z))

    // The clew is 8 m forward, which is what the depth box already says.
    await waitFor(() => {
      const el = screen.getByText(/± \d+ mm/)
      expect(el).toBeTruthy()
    })
    // the value and its sigma are siblings: "1900 ± 25 mm"
    const reading = Number(screen.getByText(/± \d+ mm/).parentElement!.textContent!.match(/^(\d+)/)![1])
    expect(reading).toBeGreaterThan(1_895)
    expect(reading).toBeLessThan(1_905)

    // the scale is the ~6 mm/px the 6 Sept originals measure out at
    expect(screen.getByText(/6\.\d\d mm\/px/)).toBeTruthy()
    // and the frame reports itself as fully calibrated
    expect(screen.queryByText(/no centreplane baseline marked/)).toBeNull()
    expect(screen.getByText(/range ≈ 260 m/)).toBeTruthy()
  })

  it('warns, loudly and specifically, when the misalignment was never measured', async () => {
    const P = makeCamera(RIG)
    render(<RigShotTab />)
    await openAFrame()
    useManualMast()

    click(P(0, -MAST_HALF_WIDTH, 5_000))
    click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000))
    click(P(0, MAST_HALF_WIDTH, 30_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z))
    click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib clew'))
    click(P(8_000, 1_900, SPREADER_Z))

    await waitFor(() => expect(screen.getByText(/no centreplane baseline marked/)).toBeTruthy())
    // …and the sigma is the ±140 mm the doc predicts, not a comfortable ±20
    const sigma = Number(screen.getByText(/± \d+ mm/).textContent!.match(/± (\d+) mm/)![1])
    expect(sigma).toBeGreaterThan(100)
  })

  it('places both mast edges even when they are a few pixels apart', async () => {
    // At fit zoom the mast is a few pixels wide. A grab radius generous enough
    // to nudge a placed mark turns the second click into a nudge of the first,
    // and the step sticks at 1/2 with nothing to say why — found by driving the
    // real tool. 12 px apart is inside the old 22 px radius and outside the
    // 7 px one that applies while a step is still being filled.
    render(<RigShotTab />)
    await openAFrame()
    useManualMast()
    click({ x: 2_000, y: 3_000 })
    click({ x: 2_012, y: 3_000 })
    await waitFor(() =>
      expect(within(screen.getByTestId('rigshot-steps')).getByText('2/2')).toBeTruthy())
  })

  it('a point placed on a full step restarts that step rather than being lost', async () => {
    const P = makeCamera(RIG)
    render(<RigShotTab />)
    await openAFrame()
    useManualMast()
    click(P(0, -MAST_HALF_WIDTH, 5_000))
    click(P(0, MAST_HALF_WIDTH, 5_000))
    expect(within(screen.getByTestId('rigshot-steps')).getByText('2/2')).toBeTruthy()
    click(P(0, -MAST_HALF_WIDTH, 6_000))
    await waitFor(() =>
      expect(within(screen.getByTestId('rigshot-steps')).getByText('1/2')).toBeTruthy())
  })
})
