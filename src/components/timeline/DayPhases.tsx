'use client'
import * as React from 'react'
import { Cloud, Users, Sailboat, Activity, ClipboardList, LineChart, ChevronRight, type LucideIcon } from 'lucide-react'
import { Badge, Skeleton } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import DayTimeline from './DayTimeline'
import Collapse from './Collapse'
import { useDockItem } from './DockMagnify'

// The phases of a day, shown when a day is opened: Weather · Speed-team meeting ·
// Sail call · Sailing · Debrief notes · Performance analysis. Each expands to its
// content (read-only here — edit in Campaign → Day). "Sailing" expands to the
// day's vertical time-axis (events + media with the hover cursor).

interface Phase { key: string; label: string; icon: LucideIcon; color: string }
const PHASES: Phase[] = [
  { key: 'weather', label: 'Weather', icon: Cloud, color: '#06B6D4' },
  { key: 'speedteam', label: 'Speed-team meeting', icon: Users, color: '#7F77DD' },
  { key: 'sailcall', label: 'Sail call', icon: Sailboat, color: '#F59E0B' },
  { key: 'sailing', label: 'Sailing', icon: Activity, color: '#1D9E75' },
  { key: 'debrief', label: 'Debrief notes', icon: ClipboardList, color: '#7F77DD' },
  { key: 'performance', label: 'Performance analysis', icon: LineChart, color: '#D85A30' },
]

interface Conditions { details: string | null; timings: string; plan: string; sailList: { source?: string; sails?: { name: string }[] } | null }
interface Debrief { learnings?: string; next_focus?: string; speed_learnings?: string; speed_focus_today?: string; speed_long_term?: string }

export default function DayPhases({ day, events, tz, teamId, boatId, onPlayVideo, autoOpenSailing = false }: {
  day: TimelineNode; events: TimelineNode[]; tz: number
  teamId?: string | null; boatId?: string | null
  onPlayVideo?: (videoId: string) => void
  autoOpenSailing?: boolean
}) {
  const date = (day.meta?.date as string) || day.id.split(':')[1] || ''
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(autoOpenSailing ? ['sailing'] : []))
  const [cond, setCond] = React.useState<Conditions | null>(null)
  const [deb, setDeb] = React.useState<Debrief | null>(null)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setLoaded(true); return }
    let alive = true
    const base = `/api/teams/${teamId}/boats/${boatId}/campaign`
    Promise.all([
      fetch(`${base}/conditions?date=${date}`).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`${base}/debrief?date=${date}`).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    ]).then(([c, d]: [any, any]) => {
      if (!alive) return
      setCond({ details: c?.details ?? null, timings: c?.timings || '', plan: c?.plan || '', sailList: c?.sailList ?? null })
      setDeb(d?.debrief || {})
      setLoaded(true)
    })
    return () => { alive = false }
  }, [teamId, boatId, date])

  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n })

  // Does a phase have content? (drives the filled dot + muted styling)
  const nMarkers = events.filter((e) => e.kind !== 'day').length
  const nMedia = (day.metrics?.videos || 0) + (day.metrics?.photos || 0)
  const has = (k: string): boolean => {
    switch (k) {
      case 'weather': return !!(cond?.details && String(cond.details).trim())
      case 'speedteam': return !!(deb?.speed_learnings || deb?.speed_focus_today || deb?.speed_long_term)
      case 'sailcall': return !!(cond?.sailList?.sails?.length)
      case 'sailing': return nMarkers > 0 || nMedia > 0
      case 'debrief': return !!(deb?.learnings || deb?.next_focus)
      case 'performance': return false
      default: return false
    }
  }

  return (
    <div className="grid gap-1 py-1">
      {PHASES.map((ph) => (
        <PhaseRow
          key={ph.key} ph={ph} isOpen={open.has(ph.key)} filled={has(ph.key)} onToggle={() => toggle(ph.key)}
          day={day} events={events} tz={tz} teamId={teamId} boatId={boatId} onPlayVideo={onPlayVideo}
          loaded={loaded} cond={cond} deb={deb} nMarkers={nMarkers} nMedia={nMedia}
        />
      ))}
    </div>
  )
}

