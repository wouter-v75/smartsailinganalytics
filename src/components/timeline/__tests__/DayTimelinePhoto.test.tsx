// src/components/timeline/__tests__/DayTimelinePhoto.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The timeline's photo path: full-resolution original in the lightbox, the sail
// geometry beside it, and the digitiser opening ABOVE the timeline rather than
// behind it.
//
// This harness exists because two defects shipped here unverified in a row —
// the lightbox composing the 480 px thumbnail, and the digitiser opening behind
// the media cards. Both were the kind of thing a single render would have
// caught, and neither was reachable from the /dev pages because the timeline
// needs a team, a boat and four API responses. So it gets the four responses.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// The digitiser pulls CDN libraries and a canvas; none of that is under test here.
vi.mock('@/lib/cdnScript', () => ({
  heicToJpeg: (f: File) => Promise.resolve(f),
  loadExifr: () => Promise.resolve({ parse: () => Promise.resolve({}) }),
  loadJsPdf: () => Promise.resolve(function () { /* unused */ }),
}))
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) => {
    const Lazy = React.lazy(loader)
    return (props: Record<string, unknown>) => (
      <React.Suspense fallback={<div>loading…</div>}><Lazy {...props} /></React.Suspense>
    )
  },
}))

import DayTimeline from '../DayTimeline'

const DATE = '2026-09-12'
const T0 = Date.parse(`${DATE}T10:00:00Z`)

const annotation = {
  version: 'sailtrim-v0.2-horizon',
  imageSize: { w: 6000, h: 4000 },
  defn: 'boat',
  axis: { low: { x: 2900, y: 3400 }, high: { x: 3100, y: 400 } },
  targets: [
    { key: 'clew', label: 'Jib clew', point: { x: 3280, y: 2600 }, foot: { x: 3010, y: 2580 }, mm: -1103, sigmaMm: 17, colour: '#FB923C' },
  ],
  psiDeg: 0.42, psiMeasured: true, heelDeg: 22.7, measuredAt: 1,
}

const photoRow = (extra: Record<string, unknown> = {}) => ({
  id: 'ph1',
  taken_utc: new Date(T0 + 60_000).toISOString(),
  thumbnail_url: 'https://cdn/thumb.jpg',
  original_url: 'https://cdn/original.jpg?signed=1',
  bunny_storage_path: 'sessions/2026-09-12/photos/p_1_a.jpg',
  bytes: 2_700_000,
  exif_data: null,
  analysis_data: { inst: { tws: 14.2 }, sails: ['J2'] },
  ...extra,
})

/** Every URL any Image was pointed at — which is the whole question here. */
let requested: string[] = []
let photos: Record<string, unknown>[] = []
let posted: { url: string; body: Record<string, unknown> }[] = []

const stubFetch = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') {
    posted.push({ url, body: JSON.parse(String(init.body)) })
    return { ok: true, json: async () => ({ photo: { id: 'ph1' }, action: 'updated' }) } as Response
  }
  const body =
    url.includes('/photos') ? { photos }
      : url.includes('/videos') ? { videos: [] }
        : url.includes('/sail-scans') ? { scans: [] }
          : url.includes('/sails') ? { sails: [] }
            : {}
  return { ok: true, json: async () => body } as Response
})

beforeAll(() => {
  // @ts-expect-error jsdom has no ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  global.URL.createObjectURL = vi.fn(() => 'blob:x')
  global.URL.revokeObjectURL = vi.fn()
  window.matchMedia = window.matchMedia || (((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as never)
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      fillRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {},
      scale: () => {}, translate: () => {}, beginPath: () => {}, moveTo: () => {},
      lineTo: () => {}, stroke: () => {}, fill: () => {}, rect: () => {}, roundRect: () => {},
      fillText: () => {}, strokeText: () => {}, setLineDash: () => {},
      measureText: () => ({ width: 40 }), getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
      lineWidth: 0, lineCap: '', imageSmoothingEnabled: false, imageSmoothingQuality: '',
    }
  }) as never
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    crossOrigin = ''
    naturalWidth = 6000
    naturalHeight = 4000
    _src = ''
    get src() { return this._src }
    set src(v: string) { this._src = v; requested.push(v); setTimeout(() => this.onload?.(), 0) }
  }
  // @ts-expect-error swapping the global constructor
  global.Image = FakeImage
})

beforeEach(() => {
  photos = [photoRow()]
  posted = []
  requested = []
  vi.clearAllMocks()
  vi.stubGlobal('fetch', stubFetch)
})

const day = { id: `day:${DATE}`, kind: 'day', title: DATE, t0: T0, t1: T0 + 6 * 3600_000, meta: { date: DATE } }

async function show() {
  const r = render(<DayTimeline day={day as never} events={[]} tz={120} teamId="t1" boatId="b1" />)
  await act(async () => { await new Promise((res) => setTimeout(res, 20)) })
  return r
}

