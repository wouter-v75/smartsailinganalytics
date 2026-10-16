// src/components/photos/PhotoShareButton.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Share a frame, with or without the data burned into it.
//
// Two different things leave the building. The picture is a picture. The same
// frame with the overlay on it carries the day's TWS, TWA, boat speed, heel, the
// mast settings and any sail-geometry millimetres measured on it — so that one
// is Sailor Gold and up, on the same ladder as putting a clip on the open
// internet. The gate is in `photoShare.ts`, not here: this component asks for a
// mode and uses whatever comes back.
//
// The WITHOUT-data share hands over the ORIGINAL file rather than a re-render of
// it. Re-encoding a canvas would strip the EXIF — and the focal length in that
// EXIF is the thing a measured frame cannot be measured without (see
// photo-lens-backfill): sharing a stripped copy is how a frame comes back later
// with no lens.
// ─────────────────────────────────────────────────────────────────────────────

'use client'
import React, { useState } from 'react'
import { canShareWithData, shareModeFor, shareFileName, SHARE_DATA_DENIED, type ShareMode } from '../../lib/photoShare'

export default function PhotoShareButton({
  role, photoName, originalUrl, composed,
}: {
  role?: string | null
  photoName?: string | null
  /** The untouched file, for the plain share. */
  originalUrl?: string | null
  /** The composed canvas — photo plus both overlays — for the data share. */
  composed?: () => HTMLCanvasElement | null
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ShareMode | null>(null)
  const [note, setNote] = useState('')
  const mayData = canShareWithData(role)

  const go = async (wanted: ShareMode) => {
    const mode = shareModeFor(role, wanted)
    setBusy(mode); setNote('')
    try {
      let blob: Blob | null = null
      if (mode === 'with-data') {
        const c = composed?.()
        if (!c) { setNote('The overlay has not finished drawing yet.'); return }
        blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.92))
      } else if (originalUrl) {
        // The original bytes, EXIF and all.
        blob = await (await fetch(originalUrl)).blob()
      }
      if (!blob) { setNote('Nothing to share — the picture has not loaded.'); return }
      const name = shareFileName(photoName, mode)
      const file = new File([blob], name, { type: 'image/jpeg' })
      const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean; share?: (d: unknown) => Promise<void> }
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        await nav.share({ files: [file], title: name })
      } else {
        // No Web Share API — a desktop browser. A download is the same outcome
        // by a longer route, and is the only one available there.
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = name; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        setNote(`Saved ${name}`)
      }
      setOpen(false)
    } catch (e) {
      // A cancelled share is not a failure and must not look like one.
      if ((e as { name?: string })?.name !== 'AbortError') {
        setNote(`Could not share: ${(e as Error)?.message || String(e)}`)
      }
    } finally { setBusy(null) }
  }

  const btn: React.CSSProperties = {
    background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 5,
    padding: '3px 9px', fontSize: 10.5, fontWeight: 700, color: '#94A3B8', cursor: 'pointer',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button onClick={() => setOpen((o) => !o)} style={btn} data-testid="photo-share">Share</button>
      {open && (
        <>
          <button onClick={() => go('plain')} disabled={busy != null}
            style={{ ...btn, color: '#38BDF8', borderColor: '#38BDF8' }} data-testid="photo-share-plain">
            {busy === 'plain' ? 'Sharing…' : 'Photo only'}
          </button>
          {/* Offered only where it is allowed, and the reason shown where it is
              not — a button that silently does the lesser thing teaches nothing,
              and a missing one looks like a bug. */}
          {mayData ? (
            <button onClick={() => go('with-data')} disabled={busy != null}
              style={{ ...btn, color: '#FBBF24', borderColor: '#FBBF24' }} data-testid="photo-share-data">
              {busy === 'with-data' ? 'Sharing…' : 'With data overlay'}
            </button>
          ) : (
            <span style={{ fontSize: 9.5, color: '#64748B' }} data-testid="photo-share-denied">{SHARE_DATA_DENIED}</span>
          )}
        </>
      )}
      {note && <span style={{ fontSize: 9.5, color: '#94A3B8' }}>{note}</span>}
    </div>
  )
}
