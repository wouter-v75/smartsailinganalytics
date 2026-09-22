'use client'
import * as React from 'react'
import { ListChecks, Film, Tags, Map, RefreshCw, AlertCircle, Sailboat, Plus } from 'lucide-react'
import { cn } from '@/lib/ui'
import { useTagger } from '@/lib/tagging/useTagger'
import { detectDay, type Detection } from '@/lib/tagging/detect'
import { segmentDay, segmentAt, type DaySegment } from '@/lib/tagging/segments'
import { snapTag } from '@/lib/tagging/snap'
import { nextReelOrder, GRAB_VIDEO_SLUG, grabMediaKind } from '@/lib/tagging/requests'
import { findDuplicates, acceptedWith } from '@/lib/tagging/duplicates'
import { hasStatedDeck, sailStateAt, weightAboard, SAIL_CHANGE_SLUG } from '@/lib/tagging/sailState'
import {
  linkDay, missingFromInventory, sailsToCreate, suggestLink, withAlias,
  type LinkableSail,
} from '@/lib/tagging/sailLink'
import { sailDetail, sailSheetDetail, useSailContext } from './sailChangeDetail.helpers'
import { useDayMedia } from './useDayMedia'
import TagButtonBar from './TagButtonBar'
import TagTrack from './TagTrack'
import TagSheet from './TagSheet'
import TrackView from './TrackView'
import DayPicker from './DayPicker'
import ReviewQueue, { REVIEW_THRESHOLD } from './ReviewQueue'
import DuplicateList from './DuplicateList'
import DebriefReel from './DebriefReel'

// The tagging tab. Built for a phone first, because that is where it gets used:
// on the boat, or standing on the dock ten minutes after it. Everything that
// matters is in the bottom half of the screen where a thumb reaches, and nothing
// needs a second hand.
//
// Four views, one segmented control:
//
//   Tagger   the day as a list, grouped into pre-race / race 1 / between / after
//   Track    the same day as a shape, for pointing at a moment you can see but
//            could not name a time for
//   Check    the review queue — least certain detection first, two big buttons
//   Debrief  the shortlist the crew nominated, and the reel the coach built
//
// Tagger and Track are two views of one thing, and which one is better depends
// on the question: a list is a clock and reads top to bottom; a track is a
// course and answers "the bad tack at the left-hand corner of the second beat".
//
// The button bar is pinned to the bottom of all four, because the crew's own
// tags are the point and they should never be more than one thumb away. What
// differs is what "now" means to it — see `now` below.

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
  /** Days the app knows about, so a previous session can be tagged. */
  sessions?: { date: string; hasLog?: boolean; hasXml?: boolean; event?: string | null }[] | null
  /** Load another day. The tagger changes the app's active day, as Analytics does. */
  onSelectDate?: (date: string) => void | Promise<unknown>
  /** Jump to Campaign → Day, where the day's sail list is edited. */
  onEditSailList?: () => void
}

type View = 'tagger' | 'track' | 'check' | 'debrief'

