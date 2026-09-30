'use client'
import * as React from 'react'
import PhotoCanvas from '@/components/photos/PhotoCanvas'
import PhotoViewer from '@/components/photos/PhotoViewer'
import { drawSailTrimAnnotation, type SailTrimAnnotation } from '@/lib/sailTrimOverlay'

// Preview harness for the photo viewer's zoom/drag (Photos → a photo), without
// a signed-in session, a day of sailing or a cloud round trip behind it.
//
//   /dev/photo-viewer?src=/some-photo.jpg
//   /dev/photo-viewer?src=/some-photo.jpg&geom=1    ← with sail-geometry lines
//   /dev/photo-viewer?src=/some-photo.jpg&viewer=1  ← the real PhotoViewer
//
// `viewer=1` is the one that exercises what the Photos tab and both timeline
// lightboxes actually render — loading, composing, the full-res notice and the
// fallback when no 2d context is to be had. Everything else here drives
// PhotoCanvas directly, which never loads anything. The difference matters: the
// fallback lives in PhotoViewer, so without this the only way to see it was to
// sign in and open a real photograph. To force it:
//
//   const real = HTMLCanvasElement.prototype.getContext
//   HTMLCanvasElement.prototype.getContext = function (...a) {
//     return this.isConnected ? real.apply(this, a) : null }
//
// pasted in the console BEFORE loading the page — the offscreen compose canvas
// then fails exactly as it does on an iPhone at its canvas-memory cap, while
// the attached viewport canvas carries on.
//
// It composes the image onto a canvas the same way PhotosTab does — which is
// the point: PhotoCanvas never loads anything, it only looks at a canvas
// somebody else drew. `geom=1` burns a sample annotation in on top, which is
// the only way to see the drawing at a real photograph's resolution without a
// day's photos and a marked-up frame behind it.

/** A stand-in annotation, placed by fractions of whatever image is loaded. */
function sampleAnnotation(w: number, h: number): SailTrimAnnotation {
  const axis = { low: { x: w * 0.47, y: h * 0.92 }, high: { x: w * 0.51, y: h * 0.08 } }
  const target = (fx: number, fy: number) => ({ x: w * fx, y: h * fy })
  const foot = (p: { x: number; y: number }) => {
    const ux = axis.high.x - axis.low.x, uy = axis.high.y - axis.low.y
    const L = Math.hypot(ux, uy) || 1
    const t = ((p.x - axis.low.x) * ux + (p.y - axis.low.y) * uy) / L
    return { x: axis.low.x + (ux / L) * t, y: axis.low.y + (uy / L) * t }
  }
  const mk = (key: string, label: string, fx: number, fy: number, mm: number, colour: string) => {
    const point = target(fx, fy)
    return { key, label, point, foot: foot(point), mm, sigmaMm: 14, colour }
  }
  return {
    version: 'sailtrim-dev-sample',
    imageSize: { w, h },
    defn: 'boat',
    axis,
    targets: [
      mk('leechSpr2', 'Jib leech @ reference height', 0.66, 0.34, 1479, '#4ADE80'),
      mk('clew', 'Jib clew', 0.62, 0.62, -1103, '#FB923C'),
      mk('boom', 'Boom', 0.72, 0.78, 2210, '#F87171'),
    ],
    psiDeg: 0.42,
    psiMeasured: true,
    heelDeg: 22.7,
    measuredAt: Date.now(),
  }
}

export default function PhotoViewerHarness() {
  const [source, setSource] = React.useState<HTMLCanvasElement | null>(null)
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null)
  const [note, setNote] = React.useState('loading…')
  const [geom, setGeom] = React.useState(false)
  const [viewer, setViewer] = React.useState(false)
  const [src, setSrc] = React.useState<string | null>(null)

  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const s = q.get('src')
    const withGeom = q.get('geom') === '1'
    const asViewer = q.get('viewer') === '1'
    setGeom(withGeom); setViewer(asViewer); setSrc(s)
    if (!s) { setNote('pass ?src=/some-photo.jpg'); return }
    const img = new Image()
    img.onload = () => {
      setSize({ w: img.naturalWidth, h: img.naturalHeight })
      setNote(`${img.naturalWidth}×${img.naturalHeight}`)
      // In viewer mode PhotoViewer does its own loading and compositing; this
      // pass only learns the size, so the sample annotation can be placed.
      if (asViewer) return
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d')
      ctx?.drawImage(img, 0, 0)
      if (withGeom && ctx) drawSailTrimAnnotation(ctx, sampleAnnotation(c.width, c.height))
      setSource(c)
    }
    img.onerror = () => setNote(`could not load ${s}`)
    img.src = s
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#030F1A', color: '#E2E8F0', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10 }}>
        photo viewer · {note}{geom ? ' · sail-geometry sample burned in' : ''}
        {viewer ? ' · PhotoViewer' : ' · PhotoCanvas only'} · wheel to zoom, drag to pan, double-click to toggle
      </div>
      {viewer ? (
        <PhotoViewer
          photoId="harness"
          thumbUrl={src}
          fullUrl={src}
          inst={{ tws: 11.4, twa: 42, awa: 28, bsp: 9.7, heel: 22.7, vmg: 7.2 }}
          sailTrim={geom && size ? { annotation: sampleAnnotation(size.w, size.h), overlay: true } : null}
          height="78vh"
        />
      ) : (
        <PhotoCanvas source={source} sourceSize={size} resetKey="harness" height="78vh" />
      )}
    </div>
  )
}
