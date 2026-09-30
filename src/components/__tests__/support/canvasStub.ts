// src/components/__tests__/support/canvasStub.ts
// ─────────────────────────────────────────────────────────────────────────────
// A 2d context for jsdom, which has none.
//
// Without one, `getContext('2d')` returns null and jsdom logs
// "Not implemented: HTMLCanvasElement.prototype.getContext" — six of those were
// coming out of PhotoLightbox's tests, and the reason they were only NOISE and
// not failures is that the tests in question assert on the chrome around the
// picture. Nothing was exercising the compose path at all. Installing this is
// what makes a photo test actually draw the photo.
//
// It covers exactly the calls photoOverlay, sailTrimOverlay and PhotoCanvas make
// (`ctx.<name>` across the three), so a new one shows up as an undefined-is-not-
// a-function rather than being quietly swallowed by a Proxy that answers
// everything.
//
// It does NOT verify drawing — every method is a no-op. What it gives a test is
// the ability to reach the code after `getContext`.
// ─────────────────────────────────────────────────────────────────────────────

import { vi } from 'vitest'

/** Installs a stub 2d context on HTMLCanvasElement, and returns the undo. Call
 *  the undo in `afterEach`: patching a PROTOTYPE and leaving it patched shows up
 *  as a fault in whichever test happens to run next. */
export function installCanvasStub(): () => void {
  const realContext = HTMLCanvasElement.prototype.getContext
  const realRect = HTMLCanvasElement.prototype.getBoundingClientRect

  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      // Drawing and pathing.
      drawImage: () => {}, fillRect: () => {}, rect: () => {}, roundRect: () => {},
      beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
      fill: () => {}, stroke: () => {}, setLineDash: () => {},
      save: () => {}, restore: () => {}, scale: () => {}, translate: () => {},
      // Text. A fixed width is enough: the layout code only needs A number, and
      // a real one would make these tests depend on a font.
      fillText: () => {}, strokeText: () => {}, measureText: () => ({ width: 40 }),
      // State, as plain properties so assignment works.
      font: '', textAlign: '', textBaseline: '',
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '',
      imageSmoothingEnabled: false, imageSmoothingQuality: '',
    }
  }) as never

  // Zero-sized in jsdom, and PhotoCanvas fits the picture to it — so without a
  // size the viewport is 0×0 and nothing is drawn even with a context.
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
  })) as never

  return () => {
    HTMLCanvasElement.prototype.getContext = realContext
    HTMLCanvasElement.prototype.getBoundingClientRect = realRect
  }
}
