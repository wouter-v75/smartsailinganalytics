'use client'
import * as React from 'react'
import { AppShell } from '@/components/ui/app-shell'
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { getBrowserSupabase } from '@/lib/supabase/browser'
import { getActiveMembership, type ActiveMembership } from '@/lib/active-membership'
import { useTimeline } from '@/lib/timeline/useTimeline'
import type { TimelineNode } from '@/lib/timeline/types'
import { buildDayTimeline } from '@/lib/timeline/buildNodes'
import { getXmlData } from '@/lib/localStore'
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
  // Empty until resolved: no ?date means "focus on the last day with data".
  const [date, setDate] = React.useState<string>(() => {
    try { return new URLSearchParams(window.location.search).get('date') || '' } catch { return '' }
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

  // When no explicit date, ask the cloud for the last day that has data and land there.
  React.useEffect(() => {
    if (date || !m?.team_id || !m?.boat_id) return
    let alive = true
    fetch(`/api/teams/${m.team_id}/timeline?boat_id=${m.boat_id}&latest=1`)
      .then((r) => r.json())
      .then((j) => { if (alive) setDate(j?.latestDate || today()) })
      .catch(() => { if (alive) setDate(today()) })
    return () => { alive = false }
  }, [m?.team_id, m?.boat_id, date])

  const resolvingDate = scope === 'day' && !date // waiting on the latest-day lookup
  const { nodes: persisted, error } = useTimeline(m?.team_id, resolvingDate ? null : m?.boat_id, scope === 'season' ? null : (date || null))

  // Backfill: if nothing is stored yet for this day, build the timeline on the
  // fly from the event data cached on this device (getXmlData) and persist it —
  // so days uploaded before the producer existed still show, then stick.
  const [localNodes, setLocalNodes] = React.useState<TimelineNode[] | null | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    setLocalNodes(undefined)
    if (scope !== 'day' || !m?.boat_id || persisted === null || !date) return
    if (persisted.length > 0) { setLocalNodes(null); return }
    const boatId = m.boat_id
    ;(async () => {
      try {
        const xml: any = await getXmlData(date)
        if (!alive) return
        const hasEvents = xml && (xml.raceGuns?.length || xml.tackJibes?.length || xml.markRoundings?.length || xml.sailsUpEvents?.length || xml.dayStartUtc != null)
        if (hasEvents) {
          const built = buildDayTimeline({ xml, boatId, date })
          setLocalNodes(built)
          if (built.length && m.team_id) {
            fetch(`/api/teams/${m.team_id}/timeline`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ boat_id: boatId, session_date: date, nodes: built }),
            }).catch(() => {})
          }
        } else setLocalNodes([])
      } catch { if (alive) setLocalNodes([]) }
    })()
    return () => { alive = false }
  }, [persisted, date, scope, m?.boat_id, m?.team_id])

  const nodes: TimelineNode[] | null =
    persisted && persisted.length > 0 ? persisted : (localNodes === undefined ? null : localNodes)
  const loading =
    (resolvingDate && !!m?.boat_id) ||
    persisted === null ||
    (scope === 'day' && !!date && persisted?.length === 0 && localNodes === undefined)

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
      ) : loading ? (
        <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : !nodes || nodes.length === 0 ? (
        <Card><EmptyState
          title={scope === 'season' ? 'No timeline yet' : 'No timeline for this day'}
          description={scope === 'season'
            ? 'Open specific race days in Day scope first to build them, then switch back to Season.'
            : 'No event file found on this device for this date. Load that day in the main app first, or pick a date you have data for.'}
        /></Card>
      ) : view === 'zoom' ? (
        <TimelineZoom nodes={nodes} />
      ) : (
        <TimelineDay nodes={nodes} />
      )}
    </AppShell>
  )
}
