'use client'
import * as React from 'react'
import { ListChecks, Film, Tags, RefreshCw, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/ui'
import { useTagger } from '@/lib/tagging/useTagger'
import { detectDay, type Detection } from '@/lib/tagging/detect'
import { segmentDay, type DaySegment } from '@/lib/tagging/segments'
import { snapTag } from '@/lib/tagging/snap'
import { nextReelOrder } from '@/lib/tagging/requests'
import TagButtonBar from './TagButtonBar'
import TagTrack from './TagTrack'
import TagSheet from './TagSheet'
import ReviewQueue, { REVIEW_THRESHOLD } from './ReviewQueue'
import DebriefReel from './DebriefReel'

// The tagging tab. Built for a phone first, because that is where it gets used:
// on the boat, or standing on the dock ten minutes after it. Everything that
// matters is in the bottom half of the screen where a thumb reaches, and nothing
// needs a second hand.
//
// Three views, one segmented control:
//
//   Track    the day, grouped into pre-race / race 1 / between / race 2 / after
//   Check    the review queue — least certain detection first, two big buttons
//   Debrief  the shortlist the crew nominated, and the reel the coach built
//
// The button bar is pinned to the bottom of all three, because the crew's own
// tags are the point and they should never be more than one thumb away.

export interface TaggerTabProps {
  teamId?: string | null
  boatId?: string | null
  /** YYYY-MM-DD */
  date?: string | null
  sessionId?: string | null
  userId?: string | null
  tzOffsetMin?: number
  /** The day's log rows, for detection. */
  logRows?: any[] | null
  /** Parsed event file (src/lib/xmlEventParse.js output). */
  xml?: any
  /** Where "now" is — the video playhead when one is open, else the wall clock. */
  playheadUtc?: number | null
}

type View = 'track' | 'check' | 'debrief'

export default function TaggerTab({
  teamId, boatId, date, sessionId, userId, tzOffsetMin = 0,
  logRows, xml, playheadUtc,
}: TaggerTabProps) {
  const t = useTagger({ teamId, boatId, date, sessionId })
  const [view, setView] = React.useState<View>('track')
  const [openId, setOpenId] = React.useState<string | null>(null)

  // Detection is pure and the day's data is already here, so it runs locally.
  // The server decides what the result MEANS for the rows that exist — see the
  // sync route.
  const detections: Detection[] = React.useMemo(() => {
    if (!boatId || !date) return []
    return detectDay({ boatId, date, rows: logRows || [], xml })
  }, [boatId, date, logRows, xml])

  const segments: DaySegment[] = React.useMemo(() => {
    const rows = logRows || []
    return segmentDay({
      guns: xml?.raceGuns,
      markRoundings: xml?.markRoundings,
      dayStartUtc: xml?.dayStartUtc ?? null,
      dayStopUtc: xml?.dayStopUtc ?? null,
      dataT0: rows.length ? rows[0].utc : null,
      dataT1: rows.length ? rows[rows.length - 1].utc : null,
    })
  }, [logRows, xml])

  // Seed the vocabulary the first time a team opens the tagger, so nobody has to
  // know a seeding step exists.
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (t.loading || seeded.current) return
    if (t.defs.length === 0 && teamId) { seeded.current = true; t.seedVocabulary() }
  }, [t.loading, t.defs.length, teamId]) // eslint-disable-line react-hooks/exhaustive-deps

  const unchecked = React.useMemo(
    () => t.events.filter((e) => e.source === 'auto' && e.verifiedAt == null).length,
    [t.events]
  )
  const uncertain = React.useMemo(
    () => t.events.filter(
      (e) => e.source === 'auto' && e.verifiedAt == null && (e.confidence ?? 1) < REVIEW_THRESHOLD
    ).length,
    [t.events]
  )

  const now = React.useCallback(
    () => (playheadUtc != null && Number.isFinite(playheadUtc) ? playheadUtc : Date.now()),
    [playheadUtc]
  )

  const open = t.items.find((i) => i.tag.id === openId) || null
  const openDef = open ? t.defs.find((d) => d.slug === open.tag.slug) : null

  if (!teamId || !boatId || !date) {
    return (
      <div className="px-6 py-12 text-center text-sm text-muted">
        Pick a boat and a day to start tagging.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
      {/* ── Views ─────────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Tagging views"
        className="flex shrink-0 gap-1 border-b border-[color:var(--border)] bg-surface-1 p-2"
      >
        <ViewTab active={view === 'track'} onClick={() => setView('track')} icon={<Tags size={15} />} label="Track" count={t.events.length} />
        <ViewTab active={view === 'check'} onClick={() => setView('check')} icon={<ListChecks size={15} />} label="Check" count={unchecked} alert={uncertain > 0} />
        <ViewTab active={view === 'debrief'} onClick={() => setView('debrief')} icon={<Film size={15} />} label="Debrief" count={t.items.filter((i) => i.tag.reelOrder != null).length} />
      </div>

      {t.error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[color:var(--border)] bg-danger-bg px-3 py-2 text-xs text-danger">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{t.error}</span>
          <button onClick={t.clearError} className="shrink-0 font-semibold">Dismiss</button>
        </div>
      )}

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {t.loading ? (
          <div className="p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="mb-2 h-14 animate-pulse rounded-lg bg-surface-2" />
            ))}
          </div>
        ) : view === 'track' ? (
          <>
            {detections.length > 0 && (
              <SyncBar
                detections={detections.length}
                tagged={t.events.filter((e) => e.source === 'auto').length}
                busy={t.busy}
                onSync={() => t.sync(detections)}
              />
            )}
            <TagTrack
              items={t.items}
              segments={segments}
              currentUserId={userId}
              onOpen={setOpenId}
              tzOffsetMin={tzOffsetMin}
            />
          </>
        ) : view === 'check' ? (
          <ReviewQueue
            tags={t.events}
            tzOffsetMin={tzOffsetMin}
            onVerify={(id) => t.patch(id, { op: 'verify' })}
            onReject={(id) => t.patch(id, { op: 'reject' })}
            onOpen={(tag) => { setView('track'); setOpenId(tag.id) }}
          />
        ) : (
          <DebriefReel
            items={t.items}
            canCurate={t.can.curateReel}
            currentUserId={userId}
            tzOffsetMin={tzOffsetMin}
            onNominate={(id) => t.request(id, 'debrief')}
            onSetReel={(id, order) => t.patch(id, { op: 'reel', order })}
            onOpen={(id) => { setView('track'); setOpenId(id) }}
          />
        )}
      </div>

      {/* ── The crew's own tags, always one thumb away ─────────────────────── */}
      <TagButtonBar
        defs={t.buttonBar}
        nowUtc={now}
        onApply={(slug, at, opts) => t.apply(slug, at, opts)}
        disabled={t.loading}
      />

      {open && (
        <TagSheet
          item={open}
          def={openDef}
          currentUserId={userId}
          canApproveVideo={t.can.approveVideo}
          canCurateReel={t.can.curateReel}
          tzOffsetMin={tzOffsetMin}
          snap={
            open.tag.source === 'human'
              ? snapTag(open.tag, detections)
              : null
          }
          onClose={() => setOpenId(null)}
          onVerify={() => t.patch(open.tag.id, { op: 'verify' })}
          onReject={() => { t.patch(open.tag.id, { op: 'reject' }); setOpenId(null) }}
          onUnreject={() => t.patch(open.tag.id, { op: 'unreject' })}
          onSnap={() => {
            const r = snapTag(open.tag, detections)
            if (r.ok) t.patch(open.tag.id, { op: 'move', delta_ms: r.result.deltaMs })
          }}
          onReset={() => t.patch(open.tag.id, { op: 'reset' })}
          onDelete={() => { t.remove(open.tag.id); setOpenId(null) }}
          onNote={(note) => t.patch(open.tag.id, { op: 'note', note })}
          onLabel={(group, text, on) =>
            t.patch(open.tag.id, on ? { op: 'label-add', group, text } : { op: 'label-remove', group, text })
          }
          onRequestVideo={() => t.request(open.tag.id, 'video', { mediaKind: 'video' })}
          onNominate={() => t.request(open.tag.id, 'debrief')}
          onSetReel={(order) =>
            t.patch(open.tag.id, {
              op: 'reel',
              order: order == null ? null : nextReelOrder(t.items),
            })
          }
        />
      )}
    </div>
  )
}

function ViewTab({
  active, onClick, icon, label, count, alert,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count?: number
  alert?: boolean
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium',
        active ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-secondary'
      )}
    >
      {icon}
      <span>{label}</span>
      {count != null && count > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 text-[11px] font-bold',
            active ? 'bg-black/20' : alert ? 'bg-warning-bg text-warning' : 'bg-surface-1'
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

/** "The data found 47 things. Pull them in." One press, then the day is tagged. */
function SyncBar({
  detections, tagged, busy, onSync,
}: {
  detections: number
  tagged: number
  busy: boolean
  onSync: () => void
}) {
  const behind = detections - tagged
  if (behind <= 0) return null
  return (
    <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-accent-bg px-3 py-2">
      <span className="flex-1 text-xs text-accent">
        The data found {behind} {behind === 1 ? 'moment' : 'moments'} not tagged yet.
      </span>
      <button
        onClick={onSync}
        disabled={busy}
        className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-60"
      >
        <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} aria-hidden />
        {busy ? 'Pulling…' : 'Pull them in'}
      </button>
    </div>
  )
}
