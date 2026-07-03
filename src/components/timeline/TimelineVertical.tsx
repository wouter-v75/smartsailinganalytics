'use client'
import * as React from 'react'
import {
  ChevronRight, Flag, MapPin, CornerUpRight, CornerDownRight, Sailboat, Cloud, Users, ClipboardList, Calendar, type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { buildSeasonScaffold } from '@/lib/timeline/buildSeasonScaffold'
import DayMedia from './DayMedia'

// Dynamic two-pane timeline. Left = the campaign spine (season → regatta → day)
// as a nested accordion; season/regatta rows expand on click. Hovering, focusing
// or clicking a DAY makes it "active" and its full detail — the day's nodes
// (starts / tacks / gybes / marks / sail changes …) plus its photo & video
// thumbnails — renders in the panel beside it (below it on narrow screens).
// Boxes enlarge on hover; motion is transform/opacity only and reduced-motion safe.

const ACCENT: Record<string, string> = {
  season: 'var(--accent)', regatta: 'var(--accent)', day: 'var(--text-secondary)', race: '#D85A30',
}
const GLYPH: Record<string, { icon: LucideIcon; color: string }> = {
  race: { icon: Flag, color: '#D85A30' },
  start: { icon: Flag, color: 'var(--danger)' }, finish: { icon: Flag, color: 'var(--text-muted)' },
  tack: { icon: CornerUpRight, color: 'var(--success)' }, gybe: { icon: CornerDownRight, color: '#7f77dd' },
  mark: { icon: MapPin, color: 'var(--warning)' }, sail_change: { icon: Sailboat, color: 'var(--accent)' },
  weather: { icon: Cloud, color: 'var(--accent)' }, meeting: { icon: Users, color: '#7f77dd' },
  debrief: { icon: ClipboardList, color: '#7f77dd' },
}
const hms = (ms: number, tz: number) => new Date(ms + tz * 60000).toISOString().slice(11, 16)
// Day-first European label (e.g. "2 Jul") — never US MM/DD. Formatted in UTC to
// match the already-tz-shifted ms so the day doesn't jump.
const dm = (ms: number, tz: number) =>
  new Date(ms + tz * 60000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dmy = (ms: number, tz: number) =>
  new Date(ms + tz * 60000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

function useIsDesktop() {
  const [d, setD] = React.useState(true)
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const on = () => setD(mq.matches)
    on(); mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return d
}

export default function TimelineVertical({ nodes: raw, tzOffset = 0, initialFocusId, teamId, boatId, onPlayVideo }: {
  nodes: TimelineNode[]; tzOffset?: number; initialFocusId?: string
  teamId?: string | null; boatId?: string | null
  onPlayVideo?: (date: string, videoId: string) => void
}) {
  const nodes = React.useMemo(() => buildSeasonScaffold(raw), [raw])
  const byId = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const byParent = React.useMemo(() => {
    const m = new Map<string, TimelineNode[]>()
    for (const n of nodes) { const k = n.parentId ?? '__root'; const a = m.get(k); if (a) a.push(n); else m.set(k, [n]) }
    m.forEach((a) => a.sort((x, y) => x.t0 - y.t0))
    return m
  }, [nodes])
  const childrenOf = React.useCallback((id: string) => byParent.get(id) ?? [], [byParent])
  const roots = byParent.get('__root') ?? []
  const isDesktop = useIsDesktop()

  // Latest day = the natural landing focus.
  const latestDayId = React.useMemo(() => {
    const days = nodes.filter((n) => n.kind === 'day')
    return days.length ? days.reduce((a, b) => (b.t0 > a.t0 ? b : a)).id : undefined
  }, [nodes])
  const focusDayId = (initialFocusId && byId.get(initialFocusId)?.kind === 'day') ? initialFocusId : latestDayId

  // Accordion open-set: roots + the ancestor chain of the focus day.
  const defaultOpen = React.useMemo(() => {
    const s = new Set<string>()
    roots.forEach((r) => s.add(r.id))
    let cur: string | undefined = focusDayId
    while (cur) { s.add(cur); cur = byId.get(cur)?.parentId ?? undefined }
    return s
  }, [focusDayId, byId, roots])
  const [open, setOpen] = React.useState<Set<string>>(defaultOpen)
  React.useEffect(() => { setOpen(defaultOpen) }, [defaultOpen])
  const toggle = React.useCallback((id: string) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n }), [])

  const [activeDayId, setActiveDayId] = React.useState<string | undefined>(focusDayId)
  React.useEffect(() => { setActiveDayId(focusDayId) }, [focusDayId])
  const activeDay = activeDayId ? byId.get(activeDayId) : undefined

  // All descendant event-nodes of a day, flattened + time-sorted (races, starts,
  // tacks, gybes, marks, sail changes, weather, meeting, debrief).
  const descendantsOf = React.useCallback((id: string): TimelineNode[] => {
    const out: TimelineNode[] = []
    const walk = (pid: string) => childrenOf(pid).forEach((c) => { out.push(c); walk(c.id) })
    walk(id)
    return out.sort((a, b) => a.t0 - b.t0)
  }, [childrenOf])

  const detail = activeDay ? (
    <DayDetail
      key={activeDay.id}
      day={activeDay}
      events={descendantsOf(activeDay.id)}
      tz={tzOffset}
      teamId={teamId}
      boatId={boatId}
      onPlayVideo={onPlayVideo}
    />
  ) : (
    <div className="rounded-xl border border-dashed border-[color:var(--border)] p-6 text-center text-sm text-muted">
      Hover or tap a day to see its markers, photos and videos.
    </div>
  )

  return (
    <div className="text-fg md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-start md:gap-5">
      <div>
        {roots.map((n) => (
          <Row
            key={n.id} node={n} tz={tzOffset} childrenOf={childrenOf}
            open={open} toggle={toggle}
            activeDayId={activeDayId} setActiveDay={setActiveDayId}
            isDesktop={isDesktop} detailInline={detail}
          />
        ))}
      </div>
      {isDesktop && (
        <div className="sticky top-3 self-start">{detail}</div>
      )}
    </div>
  )
}

function Row({ node, tz, childrenOf, open, toggle, activeDayId, setActiveDay, isDesktop, detailInline }: {
  node: TimelineNode; tz: number; childrenOf: (id: string) => TimelineNode[]
  open: Set<string>; toggle: (id: string) => void
  activeDayId?: string; setActiveDay: (id: string) => void
  isDesktop: boolean; detailInline: React.ReactNode
}) {
  const kids = childrenOf(node.id)
  const isDay = node.kind === 'day'
  const isSpanning = node.kind === 'season' || node.kind === 'regatta'
  const expandable = isSpanning && kids.length > 0
  const isOpen = open.has(node.id)
  const isActive = isDay && node.id === activeDayId
  const accent = ACCENT[node.kind] || 'var(--text-secondary)'
  const g = GLYPH[node.kind]
  const Icon = isDay ? Calendar : g?.icon
  const iconColor = isDay ? 'var(--text-secondary)' : g?.color
  const timeLabel = isSpanning ? `${dm(node.t0, tz)} – ${dm(node.t1, tz)}` : dm(node.t0, tz)

  const activate = () => setActiveDay(node.id)

  return (
    <div className="py-0.5">
      <button
        onClick={() => (expandable ? toggle(node.id) : activate())}
        onMouseEnter={isDay ? activate : undefined}
        onFocus={isDay ? activate : undefined}
        aria-expanded={expandable ? isOpen : undefined}
        aria-current={isActive ? 'true' : undefined}
        className={[
          'group flex w-full flex-col rounded-lg border px-3 py-2 text-left',
          'transition-[transform,box-shadow,background-color,border-color] duration-150 motion-reduce:transition-none',
          'hover:-translate-y-px hover:shadow-md hover:scale-[1.02] motion-reduce:hover:scale-100 origin-left cursor-pointer',
          isActive ? 'border-[color:var(--accent)] bg-surface-2 shadow-md' : 'border-[color:var(--border)] bg-surface-1 hover:bg-surface-2',
        ].join(' ')}
        style={{ borderLeft: `3px solid ${isActive ? 'var(--accent)' : accent}` }}
      >
        <div className="flex items-center gap-2">
          {Icon ? <Icon size={15} style={{ color: iconColor }} aria-hidden /> : <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />}
          <span className="truncate text-sm font-medium">{node.title}</span>
          {node.subtitle && <span className="hidden truncate text-xs text-muted sm:inline">{node.subtitle}</span>}
          <Badges m={node.metrics} />
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{timeLabel}</span>
          {expandable && <ChevronRight size={15} className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`} aria-hidden />}
        </div>
        {expandable && !isOpen && (
          <div className="mt-1 hidden truncate text-[11px] text-muted group-hover:block">
            {kids.slice(0, 6).map((k) => k.title).join('  ·  ')}{kids.length > 6 ? '  …' : ''}
          </div>
        )}
      </button>

      {/* Children of season/regatta (the accordion). */}
      {expandable && isOpen && (
        <div className="tl-reveal-item ml-[10px] mt-0.5 border-l border-[color:var(--border)] pl-3">
          {kids.map((c) => (
            <Row
              key={c.id} node={c} tz={tz} childrenOf={childrenOf}
              open={open} toggle={toggle}
              activeDayId={activeDayId} setActiveDay={setActiveDay}
              isDesktop={isDesktop} detailInline={detailInline}
            />
          ))}
        </div>
      )}

      {/* On narrow screens the detail panel renders inline under the active day. */}
      {isDay && !isDesktop && node.id === activeDayId && (
        <div className="tl-reveal-item ml-[10px] mt-1 border-l-2 border-[color:var(--accent)] pl-3">{detailInline}</div>
      )}
    </div>
  )
}

function DayDetail({ day, events, tz, teamId, boatId, onPlayVideo }: {
  day: TimelineNode; events: TimelineNode[]; tz: number
  teamId?: string | null; boatId?: string | null
  onPlayVideo?: (date: string, videoId: string) => void
}) {
  const date = (day.meta?.date as string) || day.id.split(':')[1] || ''
  const markers = events.filter((e) => e.kind !== 'day')
  const play = React.useCallback((videoId: string) => { if (onPlayVideo) onPlayVideo(date, videoId) }, [onPlayVideo, date])

  return (
    <div className="tl-reveal-item rounded-xl border border-[color:var(--border)] bg-surface-1 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Calendar size={16} className="text-secondary" aria-hidden />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{day.title}</div>
          <div className="text-xs text-muted">{dmy(day.t0, tz)}{day.subtitle ? `  ·  ${day.subtitle}` : ''}</div>
        </div>
        <div className="ml-auto"><Badges m={day.metrics} /></div>
      </div>

      {markers.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">On the water</div>
          <ol className="grid gap-0.5">
            {markers.map((e) => {
              const gg = GLYPH[e.kind]
              const EIcon = gg?.icon
              const span = e.t1 > e.t0
              return (
                <li key={e.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-surface-2">
                  {EIcon ? <EIcon size={14} style={{ color: gg!.color }} aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--text-muted)]" />}
                  <span className="truncate">{e.title}</span>
                  {e.subtitle && <span className="truncate text-xs text-muted">{e.subtitle}</span>}
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                    {span ? `${hms(e.t0, tz)}–${hms(e.t1, tz)}` : hms(e.t0, tz)}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      <div className="mt-3">
        {teamId && boatId && date
          ? <DayMedia teamId={teamId} boatId={boatId} date={date} onPlayVideo={onPlayVideo ? play : undefined} showEmpty={markers.length === 0} />
          : <div className="text-xs text-muted">No media source.</div>}
      </div>
    </div>
  )
}

function Badges({ m }: { m?: Record<string, number> }) {
  if (!m) return null
  const b: React.ReactNode[] = []
  if (m.days) b.push(<Badge key="d">{m.days} days</Badge>)
  if (m.races) b.push(<Badge key="r">{m.races} races</Badge>)
  if (m.tacks != null) b.push(<Badge key="t" tone="success">{m.tacks}T</Badge>)
  if (m.gybes != null) b.push(<Badge key="g">{m.gybes}G</Badge>)
  if (m.marks != null) b.push(<Badge key="m" tone="warning">{m.marks}M</Badge>)
  if (m.videos) b.push(<Badge key="v" tone="accent">{m.videos} vid</Badge>)
  if (m.photos) b.push(<Badge key="p" tone="accent">{m.photos} ph</Badge>)
  if (!b.length) return null
  return <span className="hidden shrink-0 items-center gap-1 sm:flex">{b}</span>
}
