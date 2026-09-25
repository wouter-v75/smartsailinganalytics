'use client'
import * as React from 'react'
import PhotoCanvas from '@/components/photos/PhotoCanvas'

// Preview harness for the photo viewer's zoom/drag (Photos → a photo), without
// a signed-in session, a day of sailing or a cloud round trip behind it.
//
//   /dev/photo-viewer?src=/some-photo.jpg
//
// It composes the image onto a canvas the same way PhotosTab does — which is
// the point: PhotoCanvas never loads anything, it only looks at a canvas
// somebody else drew.
export default function PhotoViewerHarness() {
  const [source, setSource] = React.useState<HTMLCanvasElement | null>(null)
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null)
  const [note, setNote] = React.useState('loading…')

  React.useEffect(() => {
    const src = new URLSearchParams(window.location.search).get('src')
    if (!src) { setNote('pass ?src=/some-photo.jpg'); return }
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d')?.drawImage(img, 0, 0)
      setSource(c); setSize({ w: c.width, h: c.height })
      setNote(`${c.width}×${c.height}`)
    }
    img.onerror = () => setNote(`could not load ${src}`)
    img.src = src
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#030F1A', color: '#E2E8F0', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10 }}>
        photo viewer · {note} · wheel to zoom, drag to pan, double-click to toggle
      </div>
      <PhotoCanvas source={source} sourceSize={size} resetKey="harness" height="78vh" />
    </div>
  )
}
