'use client'
import * as React from 'react'
import { MessageSquare, Users, Flag, ChevronRight, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/ui'
import { barItems, BAR_GROUPS, type BarGroup, type BarItem } from '@/lib/tagging/barGroups'
import TagComposer, { type ComposerDetail, type TagPayload } from './TagComposer'
import type { TagDef } from '@/lib/tagging/types'

// The crew's tagging path, and the most important twelve square centimetres in
// the app. Everything here is shaped by where it gets used: a phone, one-handed,
// on a moving boat or on the dock five minutes after it.
//
//   • fixed to the BOTTOM, inside the safe-area inset, because that is where a
//     thumb reaches. A toolbar at the top of a phone screen is a toolbar for
//     people holding the phone in two hands, sitting down.
//   • 56 px targets, comfortably over the 44 px floor, and a grid that wraps
//     rather than a row that scrolls — a button you have to scroll to find is a
//     button you do not press while something is happening.
//
// A press captures the TIME and opens the composer, where that time can be
// corrected before the tag is saved. It is one more tap than firing on the press,
// and it buys the thing that actually decides whether a tag is any use: people
// press late, always, and a tag ten seconds late records the recovery instead of
// the manoeuvre. See TagComposer.
//
// One button can stand for several tags — "Racing" opens start / top mark / gate
// / mark / finish. That keeps the bar short without putting the racing moments
// out of reach; see barGroups.ts for why they are not each given a slot.

export interface TagButtonBarProps {
  /** The definitions curated onto the bar. */
  defs: TagDef[]
  /** Every definition the team has — group members are resolved from these. */
  allDefs?: TagDef[]
  groups?: BarGroup[]
  /** UTC ms a press means — a point picked on the track, the video playhead, or
   *  the wall clock. */
  nowUtc: () => number
  onApply: (slug: string, at: number, opts?: TagPayload) => Promise<unknown>
  disabled?: boolean
  className?: string
  /** Minutes east of UTC for the session — the same clock the track shows. */
  tzOffsetMin?: number
  /** The day's data window, so the composer cannot nudge a tag outside it. */
  bounds?: { min?: number | null; max?: number | null }
  /** Describes where the composer's current time falls, e.g. "Race 2". */
  contextAt?: (utc: number) => string | null
  /** Extra fields for the tags that need them — a sail change needs three tabs
   *  of them; most tags need none. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detailFor?: (def: TagDef) => ComposerDetail<any> | null
}

const iconFor = (slug: string) =>
  slug === 'note' ? MessageSquare : slug === 'team-note' ? Users : null

export default function TagButtonBar({
  defs, allDefs, groups = BAR_GROUPS, nowUtc, onApply, disabled, className,
  tzOffsetMin = 0, bounds, contextAt, detailFor,
}: TagButtonBarProps) {
  const [composing, setComposing] = React.useState<{ def: TagDef; at: number } | null>(null)
  const [picking, setPicking] = React.useState<{ group: BarGroup; members: TagDef[]; at: number } | null>(null)

  const items = React.useMemo(
    () => barItems(defs, allDefs && allDefs.length ? allDefs : defs, groups),
    [defs, allDefs, groups]
  )

  if (!items.length) return null

  const press = (item: BarItem) => {
    // The time belongs to the PRESS, not to whatever the crew does next. Capture
    // it once here and carry it through the picker into the composer, or a tag
    // chosen after ten seconds of deciding would be ten seconds late on top of
    // however late the press already was.
    const at = nowUtc()
    if (item.kind === 'tag') setComposing({ def: item.def, at })
    else setPicking({ group: item.group, members: item.members, at })
  }

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
          // Five across on a phone, more as the screen allows — without a media
          // query, so it also does the right thing in a narrow desktop panel.
          // Five rather than four because the bar is nine buttons now: at four
          // it ran to three rows and took a third of the screen off the view
          // above it, which on the track view is the thing being tagged.
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(68px, 1fr))' }}
        >
          {items.map((item) =>
            item.kind === 'tag' ? (
              <BarButton
                key={item.def.id}
                label={item.def.label}
                color={item.def.color}
                Icon={iconFor(item.def.slug)}
                hint={iconFor(item.def.slug) ? 'opens a note' : undefined}
                disabled={disabled}
                onClick={() => press(item)}
              />
            ) : (
              <BarButton
                key={`group:${item.group.key}`}
                label={item.group.label}
                color={item.group.color}
                Icon={Flag}
                hint={`${item.members.length} tags`}
                group
                disabled={disabled}
                onClick={() => press(item)}
              />
            )
          )}
        </div>
      </div>

      {picking && (
        <GroupPicker
          group={picking.group}
          members={picking.members}
          onCancel={() => setPicking(null)}
          onPick={(def) => {
            const { at } = picking
            setPicking(null)
            setComposing({ def, at })
          }}
        />
      )}

      {composing && (
        <TagComposer
          // Keyed by the press, so opening a second tag re-seeds the detail
          // rather than reusing the first one's sails.
          key={`${composing.def.id}:${composing.at}`}
          def={composing.def}
          at={composing.at}
          tzOffsetMin={tzOffsetMin}
          bounds={bounds}
          context={contextAt ? contextAt(composing.at) : null}
          detail={detailFor ? detailFor(composing.def) : null}
          onCancel={() => setComposing(null)}
          onSave={async (at, opts) => {
            const { def } = composing
            setComposing(null)
            await onApply(def.slug, at, opts)
          }}
        />
      )}
    </>
  )
}

function BarButton({
  label, color, Icon, hint, group, disabled, onClick,
}: {
  label: string
  color: string
  Icon: LucideIcon | null
  hint?: string
  group?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={hint ? `${label} — ${hint}` : label}
      className={cn(
        'relative flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2',
        'text-[11px] font-medium leading-tight transition-colors',
        'active:scale-[0.97] disabled:opacity-60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
        'border-[color:var(--border)] bg-surface-2 text-fg'
      )}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      {Icon
        ? <Icon size={16} style={{ color }} />
        : <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />}
      <span className="line-clamp-2 text-center">{label}</span>
      {/* A group leads somewhere; the chevron says so before it is pressed. */}
      {group && (
        <ChevronRight
          size={11}
          className="absolute right-1 top-1 text-muted"
          aria-hidden
        />
      )}
    </button>
  )
}

/** The tags behind a group button. A list, not a grid — there are never many. */
function GroupPicker({
  group, members, onCancel, onPick,
}: {
  group: BarGroup
  members: TagDef[]
  onCancel: () => void
  onPick: (def: TagDef) => void
}) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onCancel} className="absolute inset-0 bg-black/50" />
      <div
        className="relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-[color:var(--border-strong)] bg-surface-1 p-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="mb-2 flex items-center gap-2">
          <Flag size={14} style={{ color: group.color }} aria-hidden />
          <span className="text-sm font-semibold">{group.label}</span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {members.map((def) => (
            <li key={def.id}>
              <button
                onClick={() => onPick(def)}
                className="flex min-h-[52px] w-full items-center gap-3 rounded-xl border border-[color:var(--border)] bg-surface-2 px-3 text-left text-sm font-medium"
                style={{ borderLeft: `4px solid ${def.color}` }}
              >
                <span className="flex-1 truncate">{def.label}</span>
                <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <button
          onClick={onCancel}
          className="mt-2 min-h-[48px] w-full rounded-xl border border-[color:var(--border-strong)] bg-surface-2 text-sm font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
