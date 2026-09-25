// src/components/__tests__/PhotoDetailGeometry.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The photo viewer's sail-geometry pane: the offer to measure, the card that
// comes back, and the switch that burns the lines into the picture.
//
// PhotoDetail is the whole right-hand pane and it composes the canvas itself, so
// a throw in here does not degrade — it takes the Photos tab down. These tests
// exist as much to prove it renders as to check what it says.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('@/lib/cdnScript', () => ({ heicToJpeg: (f: File) => Promise.resolve(f) }))

import { PhotoDetail } from '../PhotosTab'
import { drawSailTrimAnnotation } from '../../lib/sailTrimOverlay'

vi.mock('../../lib/sailTrimOverlay', async (orig) => {
  const real = await orig<typeof import('../../lib/sailTrimOverlay')>()
  return { ...real, drawSailTrimAnnotation: vi.fn(real.drawSailTrimAnnotation) }
})

const IMG_W = 6000, IMG_H = 4000

beforeAll(() => {
  // @ts-expect-error jsdom has no ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  global.URL.createObjectURL = vi.fn(() => 'blob:photo')
  global.URL.revokeObjectURL = vi.fn()
  // A context that does nothing but exists, so the compose path runs end to end
  // rather than bailing at the first `if (!ctx) return`.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    canvas: { width: IMG_W, height: IMG_H },
    fillRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {},
    scale: () => {}, translate: () => {}, beginPath: () => {}, moveTo: () => {},
    lineTo: () => {}, stroke: () => {}, fill: () => {}, rect: () => {}, roundRect: () => {},
    fillText: () => {}, strokeText: () => {}, setLineDash: () => {},
    measureText: () => ({ width: 40 }),
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    lineWidth: 0, lineCap: '', imageSmoothingEnabled: false, imageSmoothingQuality: '',
  })) as never
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/jpeg;base64,x') as never
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
  })) as never
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    crossOrigin = ''
    naturalWidth = IMG_W
    naturalHeight = IMG_H
    set src(_v: string) { setTimeout(() => this.onload?.(), 0) }
  }
  // @ts-expect-error swapping the global constructor
  global.Image = FakeImage
})

const annotation = {
  version: 'sailtrim-v0.2-horizon',
  imageSize: { w: IMG_W, h: IMG_H },
  defn: 'boat',
  axis: { low: { x: 2900, y: 3400 }, high: { x: 3100, y: 400 } },
  targets: [
    { key: 'leechSpr2', label: 'Jib leech @ reference height', point: { x: 3400, y: 1500 }, foot: { x: 3020, y: 1460 }, mm: 1479, sigmaMm: 14, colour: '#4ADE80' },
    { key: 'clew', label: 'Jib clew', point: { x: 3280, y: 2600 }, foot: { x: 3010, y: 2580 }, mm: -1103, sigmaMm: 17, colour: '#FB923C' },
    { key: 'boom', label: 'Boom', point: { x: 3560, y: 3100 }, foot: { x: 2990, y: 3060 }, mm: 2210, sigmaMm: 31, colour: '#F87171' },
  ],
  psiDeg: 0.42, psiMeasured: true, heelDeg: 22.7, measuredAt: 1_700_000_000_000,
}

const basePhoto = {
  id: 'p1', name: '_MG_0397.JPG', utc: Date.parse('2026-09-05T10:46:00Z'),
  objectUrl: 'blob:thumb', fullUrl: 'blob:full', cloudSynced: true, hasLocalOriginal: false,
  tws: 14.2, twa: 42, heel: 22.7, sails: ['J2'],
}

const withGeometry = (overlay: boolean) => ({
  ...basePhoto,
  sailtrim_data: JSON.stringify({ annotation, overlay, headline: 'leech 1479 · clew 1103 · boom 2210 mm' }),
})

const props = {
  onDelete: () => {}, onUpload: () => {}, uploading: false,
  canSync: true, canDelete: true, onDownloadOriginal: () => {}, downloadingOriginal: false,
}

/** Render, then let the (faked) image load land — it sets state asynchronously. */
async function show(photo: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  let r!: ReturnType<typeof render>
  await act(async () => {
    r = render(<PhotoDetail photo={photo} {...props} {...extra} />)
    await new Promise((res) => setTimeout(res, 5))
  })
  return r
}

