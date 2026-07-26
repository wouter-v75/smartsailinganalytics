'use client'
import * as React from 'react'
import { Clock, Cloud, Users, Sailboat, Map, Activity, ClipboardList, LineChart, ChevronRight, type LucideIcon } from 'lucide-react'
import { Badge, Skeleton } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import DayTimeline from './DayTimeline'
import Collapse from './Collapse'
import { useDockItem } from './DockMagnify'
import { DocThumb } from './RegattaDocs'
import { RichText } from '@/components/RichText'

// The phases of a day, shown when a day is opened: Timings · Weather · Speed-team
// meeting · Sail call · Sailing · Debrief notes · Performance analysis. Each expands
// to its content (read-only here — edit in Campaign → Day). "Sailing" expands to the
// day's vertical time-axis (events + media with the hover cursor).

interface Phase { key: string; label: string; icon: LucideIcon; color: string }
const PHASES: Phase[] = [
  // Timings sits FIRST — it's the day's schedule (dock out, warning signal, first
  // start), so it's what you want before the weather when opening a day. Same
  // campaign/conditions record the weather comes from; edited in Campaign → Day.
  { key: 'timings', label: 'Timings', icon: Clock, color: '#EF4444' },
  { key: 'weather', label: 'Weather', icon: Cloud, color: '#06B6D4' },
  { key: 'speedteam', label: 'Speed-team meeting', icon: Users, color: '#7F77DD' },
  // Goals & planning sits above the sail call: what we set out to do, read before
  // the sail is chosen. Same conditions record as Timings/Weather.
  { key: 'plan', label: 'Goals & planning', icon: Map, color: '#2DD4BF' },
  { key: 'sailcall', label: 'Sail call', icon: Sailboat, color: '#F59E0B' },
  { key: 'sailing', label: 'Sailing', icon: Activity, color: '#1D9E75' },
  { key: 'debrief', label: 'Debrief notes', icon: ClipboardList, color: '#7F77DD' },
  { key: 'performance', label: 'Performance analysis', icon: LineChart, color: '#D85A30' },
]

// `details` is the session's conditions.details_today — an OBJECT ({comments, rows}),
// not a string. It was typed as `string | null` and rendered with String(), which would
// have printed "[object Object]" and made the has-content check always true.
interface WeatherDetails { comments?: string | null; rows?: unknown[] | null }
interface Conditions { details: WeatherDetails | null; timings: string; plan: string; sailList: { source?: string; sails?: { name: string }[] } | null }
interface DebriefDoc { key?: string; name?: string; url?: string | null; thumb_url?: string | null; content_type?: string | null; scope?: string | null }
interface Debrief { learnings?: string; next_focus?: string; speed_learnings?: string; speed_focus_today?: string; speed_long_term?: string; documents?: DebriefDoc[] }

// Pictures attached to the speed-team meeting in Campaign → Day. Same store as the
// meeting's documents, told apart by content type (older rows predate content_type,
// hence the filename fallback).
const isPicture = (d: DebriefDoc): boolean =>
  /^image\//.test(String(d?.content_type || '')) ||
  /\.(png|jpe?g|gif|webp|heic|heif|avif)$/i.test(String(d?.name || ''))
const speedScoped = (deb: Debrief | null): DebriefDoc[] =>
  (deb?.documents || []).filter((d) => (d.scope || 'debrief') === 'speed' && d.url)
const speedPictures = (deb: Debrief | null): DebriefDoc[] => speedScoped(deb).filter(isPicture)
// Everything that isn't a picture — PDFs, decks, spreadsheets attached to the meeting.
const speedDocs = (deb: Debrief | null): DebriefDoc[] => speedScoped(deb).filter((d) => !isPicture(d))

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
  // Forecast decks uploaded to the day's Weather card. These live in the session
  // ATTACHMENTS store (kind=weather) — a different place from the speed-team meeting's
  // documents, which hang off the debrief record. Hence the third fetch.
  const [wxDocs, setWxDocs] = React.useState<DebriefDoc[]>([])
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setLoaded(true); return }
    let alive = true
    const base = `/api/teams/${teamId}/boats/${boatId}/campaign`
    Promise.all([
      fetch(`${base}/conditions?date=${date}`).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`${base}/debrief?date=${date}`).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`${base}/attachments?date=${date}&kind=weather`).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    ]).then(([c, d, w]: [any, any, any]) => {
      if (!alive) return
      setCond({ details: c?.details ?? null, timings: c?.timings || '', plan: c?.plan || '', sailList: c?.sailList ?? null })
      setDeb(d?.debrief || {})
      setWxDocs(((w?.attachments || []) as DebriefDoc[]).filter((x) => x.url))
      setLoaded(true)
    })
    return () => { alive = false }
  }, [teamId, boatId, date])

  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n })

  // Does a phase have content? (drives the filled dot + muted styling)
  const nMarkers = events.filter((e) => e.kind !== 'day').length
  const nMedia = (day.metrics?.videos || 0) + (day.metrics?.photos || 0) + (day.metrics?.scans || 0)
  const has = (k: string): boolean => {
    switch (k) {
      case 'timings': return !!(cond?.timings && String(cond.timings).trim())
      case 'weather': return !!((cond?.details?.comments && String(cond.details.comments).trim()) || wxDocs.length)
      case 'speedteam': return !!(deb?.speed_learnings || deb?.speed_focus_today || deb?.speed_long_term || speedPictures(deb).length || speedDocs(deb).length)
      case 'sailcall': return !!(cond?.sailList?.sails?.length)
      case 'plan': return !!(cond?.plan && String(cond.plan).trim())
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
          loaded={loaded} cond={cond} deb={deb} wxDocs={wxDocs} nMarkers={nMarkers} nMedia={nMedia}
        />
      ))}
    </div>
  )
}

