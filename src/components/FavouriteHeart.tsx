'use client'
// src/components/FavouriteHeart.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The heart on a photo or clip, and the "favourites only" button above a list.
// Personal: a favourite is the signed-in user's own (lib/favourites, 0098).
//
// The heart is a <span role="button">, not a <button>, because it sits INSIDE
// cards that are themselves buttons (the timeline's MediaCard) — a button in a
// button is invalid and the click would open the photo too. Every pointer and
// key event stops here for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { Heart } from 'lucide-react'
import { setFavourite, useFavourites, type FavKind } from '@/lib/favourites'

const RED = '#F43F5E'

/**
 * "Favourites only" for a whole subtree. The timeline's media sits four
 * components below the tab that owns the button; threading a flag through
 * TimelineVertical → DayPhases → DayTimeline would touch every one of them.
 */
export const FavouritesOnlyContext = React.createContext(false)

export function FavouriteHeart({ kind, id, size = 14, style, className }: {
  kind: FavKind
  /** The CLOUD id (videoFavId / photoFavId). Null → no heart: nothing to key it on. */
  id: string | null | undefined
  size?: number
  style?: React.CSSProperties
  className?: string
}) {
  const fav = useFavourites()
  const [err, setErr] = React.useState<string | null>(null)
  if (!id || !fav.available) return null
  const on = fav.has(kind, id)

  const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }
  const toggle = (e: React.SyntheticEvent) => {
    e.stopPropagation(); e.preventDefault()
    setErr(null)
    setFavourite(kind, id, !on).then((m) => { if (m) setErr(m) })
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={on}
      aria-label={on ? 'Remove from my favourites' : 'Add to my favourites'}
      title={err ? `Could not save — ${err}` : on ? 'My favourite — click to remove' : 'Add to my favourites'}
      onClick={toggle}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); else e.stopPropagation() }}
      className={className}
      style={{
        display: 'inline-grid', placeItems: 'center', cursor: 'pointer',
        width: size + 10, height: size + 10, borderRadius: '50%',
        background: 'rgba(3,15,26,0.72)', border: `1px solid ${on ? RED : 'rgba(255,255,255,0.35)'}`,
        lineHeight: 0, ...style,
      }}
    >
      <Heart size={size} strokeWidth={2.2} color={err ? '#F59E0B' : on ? RED : '#e2e8f0'} fill={on ? RED : 'none'} />
    </span>
  )
}

/** "♥ Favourites" — shows only the user's own favourites while on. Hidden until 0098 exists. */
export function FavouritesFilterButton({ on, onToggle, compact = false, style }: {
  on: boolean
  onToggle: () => void
  compact?: boolean
  style?: React.CSSProperties
}) {
  const fav = useFavourites()
  if (!fav.available) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={on ? 'Showing only my favourites — click to show everything' : 'Show only my favourite photos and videos'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
        fontSize: 11, fontWeight: 700, borderRadius: 6, padding: compact ? '4px 7px' : '4px 10px',
        border: `1px solid ${on ? RED : '#1E3A5A'}`,
        background: on ? 'rgba(244,63,94,0.16)' : '#0F2A45', color: on ? RED : '#94A3B8',
        whiteSpace: 'nowrap', ...style,
      }}
    >
      <Heart size={13} strokeWidth={2.2} color={on ? RED : '#94A3B8'} fill={on ? RED : 'none'} />
      {!compact && 'Favourites'}
    </button>
  )
}
