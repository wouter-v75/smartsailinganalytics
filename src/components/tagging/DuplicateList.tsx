'use client'
import * as React from 'react'
import { Copy, User, Cpu, Check } from 'lucide-react'
import { cn } from '@/lib/ui'
import { sessionClock } from '@/lib/tagging/clock'
import { sourceOf, type DuplicatePair } from '@/lib/tagging/duplicates'

// "You tagged this. So did the event file. Which one do you want?"
//
// Shown at the top of Check, above the review queue, because it is a different
// question from the queue's and a more urgent one: the queue asks whether a
// detection is real, and this asks which of two real ones to keep. Left alone
// it quietly doubles a count that a debrief will be argued over.
//
// THREE answers, not two. "Keep both" exists because the machine cannot tell a
// duplicate from two roundings taken tightly — it is thirty seconds of evidence
// — and a list with no way out is a list that grows a permanent residue nobody
// can clear. It is recorded on the tags, so the pair stops being offered.

export interface DuplicateListProps {
  pairs: DuplicatePair[]
  tzOffsetMin?: number
  /** Throw away the crew's own tag and keep what the file brought. */
  onKeepTheirs: (pair: DuplicatePair) => void | Promise<unknown>
  /** Throw away the detection and keep the crew's. */
  onKeepMine: (pair: DuplicatePair) => void | Promise<unknown>
  /** Both are real; stop asking about this pair. */
  onKeepBoth: (pair: DuplicatePair) => void | Promise<unknown>
  /** Look at one of them on the track. */
  onOpen?: (tagId: string) => void
}

export default function DuplicateList({
  pairs, tzOffsetMin = 0, onKeepTheirs, onKeepMine, onKeepBoth, onOpen,
}: DuplicateListProps) {
  // Which row is mid-decision. Keyed rather than a boolean: a coach works down
  // the list and should not have every other row go grey while one saves.
  const [busy, setBusy] = React.useState<string | null>(null)

  if (!pairs.length) return null

  const act = async (pair: DuplicatePair, fn: () => void | Promise<unknown>) => {
    if (busy) return
    setBusy(pair.key)
    try { await fn() } finally { setBusy(null) }
  }

  return (
    <section className="border-b border-[color:var(--border)] bg-warning-bg/30 p-3">
      <header className="mb-2 flex items-center gap-2">
        <Copy size={15} className="shrink-0 text-warning" aria-hidden />
        <h2 className="text-sm font-semibold">
          {pairs.length} tagged twice
        </h2>
      </header>
      <p className="mb-3 text-xs text-secondary">
        You tagged these on the water and the event file brought its own. Keeping
        both would count the moment twice.
      </p>

      <ul className="flex flex-col gap-2">
        {pairs.map((p) => {
          const working = busy === p.key
          return (
            <li
              key={p.key}
              className="rounded-xl border border-[color:var(--border)] bg-surface-1 p-3"
              style={{ borderLeft: `4px solid ${p.mine.color || p.theirs.color}` }}
            >
              <div className="flex items-baseline gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{p.label}</h3>
                <span className="shrink-0 text-[11px] text-muted">
                  {Math.round(p.gapMs / 1000)}s apart
                </span>
              </div>

              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Side
                  tag={p.mine} icon={<User size={13} aria-hidden />}
                  tzOffsetMin={tzOffsetMin} onOpen={onOpen}
                />
                <Side
                  tag={p.theirs} icon={<Cpu size={13} aria-hidden />}
                  tzOffsetMin={tzOffsetMin} onOpen={onOpen}
                />
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => act(p, () => onKeepMine(p))}
                  disabled={working}
                  className="min-h-[44px] flex-1 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-50"
                >
                  Keep mine
                </button>
                <button
                  onClick={() => act(p, () => onKeepTheirs(p))}
                  disabled={working}
                  className="min-h-[44px] flex-1 rounded-lg border border-[color:var(--border-strong)] bg-surface-2 px-3 text-xs font-semibold disabled:opacity-50"
                >
                  Keep the file’s
                </button>
                <button
                  onClick={() => act(p, () => onKeepBoth(p))}
                  disabled={working}
                  title="They are two different moments — stop asking about this pair"
                  className="min-h-[44px] rounded-lg px-3 text-xs font-semibold text-secondary disabled:opacity-50"
                >
                  Keep both
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** One side of the pair: where it came from, when, and what it already carries.
 *  The requests and the reel place matter — they are what is lost by choosing
 *  the other one, and nobody should have to find that out afterwards. */
function Side({
  tag, icon, tzOffsetMin, onOpen,
}: {
  tag: DuplicatePair['mine']
  icon: React.ReactNode
  tzOffsetMin: number
  onOpen?: (tagId: string) => void
}) {
  const extras: string[] = []
  if (tag.note) extras.push('has a note')
  if (tag.reelOrder != null) extras.push('on the reel')
  if (tag.verifiedAt != null) extras.push('confirmed')
  if ((tag.labels || []).length) extras.push(`${tag.labels.length} descriptor${tag.labels.length > 1 ? 's' : ''}`)

  return (
    <button
      onClick={() => onOpen?.(tag.id)}
      disabled={!onOpen}
      className={cn(
        'rounded-lg bg-surface-2 px-2 py-1.5 text-left',
        onOpen && 'active:bg-surface-1'
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-secondary">
        {icon}
        {sourceOf(tag)}
      </span>
      <span className="mt-0.5 block font-mono text-xs">{sessionClock(tag.t0, tzOffsetMin)}</span>
      {extras.length > 0 && (
        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
          <Check size={10} aria-hidden />
          {extras.join(' · ')}
        </span>
      )}
    </button>
  )
}
