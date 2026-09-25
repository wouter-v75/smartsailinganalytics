'use client'
// src/components/photos/PhotoViewer.tsx
// ─────────────────────────────────────────────────────────────────────────────
// One photograph, composed and looked at: the picture, the instrument overlay
// burned in, the sail-geometry lines when they exist, and a viewport with zoom
// and pan over the result.
//
// It exists because there were three of these and they drifted. The Photos tab
// had the full story; the timeline's DayMedia lightbox was still handing
// `renderOverlay` the 480 px THUMBNAIL — the same fault that made photos look
// grainy everywhere, surviving in a second copy — and DayTimeline had the
// original but neither zoom nor geometry. A photograph should not be a different
// thing depending on which tab you reached it through.
//
// What it owns: load the thumbnail first so something appears at once, then the
// original over the top of it; say which of the two you are looking at; compose
// both overlays; hand the composite to PhotoCanvas. What it does not own: the
// instrument VALUES (callers build those) or anything about saving.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect } from 'react'
import PhotoCanvasJs from './PhotoCanvas'
import { renderOverlay } from '../../lib/photoOverlay'
import { drawSailTrimAnnotation, isAnnotation, type SailTrimAnnotation } from '../../lib/sailTrimOverlay'

// PhotoCanvas is .jsx, so TypeScript infers its props from their default values
// and a canvas would not be assignable to a `null` default. The shape is stated
// once, here, rather than casting at each use.
const PhotoCanvas = PhotoCanvasJs as React.ComponentType<{
  source: HTMLCanvasElement | HTMLImageElement | null
  sourceSize: { w: number; h: number } | null
  fullStatus?: 'none' | 'loading' | 'slow' | 'missing'
  onRetryFull?: (() => void) | null
  resetKey?: string
  height?: string
  children?: React.ReactNode
}>

/** How long a picture may be "still arriving" before we say so. Matches VideoPlayer. */
const SLOW_MS = 12000

export interface SailTrimPayload {
  annotation: SailTrimAnnotation
  overlay?: boolean
}

export default function PhotoViewer({
  photoId = '',
  thumbUrl = null,
  fullUrl = null,
  inst = null,
  sailTrim = null,
  height = '62vh',
  children = null,
  onComposed = null,
}: {
  photoId?: string
  thumbUrl?: string | null
  fullUrl?: string | null
  inst?: Record<string, unknown> | null
  /** The payload PhotosTab stores as `sailtrim_data`. */
  sailTrim?: SailTrimPayload | null
  height?: string
  children?: React.ReactNode
  /** Called with the composed canvas whenever it is redrawn, for exporting. */
  onComposed?: ((c: HTMLCanvasElement) => void) | null
}) {
  const composeRef = useRef<HTMLCanvasElement | null>(null)
  const haveFull = useRef(false)
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [compose, setCompose] = useState<HTMLCanvasElement | null>(null)
  const [composed, setComposed] = useState<{ w: number; h: number } | null>(null)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [fullMissing, setFullMissing] = useState(false)
  const [fullSlow, setFullSlow] = useState(false)
  const [retry, setRetry] = useState(0)

  // Every value that is DRAWN, so a change to any of them redraws. Cheap: a
  // couple of dozen numbers and one small annotation record.
  const drawSig = JSON.stringify([inst || null, sailTrim?.overlay ?? null,
    sailTrim?.annotation?.measuredAt ?? null, sailTrim?.annotation?.targets?.length ?? null])

  useEffect(() => {
    if (!thumbUrl && !fullUrl) { setCompose(null); setComposed(null); return }
    let dead = false
    haveFull.current = false
    setFullLoaded(false); setFullMissing(false); setFullSlow(false)
    if (slowTimer.current) clearTimeout(slowTimer.current)

    const draw = (img: HTMLImageElement, isFull: boolean) => {
      // A late thumbnail must not paint over an original that already landed.
      if (dead || (!isFull && haveFull.current)) return
      if (isFull) haveFull.current = true
      const c = composeRef.current || (composeRef.current = document.createElement('canvas'))
      renderOverlay(c, img, inst || {})
      if (sailTrim?.overlay && isAnnotation(sailTrim.annotation)) {
        const ctx = c.getContext('2d')
        if (ctx) drawSailTrimAnnotation(ctx, sailTrim.annotation)
      }
      setCompose(c); setComposed({ w: c.width, h: c.height })
      onComposed?.(c)
      if (isFull) {
        setFullLoaded(true); setFullSlow(false)
        if (slowTimer.current) clearTimeout(slowTimer.current)
      }
    }

    const load = (url: string | null, isFull: boolean) => {
      if (!url) return
      const i = new Image()
      // crossOrigin so the composite stays exportable. A CDN that refuses CORS
      // fails the load, which the caller sees as "thumbnail only" rather than as
      // a silently tainted canvas that throws later, on export.
      i.crossOrigin = 'anonymous'
      i.onload = () => draw(i, isFull)
      i.onerror = () => {
        if (isFull && !dead) {
          setFullMissing(true); setFullSlow(false)
          if (slowTimer.current) clearTimeout(slowTimer.current)
        }
      }
      i.src = url
    }

    load(thumbUrl, false)
    if (fullUrl && fullUrl !== thumbUrl) {
      // A retry gets a fresh URL: a browser that cached the failure will not go
      // back to the network for the same one.
      load(retry ? `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}retry=${retry}` : fullUrl, true)
      slowTimer.current = setTimeout(() => { if (!dead && !haveFull.current) setFullSlow(true) }, SLOW_MS)
    }
    return () => { dead = true; if (slowTimer.current) clearTimeout(slowTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId, thumbUrl, fullUrl, drawSig, retry])

  const status: 'none' | 'loading' | 'slow' | 'missing' =
    (!fullUrl || fullUrl === thumbUrl || fullLoaded) ? 'none'
      : fullMissing ? 'missing' : fullSlow ? 'slow' : 'loading'

  return (
    <PhotoCanvas
      source={compose} sourceSize={composed} resetKey={photoId}
      height={height} fullStatus={status} onRetryFull={() => setRetry((n) => n + 1)}>
      {children}
    </PhotoCanvas>
  )
}
