'use client'
// src/components/timeline/PhotoLightbox.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The photo lightbox, once, for both places in the timeline that open one.
//
// DayMedia and DayTimeline each had their own, and they were the same dialog
// with the same viewer and the same geometry card — one just knew about bursts
// and about measuring. So they drifted: DayMedia was handed `openPhoto.thumb`
// as the full image for a while, which is how every photo came to look grainy
// in one view and sharp in the other, and only DayTimeline ever gained the line
// explaining that a photo with no cloud original cannot be measured.
//
// The Photos tab's PhotoDetail is deliberately NOT folded in here. It looks
// similar in a screenshot and is a different thing: an editing panel with the
// overlay-gauge picker, export, upload, delete, time editing, sail tags and the
// sail-scan card — 113 lines of it between the viewer and the geometry card.
// Forcing those together would make one component serve two jobs badly. What it
// SHARES — PhotoViewer, SailGeometryCard, MeasureGeometryButton — it already
// shares, and those are where the real logic lives.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import PhotoViewer from '@/components/photos/PhotoViewer'
import SailGeometryCard, { MeasureGeometryButton } from '@/components/photos/SailGeometryCard'
import type { SailTrimAnnotation } from '@/lib/sailTrimOverlay'

export interface LightboxPhoto {
  id: string
  thumb?: string | null
  /** The full-resolution original. Null when it never reached the cloud — which
   *  is also the reason there is nothing to measure on. */
  original?: string | null
  inst?: Record<string, unknown> | null
  sailTrim?: { annotation: SailTrimAnnotation; overlay?: boolean } | null
}

export interface PhotoLightboxProps {
  photo: LightboxPhoto | null
  onClose: () => void
  /** Viewer height. The timeline leaves room for the burst strip beneath it. */
  height?: string
  /** Stepping through the burst a single card stands for. Without it the other
   *  23 frames of 11:50 are visible only in the Photos tab, which is hiding
   *  data rather than tidying it. */
  burst?: {
    index: number
    count: number
    timeLabel: string
    spanLabel?: string
    onStep: (delta: number) => void
  } | null
  /** Null where the viewer may not write — the buttons then do not appear. */
  onToggleOverlay?: (() => void) | null
  onMeasure?: (() => void) | null
}

export default function PhotoLightbox({
  photo, onClose, height = '68vh', burst = null,
  onToggleOverlay = null, onMeasure = null,
}: PhotoLightboxProps) {
  return (
    <Dialog open={!!photo} onOpenChange={(o) => { if (!o) onClose() }}>
      {photo && (
        <DialogContent title="Photo" className="w-[min(1300px,calc(100vw-16px))] max-w-none max-h-[96vh] overflow-auto p-3">
          {/* The full-resolution original over the thumbnail, zoom, pan, and the
              sail-geometry lines — the same viewer the Photos tab uses. */}
          <PhotoViewer
            photoId={photo.id}
            thumbUrl={photo.thumb}
            fullUrl={photo.original || null}
            inst={photo.inst || {}}
            sailTrim={photo.sailTrim || null}
            height={height} />

          {burst && burst.count > 1 && (
            <div className="mb-2 mt-2 flex items-center gap-2">
              <button onClick={() => burst.onStep(-1)} disabled={burst.index <= 0}
                className="rounded-md border border-[color:var(--border)] px-2 py-1 text-xs disabled:opacity-40">← prev</button>
              <span className="font-mono text-xs text-muted">
                frame {burst.index + 1} of {burst.count} · {burst.timeLabel}
              </span>
              <button onClick={() => burst.onStep(1)} disabled={burst.index >= burst.count - 1}
                className="rounded-md border border-[color:var(--border)] px-2 py-1 text-xs disabled:opacity-40">next →</button>
              {burst.spanLabel && <span className="ml-auto text-[11px] text-muted">{burst.spanLabel}</span>}
            </div>
          )}

          {photo.sailTrim
            ? <SailGeometryCard
                annotation={photo.sailTrim.annotation}
                overlayOn={!!photo.sailTrim.overlay}
                onToggleOverlay={onToggleOverlay}
                onRemeasure={onMeasure}
                compact />
            : <MeasureGeometryButton onClick={photo.original ? onMeasure : null} compact />}

          {!photo.original && !photo.sailTrim && (
            <div className="text-xs text-muted">
              The full-resolution original is not in the cloud for this photo, so there is
              nothing to measure on.
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}
