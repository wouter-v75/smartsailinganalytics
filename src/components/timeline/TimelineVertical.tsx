'use client'
import * as React from 'react'
import {
  ChevronRight, Flag, MapPin, CornerUpRight, CornerDownRight, Sailboat, Cloud, Users, ClipboardList, type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { buildSeasonScaffold } from '@/lib/timeline/buildSeasonScaffold'
import DayMedia from './DayMedia'

// Vertical, dynamic timeline (nested accordion). Each level is a stacked list;
// spanning nodes (season/regatta/day/race) expand inline on click/tap to reveal
// the next level (progressive disclosure), and on hover show a one-line peek of
// their children. Motion is transform/opacity only and honours reduced-motion.
const SPANNING = new Set(['season', 'regatta', 'day', 'race'])
const ACCENT: Record<string, string> = {
  season: 'var(--accent)', regatta: 'var(--accent)', day: 'var(--text-secondary)', race: '#D85A30',
}
const GLYPH: Record<string, { icon: LucideIcon; color: string }> = {
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

export default function TimelineVertical({ nodes: raw, tzOffset = 0, initialFocusId, teamId, boatId }: { nodes: TimelineNode[]; tzOffset?: number; initialFocusId?: string; teamId?: string | null; boatId?: string | null }) {
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

  // Land expanded down to the focus (last day); roots always open.
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
    <div className="text-fg">
      {roots.map((n) => <Row key={n.id} node={n} tz={tzOffset} childrenOf={childrenOf} open={open} toggle={toggle} teamId={teamId} boatId={boatId} />)}
    </div>
  )
}

function Row({ node, tz, childrenOf, open, toggle, teamId, boatId }: {
  node: TimelineNode; tz: number; childrenOf: (id: string) => TimelineNode[]; open: Set<string>; toggle: (id: string) => void; teamId?: string | null; boatId?: string | null
}) {
  const kids = childrenOf(node.id)
  const expandable = SPANNING.has(node.kind) && kids.length > 0
  const isOpen = open.has(node.id)
  const accent = ACCENT[node.kind] || 'var(--text-secondary)'
  const g = GLYPH[node.kind]
  const Icon = g?.icon
  const timeLabel = node.kind === 'season' || node.kind === 'regatta'
    ? `${dm(node.t0, tz)} – ${dm(node.t1, tz)}`
    : node.kind === 'day' ? dm(node.t0, tz)
    : node.t1 > node.t0 ? `${hms(node.t0, tz)}–${hms(node.t1, tz)}` : hms(node.t0, tz)

  return (
    <div className="py-0.5">
      <button
        onClick={() => expandable && toggle(node.id)}
        aria-expanded={expandable ? isOpen : undefined}
        className={`group flex w-full flex-col rounded-lg border border-[color:var(--border)] bg-surface-1 px-3 py-2 text-left transition-[transform,background-color] duration-150 motion-reduce:transition-none ${expandable ? 'cursor-pointer hover:-translate-y-px hover:bg-surface-2' : 'cursor-default'}`}
        style={{ borderLeft: `2px solid ${accent}` }}
      >
        <div className="flex items-center gap-2">
          {Icon ? <Icon size={15} style={{ color: g!.color }} aria-hidden /> : <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />}
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
      {expandable && isOpen && (
        <div className="tl-reveal-item ml-[8px] mt-0.5 border-l border-[color:var(--border)] pl-3">
          {node.kind === 'day' && teamId && boatId && (
            <DayMedia teamId={teamId} boatId={boatId} date={(node.meta?.date as string) || node.id.split(':')[1] || ''} />
          )}
          {kids.map((c) => <Row key={c.id} node={c} tz={tz} childrenOf={childrenOf} open={open} toggle={toggle} teamId={teamId} boatId={boatId} />)}
        </div>
      )}
    </div>
  )
}

function Badges({ m }: { m?: Record<string, number> }) {
  if (!m) return null
  const b: React.ReactNode[] = []
  if (m.races) b.push(<Badge key="r">{m.races} races</Badge>)
  if (m.tacks != null) b.push(<Badge key="t" tone="success">{m.tacks}T</Badge>)
  if (m.gybes != null) b.push(<Badge key="g">{m.gybes}G</Badge>)
  if (m.marks != null) b.push(<Badge key="m" tone="warning">{m.marks}M</Badge>)
  if (m.videos) b.push(<Badge key="v" tone="accent">{m.videos} vid</Badge>)
  if (m.photos) b.push(<Badge key="p" tone="accent">{m.photos} ph</Badge>)
  if (m.days) b.push(<Badge key="d">{m.days} days</Badge>)
  if (!b.length) return null
  return <span className="hidden shrink-0 items-center gap-1 sm:flex">{b}</span>
}
