// src/components/__tests__/PhotoViewer.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The one viewer the Photos tab and both timeline lightboxes now share.
//
// It is tested here rather than through any of its three callers because this is
// where the recurring bug lives: WHICH image gets composed. Twice a photograph
// has been drawn from the 480 px thumbnail while the original sat in Bunny, and
// the second time it was a surviving copy in the timeline of a fault already
// fixed in the Photos tab. One component, one test, three call sites.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

import PhotoViewer from '../photos/PhotoViewer'
import { drawSailTrimAnnotation } from '../../lib/sailTrimOverlay'
import { renderOverlay } from '../../lib/photoOverlay'

vi.mock('../../lib/sailTrimOverlay', async (orig) => {
  const real = await orig<typeof import('../../lib/sailTrimOverlay')>()
  return { ...real, drawSailTrimAnnotation: vi.fn(real.drawSailTrimAnnotation) }
})
vi.mock('../../lib/photoOverlay', async (orig) => {
  const real = await orig<typeof import('../../lib/photoOverlay')>()
  return { ...real, renderOverlay: vi.fn(real.renderOverlay) }
})

const THUMB_W = 480, FULL_W = 6000

/** Every Image constructed, so the test can decide when each one loads. */
let images: FakeImage[] = []
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin = ''
  naturalWidth = 0
  naturalHeight = 0
  _src = ''
  constructor() { images.push(this) }
  get src() { return this._src }
  set src(v: string) {
    this._src = v
    // Width tells the compose step which one it got, and the test which one the
    // component asked for.
    this.naturalWidth = v.includes('full') ? FULL_W : THUMB_W
    this.naturalHeight = Math.round(this.naturalWidth * 0.667)
  }
  fire() { this.onload?.() }
  fail() { this.onerror?.() }
}

beforeAll(() => {
  // @ts-expect-error jsdom has no ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      fillRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {},
      scale: () => {}, translate: () => {}, beginPath: () => {}, moveTo: () => {},
      lineTo: () => {}, stroke: () => {}, fill: () => {}, rect: () => {}, roundRect: () => {},
      fillText: () => {}, strokeText: () => {}, setLineDash: () => {},
      measureText: () => ({ width: 40 }),
      font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
      lineWidth: 0, lineCap: '', imageSmoothingEnabled: false, imageSmoothingQuality: '',
    }
  }) as never
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
  })) as never
  // @ts-expect-error swapping the global constructor
  global.Image = FakeImage
})

beforeEach(() => { images = []; vi.clearAllMocks() })

const annotation = {
  version: 'sailtrim-v0.2-horizon',
  imageSize: { w: FULL_W, h: 4000 },
  defn: 'boat' as const,
  axis: { low: { x: 2900, y: 3400 }, high: { x: 3100, y: 400 } },
  targets: [
    { key: 'clew', label: 'Jib clew', point: { x: 3280, y: 2600 }, foot: { x: 3010, y: 2580 }, mm: -1103, sigmaMm: 17, colour: '#FB923C' },
  ],
  psiDeg: 0.42, psiMeasured: true, heelDeg: 22.7, measuredAt: 1_700_000_000_000,
}

