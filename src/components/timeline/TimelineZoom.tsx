'use client'
import * as React from 'react'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { buildSeasonScaffold } from '@/lib/timeline/buildSeasonScaffold'

// Semantic-zoom timeline (Phase 2 flagship). Generic over the node tree: the
// current focus node's children lay out on a time axis; a spanning child (race,
// day, regatta…) expands into its own children via a shared-element / container
// transform (FLIP via Web Animations API — transform + opacity only). Breadcrumb
// + context strip keep place; prefers-reduced-motion falls back to instant swap.
const hms = (ms: number, tz: number) => new Date(ms + tz * 60000).toISOString().slice(11, 16)
const KIND_ACCENT: Record<string, string> = {
  season: 'var(--accent)', regatta: 'var(--accent)', day: 'var(--text-secondary)', race: 'var(--accent)',
  start: 'var(--danger)', finish: 'var(--text-muted)', tack: 'var(--success)', gybe: '#7f77dd',
  mark: 'var(--warning)', sail_change: 'var(--accent)',
}
const SPANNING = new Set(['season', 'regatta', 'day', 'race'])
const isSpanning = (n: TimelineNode) => n.t1 > n.t0 && SPANNING.has(n.kind)

export default function TimelineZoom({ nodes: raw, tzOffset = 0, initialFocusId }: { nodes: TimelineNode[]; tzOffset?: number; initialFocusId?: string }) {
  // Add season/regatta parents when the set spans multiple days.
  const nodes = React.useMemo(() => buildSeasonScaffold(raw), [raw])
  const byId = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const byParent = React.useMemo(() => {
    const m = new Map<string, TimelineNode[]>()
    for (const n of nodes) { const k = n.parentId ?? '__root'; const a = m.get(k); if (a) a.push(n); else m.set(k, [n]) }
    m.forEach((a) => a.sort((x, y) => x.t0 - y.t0))
    return m
  }, [nodes])
  const childrenOf = (id: string) => byParent.get(id) ?? []
  const top = byParent.get('__root') ?? []
  // Start the zoom at the highest structural level present.
  const rootNode = top.find((n) => n.kind === 'season') ?? top.find((n) => n.kind === 'regatta') ?? top.find((n) => n.kind === 'day') ?? top[0]

  // Path from root down to the initial focus (so we can land on the last day but
  // still zoom out via the breadcrumb).
  const chainTo = React.useCallback((id?: string): string[] => {
    if (!id || !byId.has(id)) return rootNode ? [rootNode.id] : []
    const c: string[] = []
    let cur: string | undefined = id
    while (cur) { c.unshift(cur); cur = byId.get(cur)?.parentId ?? undefined }
    return c
  }, [byId, rootNode])
  const [path, setPath] = React.useState<string[]>(() => chainTo(initialFocusId))
  React.useEffect(() => { setPath(chainTo(initialFocusId)) }, [chainTo, initialFocusId])

  const stageRef = React.useRef<HTMLDivElement>(null)
  const anim = React.useRef<{ leftPx: number; w: number; dir: 'in' | 'out' } | null>(null)
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  React.useLayoutEffect(() => {
    const el = stageRef.current
    if (!el || !anim.current) { anim.current = null; return }
    const { leftPx, w, dir } = anim.current
    anim.current = null
    if (reduce) return
    el.style.transformOrigin = 'left center'
    if (dir === 'in') {
      el.animate([{ transform: `translateX(${leftPx}px) scaleX(${w}) scaleY(0.7)`, opacity: 0.25 }, { transform: 'none', opacity: 1 }],
        { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' })
    } else {
      el.animate([{ transform: 'scale(1.03)', opacity: 0.4 }, { transform: 'none', opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
  }, [path, reduce])

  const focus = path.length ? byId.get(path[path.length - 1]) : undefined
  const kids = focus ? childrenOf(focus.id) : []
  const dur = focus ? Math.max(1, focus.t1 - focus.t0) : 1

  const drill = (child: TimelineNode, e: React.MouseEvent) => {
    if (!isSpanning(child)) return
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const st = stageRef.current?.getBoundingClientRect()
    if (st && st.width) anim.current = { leftPx: box.left - st.left, w: box.width / st.width, dir: 'in' }
    setPath((p) => [...p, child.id])
  }
  const zoomTo = (i: number) => {
    if (i >= path.length - 1) return
    anim.current = { leftPx: 0, w: 1, dir: 'out' }
    setPath((p) => p.slice(0, i + 1))
  }

  if (!focus) return <div className="text-xs text-muted">No timeline.</div>

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        {path.map((id, i) => {
          const n = byId.get(id); if (!n) return null
          const cur = i === path.length - 1
          return (
            <React.Fragment key={id}>
              {i > 0 && <ChevronRight size={14} className="text-muted" aria-hidden />}
              <button onClick={() => zoomTo(i)} disabled={cur} className={cur ? 'font-medium text-fg' : 'text-secondary hover:text-fg'}>{n.title}</button>
            </React.Fragment>
          )
        })}
        {path.length > 1 && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => zoomTo(path.length - 2)}>
            <ChevronLeft size={15} aria-hidden />Back
          </Button>
        )}
      </div>

      <ContextStrip nodes={nodes} focus={focus} rootId={rootNode?.id} />

      <div ref={stageRef} className="min-h-[120px]">
        {kids.length === 0 ? (
          <div className="px-1 text-xs text-muted">No detail at this level.</div>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {kids.map((c) => {
              const span = isSpanning(c)
              const accent = KIND_ACCENT[c.kind] || 'var(--text-secondary)'
              const grow = span ? Math.max(1, ((c.t1 - c.t0) / dur) * 100) : 0
              return (
                <button
                  key={c.id}
                  onClick={(e) => drill(c, e)}
                  disabled={!span}
                  style={{ flex: span ? `${grow} 1 130px` : '0 0 auto', borderTop: `2px solid ${accent}` }}
                  className={`rounded-lg border border-[color:var(--border)] bg-surface-1 px-3 py-2 text-left ${span ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default'}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="whitespace-nowrap text-sm font-medium text-fg">{c.title}</span>
                    {span && <ChevronRight size={14} className="text-muted" aria-hidden />}
                  </div>
                  <div className="whitespace-nowrap font-mono text-[11px] text-muted">
                    {hms(c.t0, tzOffset)}{c.t1 > c.t0 ? `–${hms(c.t1, tzOffset)}` : ''}
                  </div>
                  {c.metrics && (c.metrics.races || c.metrics.tacks != null || c.metrics.marks != null || c.metrics.videos || c.metrics.photos || c.metrics.scans) && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.metrics.races ? <Badge>{c.metrics.races} races</Badge> : null}
                      {c.metrics.tacks != null && <Badge tone="success">{c.metrics.tacks}T</Badge>}
                      {c.metrics.gybes != null && <Badge>{c.metrics.gybes}G</Badge>}
                      {c.metrics.marks != null && <Badge tone="warning">{c.metrics.marks}M</Badge>}
                      {c.metrics.videos ? <Badge tone="accent">{c.metrics.videos} vid</Badge> : null}
                      {c.metrics.photos ? <Badge tone="accent">{c.metrics.photos} ph</Badge> : null}
                      {c.metrics.scans ? <Badge style={{ background: 'rgba(167,139,250,0.15)', color: '#A78BFA' }}>{c.metrics.scans} sc</Badge> : null}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ContextStrip({ nodes, focus, rootId }: { nodes: TimelineNode[]; focus: TimelineNode; rootId?: string }) {
  const root = rootId ? nodes.find((n) => n.id === rootId) : undefined
  const r0 = root ? root.t0 : Math.min(...nodes.map((n) => n.t0))
  const r1 = root ? root.t1 : Math.max(...nodes.map((n) => n.t1))
  const dur = Math.max(1, r1 - r0)
  const left = ((focus.t0 - r0) / dur) * 100
  const width = Math.max(2, ((focus.t1 - focus.t0) / dur) * 100)
  return (
    <div className="relative h-2 overflow-hidden rounded-full border border-[color:var(--border)] bg-surface-2">
      <div
        className="absolute inset-y-0 rounded-full"
        style={{ left: `${left}%`, width: `${width}%`, background: 'var(--accent)', transition: 'left .35s cubic-bezier(.2,.8,.2,1), width .35s cubic-bezier(.2,.8,.2,1)' }}
      />
    </div>
  )
}
