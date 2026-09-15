import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import SailChangeDetail from '../SailChangeDetail'
import { EMPTY_SAIL_STATE, type SailState, type SailRef } from '@/lib/tagging/sailState'

// The screen has to be able to show any state the day can produce. A deck
// folded from hand tagging plus an event file carries both inventory rows and
// bare names, and a sail that is aboard but not drawn is one nobody can see,
// count, or take off again.

const inv = (id: string, name: string): SailRef => ({ id, name })

const DAY: SailRef[] = [inv('s1', 'MAIN_B 2026'), inv('s2', 'J1.5_B 2026'), inv('s3', 'A2')]

function show(value: SailState, opts: Partial<React.ComponentProps<typeof SailChangeDetail>> = {}) {
  const onChange = vi.fn()
  render(
    <SailChangeDetail
      value={value}
      onChange={onChange}
      inventory={DAY}
      dayList={DAY}
      startPane="onboard"
      {...opts}
    />
  )
  return { onChange }
}

const deckButtons = () =>
  screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'))

describe('SailChangeDetail · On board', () => {
  it('draws the day list, and says what is aboard', () => {
    show({ ...EMPTY_SAIL_STATE, up: [inv('s1', 'MAIN_B 2026')], onBoard: DAY })
    expect(deckButtons()).toHaveLength(3)
    expect(screen.getByText(/3 of 3 on board/)).toBeTruthy()
  })

  it('shows a sail that is aboard but missing from the day’s list', () => {
    // A storm jib passed across from the RIB, never on the paperwork.
    show({ ...EMPTY_SAIL_STATE, onBoard: [...DAY, { id: 'sX', name: 'J4' }] })
    expect(screen.getByText('J4')).toBeTruthy()
    expect(screen.getByText(/4 of 4 on board/)).toBeTruthy()
  })

  it('takes a carried sail off the boat when tapped', () => {
    const { onChange } = show({ ...EMPTY_SAIL_STATE, onBoard: [...DAY, { id: 'sX', name: 'J4' }] })
    const j4 = deckButtons().find((b) => within(b).queryByText('J4'))!
    expect(j4.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(j4)
    expect(onChange.mock.calls[0][0].onBoard.map((s: SailRef) => s.name)).not.toContain('J4')
  })

  it('keeps a carried sail on screen after it goes back to the RIB', () => {
    // Drawn straight from the state, its button would vanish on the tap that
    // took it off — a one-way door, with the sail unrecoverable.
    function Harness() {
      const [v, setV] = React.useState<SailState>({
        ...EMPTY_SAIL_STATE,
        onBoard: [...DAY, { id: 'sX', name: 'J4' }],
      })
      return (
        <SailChangeDetail value={v} onChange={setV} inventory={DAY} dayList={DAY} startPane="onboard" />
      )
    }
    render(<Harness />)
    const j4 = () => deckButtons().find((b) => within(b).queryByText('J4'))!
    fireEvent.click(j4())
    expect(j4()).toBeTruthy()
    expect(j4().getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/3 of 4 on board/)).toBeTruthy()
    fireEvent.click(j4())
    expect(j4().getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/4 of 4 on board/)).toBeTruthy()
  })

  it('does not double a sail the event file named and the list owns', () => {
    // The file knows only "J1.5_B 2026"; the day's list holds the inventory row
    // for the same sail. Two rows, one aboard and one "in the RIB", is a lie.
    show({ ...EMPTY_SAIL_STATE, onBoard: [inv('s1', 'MAIN_B 2026'), { id: null, name: 'J1.5_B 2026' }] })
    expect(screen.getAllByText('J1.5_B 2026')).toHaveLength(1)
    expect(deckButtons()).toHaveLength(3)
    expect(screen.getByText(/2 of 3 on board/)).toBeTruthy()
    const j15 = deckButtons().find((b) => within(b).queryByText('J1.5_B 2026'))!
    expect(j15.getAttribute('aria-pressed')).toBe('true')
  })

  it('hoists from the whole deck, carried sails included', () => {
    show(
      { ...EMPTY_SAIL_STATE, onBoard: [...DAY, { id: 'sX', name: 'J4' }] },
      { startPane: 'up' }
    )
    expect(deckButtons()).toHaveLength(4)
    expect(screen.getByText('J4')).toBeTruthy()
  })

  it('falls back to the inventory, and says so, when the day has no list', () => {
    show({ ...EMPTY_SAIL_STATE, up: [inv('s1', 'MAIN_B 2026')] }, { dayList: [], startPane: 'up' })
    expect(screen.getByText(/showing the whole inventory/i)).toBeTruthy()
  })
})