const view = (props: Record<string, unknown> = {}) =>
  render(<PhotoViewer photoId="p1" thumbUrl="https://cdn/thumb.jpg" fullUrl="https://cdn/full.jpg" {...props} />)

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('PhotoViewer', () => {
  it('asks for BOTH the thumbnail and the original', async () => {
    view()
    await settle()
    const urls = images.map((i) => i.src)
    expect(urls).toContain('https://cdn/thumb.jpg')
    expect(urls).toContain('https://cdn/full.jpg')
  })

  it('composes the ORIGINAL, not the thumbnail — the bug that keeps coming back', async () => {
    view()
    await settle()
    const thumb = images.find((i) => i.src.includes('thumb'))!
    const full = images.find((i) => i.src.includes('full'))!
    await act(async () => { thumb.fire(); full.fire() })
    // The last compose is the one on screen, and it was handed the 6000 px image.
    const composed = vi.mocked(renderOverlay).mock.calls.at(-1)!
    expect((composed[1] as HTMLImageElement).naturalWidth).toBe(FULL_W)
  })

  it('shows the thumbnail first, so something appears before the original lands', async () => {
    view()
    await settle()
    const thumb = images.find((i) => i.src.includes('thumb'))!
    await act(async () => { thumb.fire() })
    expect(vi.mocked(renderOverlay)).toHaveBeenCalledTimes(1)
    expect((vi.mocked(renderOverlay).mock.calls[0][1] as HTMLImageElement).naturalWidth).toBe(THUMB_W)
    // …and says the original is still on its way.
    expect(screen.getByText(/loading full resolution/i)).toBeTruthy()
  })

  it('does not let a late thumbnail paint over an original that already landed', async () => {
    view()
    await settle()
    const thumb = images.find((i) => i.src.includes('thumb'))!
    const full = images.find((i) => i.src.includes('full'))!
    await act(async () => { full.fire() })
    await act(async () => { thumb.fire() })          // arrives second, as on a slow link
    const last = vi.mocked(renderOverlay).mock.calls.at(-1)!
    expect((last[1] as HTMLImageElement).naturalWidth).toBe(FULL_W)
  })

  it('says "thumbnail only" when the original will not load, and offers a retry', async () => {
    view()
    await settle()
    const thumb = images.find((i) => i.src.includes('thumb'))!
    const full = images.find((i) => i.src.includes('full'))!
    await act(async () => { thumb.fire(); full.fail() })
    expect(screen.getByText(/Thumbnail only/i)).toBeTruthy()

    const before = images.length
    fireEvent.click(screen.getByText(/Try again/i))
    await settle()
    // A FRESH url — a browser that cached the failure will not re-request the same one.
    const retried = images.slice(before).map((i) => i.src).find((u) => u.includes('full'))
    expect(retried).toMatch(/retry=1/)
  })

  it('burns the sail-geometry lines in only when the overlay is on', async () => {
    const draw = vi.mocked(drawSailTrimAnnotation)

    const on = view({ sailTrim: { annotation, overlay: true } })
    await settle()
    await act(async () => { images.find((i) => i.src.includes('full'))!.fire() })
    await waitFor(() => expect(draw).toHaveBeenCalled())
    on.unmount()

    draw.mockClear(); images = []
    view({ sailTrim: { annotation, overlay: false } })
    await settle()
    await act(async () => { images.find((i) => i.src.includes('full'))!.fire() })
    expect(draw).not.toHaveBeenCalled()
  })

  it('ignores a malformed annotation rather than throwing inside the paint', async () => {
    const draw = vi.mocked(drawSailTrimAnnotation)
    view({ sailTrim: { annotation: { targets: [] }, overlay: true } })
    await settle()
    await act(async () => { images.find((i) => i.src.includes('full'))!.fire() })
    expect(draw).not.toHaveBeenCalled()
    expect(vi.mocked(renderOverlay)).toHaveBeenCalled()   // the photo still drew
  })

  it('hands the composed canvas back for exporting', async () => {
    const onComposed = vi.fn()
    view({ onComposed })
    await settle()
    await act(async () => { images.find((i) => i.src.includes('full'))!.fire() })
    expect(onComposed).toHaveBeenCalled()
    expect(onComposed.mock.calls.at(-1)![0]).toBeInstanceOf(HTMLCanvasElement)
  })

  it('says nothing about loading when there is only one image to show', async () => {
    // A local blob, where thumb and full are the same object URL.
    view({ thumbUrl: 'blob:same', fullUrl: 'blob:same' })
    await settle()
    await act(async () => { images[0].fire() })
    expect(screen.queryByText(/loading full resolution/i)).toBeNull()
    expect(screen.queryByText(/Thumbnail only/i)).toBeNull()
  })
})
