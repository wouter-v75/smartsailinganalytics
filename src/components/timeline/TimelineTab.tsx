'use client'
import * as React from 'react'
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { useTimeline } from '@/lib/timeline/useTimeline'
import { useSessions } from '@/lib/timeline/useSessions'
import { buildCampaignTree } from '@/lib/timeline/buildCampaignTree'
import TimelineVertical from './TimelineVertical'

// The timeline as the app's main view (embedded — the app supplies the header).
// Spine from the session list + event-file detail; lands expanded on the last
// day with data. Vertical nested-accordion presentation.
export default function TimelineTab({ teamId, boatId, tzOffset = 0, onOpenVideo }: { teamId?: string | null; boatId?: string | null; tzOffset?: number; onOpenVideo?: (date: string, clipId: string) => void }) {
  const sessions = useSessions(teamId, boatId)
  const { nodes: detail, error } = useTimeline(teamId, boatId, null)

  const tree = React.useMemo(
    () => (boatId && sessions && detail ? buildCampaignTree({ sessions, detail, boatId }) : null),
    [sessions, detail, boatId]
  )
  const lastDayId = React.useMemo(() => {
    if (!tree) return undefined
    const d = tree.filter((n) => n.kind === 'day')
    return d.length ? d.reduce((a, b) => (b.t0 > a.t0 ? b : a)).id : undefined
  }, [tree])
  const loading = sessions === null || detail === null

  return (
    <div className="h-full overflow-auto bg-bg text-fg" style={{ padding: 16 }}>
      <div className="w-full">
        <h2 className="mb-3 text-[15px] font-medium">Timeline</h2>
        {!boatId ? (
          <Card><EmptyState title="No active boat" description="Select a boat workspace to see its campaign timeline." /></Card>
        ) : error ? (
          <ErrorState description={error} />
        ) : loading ? (
          <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : !tree || tree.length === 0 ? (
          <Card><EmptyState title="No campaign entries yet" description="Sync your sessions, or upload a day's data — training days and events will appear here." /></Card>
        ) : (
          <TimelineVertical nodes={tree} initialFocusId={lastDayId} tzOffset={tzOffset} teamId={teamId} boatId={boatId} onPlayVideo={onOpenVideo} />
        )}
      </div>
    </div>
  )
}
