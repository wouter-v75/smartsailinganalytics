'use client'
import * as React from 'react'
import { Camera, Search } from 'lucide-react'
import { AppShell } from '@/components/ui/app-shell'
import { Card, Badge, Button, EmptyState, Dialog, DialogContent } from '@/components/ui'
import { setUiNext } from '@/lib/ui-flags'

// Reference migration (Phase 1): the Photos browse view rebuilt on the design
// system. It reuses the already-loaded/enriched `photos` + filter state from the
// legacy PhotosTab (no re-plumbing of IDB/cloud sync) and renders a responsive
// grid + a design-system lightbox. Behind ?ui=next.
interface Photo {
  id: string; objectUrl?: string | null; lqip?: string | null; utc?: number | null
  name?: string | null; sails?: string[]; tws?: number | null; twa?: number | null
  heel?: number | null; bsp?: number | null
}
interface InvSail { id: string; name: string; category?: string | null; retired?: boolean }

export default function PhotosNext({
  photos, total, searchQuery, setSearchQuery, sailInventory = [], sailFilter, setSailFilter, tzOffset = 0,
}: {
  photos: Photo[]
  total?: number
  searchQuery: string
  setSearchQuery: (v: string) => void
  sailInventory?: InvSail[]
  sailFilter: string
  setSailFilter: (v: string) => void
  tzOffset?: number
}) {
  const [sel, setSel] = React.useState<Photo | null>(null)
  const active = sailInventory.filter((s) => !s.retired)
  const time = (u?: number | null) => (u ? new Date(u + tzOffset * 60000).toISOString().slice(11, 16) : '')
  const r = (v?: number | null, d = 0) => (v == null ? null : v.toFixed(d))

  return (
    <AppShell
      title="Photos"
      subtitle={`${photos.length}${total != null && total !== photos.length ? ` of ${total}` : ''} shown`}
      actions={<Button variant="ghost" size="sm" onClick={() => setUiNext(false)}>Classic view</Button>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search photos"
            className="w-full rounded border border-[color:var(--border)] bg-surface-1 py-2 pl-8 pr-3 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
          />
        </div>
        {active.length > 0 && (
          <select
            value={sailFilter}
            onChange={(e) => setSailFilter(e.target.value)}
            className="rounded border border-[color:var(--border)] bg-surface-1 px-3 py-2 text-sm text-fg"
          >
            <option value="">All sails</option>
            {active.map((s) => <option key={s.id} value={s.id}>{s.category ? `${s.category} · ${s.name}` : s.name}</option>)}
          </select>
        )}
      </div>

      {photos.length === 0 ? (
        <Card><EmptyState icon={Camera} title="No photos match" description="Adjust the filters, or upload from the classic view." /></Card>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))' }}>
          {photos.map((p) => (
            <button
              key={p.id}
              onClick={() => setSel(p)}
              className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-[color:var(--border)] bg-surface-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            >
              {p.objectUrl ? (
                <img src={p.objectUrl} alt={p.name || ''} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted"><Camera size={20} aria-hidden /></div>
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/45 px-2 py-1">
                {p.utc && <span className="font-mono text-[10px] text-white/90">{time(p.utc)}</span>}
                {(p.sails || []).slice(0, 2).map((s) => <span key={s} className="truncate text-[10px] text-white/80">{s}</span>)}
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!sel} onOpenChange={(o) => { if (!o) setSel(null) }}>
        {sel && (
          <DialogContent title={sel.name || 'Photo'}>
            {sel.objectUrl && <img src={sel.objectUrl} alt="" className="w-full rounded" />}
            <div className="mt-3 flex flex-wrap gap-2">
              {r(sel.tws) != null && <Badge tone="accent">TWS {r(sel.tws)} kt</Badge>}
              {r(sel.twa) != null && <Badge>TWA {r(sel.twa)}°</Badge>}
              {r(sel.bsp, 1) != null && <Badge tone="success">BSP {r(sel.bsp, 1)} kt</Badge>}
              {r(sel.heel) != null && <Badge tone="warning">Heel {r(sel.heel)}°</Badge>}
              {(sel.sails || []).map((s) => <Badge key={s}>{s}</Badge>)}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </AppShell>
  )
}
