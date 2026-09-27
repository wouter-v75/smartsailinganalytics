'use client'
// src/components/photos/BoatBadge.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Whose boat is in this photograph.
//
// It matters most for a RIVAL. A folder of stern shots is mostly our own boat,
// and the handful of Capricorno or Bella Mente frames are the ones worth
// finding again — they are the line-ups, and a rival's numbers only mean
// anything measured against its own certificate. Scrolling a grid looking for
// the one with the different sail number is not a search.
//
// The competitor list is fetched ONCE per page, not once per thumbnail: a grid
// is hundreds of these, and the answer is the same for all of them.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react'
import { fetchBoats } from '@/lib/rigModel'

/** name (lowercased) → is it a competitor. One request, shared by every badge. */
let cache: Promise<Map<string, boolean>> | null = null
function competitorMap(): Promise<Map<string, boolean>> {
  if (!cache) {
    cache = fetchBoats()
      .then((bs) => new Map(bs.map((b) => [b.name.trim().toLowerCase(), b.isCompetitor])))
      // A failed lookup must not blank the name: the boat is still worth showing,
      // we just cannot say whether it is ours.
      .catch(() => new Map<string, boolean>())
  }
  return cache
}

export function useIsCompetitor(boat?: string | null): boolean | null {
  const [is, setIs] = useState<boolean | null>(null)
  useEffect(() => {
    if (!boat?.trim()) { setIs(null); return }
    let alive = true
    void competitorMap().then((m) => { if (alive) setIs(m.get(boat.trim().toLowerCase()) ?? null) })
    return () => { alive = false }
  }, [boat])
  return is
}

export default function BoatBadge({ boat, compact = false, style }: {
  boat?: string | null
  /** For a thumbnail corner: smaller, and no icon. */
  compact?: boolean
  style?: React.CSSProperties
}) {
  const isComp = useIsCompetitor(boat)
  if (!boat?.trim()) return null
  // Amber for a rival, slate for our own: the eye should catch the rival in a
  // grid without reading anything.
  const c = isComp ? { bg: '#78350F', bd: '#F59E0B80', fg: '#FCD34D' } : { bg: '#0A1929', bd: '#1E3A5A', fg: '#94A3B8' }
  return (
    <span
      title={isComp ? `${boat} — a competitor` : boat}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: '100%',
        background: c.bg, border: `1px solid ${c.bd}`, color: c.fg,
        borderRadius: 3, padding: compact ? '0 3px' : '1px 6px',
        fontSize: compact ? 8 : 10.5, fontWeight: 700, lineHeight: compact ? 1.5 : 1.6,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {!compact && isComp && <span aria-hidden>⛵</span>}
      {boat}
    </span>
  )
}