describe('PhotoDetail — sail geometry', () => {
  it('offers to measure a photo that has never been measured', async () => {
    const onMeasure = vi.fn()
    await show(basePhoto, { onMeasureGeometry: onMeasure })
    const btn = screen.getByText(/Analyse sail geometry/)
    fireEvent.click(btn)
    expect(onMeasure).toHaveBeenCalledWith(basePhoto)
  })

  it('does not offer it to somebody who cannot save the answer', async () => {
    // The host passes null for a viewer: an unsaveable measurement would be a
    // quarter of an hour of clicking thrown away at the end.
    await show(basePhoto, { onMeasureGeometry: null })
    expect(screen.queryByText(/Analyse sail geometry/)).toBeNull()
  })

  it('shows the three numbers, unsigned, with their sigmas', async () => {
    await show(withGeometry(true), { onMeasureGeometry: () => {} })
    expect(screen.getByText('1479')).toBeTruthy()
    expect(screen.getByText('1103')).toBeTruthy()   // stored as −1103
    expect(screen.getByText('2210')).toBeTruthy()
    expect(screen.getByText('±14')).toBeTruthy()
    expect(screen.getByText('±31')).toBeTruthy()
  })

  it('says which definition the numbers are and whether psi was measured', async () => {
    const a = await show(withGeometry(true))
    expect(screen.getByText(/Athwartships/)).toBeTruthy()
    expect(screen.getByText(/ψ 0.42° measured/)).toBeTruthy()
    a.unmount()

    const assumed = JSON.parse(withGeometry(true).sailtrim_data)
    assumed.annotation = { ...annotation, psiMeasured: false }
    await show({ ...basePhoto, id: 'p2', sailtrim_data: JSON.stringify(assumed) })
    expect(screen.getByText(/ψ 0.42° assumed/)).toBeTruthy()
  })

  it('burns the lines in when the overlay is on, and leaves them off when it is not', async () => {
    const draw = vi.mocked(drawSailTrimAnnotation)

    draw.mockClear()
    const on = await show(withGeometry(true))
    await waitFor(() => expect(draw).toHaveBeenCalled())
    expect(draw.mock.calls[0][1].targets).toHaveLength(3)
    on.unmount()

    draw.mockClear()
    await show({ ...withGeometry(false), id: 'p3' })
    // Given the same chance to run as the case above had.
    expect(draw).not.toHaveBeenCalled()
  })

  it('offers the switch both ways round, and hands the photo back', async () => {
    const onToggle = vi.fn()
    const on = await show(withGeometry(true), { onToggleGeometryOverlay: onToggle })
    fireEvent.click(screen.getByText(/lines on the photo/))
    expect(onToggle).toHaveBeenCalledTimes(1)
    on.unmount()

    await show(withGeometry(false), { onToggleGeometryOverlay: onToggle })
    expect(screen.getByText('Draw lines on the photo')).toBeTruthy()
  })

  it('ignores a sailtrim_data that is corrupt, rather than taking the tab down', async () => {
    // It arrives as a JSON string out of localStorage and out of a JSONB column,
    // so both a parse failure and a half-written record are reachable.
    for (const bad of ['not json at all', '{"overlay":true}', JSON.stringify({ annotation: { targets: [] } })]) {
      const { unmount } = await show({ ...basePhoto, sailtrim_data: bad }, { onMeasureGeometry: () => {} })
      // No card, and the offer to measure is back — which is the honest state.
      expect(screen.queryByText(/Sail geometry/)).toBeNull()
      expect(screen.getByText(/Analyse sail geometry/)).toBeTruthy()
      unmount()
    }
  })

  it('asks for the ORIGINAL at the path the row records', async () => {
    // Twice now this URL has been wrong, and both times the symptom was a photo
    // that looked soft with a confident explanation over it. First the viewer
    // was handed the 480 px thumbnail; then it was handed a key RECONSTRUCTED
    // from sessionDate + photo.id, which is right only for a photo the browser
    // itself uploaded. Anything put up by `npm run media:upload` lives at
    // `sessions/<date>/photos/p_<ts>_<rand>.jpg` under a Supabase UUID, so the
    // reconstruction 404s and the viewer says the original "has not reached the
    // cloud yet" about a file that has been there for weeks.
    const src: string[] = []
    const realImage = global.Image
    class Spy {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      crossOrigin = ''
      naturalWidth = IMG_W
      naturalHeight = IMG_H
      set src(v: string) { src.push(v); setTimeout(() => this.onload?.(), 0) }
    }
    // @ts-expect-error swapping the global constructor
    global.Image = Spy
    try {
      await show({
        ...basePhoto,
        objectUrl: 'https://cdn/thumb.jpg',
        fullUrl: '/api/bunny/image?key=' +
          encodeURIComponent('sessions/2026-09-12/photos/p_1790328226840_rqkezf6hhvi.jpg'),
      })
    } finally {
      // @ts-expect-error restoring it
      global.Image = realImage
    }
    const full = src.find(u => u.includes('/api/bunny/image'))
    expect(full).toBeTruthy()
    expect(decodeURIComponent(full!)).toContain('p_1790328226840_rqkezf6hhvi.jpg')
    // And the thumbnail is still fetched too — it is what paints first.
    expect(src.some(u => u === 'https://cdn/thumb.jpg')).toBe(true)
  })

  it('still renders the instrument data it always did', async () => {
    await show(withGeometry(true))
    expect(screen.getByText('14.2')).toBeTruthy()   // TWS
    expect(screen.getByText('J2')).toBeTruthy()
  })
})
