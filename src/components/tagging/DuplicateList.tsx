'use client'
import * as React from 'react'
import { Copy, User, Cpu, Check, Lock } from 'lucide-react'
import { cn } from '@/lib/ui'
import { sessionClock } from '@/lib/tagging/clock'
import { sourceOf, type DuplicatePair } from '@/lib/tagging/duplicates'
import type { TagEvent } from '@/lib/tagging/types'

// "This moment is tagged twice. Which one do you want?"
//
// Shown at the top of Check, above the review queue, because it is a different
// question from the queue's and a more urgent one: the queue asks whether a
// detection is real, and this asks which of two real ones to keep. Left alone
// it quietly doubles a count that a debrief will be argued over.
//
// TWO SHAPES of the same problem, and the row asks each differently:
//
//   crossed  you tagged it, and then the event file brought its own. One side
//            is a person and one is a machine, so "keep mine" means something.
//   crew     two people tagged it, neither able to see what the other pressed.
//            Nobody's is authoritative, so the row asks by NAME — and names are
//            the whole reason it can ask at all.
//
// THREE answers in both cases. "Keep both" exists because thirty seconds of
// evidence cannot tell a duplicate from two roundings taken tightly, and a list
// with no way out grows a permanent residue nobody can clear.

export interface DuplicateListProps {
  pairs: DuplicatePair[]
  tzOffsetMin?: number
  /** The signed-in user, so their own tag reads as theirs. */
  meId?: string | null
  /** Author id → name, for a crew pair. */
  nameOf?: (id: string) => string | null
  /** May this user get rid of this tag? Same rule the database enforces — a
   *  choice they cannot carry out must not be offered as though they could. */
  canEdit?: (tag: TagEvent) => boolean
  /** Throw this tag away and keep the other. */
  onDrop: (pair: DuplicatePair, drop: TagEvent) => void | Promise<unknown>
  /** Both are real; stop asking about this pair. */
  onKeepBoth: (pair: DuplicatePair) => void | Promise<unknown>
  /** Look at one of them on the track. */
  onOpen?: (tagId: string) => void
}

export default function DuplicateList({
  pairs, tzOffsetMin = 0, meId, nameOf, canEdit, onDrop, onKeepBoth, onOpen,
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

  const crew = pairs.filter((p) => p.kind === 'crew').length

  return (
    <section className="border-b border-[color:var(--border)] bg-warning-bg/30 p-3">
      <header className="mb-2 flex items-center gap-2">
        <Copy size={15} className="shrink-0 text-warning" aria-hidden />
        <h2 className="text-sm font-semibold">{pairs.length} tagged twice</h2>
      </header>
      <p className="mb-3 text-xs text-secondary">
        {crew === pairs.length
          ? 'Two of you tagged the same moment. Keeping both would count it twice.'
          : crew > 0
            ? 'The same moment tagged twice — by two of you, or by you and the event file. Keeping both would count it twice.'
            : 'You tagged these on the water and the event file brought its own. Keeping both would count the moment twice.'}
      </p>

      <ul className="flex flex-col gap-2">
        {pairs.map((p) => {
          const working = busy === p.key
          // Keeping one side means getting rid of the OTHER, so each button is
          // gated on what it would delete, not on what it would keep.
          const may = (t: TagEvent) => (canEdit ? canEdit(t) : true)
          const who = (t: TagEvent) => sourceOf(t, { meId, nameOf })
          return (
            <li
              key={p.key}
              className="rounded-xl border border-[color:var(--border)] bg-surface-1 p-3"
              style={{ borderLeft: `4px solid ${p.a.color || p.b.color}` }}
            >
              <div className="flex items-baseline gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{p.label}</h3>
                <span className="shrink-0 text-[11px] text-muted">
                  {Math.round(p.gapMs / 1000)}s apart
                </span>
              </div>

              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Side tag={p.a} who={who(p.a)} tzOffsetMin={tzOffsetMin} onOpen={onOpen} />
                <Side tag={p.b} who={who(p.b)} tzOffsetMin={tzOffsetMin} onOpen={onOpen} />
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <Keep
                  label={p.kind === 'crossed' ? 'Keep mine' : `Keep ${shortOf(who(p.a))}`}
                  primary
                  allowed={may(p.b)}
                  busy={working}
                  onClick={() => act(p, () => onDrop(p, p.b))}
                />
                <Keep
                  label={p.kind === 'crossed' ? 'Keep the file’s' : `Keep ${shortOf(who(p.b))}`}
                  allowed={may(p.a)}
                  busy={working}
                  onClick={() => act(p, () => onDrop(p, p.a))}
                />
                <button
                  onClick={() => act(p, () => onKeepBoth(p))}
                  // Accepting a pair is WRITTEN to one of its tags, so somebody
                  // who may edit neither cannot record it either. Offering the
                  // button would mean a press that comes back as a refusal
                  // from the database.
                  disabled={working || !(may(p.a) || may(p.b))}
                  title={
                    may(p.a) || may(p.b)
                      ? 'They are two different moments — stop asking about this pair'
                      : 'Only the afterguard can settle somebody else’s tags'
                  }
                  className="min-h-[44px] rounded-lg px-3 text-xs font-semibold text-secondary disabled:opacity-50"
                >
                  Keep both
                </button>
              </div>

              {/* Nothing here is theirs to do. Still worth SEEING — a coach
                  cannot fix what nobody told them about. */}
              {!may(p.a) && !may(p.b) && (
                <p className="mt-2 text-[11px] text-muted">
                  These are somebody else’s to settle — ask the afterguard.
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** "Sam tagged it" → "Sam’s". The button has room for a name, not a sentence. */
function shortOf(who: string): string {
  const name = who.replace(/ tagged it$/, '').trim()
  if (name === 'You') return 'mine'
  if (!name || /^(Another crew member|Tagged by hand)$/.test(name)) return 'theirs'
  return `${name}’s`
}

function Keep({
  label, primary, allowed, busy, onClick,
}: {
  label: string
  primary?: boolean
  allowed: boolean
  busy: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || !allowed}
      title={allowed ? undefined : 'Only the afterguard can remove somebody else’s tag'}
      className={cn(
        'flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-50',
        primary
          ? 'bg-accent text-accent-fg'
          : 'border border-[color:var(--border-strong)] bg-surface-2'
      )}
    >
      {!allowed && <Lock size={12} aria-hidden />}
      {label}
    </button>
  )
}

/** One side of the pair: where it came from, when, and what it already carries.
 *  The requests and the reel place matter — they are what is lost by choosing
 *  the other one, and nobody should have to find that out afterwards. */
function Side({
  tag, who, tzOffsetMin, onOpen,
}: {
  tag: TagEvent
  who: string
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
        {tag.source === 'human' ? <User size={13} aria-hidden /> : <Cpu size={13} aria-hidden />}
        {who}
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
