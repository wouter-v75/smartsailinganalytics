'use client'
// src/components/photos/SailGeometryDialog.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The full-screen digitiser, and the chrome around it, in ONE place.
//
// It was two: the Photos tab had a copy and the timeline had a copy. They were
// the same window reached two ways and they drifted, which cost most of an
// evening. The timeline's copy passed no boat at all, so the tab fell back to
// generic estimates — no measured scale reference and NO SAIL WIDTHS, hence no
// twist — while the Photos tab worked, and the difference was invisible from
// either side. The close button, the padding that keeps the caption clear of the
// user pill, and the save wiring all had to be fixed twice.
//
// SailTrimTab and SailGeometryCard were already single components; only this
// wrapper was duplicated. So it is the wrapper that moved.
//
// Full screen because it is a measuring instrument: the mast is two pixels wide
// at fit zoom, and marking has to be done zoomed in with the rig model and the
// checks visible beside it.
//
// Portalled to <body>. `fixed` is not enough from the timeline, whose cards
// carry z-index 100 and up inside transformed ancestors, so a z-index set within
// that subtree competes with the thumbnails instead of covering them — which is
// how the digitiser once opened BEHIND them. Leaving the stacking context is the
// fix; raising the number is not. It costs the Photos tab nothing.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'

// The digitiser is a big component with its own CDN libraries, and most visits
// never open it — so it arrives as its own chunk, on demand, with something on
// screen while it does.
const SailTrimTab = dynamic(() => import('../sailtrim/SailTrimTab'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#7DD3FC', fontSize: 13 }}>
      Loading the digitiser…
    </div>
  ),
})

export interface SailGeometryDialogProps {
  /** Nothing renders when false. */
  open: boolean
  onClose: () => void
  /** The full-resolution ORIGINAL — never a composite, whose burned-in gauges
   *  and any previous annotation would be measured as though photographed. */
  fileUrl: string
  fileName?: string
  photoLabel?: string
  /** Shown at the right of the header: filename, date, whatever identifies it. */
  caption?: string
  /** Whichever the caller has. The id is preferred — a name is what somebody
   *  typed, and two boats in a programme can be a keystroke apart. */
  boatName?: string
  boatId?: string | null
  /** TWA from the log at this instant; it fixes the tack, which is what makes
   *  the sign of a measurement mean something about the boat. */
  twaDeg?: number | null
  /** A previously saved measurement, to put the marks back on the picture. */
  initialResult?: unknown
  onSaveToPhoto?: (save: unknown) => void | Promise<unknown>
}

export default function SailGeometryDialog({
  open, onClose, fileUrl, fileName = 'photo.jpg', photoLabel = 'this photo',
  caption = '', boatName, boatId = null, twaDeg = null, initialResult = null,
  onSaveToPhoto,
}: SailGeometryDialogProps) {
  // createPortal needs a document, which the server render does not have.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!open || !mounted) return null

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Sail geometry"
         data-testid="sail-geometry-dialog"
         style={{ position: 'fixed', inset: 0, zIndex: 1200, background: '#030F1A', display: 'flex', flexDirection: 'column' }}>
      {/* The way OUT goes in the MIDDLE. The user pill is `fixed top-3 right-3`
          at z-index 9999 — above this dialog, which cannot raise itself past it
          — so the top right corner is not ours to use, and the top left is where
          the eye goes last on a full-screen instrument. The caption keeps a
          pill's width of padding for the same reason. */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', background: '#0F2A45', borderBottom: '1px solid #1E3A5A' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#38BDF8', whiteSpace: 'nowrap' }}>📐 Sail geometry</div>
        </div>
        <button onClick={onClose}
          style={{ flexShrink: 0, background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 7, padding: '7px 13px', color: '#E2E8F0', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
          ← Back to photo
        </button>
        <div style={{ flex: 1, minWidth: 0, paddingRight: 52, textAlign: 'right', fontSize: 11, color: '#94A3B8', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {caption}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <SailTrimTab
          boatName={boatName}
          boatId={boatId}
          initialFileUrl={fileUrl}
          initialFileName={fileName}
          photoLabel={photoLabel}
          twaDeg={twaDeg}
          initialResult={initialResult as never}
          onSaveToPhoto={onSaveToPhoto as never} />
      </div>
    </div>,
    document.body,
  )
}
