'use client'
import * as React from 'react'
import { Film, Plus, Minus, ArrowUp, ArrowDown, Users, Video, Clock } from 'lucide-react'
import { cn } from '@/lib/ui'
import { buildShortlist, reelOf, nextReelOrder, renumberReel } from '@/lib/tagging/requests'
import type { TagWithRequests } from '@/lib/tagging/types'

// The deliverable.
//
// A day produces a hundred and forty tags; an evening has room for five. So the
// output of tagging is a SHORTLIST, not an archive — and the shortlist is built
// by the whole crew rather than by whoever owns the analysis laptop.
//
// Two halves, and the split is the point:
//
//   REEL       what the coach selected, in the coach's order. This is tonight's
//              agenda, and it is what exports.
//   SHORTLIST  what everyone nominated, ranked by HOW MANY people asked. Five
//              people wanting to talk about the same gybe is the strongest
//              signal here, and it only exists because nominating is open.
//
// Anyone can nominate. Only the coach promotes. That is the entire permission
// model on this screen, and it is why the crew bother.

export interface DebriefReelProps {
  items: TagWithRequests[]
  canCurate: boolean
  currentUserId?: string | null
  onNominate: (tagId: string) => void | Promise<unknown>
  onSetReel: (tagId: string, order: number | null) => void | Promise<unknown>
  onOpen?: (tagId: string) => void
  tzOffsetMin?: number
}

const clock = (utc: number, tz = 0) => new Date(utc + tz * 60_000).toISOString().slice(11, 16)

export default function DebriefReel({
  items, canCurate, currentUserId, onNominate, onSetReel, onOpen, tzOffsetMin = 0,
}: DebriefReelProps) {
  const reel = React.useMemo(() => reelOf(items), [items])
  const shortlist = React.useMemo(
    () => buildShortlist(items).filter((i) => i.tag.reelOrder == null),
    [items]
  )

  const move = async (tagId: string, dir: -1 | 1) => {
    const idx = reel.findIndex((i) => i.tag.id === tagId)
    const swap = idx + dir
    if (idx < 0 || swap < 0 || swap >= reel.length) return
    // Swap the two positions, then let renumber close any gaps the day has
    // accumulated — a reel that reads "3, 7, 9" invites "position 7 of 4".
    await onSetReel(reel[idx].tag.id, reel[swap].tag.reelOrder as number)
    await onSetReel(reel[swap].tag.id, reel[idx].tag.reelOrder as number)
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* ── Tonight's agenda ─────────────────────────────────────────────── */}
      <section>
        <header className="mb-2 flex items-center gap-2">
          <Film size={16} className="text-accent" aria-hidden />
          <h2 className="text-sm font-semibold">Debrief reel</h2>
          <span className="ml-auto text-xs text-muted">
            {reel.length ? `${reel.length} moment${reel.length === 1 ? '' : 's'}` : 'empty'}
          </span>
        </header>

        {reel.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[color:var(--border)] p-4 text-center text-xs text-muted">
            {canCurate
              ? 'Add moments from the shortlist below. Five is a good evening.'
              : 'The coach has not picked tonight’s moments yet.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {reel.map((item, idx) => (
              <li
                key={item.tag.id}
                className="flex items-center gap-2 rounded-lg border border-[color:var(--border)] bg-surface-1 p-2"
                style={{ borderLeft: `4px solid ${item.tag.color}` }}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-bg text-xs font-bold text-accent">
                  {idx + 1}
                </span>
                <button
                  onClick={() => onOpen?.(item.tag.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium">{item.tag.label}</span>
                  <span className="block truncate text-xs text-muted">
                    {clock(item.tag.t0, tzOffsetMin)}
                    {item.tag.note ? ` · ${item.tag.note}` : ''}
                    {item.debriefVotes > 0 ? ` · ${item.debriefVotes} asked` : ''}
                  </span>
                </button>
                {canCurate && (
                  <div className="flex shrink-0 gap-1">
                    <IconBtn label="Move up" disabled={idx === 0} onClick={() => move(item.tag.id, -1)}>
                      <ArrowUp size={16} />
                    </IconBtn>
                    <IconBtn label="Move down" disabled={idx === reel.length - 1} onClick={() => move(item.tag.id, 1)}>
                      <ArrowDown size={16} />
                    </IconBtn>
                    <IconBtn label="Take off the reel" onClick={() => onSetReel(item.tag.id, null)}>
                      <Minus size={16} />
                    </IconBtn>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── What the crew asked for ──────────────────────────────────────── */}
      <section>
        <header className="mb-2 flex items-center gap-2">
          <Users size={16} className="text-secondary" aria-hidden />
          <h2 className="text-sm font-semibold">Shortlist</h2>
          <span className="ml-auto text-xs text-muted">
            {canCurate ? 'tap + to add' : 'tap to ask for it'}
          </span>
        </header>

        {shortlist.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[color:var(--border)] p-4 text-center text-xs text-muted">
            Nobody has asked to discuss anything yet. Tag a moment and ask for it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shortlist.map((item) => {
              const mine = item.requests.some(
                (r) => r.kind === 'debrief' && r.requestedByUserId === currentUserId
              )
              const video = item.videoPending > 0
              return (
                <li
                  key={item.tag.id}
                  className="flex items-center gap-2 rounded-lg border border-[color:var(--border)] bg-surface-1 p-2"
                  style={{ borderLeft: `4px solid ${item.tag.color}` }}
                >
                  {item.debriefVotes > 0 && (
                    <span
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-bold"
                      title={`${item.debriefVotes} asked to discuss this`}
                    >
                      {item.debriefVotes}
                    </span>
                  )}
                  <button onClick={() => onOpen?.(item.tag.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium">{item.tag.label}</span>
                    {/* `truncate` on a flex PARENT clips mid-word with no
                        ellipsis — the text needs its own min-w-0 box. */}
                    <span className="flex items-center gap-1 text-xs text-muted">
                      <Clock size={11} className="shrink-0" aria-hidden />
                      <span className="shrink-0">{clock(item.tag.t0, tzOffsetMin)}</span>
                      {item.tag.note && (
                        <span className="min-w-0 flex-1 truncate">· {item.tag.note}</span>
                      )}
                      {video && <Video size={11} className="shrink-0 text-accent" aria-hidden />}
                    </span>
                  </button>

                  {canCurate ? (
                    <IconBtn
                      label="Add to the reel"
                      onClick={() => onSetReel(item.tag.id, nextReelOrder(items))}
                    >
                      <Plus size={18} />
                    </IconBtn>
                  ) : (
                    <button
                      onClick={() => onNominate(item.tag.id)}
                      disabled={mine}
                      className={cn(
                        'min-h-[44px] shrink-0 rounded-lg px-3 text-xs font-semibold',
                        mine
                          ? 'bg-surface-2 text-muted'
                          : 'border border-[color:var(--border-strong)] bg-surface-2 text-fg'
                      )}
                    >
                      {mine ? 'Asked' : 'Ask'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/** 44 px minimum, because this is used with a thumb. */
function IconBtn({
  label, onClick, disabled, children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[color:var(--border)] bg-surface-2 text-secondary disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export { renumberReel }
