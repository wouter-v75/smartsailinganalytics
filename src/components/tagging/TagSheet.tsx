'use client'
import * as React from 'react'
import {
  Check, X, Undo2, Magnet, Film, Video, MessageSquare, Trash2, Lock,
} from 'lucide-react'
import { cn } from '@/lib/ui'
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

export interface TagSheetProps {
  item: TagWithRequests
  def?: TagDef | null
  currentUserId?: string | null
  canApproveVideo: boolean
  canCurateReel: boolean
  tzOffsetMin?: number
  snap?: SnapOutcome | null
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
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50" />

      <div
        className="relative max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-[color:var(--border-strong)] bg-surface-1"
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}
      >
        {/* Grab handle — the affordance people already know means "flick me down". */}
        <div className="sticky top-0 flex justify-center bg-surface-1 pb-1 pt-2">
          <span className="h-1 w-10 rounded-full bg-[color:var(--border-strong)]" aria-hidden />
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
