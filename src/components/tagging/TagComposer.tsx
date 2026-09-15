'use client'
import * as React from 'react'
import { Loader2, Check } from 'lucide-react'
import { cn } from '@/lib/ui'
import { sessionClock, parseSessionClock, nudge, driftLabel, NUDGES } from '@/lib/tagging/clock'
import type { TagDef } from '@/lib/tagging/types'

// What comes up when a tag button is pressed.
//
// The press captures WHEN, and this sheet is where that time can be corrected
// before the tag is saved — because the press is always late. The crew member
// had to see the thing, recognise it, and find the button, and on the water they
// did all three one-handed while sailing the boat. Ten to thirty seconds is
// normal. A tagging tool that treats the press as the truth records the recovery
// and misses the manoeuvre.
//
// So the time is prefilled and immediately adjustable, and the backward steps
// come first because that is the direction almost every correction goes. The
// forward steps exist so an overshoot is not a dead end, and the field itself is
// editable for the case where somebody knows the number.
//
// The note field only appears for the tags that are a note — everything else
// carries its meaning in the tag itself, and an empty box invites a sentence
// nobody will read.

const NOTE_SLUGS = new Set(['note', 'team-note'])

export interface TagComposerProps {
  def: TagDef
  /** The instant the button was pressed — the starting point, not the answer. */
  at: number
  tzOffsetMin?: number
  /** The day's data window, so a nudge cannot land outside it. */
  bounds?: { min?: number | null; max?: number | null }
  /** Shown under the time — e.g. which race the current time falls in. */
  context?: string | null
  onCancel: () => void
  onSave: (at: number, opts: { note?: string }) => void | Promise<unknown>
}

export default function TagComposer({
  def, at, tzOffsetMin = 0, bounds, context, onCancel, onSave,
}: TagComposerProps) {
  const [t, setT] = React.useState(at)
  const [note, setNote] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const wantsNote = NOTE_SLUGS.has(def.slug)

  // What the field SHOWS. Kept separate from `t` while the crew is typing, so a
  // half-typed "13:0" does not get parsed, rejected, and snapped back under
  // their fingers mid-keystroke.
  const [typed, setTyped] = React.useState<string | null>(null)
  const shown = typed ?? sessionClock(t, tzOffsetMin)
  const drift = driftLabel(at, t)

  const noteRef = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => { if (wantsNote) noteRef.current?.focus() }, [wantsNote])

  const commitTyped = (text: string) => {
    const parsed = parseSessionClock(text, at, tzOffsetMin)
    if (parsed != null) setT(nudge(parsed, 0, bounds))
    setTyped(null)
  }

  const save = async () => {
    if (saving) return
    if (wantsNote && !note.trim()) return
    setSaving(true)
    await onSave(t, { note: note.trim() || undefined })
  }

  return (
    // Absolute rather than fixed — see the note in TagSheet. Inside the app shell
    // the bottom of the viewport is the tab bar, and a fixed sheet puts its Save
    // button underneath it.
    <div className="absolute inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onCancel} className="absolute inset-0 bg-black/50" />

      <div
        className="relative max-h-[92dvh] overflow-y-auto rounded-t-2xl border-t border-[color:var(--border-strong)] bg-surface-1 p-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: def.color }} aria-hidden />
          <span className="truncate text-sm font-semibold">{def.label}</span>
        </div>

        {/* ── When ──────────────────────────────────────────────────────────── */}
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted" htmlFor="tag-time">
          When
        </label>
        <div className="mb-2 flex items-center gap-2">
          <input
            id="tag-time"
            type="text"
            inputMode="numeric"
            // A plain text field, not <input type="time">: that control renders
            // in the DEVICE's 12/24-hour preference and would show a different
            // clock from the track two centimetres above it.
            pattern="[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?"
            value={shown}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={(e) => commitTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTyped((e.target as HTMLInputElement).value) }
            }}
            className="w-[7.5rem] rounded-lg border border-[color:var(--border-strong)] bg-surface-2 px-3 py-2 text-center font-mono text-[18px] tabular-nums text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
          />
          <div className="min-w-0 flex-1 text-xs text-muted">
            {drift && <span className="font-mono text-warning">{drift}</span>}
            {drift && context ? ' · ' : ''}
            {context}
          </div>
          {drift && (
            <button
              onClick={() => { setTyped(null); setT(at) }}
              className="shrink-0 rounded-lg border border-[color:var(--border)] px-2 py-2 text-[11px] text-secondary"
            >
              Now
            </button>
          )}
        </div>

        {/* Four across, so it falls out as a row of back steps over a row of
            forward ones. Eight in a single row fits a 390px screen only at 40px
            wide, under the touch floor everything else here respects — and this
            is a control used with a thumb on a moving boat. */}
        <div className="mb-3 grid gap-1.5" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {NUDGES.map((n) => (
            <button
              key={n.ms}
              onClick={() => { setTyped(null); setT((prev) => nudge(prev, n.ms, bounds)) }}
              className={cn(
                'min-h-[44px] rounded-lg border text-xs font-semibold tabular-nums',
                n.ms < 0
                  ? 'border-[color:var(--border-strong)] bg-surface-2 text-fg'
                  : 'border-[color:var(--border)] bg-surface-2 text-secondary'
              )}
            >
              {n.label}
            </button>
          ))}
        </div>

        {/* ── What (notes only) ─────────────────────────────────────────────── */}
        {wantsNote && (
          <>
            {def.slug === 'team-note' && (
              <p className="mb-1 text-[11px] text-muted">The whole crew will see this.</p>
            )}
            {def.privateByDefault && (
              <p className="mb-1 text-[11px] text-muted">Only you will see this.</p>
            )}
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={def.slug === 'team-note' ? 'For the crew…' : 'For you…'}
              className="mb-3 w-full resize-none rounded-lg border border-[color:var(--border)] bg-surface-2 p-3 text-[16px] text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            />
          </>
        )}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="min-h-[52px] flex-1 rounded-xl border border-[color:var(--border-strong)] bg-surface-2 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || (wantsNote && !note.trim())}
            className="flex min-h-[52px] flex-[2] items-center justify-center gap-2 rounded-xl text-sm font-bold text-white disabled:opacity-50"
            style={{ background: def.color }}
          >
            {saving
              ? <Loader2 size={18} className="animate-spin" aria-hidden />
              : <Check size={18} aria-hidden />}
            {saving ? 'Saving…' : `Add at ${sessionClock(t, tzOffsetMin)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export { NOTE_SLUGS }