export default function TaggerTab({
  teamId, boatId, date, sessionId, userId, tzOffsetMin = 0,
  logRows, xml, playheadUtc, sessions, onSelectDate, onEditSailList,
}: TaggerTabProps) {
  const t = useTagger({ teamId, boatId, date, sessionId, userId })
  const [view, setView] = React.useState<View>('tagger')
  const [openId, setOpenId] = React.useState<string | null>(null)
  // A moment picked by holding the track. While one is held the button bar tags
  // THERE rather than now — which is the entire point of the track view.
  const [pickedUtc, setPickedUtc] = React.useState<number | null>(null)

  // The pick belongs to the track. Carrying it into the list view would leave
  // the bar quietly tagging 12:18 with the only thing that said so two screens
  // back — the kind of hidden mode that puts a tag somewhere nobody meant.
  React.useEffect(() => { if (view !== 'track') setPickedUtc(null) }, [view])

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
  // The same moment tagged twice — once by the crew, once by the file that
  // arrived afterwards. Neither is wrong, so nothing is thrown away without
  // somebody saying so; see lib/tagging/duplicates.ts.
  const duplicates = React.useMemo(() => findDuplicates(t.events), [t.events])

  const uncertain = React.useMemo(
    () => t.events.filter(
      (e) => e.source === 'auto' && e.verifiedAt == null && (e.confidence ?? 1) < REVIEW_THRESHOLD
    ).length,
    [t.events]
  )

  // Sails, today's list and the boat's batten card — everything the sail-change
  // composer needs. One fetch per boat/day, not one per press.
  const sailCtx = useSailContext(teamId, boatId, date)

  // What was filmed and photographed, drawn on the track in the timeline's own
  // deck colours. Context rather than content: it answers "was that gybe
  // filmed" without leaving the tagger.
  const dayMedia = useDayMedia(teamId, boatId, date, tzOffsetMin)

  // The day's tags with every sail resolved to its inventory row. A DERIVED
  // view — nothing is written back — because the identity problem is felt in
  // the fold, the composer and the weight, not in the stored rows. Without it
  // the event file's "Main" and the inventory's "Main" are two different sails
  // that happen to share a spelling.
  const events = React.useMemo(
    () => linkDay(t.events, sailCtx.inventory),
    [t.events, sailCtx.inventory]
  )

  // Sails the event file names that the boat's inventory has never heard of.
  // Not created automatically: a file with a stray space in it would mint a
  // second "J2 " nobody asked for, and an inventory is a thing crews curate.
  const unknownSails = React.useMemo(
    () => (sailCtx.inventory.length ? missingFromInventory(t.events, sailCtx.inventory) : []),
    [t.events, sailCtx.inventory]
  )
  // Which name is being dealt with, so only its own row goes quiet.
  const [sailBusy, setSailBusy] = React.useState<string | null>(null)
  const [sailError, setSailError] = React.useState<string | null>(null)

  const runSailFix = async (name: string, go: () => Promise<Response>) => {
    if (!teamId || !boatId || sailBusy) return
    setSailBusy(name)
    setSailError(null)
    try {
      const r = await go()
      if (!r.ok) {
        // RLS refuses this below TL3, and a button that fails silently is worse
        // than one that is not there: the name stays in the bar and nobody
        // knows why.
        const j = await r.json().catch(() => null)
        setSailError(j?.error || 'Could not save — the inventory is edited by team leads.')
        return
      }
      await sailCtx.reload()
    } catch {
      setSailError('Could not reach the server.')
    } finally {
      setSailBusy(null)
    }
  }

  /** Add the name as a sail the boat has never had. */
  const addSail = (name: string) => runSailFix(name, () =>
    fetch(`/api/teams/${teamId}/sails/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boat_id: boatId,
        sails: sailsToCreate([name]),
        // NOT a reconcile: this adds what is missing. The importer's default
        // is to treat its payload as the WHOLE inventory and retire anything
        // absent from it, which here would retire the boat's entire sail
        // locker on the way to adding one storm jib.
        reconcile: false,
      }),
    })
  )

  /** Say the name is another spelling of a sail the boat already has. Stored on
   *  that sail, so every later file spelling it the same way resolves too. */
  const linkSail = (name: string, sailId: string) => {
    const sail = sailCtx.inventory.find((s) => s.id === sailId)
    if (!sail) return
    const aliases = withAlias(sail, name)
    if (!aliases) { sailCtx.reload(); return }
    return runSailFix(name, () =>
      fetch(`/api/teams/${teamId}/sails`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // specs MERGES server-side, so this replaces the alias list and leaves
        // the weight, the design shapes and everything else alone.
        body: JSON.stringify({ id: sailId, specs: { aliases } }),
      })
    )
  }

  // Nobody has said what is ON the boat today, so every weight-aboard figure
  // downstream is a floor rather than a number. Asked once, at the top, rather
  // than left to be discovered at the debrief.
  const deckUnknown = React.useMemo(
    () => !t.loading && !hasStatedDeck(events),
    [t.loading, events]
  )
  // What is aboard now, for the line that says so.
  const deck = React.useMemo(() => sailStateAt(events, Date.now()), [events])
  const [composeReq, setComposeReq] = React.useState<{ slug: string; at: number } | null>(null)

  // Where the day's data actually runs. The composer clamps its nudges to it,
  // so −10m pressed twice cannot put a tag before the boat left the dock.
  const bounds = React.useMemo(() => {
    const rows = logRows || []
    if (!rows.length) return undefined
    return { min: rows[0]?.utc ?? null, max: rows[rows.length - 1]?.utc ?? null }
  }, [logRows])

  // What a press means, most specific first: a moment held on the track, then
  // the video playhead, then the wall clock. Tagging the track and having the
  // tag land at "now" would make the whole view decorative.
  const now = React.useCallback(
    () => {
      if (pickedUtc != null && Number.isFinite(pickedUtc)) return pickedUtc
      if (playheadUtc != null && Number.isFinite(playheadUtc)) return playheadUtc
      return Date.now()
    },
    [pickedUtc, playheadUtc]
  )

  // "Race 2" under the composer's clock, so a corrected time can be seen to
  // have moved out of the race it was meant for.
  const contextAt = React.useCallback(
    (utc: number) => (segments.length ? segmentAt(segments, utc)?.label ?? null : null),
    [segments]
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
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
      {/* ── Which day ─────────────────────────────────────────────────────── */}
      {/* Above the view tabs, because it scopes all four of them: the day is the
          first thing to be sure of and the last thing anyone should have to
          guess at. */}
      {onSelectDate && (
        <DayPicker
          date={date}
          sessions={sessions}
          onSelect={onSelectDate}
          disabled={t.busy}
        />
      )}

      {/* ── Views ─────────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Tagging views"
        className="flex shrink-0 gap-1 border-b border-[color:var(--border)] bg-surface-1 p-2"
      >
        <ViewTab active={view === 'tagger'} onClick={() => setView('tagger')} icon={<Tags size={15} />} label="Tagger" count={t.events.length} />
        <ViewTab active={view === 'track'} onClick={() => setView('track')} icon={<Map size={15} />} label="Track" />
        <ViewTab
          active={view === 'check'} onClick={() => setView('check')}
          icon={<ListChecks size={15} />} label="Check"
          count={unchecked + duplicates.length}
          alert={uncertain > 0 || duplicates.length > 0}
        />
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
        ) : view === 'tagger' ? (
          <>
            {detections.length > 0 && (
              <SyncBar
                detections={detections.length}
                tagged={t.events.filter((e) => e.source === 'auto').length}
                busy={t.busy}
                onSync={() => t.sync(detections)}
              />
            )}
            <UnknownSails
              names={unknownSails}
              inventory={sailCtx.inventory}
              busy={sailBusy}
              error={sailError}
              onAdd={addSail}
              onLink={linkSail}
            />
            <DeckBar
              unknown={deckUnknown}
              deck={deck}
              weightOf={(s) => (s.id ? sailCtx.weights[s.id] ?? null : null)}
              onSet={() => setComposeReq({
                // The day's own start, so the deck is recorded from the moment
                // the boat left rather than from whenever somebody noticed.
                slug: SAIL_CHANGE_SLUG,
                at: xml?.dayStartUtc ?? bounds?.min ?? Date.now(),
              })}
            />
            <TagTrack
              items={t.items}
              segments={segments}
              currentUserId={userId}
              onOpen={setOpenId}
              tzOffsetMin={tzOffsetMin}
            />
          </>
        ) : view === 'track' ? (
          <TrackView
            rows={logRows || []}
            items={t.items}
            segments={segments}
            selectedUtc={pickedUtc}
            onSelect={setPickedUtc}
            onOpenTag={setOpenId}
            canEditTag={t.canEdit}
            // A drop is an absolute instant; the API moves tags by a DELTA, so
            // the whole window travels with the tag — a range tag dragged by
            // its head keeps its length instead of being silently truncated.
            onMoveTag={(id, utc) => {
              const tag = t.events.find((e) => e.id === id)
              if (!tag) return
              t.patch(id, { op: 'move', delta_ms: utc - tag.t0 })
            }}
            media={dayMedia}
            tzOffsetMin={tzOffsetMin}
          />
        ) : view === 'check' ? (
          <>
            {/* Above the queue: the queue asks whether a detection is real,
                this asks which of two real ones to keep. The second question is
                the more urgent — left alone it doubles a count that a debrief
                will be argued over. */}
            <DuplicateList
              pairs={duplicates}
              tzOffsetMin={tzOffsetMin}
              meId={userId}
              nameOf={t.nameOf}
              canEdit={t.canEdit}
              onOpen={setOpenId}
              // Getting rid of one side. A DETECTION is tombstoned rather than
              // deleted, or the next sync recreates it and the same pair is
              // back tomorrow; a hand-placed tag has no detection behind it, so
              // it simply goes.
              onDrop={(p, drop) =>
                drop.source === 'human'
                  ? t.remove(drop.id)
                  : t.patch(drop.id, { op: 'reject', reason: 'duplicate of a tag the crew placed' })
              }
              // Both real. Recorded on the pair, so it stops being offered — a
              // list with no way out grows a residue nobody can clear. Written
              // to whichever side this user may actually edit.
              onKeepBoth={(p) => {
                const carrier = t.canEdit(p.a) ? p.a : p.b
                const other = carrier === p.a ? p.b : p.a
                return t.patch(carrier.id, {
                  op: 'recompose',
                  meta: { dupOkWith: acceptedWith(carrier, other.id) },
                })
              }}
            />
            <ReviewQueue
            tags={t.events}
            tzOffsetMin={tzOffsetMin}
            onVerify={(id) => t.patch(id, { op: 'verify' })}
            onReject={(id) => t.patch(id, { op: 'reject' })}
            keysPaused={!!open}
            // Opens the sheet OVER the queue rather than jumping to the list.
            // The sheet is pinned to the tagger pane, so it covers whichever
            // view is behind it, and its close button puts the coach back on
            // the same card in the same queue. Switching views to open a tag
            // meant that closing it stranded them in the list, halfway through
            // a run of checks, with no way back to where they were.
            onOpen={(tag) => setOpenId(tag.id)}
            />
          </>
        ) : (
          <DebriefReel
            items={t.items}
            canCurate={t.can.curateReel}
            currentUserId={userId}
            tzOffsetMin={tzOffsetMin}
            onNominate={(id) => t.request(id, 'debrief')}
            onSetReel={(id, order) => t.patch(id, { op: 'reel', order })}
            // Over the reel, not away from it — same reason as the queue. A
            // coach halfway down a shortlist who opens a tag to look at it
            // should get back to the same row, not to the top of the list view.
            onOpen={setOpenId}
          />
        )}
      </div>

      {/* ── The crew's own tags, always one thumb away ─────────────────────── */}
      <TagButtonBar
        defs={t.buttonBar}
        allDefs={t.defs}
        nowUtc={now}
        tzOffsetMin={tzOffsetMin}
        bounds={bounds}
        contextAt={contextAt}
        compose={composeReq}
        onComposeTaken={() => setComposeReq(null)}
        detailFor={(def) =>
          sailDetail({
            def,
            // The LINKED day, as the deck line and the weight use — otherwise
            // the composer folds over an event file's bare names while
            // everything around it folds over inventory rows, and the two
            // disagree about what is aboard.
            events,
            ctx: sailCtx,
            logRows,
            tzOffsetMin,
            onEditSailList,
            // Opened from the deck prompt: it is asking what is ABOARD, and
            // landing on the sails-up tab makes it look like it asked something
            // else.
            startPane: composeReq ? 'onboard' : undefined,
          })
        }
        onApply={async (slug, at, opts) => {
          const made = await t.apply(slug, at, opts)
          // "Grab video" is one intention — mark this, and get me the footage —
          // so the request goes up with the tag rather than waiting for somebody
          // to remember to open it and ask. It is a normal video request from
          // there on: same queue, same approver.
          if (made && slug === GRAB_VIDEO_SLUG) {
            await t.request(made.id, 'video', { mediaKind: grabMediaKind(made.labels) })
          }
          // Tagging a held point and leaving it held invites a second tag landing
          // on the first by accident. One press, one moment.
          if (made) setPickedUtc(null)
          return made
        }}
        disabled={t.loading}
      />

      {open && (
        <TagSheet
          item={open}
          def={openDef}
          currentUserId={userId}
          // The team whose workspace this is — who the viewer comments AS.
          viewerTeamId={teamId}
          canApproveVideo={t.can.approveVideo}
          canCurateReel={t.can.curateReel}
          tzOffsetMin={tzOffsetMin}
          snap={
            open.tag.source === 'human'
              ? snapTag(open.tag, detections)
              : null
          }
          // Opening a sail change from the track has to show the deck it was
          // chosen from — otherwise the only way to correct one is to delete it
          // and start again, which loses its requests and its place on the reel.
          detail={sailSheetDetail({
            tag: open.tag,
            events,
            ctx: sailCtx,
            logRows,
            tzOffsetMin,
            onEditSailList,
          })}
          canEditDetail={t.canEdit(open.tag)}
          onRecompose={(patch) => t.patch(open.tag.id, { op: 'recompose', ...patch })}
          onClose={() => setOpenId(null)}
          onVerify={() => t.patch(open.tag.id, { op: 'verify' })}
          onReject={() => { t.patch(open.tag.id, { op: 'reject' }); setOpenId(null) }}
          onUnreject={() => t.patch(open.tag.id, { op: 'unreject' })}
          // Only a HAND-PLACED tag can be snapped. Snapping a detection would
          // move it onto itself, which is why the sheet must not offer it.
          onSnap={
            open.tag.source === 'human'
              ? () => {
                  const r = snapTag(open.tag, detections)
                  if (r.ok) t.patch(open.tag.id, { op: 'move', delta_ms: r.result.deltaMs })
                }
              : undefined
          }
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

/**
 * Sails an event file names that the inventory has never heard of.
 *
 * An unlinked sail is a sail with no weight, no batten card and no scans — so
 * it silently drops out of the weight aboard and cannot be the main whose
 * battens the composer offers.
 *
 * TWO answers, because "add it" is usually the wrong one. "J4_A 2026" is not a
 * new sail; it is J4_A_2026 with a space where an underscore should be. Adding
 * it leaves the boat with two J4_As, the one the file now points at having none
 * of the things that made the first one worth keeping. So the near-match is
 * offered first and by name, and every other sail is one pick away.
 *
 * Named rather than counted: "3 sails missing" is a number somebody dismisses,
 * and "Storm jib" is a sail they recognise. One row each, because each is its
 * own decision — a single button for all of them is how the wrong one gets made
 * three times.
 */
export function UnknownSails({
  names, inventory, busy, error, onAdd, onLink,
}: {
  names: string[]
  inventory: LinkableSail[]
  /** The name currently being saved, if any. */
  busy: string | null
  error: string | null
  onAdd: (name: string) => void
  onLink: (name: string, sailId: string) => void
}) {
  if (!names.length) return null
  return (
    <div className="border-b border-[color:var(--border)] bg-warning-bg px-3 py-2">
      <p className="flex items-start gap-2 text-xs text-warning">
        <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold">
            {names.length === 1 ? 'A sail' : `${names.length} sails`} in the event file
          </span>{' '}
          {names.length === 1 ? 'is' : 'are'} not in the boat’s inventory. Link each
          one to the sail it means, or add it as a new sail.
        </span>
      </p>

      {names.map((name) => (
        <UnknownSailRow
          key={name}
          name={name}
          inventory={inventory}
          busy={busy === name}
          disabled={busy != null && busy !== name}
          onAdd={() => onAdd(name)}
          onLink={(id) => onLink(name, id)}
        />
      ))}

      {error && <p className="mt-2 text-[11px] font-medium text-danger">{error}</p>}
    </div>
  )
}

function UnknownSailRow({
  name, inventory, busy, disabled, onAdd, onLink,
}: {
  name: string
  inventory: LinkableSail[]
  busy: boolean
  disabled: boolean
  onAdd: () => void
  onLink: (sailId: string) => void
}) {
  // Punctuation only — see suggestLink. Anything fuzzier would offer J1 for J2,
  // and a wrong link is invisible afterwards.
  const suggested = React.useMemo(() => suggestLink(name, inventory), [name, inventory])
  const off = busy || disabled

  return (
    <div className="mt-2 rounded-lg bg-surface-1 px-2 py-1.5">
      {/* The name on its own line. Sharing one with the buttons truncated it to
          "J…", and which sail is being decided about is the whole question. */}
      <p className="truncate font-mono text-xs font-semibold text-fg">{name}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {suggested?.id && (
        <button
          onClick={() => onLink(suggested.id!)}
          disabled={off}
          className="min-h-[40px] shrink-0 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-60"
        >
          {busy ? 'Saving…' : <>Link to “{suggested.name}”</>}
        </button>
      )}

      {/* Everything else the boat owns. A native select, because on a phone it
          is the picker the OS already gave the crew. */}
      <select
        value=""
        disabled={off || !inventory.length}
        onChange={(e) => { if (e.target.value) onLink(e.target.value) }}
        aria-label={`Link ${name} to a sail in the inventory`}
        className="min-h-[40px] shrink-0 rounded-lg border border-[color:var(--border-strong)] bg-surface-2 px-2 text-xs font-medium text-fg disabled:opacity-60"
      >
        <option value="">{suggested ? 'Link to another sail…' : 'Link to a sail…'}</option>
        {inventory.map((s) => (
          <option key={s.id || s.name} value={s.id || ''}>{s.name}</option>
        ))}
      </select>

      <button
        onClick={onAdd}
        disabled={off}
        className="flex min-h-[40px] shrink-0 items-center gap-1 rounded-lg border border-[color:var(--border-strong)] bg-surface-2 px-2.5 text-xs font-semibold text-secondary disabled:opacity-60"
      >
        <Plus size={13} aria-hidden /> Add as new
      </button>
      </div>
    </div>
  )
}

/**
 * What is on the boat — asked for once, then shown.
 *
 * The deck is the input nothing in the data can supply: the log records what
 * the boat did, the event file records what was hoisted, and neither knows that
 * the A3 is lying in the bow. Without it the weight aboard is a floor rather
 * than a figure, and nobody finds that out until a debrief argues about it.
 *
 * So: asked at the top of the day's list while it is unknown, and stated there
 * once it is — because a list held constant all day is only useful if somebody
 * can see it without opening a tag.
 */
function DeckBar({
  unknown, deck, weightOf, onSet,
}: {
  unknown: boolean
  deck: { up: { id?: string | null; name: string }[]; onBoard: { id?: string | null; name: string }[] }
  weightOf: (s: { id?: string | null; name: string }) => number | null
  onSet: () => void
}) {
  if (unknown) {
    return (
      <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-accent-bg px-3 py-2">
        <Sailboat size={15} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 text-xs text-accent">
          What is on board today? Set it once and it holds for the day.
        </span>
        <button
          onClick={onSet}
          className="min-h-[40px] shrink-0 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg"
        >
          Set the deck
        </button>
      </div>
    )
  }

  if (!deck.onBoard.length) return null
  const kg = weightAboard(deck as never, weightOf)
  return (
    <button
      onClick={onSet}
      className="flex w-full items-center gap-2 border-b border-[color:var(--border)] bg-surface-1 px-3 py-2 text-left"
    >
      <Sailboat size={14} className="shrink-0 text-secondary" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[11px] text-secondary">
        <span className="font-semibold">On board</span>{' '}
        {deck.onBoard.map((s) => s.name).join(' + ')}
      </span>
      {kg && (
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {kg.kg.toFixed(1)} kg{kg.unknown ? ` +${kg.unknown}?` : ''}
        </span>
      )}
    </button>
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
      // Four tabs, each carrying a word, a count and an icon, are wider than a
      // phone: a flex item's min-width defaults to auto, so the row was pushing
      // "Debrief" off the side of the screen, and capping it merely truncated
      // every label to "Ta…" and "Ch…".
      //
      // So they are dropped in order of what they are worth. The WORD is the
      // tab and is always there. The COUNT appears from 380px, where there is
      // room for it beside the longest label. The ICON is decoration and waits
      // until 480px. Nothing truncates at any width.
      className={cn(
        'flex min-h-[44px] min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden rounded-lg px-1.5 text-[13px] font-medium',
        active ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-secondary'
      )}
    >
      <span className="hidden shrink-0 min-[480px]:inline">{icon}</span>
      <span className="truncate">{label}</span>
      {count != null && count > 0 && (
        <span
          className={cn(
            'hidden shrink-0 rounded-full px-1 text-[11px] font-bold min-[380px]:inline',
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
