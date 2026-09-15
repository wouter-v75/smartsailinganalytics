'use client'
import * as React from 'react'
import { Check, X, Clock, AlertTriangle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/ui'
import type { TagEvent } from '@/lib/tagging/types'

// "Can a coach review a whole day's tags in sixty seconds?" — this is the screen
// that has to answer yes.
//
// One card at a time, LEAST TRUSTWORTHY FIRST. A textbook 95° tack off a clean
// speed trace needs nobody; the 40° wobble at 5 kn in a gap in the log is what a
// human should spend their minute on. Semi-automated scoring beats manual work
// precisely by directing attention, not by removing it.
//
// Two enormous buttons and nothing else in reach. On a phone the entire flow is
// thumb · thumb · thumb, and a 140-tag day collapses to the dozen that are
// genuinely uncertain.

export interface ReviewQueueProps {
  tags: TagEvent[]
  onVerify: (id: string) => void | Promise<unknown>
  onReject: (id: string, reason?: string) => void | Promise<unknown>
  onOpen?: (tag: TagEvent) => void
  tzOffsetMin?: number
  /** A sheet is open in front of the queue, so the shortcuts are not ours. The
   *  queue stays mounted behind it — without this, V or X typed at an open tag
   *  would confirm or discard the card underneath, unseen. */
  keysPaused?: boolean
}

/** Below this, a detection is worth a human's attention. Above it, the detector
 *  has earned the benefit of the doubt and the tag is left alone. */
export const REVIEW_THRESHOLD = 0.75

const clock = (utc: number, tzOffsetMin = 0) =>
  new Date(utc + tzOffsetMin * 60_000).toISOString().slice(11, 19)

/** What makes this one uncertain, in the crew's own words. `meta` is set by
 *  detect.ts, so these read off the same signals the confidence score used. */
function doubts(tag: TagEvent): string[] {
  const m = (tag.meta || {}) as Record<string, unknown>
  const out: string[] = []
  if (m.logGap) out.push('gap in the log')
  if (m.shortHitch) out.push('another manoeuvre seconds earlier')
  if (m.atMark) out.push('sits on a mark rounding')
  if (m.inferred) out.push('inferred from the track, not the event file')
  if (m.valid === false) out.push('the onboard system doubted its own measurement')
  if (m.orphaned) out.push('the detector no longer finds this')
  const metrics = (m.metrics || {}) as Record<string, number | null>
  const turn = metrics.turnAngle
  const target = metrics.target
  if (typeof turn === 'number' && typeof target === 'number' && target > 0 && turn / target < 0.5) {
    out.push(`turned only ${Math.round(turn)}° of ${Math.round(target)}°`)
  }
  return out
}

export default function ReviewQueue({
  tags, onVerify, onReject, onOpen, tzOffsetMin = 0, keysPaused = false,
}: ReviewQueueProps) {
  const queue = React.useMemo(
    () => tags
      .filter((t) => t.source === 'auto' && !t.rejected && t.verifiedAt == null)
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1) || a.t0 - b.t0),
    [tags]
  )

  const [i, setI] = React.useState(0)
  const [acting, setActing] = React.useState(false)
  // Keep the cursor in range as the queue shrinks under it.
  React.useEffect(() => { if (i >= queue.length) setI(Math.max(0, queue.length - 1)) }, [queue.length, i])

  const tag = queue[i]

  const act = async (fn: () => void | Promise<unknown>) => {
    if (acting) return
    setActing(true)
    await fn()
    setActing(false)
    // The queue reshuffles beneath us — staying put lands on the next one.
  }

  // Keyboard for anyone at a desk. The phone flow needs none of it.
  React.useEffect(() => {
    if (!tag || keysPaused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (el && /input|textarea/i.test(el.tagName)) return
      if (e.key === 'v' || e.key === 'Enter') { e.preventDefault(); act(() => onVerify(tag.id)) }
      if (e.key === 'x') { e.preventDefault(); act(() => onReject(tag.id)) }
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(n + 1, queue.length - 1)) }
      if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(n - 1, 0)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tag, queue.length, keysPaused]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!queue.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <Check size={28} className="text-success" aria-hidden />
        <p className="text-sm font-medium">Nothing left to check</p>
        <p className="max-w-xs text-xs text-muted">
          Every detection on this day has been confirmed or thrown out.
        </p>
      </div>
    )
  }

  const why = doubts(tag)
  const pct = tag.confidence == null ? null : Math.round(tag.confidence * 100)
  const low = (tag.confidence ?? 1) < REVIEW_THRESHOLD

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{i + 1} of {queue.length} to check</span>
        <span className="flex items-center gap-1">
          <span className="hidden sm:inline">least certain first</span>
          {low && <AlertTriangle size={13} className="text-warning" aria-hidden />}
        </span>
      </div>

      <article
        className="rounded-xl border bg-surface-1 p-4"
        style={{ borderColor: 'var(--border)', borderLeft: `4px solid ${tag.color}` }}
      >
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold">{tag.label}</h3>
            <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted">
              <Clock size={12} aria-hidden />
              {clock(tag.t0, tzOffsetMin)}
              {(tag.meta as any)?.raceNum ? (
                <span className="font-sans">· Race {(tag.meta as any).raceNum}</span>
              ) : null}
            </p>
          </div>
          {pct != null && (
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold',
                low ? 'bg-warning-bg text-warning' : 'bg-success-bg text-success'
              )}
            >
              {pct}%
            </span>
          )}
        </header>

        {why.length > 0 && (
          <ul className="mt-3 space-y-1">
            {why.map((w) => (
              <li key={w} className="flex gap-1.5 text-xs text-secondary">
                <span aria-hidden className="text-warning">•</span>
                {w}
              </li>
            ))}
          </ul>
        )}

        <Metrics tag={tag} />

        {onOpen && (
          <button
            onClick={() => onOpen(tag)}
            className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-1 rounded-lg border border-[color:var(--border)] text-xs font-medium text-secondary"
          >
            Open the tag <ChevronRight size={14} aria-hidden />
          </button>
        )}
      </article>

      {/* The only two things in thumb reach. */}
      <div className="flex gap-2">
        <button
          onClick={() => act(() => onReject(tag.id))}
          disabled={acting}
          className="flex min-h-[60px] flex-1 items-center justify-center gap-2 rounded-xl border border-[color:var(--border-strong)] bg-surface-2 text-sm font-semibold disabled:opacity-50"
        >
          <X size={20} aria-hidden /> Not real
        </button>
        <button
          onClick={() => act(() => onVerify(tag.id))}
          disabled={acting}
          className="flex min-h-[60px] flex-[1.6] items-center justify-center gap-2 rounded-xl bg-success text-sm font-semibold text-white disabled:opacity-50"
        >
          <Check size={22} aria-hidden /> Confirm
        </button>
      </div>

      <p className="text-center text-[11px] text-muted">
        <span className="hidden sm:inline">V confirm · X discard · J/K move · </span>
        Discarded detections stay discarded — they will not come back.
      </p>
    </div>
  )
}

/** The evidence, so a decision does not need another screen. */
function Metrics({ tag }: { tag: TagEvent }) {
  // Written by the detector via planSync — see merge.ts rowFor().
  const m = ((tag.meta as any)?.metrics || {}) as Record<string, number | null>
  const cells = [
    { k: 'Entry', v: m.bspBefore, u: 'kn', d: 1 },
    { k: 'Exit', v: m.bspAfter, u: 'kn', d: 1 },
    { k: 'To 95%', v: m.timeTo95, u: 's', d: 0 },
    { k: 'Turn', v: m.turnAngle, u: '°', d: 0 },
    { k: 'Lost', v: m.distLost, u: 'm', d: 0 },
    { k: 'TWS', v: m.tws, u: 'kn', d: 1 },
  ].filter((c) => typeof c.v === 'number' && Number.isFinite(c.v as number))

  if (!cells.length) return null
  return (
    <dl className="mt-3 grid grid-cols-3 gap-2">
      {cells.map((c) => (
        <div key={c.k} className="rounded-lg bg-surface-2 px-2 py-1.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted">{c.k}</dt>
          <dd className="font-mono text-sm">
            {(c.v as number).toFixed(c.d)}<span className="text-[10px] text-muted">{c.u}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}
