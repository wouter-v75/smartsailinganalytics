'use client'
// src/components/photos/PhotoCanvas.jsx
// ─────────────────────────────────────────────────────────────────────────────
// A window onto an already-composed picture: zoom, drag, fit.
//
// `source` is a canvas somebody else has drawn — in PhotosTab it is the
// photograph with its instrument overlay burned in, at the image's own size.
// This component never composes anything; it only decides which part of that
// canvas you are looking at, which is why it can be driven on its own at
// /dev/photo-viewer.
//
// The arithmetic lives in src/lib/photoViewport.ts and is tested there. What is
// here is the DOM: a backing store kept in step with the CSS box, a wheel
// listener that has to be non-passive, and pointer handlers.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  fitTransform, zoomAt, zoomAboutCentre, clampPan, panBy, isFitted, detailPct,
} from '../../lib/photoViewport'

const ZBTN = {
  width: 22, height: 22, borderRadius: 5, border: '1px solid #1E3A5A',
  background: '#0A1929', color: '#CBD5E1', fontSize: 13, fontWeight: 700,
  lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 0,
}

export default function PhotoCanvas({
  source,                 // HTMLCanvasElement | HTMLImageElement | null
  sourceSize,             // {w,h} of it, or null
  loadingFull = false,    // show "loading full resolution…"
  resetKey = '',          // changing this refits (a different photo)
  height = '62vh',
  children = null,        // anything to overlay in the corner (a timestamp…)
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 })
  const [grabbing, setGrabbing] = useState(false)

  /** The viewport in BACKING-STORE pixels, which is what the transform speaks. */
  const viewSize = useCallback(() => {
    const c = canvasRef.current
    if (!c) return { w: 0, h: 0 }
    const r = c.getBoundingClientRect()
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2)
    return { w: Math.max(1, Math.round(r.width * dpr)), h: Math.max(1, Math.round(r.height * dpr)) }
  }, [])

  const fitNow = useCallback(() => {
    if (!sourceSize) return
    setView(fitTransform(sourceSize, viewSize()))
  }, [sourceSize, viewSize])

  // Refit for a different picture, or when the picture's size changes. NOT on
  // every re-compose of the same one: being thrown back to fit the moment the
  // full-resolution image replaces the thumbnail is maddening.
  useEffect(() => { fitNow() }, [resetKey, sourceSize?.w, sourceSize?.h])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── paint ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const vs = viewSize()
    if (c.width !== vs.w || c.height !== vs.h) { c.width = vs.w; c.height = vs.h }
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#050E1C'
    ctx.fillRect(0, 0, c.width, c.height)
    if (!source || !sourceSize) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.save()
    ctx.scale(view.zoom, view.zoom)
    ctx.translate(view.panX, view.panY)
    ctx.drawImage(source, 0, 0)
    ctx.restore()
  }, [view, source, sourceSize, viewSize])

  // Rotating a phone otherwise leaves the picture in a viewport that has gone.
  useEffect(() => {
    const c = canvasRef.current
    if (!c || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!sourceSize) return
      setView((v) => clampPan(v, sourceSize, viewSize()))
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [sourceSize, viewSize])

  const toView = useCallback((e) => {
    const c = canvasRef.current
    const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }
  }, [])

  // Non-passive: React attaches `wheel` passively at the root, and a passive
  // listener cannot preventDefault — the page would scroll instead of zooming.
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !sourceSize) return
    const onWheel = (e) => {
      e.preventDefault()
      const vs = viewSize()
      setView((v) => clampPan(zoomAt(v, toView(e), e.deltaY < 0 ? 1.15 : 1 / 1.15, sourceSize, vs), sourceSize, vs))
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [sourceSize, toView, viewSize])

  const onPointerDown = (e) => {
    if (!sourceSize) return
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* not capturable */ }
    dragRef.current = { x: e.clientX, y: e.clientY }
    setGrabbing(true)
  }
  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d || !sourceSize) return
    const c = canvasRef.current
    const k = c.width / c.getBoundingClientRect().width
    const vs = viewSize()
    setView((v) => clampPan(panBy(v, (e.clientX - d.x) * k, (e.clientY - d.y) * k), sourceSize, vs))
    dragRef.current = { x: e.clientX, y: e.clientY }
  }
  const endDrag = () => { dragRef.current = null; setGrabbing(false) }
  const onDoubleClick = (e) => {
    if (!sourceSize) return
    const vs = viewSize()
    setView((v) => (isFitted(v, sourceSize, vs)
      ? clampPan(zoomAt(v, toView(e), 3, sourceSize, vs), sourceSize, vs)
      : fitTransform(sourceSize, vs)))
  }
  const zoomBtn = (f) => {
    if (!sourceSize) return
    const vs = viewSize()
    setView((v) => clampPan(zoomAboutCentre(v, f, sourceSize, vs), sourceSize, vs))
  }

  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2)
  const fitted = sourceSize ? isFitted(view, sourceSize, viewSize()) : true

  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <canvas
        ref={canvasRef}
        data-testid="photo-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onDoubleClick={onDoubleClick}
        style={{
          width: '100%', height, minHeight: 280, maxHeight: 720,
          borderRadius: 8, border: '1px solid #1E3A5A', display: 'block',
          background: '#050E1C', touchAction: 'none',
          cursor: !sourceSize ? 'default' : grabbing ? 'grabbing' : fitted ? 'zoom-in' : 'grab',
        }}
      />
      {/* The photograph is 24 megapixels and the panel is a few hundred wide,
          so at fit you are seeing about a tenth of what is there. The figure
          says so, rather than leaving you to wonder whether the picture is
          soft or merely small. */}
      {sourceSize && (
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(3,15,26,0.82)', borderRadius: 6, padding: '4px 6px' }}>
          <button onClick={() => zoomBtn(1 / 1.6)} aria-label="Zoom out" style={ZBTN}>−</button>
          <button onClick={() => zoomBtn(1.6)} aria-label="Zoom in" style={ZBTN}>+</button>
          <button onClick={fitNow} style={{ ...ZBTN, width: 'auto', padding: '0 8px' }}>Fit</button>
          <span data-testid="photo-detail-pct" style={{ fontSize: 10, color: '#94A3B8', fontFamily: 'monospace', minWidth: 34, textAlign: 'right' }}>
            {detailPct(view, dpr)}%
          </span>
        </div>
      )}
      {loadingFull && (
        <div style={{ position: 'absolute', top: 8, left: 10, background: 'rgba(3,15,26,0.82)', borderRadius: 4, padding: '3px 8px', fontSize: 10, color: '#FCD34D' }}>
          loading full resolution…
        </div>
      )}
      {children}
    </div>
  )
}
