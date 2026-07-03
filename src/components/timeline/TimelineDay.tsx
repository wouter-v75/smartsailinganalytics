'use client'
import * as React from 'react'
import { Flag, MapPin, CornerUpRight, CornerDownRight, Sailboat, Circle, type LucideIcon } from 'lucide-react'
import { Card, Badge } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'

// Instrument-style day view (Phase 2, first projection). Renders the node tree as
// a calm, glanceable feed: day → races → events, mono times, hairline rules,
// flat surfaces, non-colour state cues (labels + shapes, not colour alone). This
// is the static base; semantic zoom + shared-element expand layer on next.
const GLYPH: Record<string, { icon: LucideIcon; color: string }> = {
  start: { icon: Flag, color: 'var(--danger)' },
  finish: { icon: Flag, color: 'var(--text-muted)' },
  tack: { icon: CornerUpRight, color: 'var(--success)' },
  gybe: { icon: CornerDownRight, color: '#7f77dd' },
  mark: { icon: MapPin, color: 'var(--warning)' },
  sail_change: { icon: Sailboat, color: 'var(--accent)' },
}
const hms = (ms: number, tz: number) => new Date(ms + tz * 60000).toISOString().slice(11, 19)

export default function TimelineDay({ nodes, tzOffset = 0 }: { nodes: TimelineNode[]; tzOffset?: number }) {
  const byParent = React.useMemo(() => {
    const m = new Map<string, TimelineNode[]>()
    for (const n of nodes) {
      const k = n.parentId ?? '__root'
      const arr = m.get(k)
      if (arr) arr.push(n); else m.set(k, [n])
    }
    m.forEach((arr) => arr.sort((a, b) => a.t0 - b.t0))
    return m
  }, [nodes])
  const children = (id: string) => byParent.get(id) ?? []
  const top = byParent.get('__root') ?? []
  const days = top.filter((n) => n.kind === 'day')
  const roots = days.length ? days : top

  return (
    <div className="grid gap-4">
      {roots.map((day) => {
        const kids = children(day.id)
        const races = kids.filter((k) => k.kind === 'race')
        const dayEvents = kids.filter((k) => k.kind !== 'race')
        return (
          <div key={day.id} className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">{day.title}</span>
              {day.subtitle && <span className="text-xs text-muted">{day.subtitle}</span>}
              {day.metrics?.videos ? <Badge tone="accent">{day.metrics.videos} vid</Badge> : null}
              {day.metrics?.photos ? <Badge tone="accent">{day.metrics.photos} ph</Badge> : null}
              <span className="ml-auto font-mono text-[11px] text-muted">{hms(day.t0, tzOffset)}–{hms(day.t1, tzOffset)}</span>
            </div>

            {dayEvents.length > 0 && <Card><EventList events={dayEvents} tz={tzOffset} /></Card>}
            {races.length === 0 && dayEvents.length === 0 && (
              <div className="px-1 text-xs text-muted">No race detail for this day — videos, photos and data only.</div>
            )}

            {races.map((r) => (
              <Card key={r.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--border)] px-3 py-2">
                  <span className="text-sm font-medium text-fg">{r.title}</span>
                  <span className="font-mono text-[11px] text-muted">{hms(r.t0, tzOffset)}–{hms(r.t1, tzOffset)}</span>
                  <div className="ml-auto flex gap-1.5">
                    {r.metrics?.tacks != null && <Badge tone="success">{r.metrics.tacks} tacks</Badge>}
                    {r.metrics?.gybes != null && <Badge>{r.metrics.gybes} gybes</Badge>}
                    {r.metrics?.marks != null && <Badge tone="warning">{r.metrics.marks} marks</Badge>}
                  </div>
                </div>
                <EventList events={children(r.id)} tz={tzOffset} />
              </Card>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function EventList({ events, tz }: { events: TimelineNode[]; tz: number }) {
  const rows = [...events].sort((a, b) => a.t0 - b.t0)
  if (!rows.length) return <div className="px-3 py-2 text-xs text-muted">No events.</div>
  return (
    <div className="divide-y divide-[color:var(--border)]">
      {rows.map((e) => {
        const g = GLYPH[e.kind] || { icon: Circle, color: 'var(--text-muted)' }
        const Icon = g.icon
        const invalid = !!e.meta && (e.meta as Record<string, unknown>).valid === false
        return (
          <div key={e.id} className="flex items-center gap-3 px-3 py-1.5">
            <span className="w-16 shrink-0 font-mono text-[11px] text-muted">{hms(e.t0, tz)}</span>
            <Icon size={15} style={{ color: g.color }} aria-hidden />
            <span className="text-sm text-fg">{e.title}</span>
            {invalid && <Badge tone="warning" className="ml-auto">invalid</Badge>}
          </div>
        )
      })}
    </div>
  )
}
