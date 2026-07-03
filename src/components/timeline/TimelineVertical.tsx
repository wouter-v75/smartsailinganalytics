'use client'
import * as React from 'react'
import { ChevronRight, Flag, Calendar, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { buildSeasonScaffold } from '@/lib/timeline/buildSeasonScaffold'
import DayTimeline from './DayTimeline'

// A narrow campaign spine on the left (season → regatta → day). Clicking a DAY
// expands its own vertical time-axis inline — pushing the following days down —
// so you can read the whole day (nodes + event-file tags + media connected to
// their timestamps). Season/regatta rows are a simple accordion. Boxes enlarge
// on hover; motion is transform/opacity only and reduced-motion safe.

const ACCENT: Record<string, string> = {
  season: 'var(--accent)', regatta: 'var(--accent)', day: 'var(--text-secondary)',
}
const GLYPH: Record<string, LucideIcon> = { season: Flag, regatta: Flag, day: Calendar }
const dm = (ms: number, tz: number) =>
  new Date(ms + tz * 60000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

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

  // All descendant event-nodes of a day, flattened + time-sorted.
  const descendantsOf = React.useCallback((id: string): TimelineNode[] => {
    const out: TimelineNode[] = []
    const walk = (pid: string) => childrenOf(pid).forEach((c) => { out.push(c); walk(c.id) })
    walk(id)
    return out.sort((a, b) => a.t0 - b.t0)
  }, [childrenOf])

  // Land expanded down to the focus day (and open that day's axis).
  const defaultOpen = React.useMemo(() => {
    const s = new Set<string>()
    roots.forEach((r) => s.add(r.id))
    let cur: string | undefined = initialFocusId
    while (cur) { s.add(cur); cur = byId.get(cur)?.parentId ?? undefined }
    return s
  }, [initialFocusId, byId, roots])
  const [open, setOpen] = React.useState<Set<string>>(defaultOpen)
  React.useEffect(() => { setOpen(defaultOpen) }, [defaultOpen])
  const toggle = React.useCallback((id: string) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n }), [])

  return (
    <div className="mr-auto w-full max-w-5xl text-fg">
      {roots.map((n) => (
        <Row key={n.id} node={n} tz={tzOffset} childrenOf={childrenOf} descendantsOf={descendantsOf}
          open={open} toggle={toggle} teamId={teamId} boatId={boatId} onPlayVideo={onPlayVideo} />
      ))}
    </div>
  )
}

function Row({ node, tz, childrenOf, descendantsOf, open, toggle, teamId, boatId, onPlayVideo }: {
  node: TimelineNode; tz: number
  childrenOf: (id: string) => TimelineNode[]; descendantsOf: (id: string) => TimelineNode[]
  open: Set<string>; toggle: (id: string) => void
  teamId?: string | null; boatId?: string | null
  onPlayVideo?: (date: string, videoId: string) => void
}) {
  const kids = childrenOf(node.id)
  const isDay = node.kind === 'day'
  const isSpanning = node.kind === 'season' || node.kind === 'regatta'
  const expandable = isDay || (isSpanning && kids.length > 0)
  const isOpen = open.has(node.id)
  const accent = ACCENT[node.kind] || 'var(--text-secondary)'
  const Icon = GLYPH[node.kind]
  const timeLabel = isSpanning ? `${dm(node.t0, tz)} – ${dm(node.t1, tz)}` : dm(node.t0, tz)
  const date = isDay ? ((node.meta?.date as string) || node.id.split(':')[1] || '') : ''
  const playForDay = React.useCallback((vid: string) => { if (onPlayVideo && date) onPlayVideo(date, vid) }, [onPlayVideo, date])

  return (
    <div className="py-0.5">
      <button
        onClick={() => expandable && toggle(node.id)}
        aria-expanded={expandable ? isOpen : undefined}
        className={[
          'group flex w-[300px] max-w-full flex-col rounded-lg border px-3 py-2 text-left',
          'transition-[transform,box-shadow,background-color,border-color] duration-150 motion-reduce:transition-none',
          'origin-left hover:-translate-y-px hover:scale-[1.02] hover:shadow-md motion-reduce:hover:scale-100',
          expandable ? 'cursor-pointer' : 'cursor-default',
          isDay && isOpen ? 'border-[color:var(--accent)] bg-surface-2 shadow-md' : 'border-[color:var(--border)] bg-surface-1 hover:bg-surface-2',
        ].join(' ')}
        style={{ borderLeft: `3px solid ${isDay && isOpen ? 'var(--accent)' : accent}` }}
      >
        <div className="flex items-center gap-2">
          {Icon ? <Icon size={15} style={{ color: isDay && isOpen ? 'var(--accent)' : accent }} aria-hidden /> : <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />}
          <span className="truncate text-sm font-medium">{node.title}</span>
          {node.subtitle && <span className="hidden truncate text-xs text-muted sm:inline">{node.subtitle}</span>}
          <Badges m={node.metrics} />
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{timeLabel}</span>
          {expandable && <ChevronRight size={15} className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`} aria-hidden />}
        </div>
        {expandable && !isOpen && isSpanning && (
          <div className="mt-1 hidden truncate text-[11px] text-muted group-hover:block">
            {kids.slice(0, 6).map((k) => k.title).join('  ·  ')}{kids.length > 6 ? '  …' : ''}
          </div>
        )}
      </button>

      {/* Season / regatta accordion children. */}
      {isSpanning && isOpen && kids.length > 0 && (
        <div className="tl-reveal-item ml-[10px] mt-0.5 border-l border-[color:var(--border)] pl-3">
          {kids.map((c) => (
            <Row key={c.id} node={c} tz={tz} childrenOf={childrenOf} descendantsOf={descendantsOf}
              open={open} toggle={toggle} teamId={teamId} boatId={boatId} onPlayVideo={onPlayVideo} />
          ))}
        </div>
      )}

      {/* Day → its own vertical time-axis, inline (pushes following days down). */}
      {isDay && isOpen && (
        <div className="tl-reveal-item ml-[10px] mt-1 border-l-2 border-[color:var(--accent)] pl-3">
          <DayTimeline day={node} events={descendantsOf(node.id)} tz={tz} teamId={teamId} boatId={boatId} onPlayVideo={onPlayVideo ? playForDay : undefined} />
        </div>
      )}
    </div>
  )
}

function Badges({ m }: { m?: Record<string, number> }) {
  if (!m) return null
  const b: React.ReactNode[] = []
  if (m.days) b.push(<Badge key="d">{m.days} days</Badge>)
  if (m.races) b.push(<Badge key="r">{m.races} races</Badge>)
  if (m.videos) b.push(<Badge key="v" tone="accent">{m.videos} vid</Badge>)
  if (m.photos) b.push(<Badge key="p" tone="warning">{m.photos} ph</Badge>)
  if (!b.length) return null
  return <span className="hidden shrink-0 items-center gap-1 sm:flex">{b}</span>
}
