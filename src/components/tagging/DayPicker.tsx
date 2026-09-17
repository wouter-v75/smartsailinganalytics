'use client'
import * as React from 'react'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import { cn } from '@/lib/ui'
import { venueTodayIso as todayIso } from '@/lib/localStore'

// Which day is being tagged.
//
// Tagging is mostly a thing you do to today, on the dock — but not always. A
// coach catches up on Tuesday's racing on Wednesday; somebody joins a campaign
// halfway through and works back; a designer wants the sail changes from a
// regatta three weeks ago. Without this the tagger could only ever see whatever
// day the app happened to have open, which made every one of those impossible.
//
// Previous / next step through the days the app knows about, NOT through the
// calendar: a boat does not sail every day, and "yesterday" on a Monday is a
// Sunday nobody launched. The dropdown is there when the step buttons would take
// too long.

export interface DayPickerProps {
  date?: string | null
  sessions?: { date: string; hasLog?: boolean; hasXml?: boolean; event?: string | null }[] | null
  onSelect: (date: string) => void | Promise<unknown>
  disabled?: boolean
}

/** "Fri 11 Sep" — short, and unambiguous about which day of the week it was. */
function label(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}


export default function DayPicker({ date, sessions, onSelect, disabled }: DayPickerProps) {
  // Oldest first, de-duplicated, and never into the future — a session row with
  // a mis-parsed date used to put "2035" at the end of the list.
  const days = React.useMemo(() => {
    const today = todayIso()
    const seen = new Set<string>()
    const out: { date: string; event?: string | null; hasLog?: boolean }[] = []
    for (const s of sessions || []) {
      const d = String(s?.date || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || seen.has(d)) continue
      seen.add(d)
      out.push({ date: d, event: s.event ?? null, hasLog: s.hasLog })
    }
    return out.sort((a, b) => a.date.localeCompare(b.date))
  }, [sessions])

  const idx = date ? days.findIndex((d) => d.date === date) : -1
  const prev = idx > 0 ? days[idx - 1] : null
  const next = idx >= 0 && idx < days.length - 1 ? days[idx + 1] : null
  const isToday = date === todayIso()

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-[color:var(--border)] bg-surface-1 px-2 py-1.5">
      <Step
        label="Previous session"
        disabled={disabled || !prev}
        onClick={() => prev && onSelect(prev.date)}
      >
        <ChevronLeft size={18} />
      </Step>

      {days.length > 0 ? (
        <div className="relative min-w-0 flex-1">
          <select
            aria-label="Day being tagged"
            value={idx >= 0 ? date! : ''}
            disabled={disabled}
            onChange={(e) => e.target.value && onSelect(e.target.value)}
            className={cn(
              'min-h-[40px] w-full appearance-none truncate rounded-lg border border-[color:var(--border-strong)]',
              'bg-surface-2 pl-8 pr-2 text-center text-sm font-semibold text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]'
            )}
          >
            {/* A day the app has no session row for still has to show, or the
                control would read as a different day from the one being tagged. */}
            {idx < 0 && date && <option value={date}>{label(date)}</option>}
            {[...days].reverse().map((d) => (
              <option key={d.date} value={d.date}>
                {d.date === todayIso() ? 'Today · ' : ''}{label(d.date)}
                {d.event ? ` · ${d.event}` : ''}
                {d.hasLog === false ? ' · no log' : ''}
              </option>
            ))}
          </select>
          <CalendarDays
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            aria-hidden
          />
        </div>
      ) : (
        <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
          {date ? label(date) : 'No day selected'}
        </span>
      )}

      <Step
        label="Next session"
        disabled={disabled || !next}
        onClick={() => next && onSelect(next.date)}
      >
        <ChevronRight size={18} />
      </Step>

      {/* Back to today, because that is where nine days in ten are spent and
          stepping home one session at a time after browsing a regatta is a
          chore. Hidden when it would do nothing. */}
      {!isToday && days.some((d) => d.date === todayIso()) && (
        <button
          onClick={() => onSelect(todayIso())}
          disabled={disabled}
          className="min-h-[40px] shrink-0 rounded-lg border border-[color:var(--border)] px-2 text-xs font-semibold text-secondary"
        >
          Today
        </button>
      )}
    </div>
  )
}

function Step({
  label: aria, disabled, onClick, children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      title={aria}
      disabled={disabled}
      onClick={onClick}
      className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[color:var(--border)] bg-surface-2 text-secondary disabled:opacity-35"
    >
      {children}
    </button>
  )
}
