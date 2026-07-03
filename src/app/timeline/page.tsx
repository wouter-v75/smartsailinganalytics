'use client'
import * as React from 'react'
import { AppShell } from '@/components/ui/app-shell'
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { getBrowserSupabase } from '@/lib/supabase/browser'
import { getActiveMembership, type ActiveMembership } from '@/lib/active-membership'
import { useTimeline } from '@/lib/timeline/useTimeline'
import { useSessions } from '@/lib/timeline/useSessions'
import { buildCampaignTree } from '@/lib/timeline/buildCampaignTree'
import TimelineVertical from '@/components/timeline/TimelineVertical'

// Standalone timeline page. Spine from the session list + event-file detail;
// lands expanded on the last day with data. Vertical nested-accordion.
export default function TimelinePage() {
  const [m, setM] = React.useState<ActiveMembership | null | undefined>(undefined)
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
  const { nodes: detail, error } = useTimeline(m?.team_id, m?.boat_id, null)

  const tree = React.useMemo(
    () => (m?.boat_id && sessions && detail ? buildCampaignTree({ sessions, detail, boatId: m.boat_id }) : null),
    [sessions, detail, m?.boat_id]
  )
  const lastDayId = React.useMemo(() => {
    if (!tree) return undefined
    const d = tree.filter((n) => n.kind === 'day')
    return d.length ? d.reduce((a, b) => (b.t0 > a.t0 ? b : a)).id : undefined
  }, [tree])
  const loading = m === undefined || sessions === null || detail === null

  return (
    <AppShell title="Timeline" subtitle={m?.boat_name || undefined} className="min-h-screen">
      {m === undefined ? (
        <div className="grid gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : !m || !m.boat_id ? (
        <Card><EmptyState title="No active boat" description="Open the main app and select a boat workspace first, then return here." /></Card>
      ) : error ? (
        <ErrorState description={error} />
      ) : loading ? (
        <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : !tree || tree.length === 0 ? (
        <Card><EmptyState title="No campaign entries yet" description="Sync your sessions in the main app, or upload a day's data." /></Card>
      ) : (
        <div className="w-full"><TimelineVertical nodes={tree} initialFocusId={lastDayId} teamId={m.team_id} boatId={m.boat_id} /></div>
      )}
    </AppShell>
  )
}
