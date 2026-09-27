'use client'
// src/components/photos/BoatBadge.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Whose boat is in this photograph.
//
// ONLY for a rival. A folder of stern shots is nearly all our own boat, so
// badging those would label the whole grid and bury the handful worth
// spotting — the line-ups, where a rival's numbers only mean anything measured
// against its own certificate. Silence means "us"; a badge means "someone
// else". Scrolling a grid looking for a different sail number is not a search.
//
// The competitor list is fetched ONCE per page, not once per thumbnail: a grid
// is hundreds of these, and the answer is the same for all of them.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react'
import { fetchBoats } from '@/lib/rigModel'

/** id → { name, isCompetitor }. One request, shared by every badge on the page. */
let cache: Promise<Map<string, { name: string; isCompetitor: boolean }>> | null = null
function boatMap() {
  if (!cache) {
    cache = fetchBoats()
      .then((bs) => new Map(bs.map((b) => [b.id, { name: b.name, isCompetitor: b.isCompetitor }])))
      .catch(() => new Map<string, { name: string; isCompetitor: boolean }>())
  }
  return cache
}

/** The boats visible in a frame, resolved from ids. */
export function useSubjectBoats(ids?: string[] | null) {
  const [out, setOut] = useState<{ name: string; isCompetitor: boolean }[]>([])
  const key = (ids || []).join(',')
  useEffect(() => {
    if (!ids?.length) { setOut([]); return }
    let alive = true
    void boatMap().then((m) => {
      if (alive) setOut(ids.map((i) => m.get(i)).filter((b): b is { name: string; isCompetitor: boolean } => !!b))
    })
    return () => { alive = false }
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps
  return out
}

export default function BoatBadge({ boatIds, compact = false, style }: {
  /** `photos.subject_boat_ids` — who is IN the frame. Deliberately not the
   *  photo's `boat`, which is the boat that was sailing: every stored photo
   *  carries our own there, including the pictures of Capricorno. */
  boatIds?: string[] | null
  /** For a thumbnail corner: smaller, and no icon. */
  compact?: boolean
  style?: React.CSSProperties
}) {
  const boats = useSubjectBoats(boatIds)
  // COMPETITORS ONLY. Nearly every frame is our own boat, so badging those
  // would put a label on almost the whole grid and hide the handful that are
  // worth spotting. Silence means "us"; a badge means "someone else".
  const rivals = boats.filter((b) => b.isCompetitor)
  if (!rivals.length) return null
  const boat = rivals.map((b) => b.name).join(' \u00b7 ')
  const isComp = true
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