function PhaseRow({ ph, isOpen, filled, onToggle, day, events, tz, teamId, boatId, onPlayVideo, loaded, cond, deb, nMarkers, nMedia }: {
  ph: Phase; isOpen: boolean; filled: boolean; onToggle: () => void
  day: TimelineNode; events: TimelineNode[]; tz: number; teamId?: string | null; boatId?: string | null
  onPlayVideo?: (videoId: string) => void
  loaded: boolean; cond: Conditions | null; deb: Debrief | null; nMarkers: number; nMedia: number
}) {
  const Icon = ph.icon
  const dockRef = useDockItem()
  return (
    <div>
      <button
        ref={dockRef}
        onClick={onToggle}
        aria-expanded={isOpen}
        className={[
          'tl-dock-item group flex w-[300px] max-w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm hover:shadow-md',
          isOpen ? 'border-[color:var(--border-strong)] bg-surface-2' : 'border-[color:var(--border)] bg-surface-1 hover:bg-surface-2',
        ].join(' ')}
        style={{ borderLeft: `3px solid ${filled || isOpen ? ph.color : 'var(--border)'}` }}
      >
        <Icon size={14} style={{ color: filled || isOpen ? ph.color : 'var(--text-muted)' }} aria-hidden />
        <span className={filled || isOpen ? 'font-medium' : 'text-muted'}>{ph.label}</span>
        {ph.key === 'sailing' && (nMarkers > 0 || nMedia > 0) && (
          <span className="ml-1 flex gap-1">
            {(day.metrics?.videos || 0) > 0 && <Badge tone="accent">{day.metrics!.videos} vid</Badge>}
            {(day.metrics?.photos || 0) > 0 && <Badge tone="warning">{day.metrics!.photos} ph</Badge>}
          </span>
        )}
        {ph.key !== 'sailing' && filled && <span className="h-1.5 w-1.5 rounded-full" style={{ background: ph.color }} aria-hidden />}
        <ChevronRight size={14} className={`ml-auto shrink-0 text-muted transition-transform duration-[300ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`} aria-hidden />
      </button>

      <Collapse open={isOpen}>
        <div className="ml-0.5 mt-1 border-l border-[color:var(--border)] pl-1.5 sm:ml-[10px] sm:pl-3">
          {ph.key === 'sailing' ? (
            <DayTimeline day={day} events={events} tz={tz} teamId={teamId} boatId={boatId} onPlayVideo={onPlayVideo} />
          ) : !loaded ? (
            <Skeleton className="h-10 w-full max-w-md rounded" />
          ) : (
            <PhaseContent phaseKey={ph.key} cond={cond} deb={deb} />
          )}
        </div>
      </Collapse>
    </div>
  )
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value || !String(value).trim()) return null
  return (
    <div className="mb-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="whitespace-pre-wrap text-sm text-fg">{value}</div>
    </div>
  )
}

function Empty({ what }: { what: string }) {
  return <div className="py-1 text-xs text-muted">No {what} yet — add it in Campaign → Day.</div>
}

function PhaseContent({ phaseKey, cond, deb }: { phaseKey: string; cond: Conditions | null; deb: Debrief | null }) {
  const box = 'max-w-xl rounded-lg border border-[color:var(--border)] bg-surface-1 p-3'
  switch (phaseKey) {
    case 'weather':
      return <div className={box}>{cond?.details ? <Field label="Conditions" value={String(cond.details)} /> : <Empty what="weather notes" />}</div>
    case 'speedteam':
      return (
        <div className={box}>
          {(deb?.speed_learnings || deb?.speed_focus_today || deb?.speed_long_term) ? (
            <>
              <Field label="Learnings" value={deb?.speed_learnings} />
              <Field label="Focus for today" value={deb?.speed_focus_today} />
              <Field label="Long-term development" value={deb?.speed_long_term} />
            </>
          ) : <Empty what="speed-team notes" />}
        </div>
      )
    case 'sailcall':
      return (
        <div className={box}>
          {cond?.sailList?.sails?.length ? (
            <>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Sail list{cond.sailList.source ? ` · ${cond.sailList.source}` : ''}</div>
              <div className="flex flex-wrap gap-1.5">{cond.sailList.sails.map((s, i) => <Badge key={i}>{s.name}</Badge>)}</div>
            </>
          ) : <Empty what="sail call" />}
        </div>
      )
    case 'debrief':
      return (
        <div className={box}>
          {(deb?.learnings || deb?.next_focus) ? (
            <>
              <Field label="Learnings" value={deb?.learnings} />
              <Field label="Next focus points" value={deb?.next_focus} />
            </>
          ) : <Empty what="debrief notes" />}
        </div>
      )
    case 'performance':
      return <div className={box}><div className="text-xs text-muted">Open the Analytics tab for this day to review speed vs. targets, tracks and manoeuvre stats.</div></div>
    default:
      return null
  }
}
