'use client'
import * as React from 'react'
import { ExternalLink, Check } from 'lucide-react'
import { cn } from '@/lib/ui'
import {
  toggleUp, isUp, setBatten, withBattenCount, describeState,
  type SailState, type SailRef,
} from '@/lib/tagging/sailState'
import {
  TENSIONS, TENSION_SHORT, cardSetting, formatSetting, bandForTws,
  type BattenCard, type Tension,
} from '@/lib/battens'
import { sessionClockHm } from '@/lib/tagging/clock'

// What a sail change actually is.
//
// Three tabs, and the nesting is the point:
//
//   UP        which of the sails ON BOARD are hoisted right now. This is the
//             thing being recorded, so it opens first.
//   ON BOARD  which of the boat's sails came out today. That is decided once, in
//             Campaign → Day, so this tab SHOWS it and links there rather than
//             offering a second place to change it — two editors for one list is
//             how a crew ends up with two different lists.
//   BATTENS   how the main is set up. The boat's card says what it should be in
//             this breeze; this records what it was.
//
// The state is the WHOLE state after the change, not a diff — see sailState.ts
// for why that is what makes a day readable backwards.

export interface SailChangeDetailProps {
  value: SailState
  onChange: (next: SailState) => void
  /** The boat's whole inventory. */
  inventory: SailRef[]
  /** Today's sail list from Campaign → Day — the sails actually aboard. */
  onBoard: SailRef[]
  /** What was up before this change, for the "carried over" line. */
  previous?: { state: SailState; utc: number } | null
  /** The batten card of the mainsail that is up. */
  battenCard?: BattenCard | null
  /** That mainsail's name, so the tab can say whose card it is showing. */
  battenCardSail?: string | null
  /** True wind speed at the tag's time, for which band to recommend. */
  twsKn?: number | null
  tzOffsetMin?: number
  /** Jump to Campaign → Day, where the sail list is edited. */
  onEditSailList?: () => void
}

type Pane = 'up' | 'onboard' | 'battens'

