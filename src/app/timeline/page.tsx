'use client'
import * as React from 'react'
import { AppShell } from '@/components/ui/app-shell'
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { getBrowserSupabase } from '@/lib/supabase/browser'
import { getActiveMembership, type ActiveMembership } from '@/lib/active-membership'
import { useTimeline } from '@/lib/timeline/useTimeline'
import TimelineDay from '@/components/timeline/TimelineDay'
import TimelineZoom from '@/components/timeline/TimelineZoom'

// Standalone timeline page (Phase 2, first projection). Reads the active boat
// workspace + a ?date and renders the instrument-style day view. Open at
// /timeline?date=YYYY-MM-DD after selecting a boat in the main app.
const today = () => new Date().toISOString().slice(0, 10)

export default function TimelinePage() {
  const [m, setM] = React.useState<ActiveMembership | null | undefined>(undefined)
  const [view, setView] = React.useState<'zoom' | 'feed'>('zoom')
  const [scope, setScope] = React.useState<'day' | 'season'>('day')
  const [date, setDate] = React.useState<string>(() => {
    try { return new URLSearchParams(window.location.search).get('date') || today() } catch { return today() }
  })

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data: { user } } = await getBrowserSupabase().auth.getUser()
        const am = user ? getActiveMembership(user.id) : null
        if (alive) setM(am)
      } catch { if (alive) setM(null) }
    })()
    return () => { alive = false }
  }, [])

  const { nodes, error } = useTimeline(m?.team_id, m?.boat_id, scope === 'season' ? null : date)

  return (
    <AppShell
      title="Timeline"
      subtitle={m?.boat_name || undefined}
      className="min-h-screen"
      actions={
        <>
          <div className="flex overflow-hidden rounded border border-[color:var(--border)]">
            {(['zoom', 'feed'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-2.5 py-1.5 text-xs capitalize ${view === v ? 'bg-accent text-accent-fg' : 'text-secondary hover:bg-surface-1'}`}>{v}</button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded border border-[color:var(--border)]">
            {(['day', 'season'] as const).map((s) => (
              <button key={s} onClick={() => setScope(s)}
                className={`px-2.5 py-1.5 text-xs capitalize ${scope === s ? 'bg-accent text-accent-fg' : 'text-secondary hover:bg-surface-1'}`}>{s}</button>
            ))}
          </div>
          {scope === 'day' && (
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded border border-[color:var(--border)] bg-surface-1 px-2 py-1.5 text-sm text-fg"
            />
          )}
        </>
      }
    >
      {m === undefined ? (
        <div className="grid gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : !m || !m.boat_id ? (
        <Card><EmptyState title="No active boat" description="Open the main app and select a boat workspace first, then return here." /></Card>
      ) : error ? (
        <ErrorState description={error} />
      ) : nodes === null ? (
        <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : nodes.length === 0 ? (
        <Card><EmptyState title="No timeline for this day" description="Upload an event file for this date in the main app to build the race timeline." /></Card>
      ) : view === 'zoom' ? (
        <TimelineZoom nodes={nodes} />
      ) : (
        <TimelineDay nodes={nodes} />
      )}
    </AppShell>
  )
}
