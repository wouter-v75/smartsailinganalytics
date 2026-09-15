'use client'
import * as React from 'react'
import { cn } from '@/lib/ui'
import { racesOf, type DaySegment } from '@/lib/tagging/segments'
import { sessionClockHm } from '@/lib/tagging/clock'
import TrackCanvas from './TrackCanvas'
import type { GeoRow } from '@/lib/tagging/trackGeom'
import type { TagWithRequests } from '@/lib/tagging/types'

// The track view: where the day happened, rather than when.
//
// The list view is the better tool for reviewing what has been tagged — it is a
// clock, and a day reads top to bottom. This is the better tool for the other
// job: pointing at a moment you can SEE but could not name. "That bad tack, the
// one at the left-hand corner of the second beat" is a position before it is a
// time, and asking someone to convert it into 12:31:44 is asking them to do the
// computer's work.
//
// The race filter is what makes it usable at all. A whole day zoomed to fit is a
// scribble; one race is a course.

export interface TrackViewProps {
  rows: GeoRow[]
  items: TagWithRequests[]
  segments: DaySegment[]
  selectedUtc: number | null
  onSelect: (utc: number | null) => void
  onOpenTag?: (tagId: string) => void
  tzOffsetMin?: number
}

export default function TrackView({
  rows, items, segments, selectedUtc, onSelect, onOpenTag, tzOffsetMin = 0,
}: TrackViewProps) {
  const races = React.useMemo(() => racesOf(segments), [segments])
  const [key, setKey] = React.useState<string>('all')

  // A race that disappears — the event file reloaded, a different day opened —
  // must not leave the view filtered to a window that no longer exists, showing
  // an empty box and no way to understand why.
  React.useEffect(() => {
    if (key !== 'all' && !races.some((r) => r.key === key)) setKey('all')
  }, [races, key])

  const race = key === 'all' ? null : races.find((r) => r.key === key) || null
  const t0 = race?.t0 ?? null
  const t1 = race?.t1 ?? null

  const shown = React.useMemo(
    () => (race ? items.filter((i) => i.tag.t0 >= race.t0 && i.tag.t0 <= race.t1) : items),
    [items, race]
  )

  // Selecting a race while a point outside it is picked would leave the ring
  // off-screen and the button bar pointing at a moment nobody can see.
  React.useEffect(() => {
    if (selectedUtc == null || !race) return
    if (selectedUtc < race.t0 || selectedUtc > race.t1) onSelect(null)
  }, [race, selectedUtc, onSelect])

  return (
    <div className="flex h-full min-h-0 flex-col pb-2">
      {/* ── Whole track, or one race ───────────────────────────────────────── */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto px-2 pt-2" role="tablist" aria-label="Part of the day">
        <Chip active={key === 'all'} onClick={() => setKey('all')}>Whole track</Chip>
        {races.map((r) => (
          <Chip key={r.key} active={key === r.key} onClick={() => setKey(r.key)}>
            {r.label}
          </Chip>
        ))}
      </div>

      <TrackCanvas
        rows={rows}
        items={shown}
        t0={t0}
        t1={t1}
        selectedUtc={selectedUtc}
        onSelect={onSelect}
        onOpenTag={onOpenTag}
        tzOffsetMin={tzOffsetMin}
      />

      <p className="shrink-0 px-3 pt-2 text-[11px] text-muted">
        {race
          ? `${race.label} · ${sessionClockHm(race.t0, tzOffsetMin)}–${sessionClockHm(race.t1, tzOffsetMin)} · ${shown.length} tagged`
          : `The whole day · ${shown.length} tagged`}
        {races.length === 0 && ' · no races found in the event file'}
      </p>
    </div>
  )
}

function Chip({
  active, onClick, children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'min-h-[40px] shrink-0 whitespace-nowrap rounded-full border px-3 text-xs font-semibold',
        active
          ? 'border-transparent bg-accent text-accent-fg'
          : 'border-[color:var(--border)] bg-surface-2 text-secondary'
      )}
    >
      {children}
    </button>
  )
}
