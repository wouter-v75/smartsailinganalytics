'use client'

// Inline SVG QR for invite-link sharing. Uses the well-tested `qrcode`
// package; renders to an <img> with a data: URL so you can right-click /
// long-press → save (handy for screenshotting into WhatsApp).

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export default function QRCodeSVG({
  text,
  size = 240,
}: {
  text: string
  size?: number
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size * 2, // 2x for sharp on retina
    })
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message || e))
      })
    return () => {
      cancelled = true
    }
  }, [text, size])

  if (err) {
    return <div className="text-xs text-red-600">QR error: {err}</div>
  }
  if (!src) {
    return (
      <div
        style={{ width: size, height: size }}
        className="bg-slate-100 animate-pulse rounded"
      />
    )
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="Invite QR code"
      style={{ width: size, height: size }}
    />
  )
}
