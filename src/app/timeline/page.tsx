'use client'
import * as React from 'react'
import { AppShell } from '@/components/ui/app-shell'
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { getBrowserSupabase } from '@/lib/supabase/browser'
import { getActiveMembership, type ActiveMembership } from '@/lib/active-membership'
import { useTimeline } from '@/lib/timeline/useTimeline'
import { useSessions } from '@/lib/timeline/useSessions'
import { buildCampaignTree } from '@/lib/timeline/buildCampaignTree'
import TimelineDay from '@/components/timeline/TimelineDay'
import TimelineZoom from '@/components/timeline/TimelineZoom'

// The timeline page. The spine comes from the SESSION LIST (every training day +
// event, cloud-synced), with event-file race detail merged in. Lands zoomed on
// the last day with data; breadcrumb zooms out to the whole season.
export default function TimelinePage() {
  const [m, setM] = React.useState<ActiveMembership | null | undefined>(undefined)
  const [view, setView] = React.useState<'zoom' | 'feed'>('zoom')

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

  const sessions = useSessions(m?.team_id, m?.boat_id)
  const { nodes: detail, error } = useTimeline(m?.team_id, m?.boat_id, null) // all persisted event detail

  const tree = React.useMemo(
    () => (m?.boat_id && sessions && detail ? buildCampaignTree({ sessions, detail, boatId: m.boat_id }) : null),
    [sessions, detail, m?.boat_id]
  )
  const lastDayId = React.useMemo(() => {
    if (!tree) return undefined
    const days = tree.filter((n) => n.kind === 'day')
    return days.length ? days.reduce((a, b) => (b.t0 > a.t0 ? b : a)).id : undefined
  }, [tree])

  const loading = m === undefined || sessions === null || detail === null

  return (
    <AppShell
      title="Timeline"
      subtitle={m?.boat_name || undefined}
      className="min-h-screen"
      actions={
        <div className="flex overflow-hidden rounded border border-[color:var(--border)]">
          {(['zoom', 'feed'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-2.5 py-1.5 text-xs capitalize ${view === v ? 'bg-accent text-accent-fg' : 'text-secondary hover:bg-surface-1'}`}>{v}</button>
          ))}
        </div>
      }
    >
      {m === undefined ? (
        <div className="grid gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : !m || !m.boat_id ? (
        <Card><EmptyState title="No active boat" description="Open the main app and select a boat workspace first, then return here." /></Card>
      ) : error ? (
        <ErrorState description={error} />
      ) : loading ? (
        <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : !tree || tree.length === 0 ? (
        <Card><EmptyState title="No campaign entries yet" description="Sync your sessions in the main app, or upload a day's data." /></Card>
      ) : view === 'zoom' ? (
        <TimelineZoom nodes={tree} initialFocusId={lastDayId} />
      ) : (
        <TimelineDay nodes={tree} />
      )}
    </AppShell>
  )
}
