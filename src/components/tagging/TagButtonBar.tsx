'use client'
import * as React from 'react'
import { MessageSquare, Users, Loader2 } from 'lucide-react'
import { cn } from '@/lib/ui'
import type { TagDef } from '@/lib/tagging/types'

// The crew's one-press path, and the most important twelve square centimetres in
// the app. Everything here is shaped by where it gets used: a phone, one-handed,
// on a moving boat or on the dock five minutes after it.
//
//   • fixed to the BOTTOM, inside the safe-area inset, because that is where a
//     thumb reaches. A toolbar at the top of a phone screen is a toolbar for
//     people holding the phone in two hands, sitting down.
//   • 56 px targets, comfortably over the 44 px floor, and a grid that wraps
//     rather than a row that scrolls — a button you have to scroll to find is a
//     button you do not press while something is happening.
//   • the press is recorded the instant it lands. The server works out the
//     window from the definition's lead/lag; the caller supplies only "now".
//
// Notes need text, so they open a composer sheet instead of firing immediately —
// but the TIME is captured at the press, not at the send, or every note would be
// stamped with however long it took to type.

export interface TagButtonBarProps {
  defs: TagDef[]
  /** UTC ms this press means — the playhead, or Date.now() when live. */
  nowUtc: () => number
  onApply: (slug: string, at: number, opts?: { note?: string }) => Promise<unknown>
  disabled?: boolean
  className?: string
}

const NOTE_SLUGS = new Set(['note', 'team-note'])

export default function TagButtonBar({
  defs, nowUtc, onApply, disabled, className,
}: TagButtonBarProps) {
  const [composing, setComposing] = React.useState<{ def: TagDef; at: number } | null>(null)
  const [pending, setPending] = React.useState<string | null>(null)
  const [flash, setFlash] = React.useState<string | null>(null)

  const press = async (def: TagDef) => {
    const at = nowUtc()
    if (NOTE_SLUGS.has(def.slug)) { setComposing({ def, at }); return }
    setPending(def.id)
    await onApply(def.slug, at)
    setPending(null)
    // A moment of colour is the whole acknowledgement. On a boat nobody reads a
    // toast, but they do see the button they just hit light up.
    setFlash(def.id)
    setTimeout(() => setFlash((f) => (f === def.id ? null : f)), 700)
  }

  if (!defs.length) return null

  return (
    <>
      <div
        className={cn(
          'sticky bottom-0 z-30 border-t border-[color:var(--border)] bg-surface-1/95 backdrop-blur',
          className
        )}
        style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div
          className="grid gap-1.5 px-2 pt-2"
          // Four across on a phone, more as the screen allows — without a media
          // query, so it also does the right thing in a narrow desktop panel.
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))' }}
        >
          {defs.map((def) => {
            const isNote = NOTE_SLUGS.has(def.slug)
            const Icon = def.slug === 'note' ? MessageSquare : def.slug === 'team-note' ? Users : null
            return (
              <button
                key={def.id}
                type="button"
                disabled={disabled || pending === def.id}
                onClick={() => press(def)}
                aria-label={isNote ? `${def.label} — opens a note` : def.label}
                className={cn(
                  'relative flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2',
                  'text-[11px] font-medium leading-tight transition-colors',
                  'active:scale-[0.97] disabled:opacity-60',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
                  flash === def.id
                    ? 'border-transparent text-white'
                    : 'border-[color:var(--border)] bg-surface-2 text-fg'
                )}
                style={{
                  background: flash === def.id ? def.color : undefined,
                  borderLeft: flash === def.id ? undefined : `3px solid ${def.color}`,
                }}
              >
                {pending === def.id ? (
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                ) : Icon ? (
                  <Icon size={16} style={{ color: flash === def.id ? '#fff' : def.color }} aria-hidden />
                ) : (
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: flash === def.id ? '#fff' : def.color }}
                    aria-hidden
                  />
                )}
                <span className="line-clamp-2 text-center">{def.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {composing && (
        <NoteComposer
          def={composing.def}
          at={composing.at}
          onCancel={() => setComposing(null)}
          onSend={async (text) => {
            const { def, at } = composing
            setComposing(null)
            await onApply(def.slug, at, { note: text })
          }}
        />
      )}
    </>
  )
}

/**
 * A note, typed on a phone.
 *
 * Bottom sheet rather than a modal: it sits above the keyboard instead of
 * fighting it, and the thumb stays where it already was. The time was captured
 * when the button was pressed, which is why the sheet can say WHEN the note is
 * about — a detail that matters when you type it four minutes later.
 */
function NoteComposer({
  def, at, onCancel, onSend,
}: {
  def: TagDef
  at: number
  onCancel: () => void
  onSend: (text: string) => void | Promise<void>
}) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const ref = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => { ref.current?.focus() }, [])

  const send = async () => {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    await onSend(t)
  }

  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 bg-black/50"
      />
      <div
        className="relative rounded-t-2xl border-t border-[color:var(--border-strong)] bg-surface-1 p-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: def.color }} aria-hidden />
          <span className="text-sm font-medium">{def.label}</span>
          <span className="ml-auto font-mono text-xs text-muted">{time}</span>
        </div>

        {def.slug === 'team-note' && (
          <p className="mb-2 text-[11px] text-muted">
            The whole crew will see this.
          </p>
        )}

        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={def.slug === 'note' ? 'Just for you…' : 'For the crew…'}
          className={cn(
            'w-full resize-none rounded-lg border border-[color:var(--border)] bg-surface-2 p-3',
            // 16px, so iOS does not zoom the viewport when the field takes focus.
            'text-[16px] text-fg placeholder:text-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]'
          )}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
            // Enter sends on a hardware keyboard; on a phone the newline is
            // usually what you meant, so only the modifier combination fires.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />

        <div className="mt-2 flex gap-2">
          <button
            onClick={onCancel}
            className="min-h-[48px] flex-1 rounded-lg border border-[color:var(--border)] bg-surface-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!text.trim() || sending}
            className="min-h-[48px] flex-[2] rounded-lg text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: def.color }}
          >
            {sending ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </div>
    </div>
  )
}