export default function SailChangeDetail({
  value, onChange, inventory, onBoard, previous, battenCard, battenCardSail, twsKn,
  tzOffsetMin = 0, onEditSailList,
}: SailChangeDetailProps) {
  const [pane, setPane] = React.useState<Pane>('up')

  const battenCount = battenCard?.count ?? 3
  // Make sure there is a row per batten to edit, without writing anything into
  // the tag until the crew actually sets something.
  const battens = React.useMemo(
    () => withBattenCount(value, battenCount).battens,
    [value, battenCount]
  )

  // The UP tab offers what is aboard. A boat whose day sail list has not been
  // filled in yet falls back to the whole inventory — an empty tab would make
  // the tagger useless on exactly the days people forget the paperwork.
  const choosable = onBoard.length ? onBoard : inventory
  const usingFallback = !onBoard.length && inventory.length > 0

  const band = bandForTws(twsKn)

  return (
    <div className="mb-3 rounded-xl border border-[color:var(--border)] bg-surface-2/40 p-2">
      <div role="tablist" aria-label="Sail change" className="mb-2 flex gap-1">
        <PaneTab active={pane === 'up'} onClick={() => setPane('up')}>
          Up{value.up.length > 0 ? ` · ${value.up.length}` : ''}
        </PaneTab>
        <PaneTab active={pane === 'onboard'} onClick={() => setPane('onboard')}>
          On board{onBoard.length ? ` · ${onBoard.length}` : ''}
        </PaneTab>
        <PaneTab active={pane === 'battens'} onClick={() => setPane('battens')}>
          Battens
        </PaneTab>
      </div>

      {/* ── UP ────────────────────────────────────────────────────────────── */}
      {pane === 'up' && (
        <div>
          {previous && (
            <p className="mb-2 text-[11px] text-muted">
              Was {describeState(previous.state)} from {sessionClockHm(previous.utc, tzOffsetMin)}
            </p>
          )}
          {choosable.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted">
              No sails on the boat’s list yet. Add them in Boat → Sail inventory,
              then set the day’s list in Campaign → Day.
            </p>
          ) : (
            <>
              {usingFallback && (
                <p className="mb-2 text-[11px] text-warning">
                  No sail list for today — showing the whole inventory.
                </p>
              )}
              <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))' }}>
                {choosable.map((s, i) => {
                  const on = isUp(value, s)
                  return (
                    <button
                      key={s.id || `${s.name}-${i}`}
                      onClick={() => onChange(toggleUp(value, s))}
                      aria-pressed={on}
                      className={cn(
                        'flex min-h-[52px] items-center justify-center gap-1.5 rounded-lg border px-2 text-center text-xs font-semibold leading-tight',
                        on
                          ? 'border-transparent bg-accent text-accent-fg'
                          : 'border-[color:var(--border-strong)] bg-surface-2 text-fg'
                      )}
                    >
                      {on && <Check size={13} className="shrink-0" aria-hidden />}
                      <span className="line-clamp-2">{s.name}</span>
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-[11px] text-muted">
                {value.up.length ? describeState(value) : 'Nothing up — this records a drop.'}
              </p>
            </>
          )}
        </div>
      )}

      {/* ── ON BOARD ──────────────────────────────────────────────────────── */}
      {pane === 'onboard' && (
        <div>
          <p className="mb-2 text-[11px] text-muted">
            Today’s sail list. Highlighted sails came out; the rest stayed ashore.
          </p>
          {inventory.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted">
              The boat has no sail inventory yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {inventory.map((s, i) => {
                const aboard = onBoard.some(
                  (o) => (o.id && s.id && o.id === s.id) || o.name.toLowerCase() === s.name.toLowerCase()
                )
                return (
                  <span
                    key={s.id || `${s.name}-${i}`}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-xs font-medium',
                      aboard
                        ? 'border-[color:var(--accent)] bg-accent-bg text-accent'
                        : 'border-[color:var(--border)] bg-surface-2 text-muted'
                    )}
                  >
                    {s.name}
                  </span>
                )
              })}
            </div>
          )}
          {/* Editing happens where the list lives. Offering a second editor here
              is how a crew ends up with two lists that disagree. */}
          {onEditSailList && (
            <button
              onClick={onEditSailList}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--border-strong)] bg-surface-2 text-xs font-semibold"
            >
              <ExternalLink size={14} aria-hidden />
              Edit sail list in Campaign → Day
            </button>
          )}
        </div>
      )}

      {/* ── BATTENS ───────────────────────────────────────────────────────── */}
      {pane === 'battens' && (
        <div>
          <p className="mb-2 text-[11px] text-muted">
            {band
              ? <>Card for <span className="font-semibold text-secondary">{band.label} kn</span>{twsKn != null && ` · ${twsKn.toFixed(1)} kn now`}</>
              : 'No wind reading at this time — the card cannot suggest a band.'}
            {/* Whose card. A boat with two mains needs to know which one is
                being suggested, or a right-looking number is worse than none. */}
            {battenCard && battenCardSail && <> · <span className="font-semibold text-secondary">{battenCardSail}</span></>}
          </p>
          <div className="flex flex-col gap-2">
            {battens.map((b) => {
              const target = battenCard ? cardSetting(battenCard, b.no, twsKn) : null
              return (
                <div key={b.no} className="flex items-center gap-2">
                  <span className="w-9 shrink-0 text-xs font-bold leading-tight">
                    {b.no}
                    {b.no === 1 && <span className="block text-[9px] font-normal text-muted">top</span>}
                  </span>

                  <div className="flex shrink-0 gap-1">
                    {TENSIONS.map((t) => {
                      const on = b.tension === t
                      return (
                        <button
                          key={t}
                          // Tapping the one already set clears it, or a cell
                          // filled in by mistake could never be blanked.
                          onClick={() => onChange(setBatten(withBattenCount(value, battenCount), b.no, { tension: on ? null : (t as Tension) }))}
                          aria-pressed={on}
                          aria-label={`Batten ${b.no} ${t}`}
                          className={cn(
                            'min-h-[40px] w-11 rounded-lg border text-[11px] font-bold',
                            on
                              ? 'border-transparent bg-accent text-accent-fg'
                              : 'border-[color:var(--border)] bg-surface-2 text-secondary'
                          )}
                        >
                          {TENSION_SHORT[t]}
                        </button>
                      )
                    })}
                  </div>

                  <input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    value={b.turns === 0 ? '' : b.turns}
                    placeholder="0"
                    aria-label={`Batten ${b.no} turns`}
                    onChange={(e) => {
                      const raw = e.target.value
                      // "-" alone is a half-typed number, not a zero — treating
                      // it as 0 fights the keyboard on every negative entry.
                      const turns = raw === '' || raw === '-' ? 0 : Math.round(Number(raw))
                      if (!Number.isFinite(turns)) return
                      onChange(setBatten(withBattenCount(value, battenCount), b.no, { turns }))
                    }}
                    className="min-h-[40px] w-12 shrink-0 rounded-lg border border-[color:var(--border)] bg-surface-2 text-center text-[16px] tabular-nums text-fg"
                  />

                  {/* The card's answer, one tap away from being the record. */}
                  {/* The card's answer, one tap from becoming the record. No
                      "card:" prefix — it cost the room that made "medium +2"
                      render as "mediu…". The arrow says it applies. */}
                  {target && (
                    <button
                      onClick={() => onChange(setBatten(withBattenCount(value, battenCount), b.no, { tension: target.tension, turns: target.turns }))}
                      className="min-w-0 flex-1 rounded-lg px-1 py-2 text-left text-[10px] font-semibold leading-tight text-muted"
                      title={`Use the card: ${formatSetting(target)}`}
                    >
                      → {formatSetting(target)}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {!battenCard && (
            <p className="mt-2 text-[11px] text-muted">
              No batten card for the main that is up — set one up in
              Boat → Battens and it will suggest the setting for the breeze.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PaneTab({
  active, onClick, children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'min-h-[40px] min-w-0 flex-1 truncate rounded-lg px-2 text-xs font-semibold',
        active ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-secondary'
      )}
    >
      {children}
    </button>
  )
}
