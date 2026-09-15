'use client'
import * as React from 'react'
import { Lock, Check, Video, MessageSquare, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/ui'
import type { DaySegment } from '@/lib/tagging/segments'
import { segmentAt } from '@/lib/tagging/segments'
import type { TagWithRequests } from '@/lib/tagging/types'

// The day's tags, grouped the way a crew talks about a day:
//
//   Pre-race · Race 1 · Between races 1–2 · Race 2 · After racing
//
// A VERTICAL list with sticky segment headers, not a horizontal timeline. On a
// phone a horizontal time axis gives every tag about four pixels and needs two
// hands to pan; a vertical list scrolls with one thumb and is the same shape as
// DayTimeline, which the app already uses for exactly this reason.
//
// Detections come first inside each segment and crew tags beneath them — the
// order an F1 debrief runs in, data before the subjective account.
//
// A hollow chip is an unconfirmed detection; a solid one has been vouched for.
// That single visual distinction is most of what the review flow needs.

export interface TagTrackProps {
  items: TagWithRequests[]
  segments: DaySegment[]
  currentUserId?: string | null
  onOpen: (tagId: string) => void
  tzOffsetMin?: number
  /** Collapse everything but this segment on first render. */
  focusSegmentKey?: string | null
}

const clock = (utc: number, tz = 0) => new Date(utc + tz * 60_000).toISOString().slice(11, 19)

export default function TagTrack({
  items, segments, currentUserId, onOpen, tzOffsetMin = 0, focusSegmentKey,
}: TagTrackProps) {
  const grouped = React.useMemo(() => {
    const bySeg = new Map<string, TagWithRequests[]>()
    const loose: TagWithRequests[] = []
    for (const item of items) {
      const seg = segments.length ? segmentAt(segments, item.tag.t0) : null
      if (!seg) { loose.push(item); continue }
      const list = bySeg.get(seg.key)
      if (list) list.push(item)
      else bySeg.set(seg.key, [item])
    }
    const out = segments
      .map((segment) => ({ segment, items: bySeg.get(segment.key) || [] }))
      .filter((g) => g.items.length)
    if (loose.length) {
      // "Outside the day" is only true when a day was worked out and these tags
      // fell beyond it. With no segments at all — the log has not loaded, so
      // nothing is known about when racing happened — every tag is "loose", and
      // calling the whole day "outside the day" is simply wrong.
      out.push({
        segment: {
          key: 'other', kind: 'session', raceNum: null,
          t0: 0, t1: 0,
          label: segments.length ? 'Outside the day' : 'The day',
          endSource: 'data-end',
        } as DaySegment,
        items: loose,
      })
    }
    return out
  }, [items, segments])

  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    if (!focusSegmentKey) return new Set()
    return new Set(segments.filter((s) => s.key !== focusSegmentKey).map((s) => s.key))
  })
  const toggle = (k: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })

  if (!grouped.length) {
    return (
      <div className="px-6 py-12 text-center">
        <p className="text-sm font-medium">Nothing tagged yet</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
          Pull the day’s data in and the starts, mark roundings and manoeuvres
          appear by themselves. The buttons below are for what the data cannot see.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {grouped.map(({ segment, items: segItems }) => {
        const isShut = collapsed.has(segment.key)
        // STRICTLY by time. "Data before the subjective account" is about the
        // running order of a debrief, not about a timeline — sorting detections
        // ahead of crew tags made the clock read 11:59, 12:06, 12:20, 12:50,
        // then 12:04, which is unreadable. A track is a clock.
        const ordered = [...segItems].sort((a, b) => a.tag.t0 - b.tag.t0)
        return (
          <section key={segment.key}>
            <button
              onClick={() => toggle(segment.key)}
              aria-expanded={!isShut}
              className={cn(
                'sticky top-0 z-10 flex min-h-[44px] w-full items-center gap-2 border-y',
                'border-[color:var(--border)] bg-surface-2/95 px-3 text-left backdrop-blur'
              )}
            >
              <span className="text-sm font-semibold">{segment.label}</span>
              {segment.kind === 'race' && segment.endSource !== 'finish' && (
                <span
                  title="The finish is inferred — the event file records start guns but no finish"
                  className="text-xs text-muted"
                >
                  ~
                </span>
              )}
              <span className="ml-auto text-xs text-muted">{ordered.length}</span>
              <ChevronDown
                size={16}
                className={cn('shrink-0 text-muted transition-transform', isShut && '-rotate-90')}
                aria-hidden
              />
            </button>

            {!isShut && (
              <ul className="divide-y divide-[color:var(--border)]">
                {ordered.map((item) => (
                  <TagRow
                    key={item.tag.id}
                    item={item}
                    mine={item.tag.ownerUserId === currentUserId}
                    onOpen={onOpen}
                    tzOffsetMin={tzOffsetMin}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

function TagRow({
  item, mine, onOpen, tzOffsetMin,
}: {
  item: TagWithRequests
  mine: boolean
  onOpen: (id: string) => void
  tzOffsetMin: number
}) {
  const t = item.tag
  const verified = t.verifiedAt != null
  const isAuto = t.source === 'auto'
  const drifted = t.autoT0 != null && t.t0 !== t.autoT0

  return (
    <li>
      <button
        onClick={() => onOpen(t.id)}
        className="flex min-h-[56px] w-full items-start gap-3 px-3 py-3 text-left active:bg-surface-2"
      >
        {/* Hollow = the detector's guess. Solid = somebody vouched for it.
            Pinned to the first line so a three-line note does not leave it
            floating in the middle of the row. */}
        <span
          className={cn('mt-1 h-3 w-3 shrink-0 rounded-full border-2')}
          style={{
            borderColor: t.color,
            background: !isAuto || verified ? t.color : 'transparent',
          }}
          aria-hidden
        />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{t.label}</span>
            {t.scope === 'personal' && mine && (
              <Lock size={11} className="shrink-0 text-muted" aria-label="Only you can see this" />
            )}
            {verified && <Check size={12} className="shrink-0 text-success" aria-label="Confirmed" />}
          </span>

          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <span className="font-mono">{clock(t.t0, tzOffsetMin)}</span>
            {drifted && <span title="Moved from where the detector put it">·&nbsp;moved</span>}
            {t.section && <span className="truncate">· {t.section}</span>}
            {t.labels?.length > 0 && (
              <span className="truncate">· {t.labels.map((l) => l.text).join(', ')}</span>
            )}
          </span>

          {t.note && (
            <span className="mt-1 line-clamp-2 block text-xs text-secondary">{t.note}</span>
          )}
        </span>

        <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
          {item.debriefVotes > 0 && (
            <span
              className="grid h-6 min-w-[24px] place-items-center rounded-full bg-surface-2 px-1 text-[11px] font-bold"
              title={`${item.debriefVotes} asked to discuss this`}
            >
              {item.debriefVotes}
            </span>
          )}
          {item.videoPending > 0 && (
            <Video size={14} className="text-accent" aria-label="Video requested" />
          )}
          {t.reelOrder != null && (
            <span
              className="grid h-6 w-6 place-items-center rounded-full bg-accent-bg text-[11px] font-bold text-accent"
              title="On the debrief reel"
            >
              {t.reelOrder}
            </span>
          )}
          {isAuto && !verified && t.confidence != null && (
            <span className="font-mono text-[11px] text-muted">
              {Math.round(t.confidence * 100)}%
            </span>
          )}
          {!isAuto && t.note && <MessageSquare size={13} className="text-muted" aria-hidden />}
        </span>
      </button>
    </li>
  )
}
