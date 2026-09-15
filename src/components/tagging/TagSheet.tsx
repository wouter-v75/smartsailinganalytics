'use client'
import * as React from 'react'
import {
  Check, X, Undo2, Magnet, Film, Video, MessageSquare, Trash2, Lock, ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/ui'
import DictateButton from './DictateButton'
import type { TagDef, TagWithRequests } from '@/lib/tagging/types'
import type { SnapOutcome } from '@/lib/tagging/snap'

// One tag, opened from the track. A bottom SHEET rather than a side panel or a
// modal — it rises into the thumb's half of the screen, and dismissing it is a
// downward flick or a tap on the backdrop rather than a hunt for a close button.
//
// The order of things here is the order a crew member wants them:
//
//   1. what it is, and when
//   2. the two decisions (confirm / not real) if it is a detection
//   3. what they want doing with it (ask for video, ask to debrief)
//   4. descriptors and a note
//   5. the fiddly bits — snap, reset, delete — last, because they are rarest
//
// Provenance is shown plainly: "detected 13:42:07, moved −4 s". A tool that
// silently rewrites what it told you five minutes ago is a tool people check up
// on instead of trusting.

/**
 * An editable DETAIL for a tag that already exists — the sails up on a sail
 * change, today; whatever else grows one tomorrow.
 *
 * The mirror of TagComposer's ComposerDetail, which only ever appeared on the
 * way IN. Without this a change entered in a hurry could never be corrected
 * without deleting it and starting again.
 */
export interface SheetDetail<D> {
  /** The starting value, read off the tag. */
  initial: () => D
  render: (value: D, onChange: (next: D) => void, at: number) => React.ReactNode
  /** What to write back — see merge.recomposeTag. */
  toPatch: (value: D, at: number) => {
    label?: string
    note?: string | null
    labels?: { group: string; text: string }[]
    meta?: Record<string, unknown>
  }
  /** Block Save until the detail is usable. */
  isIncomplete?: (value: D) => boolean
}

export interface TagSheetProps {
  item: TagWithRequests
  def?: TagDef | null
  currentUserId?: string | null
  canApproveVideo: boolean
  canCurateReel: boolean
  tzOffsetMin?: number
  snap?: SnapOutcome | null
  /** The tag's own editable detail, when it has one. Absent for the tags that
   *  do not — which is most of them. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail?: SheetDetail<any> | null
  /** May this user change it? A detail they cannot write is shown read-only
   *  rather than hidden: knowing what was up matters even when correcting it is
   *  somebody else's job. */
  canEditDetail?: boolean
  /** Write a re-entered detail back, in one patch. */
  onRecompose?: (patch: {
    label?: string
    note?: string | null
    labels?: { group: string; text: string }[]
    meta?: Record<string, unknown>
  }) => void | Promise<unknown>
  onClose: () => void
  onVerify: () => void
  onReject: () => void
  onUnreject?: () => void
  onSnap?: () => void
  onReset?: () => void
  onDelete: () => void
  onNote: (note: string | null) => void
  onLabel: (group: string, text: string, on: boolean) => void
  onRequestVideo: () => void
  onNominate: () => void
  onSetReel: (order: number | null) => void
}

const clock = (utc: number, tz = 0) => new Date(utc + tz * 60_000).toISOString().slice(11, 19)

export default function TagSheet(props: TagSheetProps) {
  const { item, def, currentUserId, tzOffsetMin = 0, onClose } = props
  const t = item.tag
  const isAuto = t.source === 'auto'
  const verified = t.verifiedAt != null
  const mineVideo = item.requests.some(
    (r) => r.kind === 'video' && r.requestedByUserId === currentUserId
  )
  const mineDebrief = item.requests.some(
    (r) => r.kind === 'debrief' && r.requestedByUserId === currentUserId
  )
  const drift = t.autoT0 == null ? null : Math.round((t.t0 - t.autoT0) / 1000)

  // The tag's own detail, if it has one. Keyed on the tag id so opening a
  // different tag starts from ITS state rather than from the last one's.
  const { detail } = props
  const [dv, setDv] = React.useState<unknown>(() => detail?.initial())
  const [savingDetail, setSavingDetail] = React.useState(false)
  const [detailSaved, setDetailSaved] = React.useState(false)
  React.useEffect(() => {
    setDv(detail?.initial())
    setDetailSaved(false)
  }, [t.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Compared as JSON: the value is a plain data structure the detail rebuilds
  // on every keystroke, so reference equality would call it dirty for ever.
  const detailDirty = !!detail && JSON.stringify(dv) !== JSON.stringify(detail.initial())

  const saveDetail = async () => {
    if (!detail || !props.onRecompose || savingDetail) return
    setSavingDetail(true)
    try {
      await props.onRecompose(detail.toPatch(dv, t.t0))
      setDetailSaved(true)
    } finally {
      setSavingDetail(false)
    }
  }

  const [note, setNote] = React.useState(t.note || '')
  React.useEffect(() => { setNote(t.note || '') }, [t.id, t.note])

  return (
    // ABSOLUTE, not fixed. A fixed sheet is measured against the viewport, and
    // inside the app shell the bottom ~52px of the viewport is the tab bar — so
    // the last row of the sheet (Delete, and the safe-area padding under it)
    // came out underneath it. Absolute pins the sheet to the tagger pane, which
    // already stops where the tab bar starts. TaggerTab's root is `relative`
    // for exactly this; so is the /dev/tagger harness.
    <div className="absolute inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button aria-label="Close without changing anything" onClick={onClose} className="absolute inset-0 bg-black/50" />

      <div
        className="relative max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-[color:var(--border-strong)] bg-surface-1"
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}
      >
        {/* Grab handle, and a real close button beside it.
            The handle and the backdrop are the gestures people know, but neither
            is a CONTROL: on a tall sheet the backdrop is a strip at the very top
            of the screen, out of a thumb's reach, and a flick-down is a thing you
            have to already know. Somebody who opened a tag to look at it needs an
            obvious way back that does not commit to anything. */}
        <div className="sticky top-0 z-10 flex items-center bg-surface-1 pb-1 pt-2">
          <span className="w-11 shrink-0" aria-hidden />
          <span className="mx-auto h-1 w-10 rounded-full bg-[color:var(--border-strong)]" aria-hidden />
          <button
            onClick={onClose}
            aria-label="Close"
            className="mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-secondary active:bg-surface-2"
          >
            <ChevronDown size={22} aria-hidden />
          </button>
        </div>

        <div className="px-4 pb-4">
          {/* 1. What and when */}
          <header className="flex items-start gap-2 pb-3">
            <span
              className="mt-1 h-3 w-3 shrink-0 rounded-full border-2"
              style={{ borderColor: t.color, background: !isAuto || verified ? t.color : 'transparent' }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-1.5 text-base font-semibold">
                <span className="truncate">{t.label}</span>
                {t.scope === 'personal' && <Lock size={13} className="text-muted" aria-label="Private" />}
              </h2>
              <p className="font-mono text-xs text-muted">{clock(t.t0, tzOffsetMin)}</p>
              {isAuto && (
                <p className="mt-1 text-[11px] text-muted">
                  Detected by {String(t.producer)}
                  {t.confidence != null && ` · ${Math.round(t.confidence * 100)}% sure`}
                  {drift ? ` · moved ${drift > 0 ? '+' : ''}${drift}s` : ''}
                </p>
              )}
            </div>
          </header>

          {/* 2. The two decisions */}
          {isAuto && !t.rejected && (
            <div className="flex gap-2 pb-3">
              <button
                onClick={props.onReject}
                className="flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-xl border border-[color:var(--border-strong)] bg-surface-2 text-sm font-semibold"
              >
                <X size={18} aria-hidden /> Not real
              </button>
              <button
                onClick={props.onVerify}
                className={cn(
                  'flex min-h-[52px] flex-[1.4] items-center justify-center gap-2 rounded-xl text-sm font-semibold',
                  verified ? 'bg-surface-2 text-secondary' : 'bg-success text-white'
                )}
              >
                <Check size={20} aria-hidden /> {verified ? 'Confirmed' : 'Confirm'}
              </button>
            </div>
          )}

          {t.rejected && props.onUnreject && (
            <button
              onClick={props.onUnreject}
              className="mb-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-[color:var(--border-strong)] text-sm font-medium"
            >
              <Undo2 size={16} aria-hidden /> Put this back
            </button>
          )}

          {/* 2b. The tag's own detail — for a sail change, which sails were up.
              High, because it is what somebody opens a sail change FOR: the
              deck it was chosen from is the thing they came to correct. */}
          {detail && (
            <div className="border-t border-[color:var(--border)] py-3">
              {props.canEditDetail === false ? (
                <>
                  <p className="mb-2 text-[11px] text-muted">
                    What was up. Correcting it is the afterguard’s to do.
                  </p>
                  <div className="pointer-events-none opacity-70">
                    {detail.render(dv, () => {}, t.t0)}
                  </div>
                </>
              ) : (
                <>
                  {detail.render(dv, setDv, t.t0)}
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={saveDetail}
                      disabled={savingDetail || !detailDirty || !!detail.isIncomplete?.(dv)}
                      className={cn(
                        'min-h-[44px] rounded-xl px-4 text-sm font-semibold',
                        detailDirty && !detail.isIncomplete?.(dv)
                          ? 'bg-accent text-accent-fg'
                          : 'bg-surface-2 text-muted'
                      )}
                    >
                      {savingDetail ? 'Saving…' : 'Save sails'}
                    </button>
                    {detailDirty && (
                      <button
                        onClick={() => setDv(detail.initial())}
                        disabled={savingDetail}
                        className="text-xs font-semibold text-secondary"
                      >
                        Undo
                      </button>
                    )}
                    {!detailDirty && detailSaved && (
                      <span className="text-[11px] text-success">Saved</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 3. What they want doing with it */}
          <div className="grid grid-cols-2 gap-2 pb-3">
            <ActionButton
              icon={<Video size={16} />}
              label={mineVideo ? 'Video asked for' : 'Ask for video'}
              sub={item.videoPending > 0 ? `${item.videoPending} pending` : undefined}
              done={mineVideo}
              onClick={props.onRequestVideo}
            />
            <ActionButton
              icon={<MessageSquare size={16} />}
              label={mineDebrief ? 'On the shortlist' : 'Ask to debrief'}
              sub={item.debriefVotes > 0 ? `${item.debriefVotes} asked` : undefined}
              done={mineDebrief}
              onClick={props.onNominate}
            />
          </div>

          {props.canCurateReel && (
            <button
              onClick={() => props.onSetReel(t.reelOrder == null ? 9999 : null)}
              className={cn(
                'mb-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold',
                t.reelOrder == null
                  ? 'border border-[color:var(--border-strong)] bg-surface-2'
                  : 'bg-accent text-accent-fg'
              )}
            >
              <Film size={16} aria-hidden />
              {t.reelOrder == null ? 'Add to debrief reel' : `On the reel (${t.reelOrder})`}
            </button>
          )}

          {/* 4. Descriptors and a note */}
          {def?.labelGroups?.length ? (
            <div className="pb-3">
              {def.labelGroups.map((g) => (
                <div key={g.group} className="pb-2">
                  <p className="pb-1 text-[11px] uppercase tracking-wide text-muted">{g.group}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {g.options.map((opt) => {
                      const on = (t.labels || []).some((l) => l.group === g.group && l.text === opt)
                      return (
                        <button
                          key={opt}
                          onClick={() => props.onLabel(g.group, opt, !on)}
                          className={cn(
                            'min-h-[40px] rounded-full border px-3 text-xs font-medium',
                            on
                              ? 'border-transparent text-white'
                              : 'border-[color:var(--border)] bg-surface-2 text-secondary'
                          )}
                          style={{ background: on ? t.color : undefined }}
                        >
                          {opt}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="pb-3">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => note !== (t.note || '') && props.onNote(note.trim() || null)}
              rows={2}
              placeholder="Add a note…"
              className="w-full resize-none rounded-lg border border-[color:var(--border)] bg-surface-2 p-3 text-[16px] text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            />
            {/* Dictation saves on its own rather than waiting for a blur: the
                mic button IS where the thumb already is, so the textarea may
                never be focused at all and its onBlur may never fire. */}
            <DictateButton
              value={note}
              onChange={setNote}
              onCommit={(next) => props.onNote(next.trim() || null)}
              className="mt-2"
            />
          </div>

          {/* 5. The rare things, last */}
          <div className="flex flex-wrap gap-2 border-t border-[color:var(--border)] pt-3">
            {/* Snapping moves a HAND-PLACED tag onto the data. A detection IS the
                data, so snapping it would move it onto itself. The rule lives
                here rather than in the caller: a component that depends on every
                caller remembering a rule is a component that will one day meet a
                caller who did not. */}
            {props.onSnap && t.source !== 'auto' && (
              <SmallButton onClick={props.onSnap} disabled={props.snap?.ok === false}>
                <Magnet size={14} aria-hidden />
                {props.snap?.ok === false ? props.snap.reason : 'Snap to the data'}
              </SmallButton>
            )}
            {props.onReset && t.autoT0 != null && t.editedFields.length > 0 && (
              <SmallButton onClick={props.onReset}>
                <Undo2 size={14} aria-hidden /> Back to detected
              </SmallButton>
            )}
            {!isAuto && (
              <SmallButton onClick={props.onDelete} danger>
                <Trash2 size={14} aria-hidden /> Delete
              </SmallButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionButton({
  icon, label, sub, done, onClick,
}: {
  icon: React.ReactNode
  label: string
  sub?: string
  done?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={done}
      className={cn(
        'flex min-h-[56px] flex-col items-center justify-center gap-0.5 rounded-xl border px-2 text-xs font-medium',
        done
          ? 'border-[color:var(--border)] bg-surface-2 text-muted'
          : 'border-[color:var(--border-strong)] bg-surface-2 text-fg'
      )}
    >
      <span className="flex items-center gap-1.5">{icon}{label}</span>
      {sub && <span className="text-[10px] text-muted">{sub}</span>}
    </button>
  )
}

function SmallButton({
  onClick, disabled, danger, children,
}: {
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:opacity-60',
        danger
          ? 'border-[color:var(--border)] text-danger'
          : 'border-[color:var(--border)] text-secondary'
      )}
    >
      {children}
    </button>
  )
}