function PhaseRow({ ph, isOpen, filled, onToggle, day, events, tz, teamId, boatId, onPlayVideo, loaded, cond, deb, wxDocs, nMarkers, nMedia }: {
  ph: Phase; isOpen: boolean; filled: boolean; onToggle: () => void
  day: TimelineNode; events: TimelineNode[]; tz: number; teamId?: string | null; boatId?: string | null
  onPlayVideo?: (videoId: string) => void
  loaded: boolean; cond: Conditions | null; deb: Debrief | null; wxDocs: DebriefDoc[]; nMarkers: number; nMedia: number
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
            {(day.metrics?.scans || 0) > 0 && <Badge style={{ background: 'rgba(167,139,250,0.15)', color: '#A78BFA' }}>{day.metrics!.scans} sc</Badge>}
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
            <PhaseContent phaseKey={ph.key} cond={cond} deb={deb} wxDocs={wxDocs} />
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
      <RichText text={value} className="text-sm text-fg" />
    </div>
  )
}

function Empty({ what }: { what: string }) {
  return <div className="py-1 text-xs text-muted">No {what} yet — add it in Campaign → Day.</div>
}

// Speed-team meeting pictures (whiteboard shots, screenshots) — thumbnails that open
// full-size. Read-only, like the rest of the day phases: upload lives in Campaign.
function SpeedPictures({ pics }: { pics: DebriefDoc[] }) {
  const [open, setOpen] = React.useState<DebriefDoc | null>(null)
  return (
    <>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted">Pictures</div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {pics.map((d, i) => (
          <button
            key={d.key || i}
            onClick={() => setOpen(d)}
            title={`Open ${d.name || 'picture'}`}
            className="h-[70px] w-[94px] overflow-hidden rounded-md border border-[color:var(--border)] bg-surface-2 transition-transform duration-150 hover:z-10 hover:scale-[1.06] hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            style={{ cursor: 'zoom-in' }}
          >
            <img src={(d.thumb_url || d.url) as string} alt={d.name || ''} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
      {open && (
        <div
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-6"
          style={{ background: 'rgba(3,15,26,0.82)' }}
        >
          <button
            onClick={() => setOpen(null)}
            aria-label="Close"
            className="absolute right-4 top-3.5 h-8 w-9 rounded-md border border-[color:var(--border)] text-fg"
            style={{ background: 'var(--surface-1)' }}
          >
            ✕
          </button>
          <img
            src={open.url as string}
            alt={open.name || ''}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
          <div className="absolute inset-x-0 bottom-3.5 text-center text-xs text-muted">{open.name}</div>
        </div>
      )}
    </>
  )
}

function PhaseContent({ phaseKey, cond, deb, wxDocs = [] }: { phaseKey: string; cond: Conditions | null; deb: Debrief | null; wxDocs?: DebriefDoc[] }) {
  const box = 'max-w-xl rounded-lg border border-[color:var(--border)] bg-surface-1 p-3'
  switch (phaseKey) {
    case 'timings':
      return <div className={box}>{cond?.timings && String(cond.timings).trim() ? <Field label="Timings" value={String(cond.timings)} /> : <Empty what="timings" />}</div>
    case 'weather': {
      const notes = cond?.details?.comments
      const hasNotes = !!(notes && String(notes).trim())
      return (
        <div className={box}>
          {hasNotes && <Field label="Notes" value={String(notes)} />}
          {!hasNotes && wxDocs.length === 0 && <Empty what="weather notes" />}
          {wxDocs.length > 0 && (
            <>
              <div className={hasNotes ? 'mt-2 text-[11px] font-medium uppercase tracking-wide text-muted' : 'text-[11px] font-medium uppercase tracking-wide text-muted'}>Forecast</div>
              <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
                {wxDocs.map((d, i) => (
                  <DocThumb key={d.key || i} doc={{ name: d.name || 'forecast', url: d.url, content_type: d.content_type }} />
                ))}
              </div>
            </>
          )}
        </div>
      )
    }
    case 'speedteam': {
      const pics = speedPictures(deb)
      const docs = speedDocs(deb)
      const hasText = !!(deb?.speed_learnings || deb?.speed_focus_today || deb?.speed_long_term)
      const empty = !hasText && pics.length === 0 && docs.length === 0
      return (
        <div className={box}>
          {hasText && (
            <>
              <Field label="Notes" value={deb?.speed_learnings || deb?.speed_focus_today || deb?.speed_long_term} />
            </>
          )}
          {empty && <Empty what="speed-team notes" />}
          {pics.length > 0 && <SpeedPictures pics={pics} />}
          {docs.length > 0 && (
            <>
              <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-muted">Documents</div>
              <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
                {docs.map((d, i) => (
                  <DocThumb key={d.key || i} doc={{ name: d.name || 'document', url: d.url, content_type: d.content_type }} />
                ))}
              </div>
            </>
          )}
        </div>
      )
    }
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
    case 'plan':
      return <div className={box}>{cond?.plan && String(cond.plan).trim() ? <Field label="Plan" value={String(cond.plan)} /> : <Empty what="plan" />}</div>
    case 'debrief':
      return (
        <div className={box}>
          {(deb?.learnings || deb?.next_focus) ? (
            <>
              <Field label="Notes" value={deb?.learnings || deb?.next_focus} />
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
