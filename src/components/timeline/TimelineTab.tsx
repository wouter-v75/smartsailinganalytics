'use client'
import * as React from 'react'
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { useTimeline } from '@/lib/timeline/useTimeline'
import { useSessions } from '@/lib/timeline/useSessions'
import { buildCampaignTree } from '@/lib/timeline/buildCampaignTree'
import TimelineDay from './TimelineDay'
import TimelineZoom from './TimelineZoom'

// The timeline as the app's main view (embedded — no AppShell, the app supplies
// the header). Spine from the session list + event-file detail; lands on the
// last day with data.
export default function TimelineTab({ teamId, boatId, tzOffset = 0 }: { teamId?: string | null; boatId?: string | null; tzOffset?: number }) {
  const [view, setView] = React.useState<'zoom' | 'feed'>('zoom')
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
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[15px] font-medium">Timeline</h2>
          <div className="ml-auto flex overflow-hidden rounded border border-[color:var(--border)]">
            {(['zoom', 'feed'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-2.5 py-1.5 text-xs capitalize ${view === v ? 'bg-accent text-accent-fg' : 'text-secondary hover:bg-surface-1'}`}>{v}</button>
            ))}
          </div>
        </div>
        {!boatId ? (
          <Card><EmptyState title="No active boat" description="Select a boat workspace to see its campaign timeline." /></Card>
        ) : error ? (
          <ErrorState description={error} />
        ) : loading ? (
          <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : !tree || tree.length === 0 ? (
          <Card><EmptyState title="No campaign entries yet" description="Sync your sessions, or upload a day's data — training days and events will appear here." /></Card>
        ) : view === 'zoom' ? (
          <TimelineZoom nodes={tree} initialFocusId={lastDayId} tzOffset={tzOffset} />
        ) : (
          <TimelineDay nodes={tree} tzOffset={tzOffset} />
        )}
      </div>
    </div>
  )
}