/** The photo card is the only media button on the timeline in this fixture. */
/** The media card is the clickable element that holds the photo's thumbnail. */
const openLightbox = async () => {
  const img = document.querySelector('img')
  const card = (img?.closest('button') || img?.closest('[role="button"]') || img?.parentElement) as HTMLElement
  if (!card) throw new Error('no photo card rendered')
  await act(async () => { fireEvent.click(card) })
  await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

describe('DayTimeline — photos', () => {
  it('asks the photos API for the day and renders the card', async () => {
    await show()
    expect(stubFetch.mock.calls.some(([u]) => String(u).includes(`/photos?date=${DATE}`))).toBe(true)
  })

  it('shows the FULL-RESOLUTION original in the lightbox, not the thumbnail', async () => {
    await show()
    await openLightbox()
    await waitFor(() => expect(document.querySelector('[data-testid="photo-canvas"]')).toBeTruthy())
    // The thumbnail paints first so something appears, but the SIGNED ORIGINAL
    // is fetched too — this is the assertion the timeline was failing.
    await waitFor(() => expect(requested.some((u) => u.includes('original.jpg'))).toBe(true))
    expect(requested.some((u) => u.includes('thumb.jpg'))).toBe(true)
    // Zoom and pan: only PhotoCanvas renders these.
    expect(screen.getByText('Fit')).toBeTruthy()
    expect(screen.getByTestId('photo-detail-pct')).toBeTruthy()
  })

  it('shows the sail-geometry card for a photo that has been measured', async () => {
    photos = [photoRow({ analysis_data: { inst: { tws: 14.2 }, sailTrim: { annotation, overlay: true } } })]
    await show()
    await openLightbox()
    await waitFor(() => expect(screen.getByText(/Sail geometry/i)).toBeTruthy())
    expect(screen.getByText('1103')).toBeTruthy()        // −1103 mm, shown unsigned
    expect(screen.getByText(/ψ 0.42° measured/)).toBeTruthy()
  })

  it('offers to measure a photo that has an original and has not been measured', async () => {
    await show()
    await openLightbox()
    await waitFor(() => expect(screen.getByText(/Analyse sail geometry/)).toBeTruthy())
  })

  it('does not offer to measure a photo whose original is not in the cloud', async () => {
    photos = [photoRow({ original_url: null })]
    await show()
    await openLightbox()
    await waitFor(() => expect(screen.getByText(/nothing to measure on/i)).toBeTruthy())
    expect(screen.queryByText(/Analyse sail geometry/)).toBeNull()
  })

  it('prints seconds when a minute holds a burst, so the frames are telling apart', async () => {
    // 2026-09-04's leeway set put 24 frames into 11:50 and 17 into 11:49. The
    // card shows HH:MM, so two dozen genuinely different photographs read as two
    // dozen copies of one — which is exactly how it was reported.
    const at = (s: number) => new Date(T0 + s * 1000).toISOString()
    photos = [
      photoRow({ id: 'a', taken_utc: at(10), bunny_storage_path: 'p/a.jpg' }),
      photoRow({ id: 'b', taken_utc: at(16), bunny_storage_path: 'p/b.jpg' }),
      photoRow({ id: 'c', taken_utc: at(41), bunny_storage_path: 'p/c.jpg' }),
      photoRow({ id: 'lonely', taken_utc: at(3600), bunny_storage_path: 'p/d.jpg' }),
    ]
    await show()
    // The three in one minute are labelled to the second and are all different.
    const labels = Array.from(document.querySelectorAll('button span'))
      .map((e) => e.textContent || '').filter((t) => /^\d\d:\d\d/.test(t))
    const withSeconds = labels.filter((t) => /^\d\d:\d\d:\d\d$/.test(t))
    expect(withSeconds.length).toBe(3)
    expect(new Set(withSeconds).size).toBe(3)
    // The one on its own keeps the tidier HH:MM.
    expect(labels.some((t) => /^\d\d:\d\d$/.test(t))).toBe(true)
  })

  it('opens the digitiser ABOVE the timeline, not inside it', async () => {
    // The bug this file was written for. The timeline's media cards carry
    // zIndex 100+ inside transformed ancestors, so an overlay rendered in that
    // subtree loses to them however high its own z-index is. It must leave the
    // stacking context — which means being a child of <body>.
    const { container } = await show()
    await openLightbox()
    await waitFor(() => expect(screen.getByText(/Analyse sail geometry/)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByText(/Analyse sail geometry/)) })

    const modal = await waitFor(() => {
      const el = document.querySelector('[aria-label="Sail geometry"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    // Portalled: NOT inside the component's own tree.
    expect(container.contains(modal)).toBe(false)
    expect(modal.parentElement).toBe(document.body)
    // And above the app's own Dialog layer (z-1100).
    expect(Number(/z-\[(\d+)\]/.exec(modal.className)?.[1] || 0)).toBeGreaterThan(1100)
  })
})
