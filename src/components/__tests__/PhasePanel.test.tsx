import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PhasePanel from '../analytics/PhasePanel'
import { withSettings } from '../../lib/phaseSettings'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)

const base = {
  source: 'event' as const, onSource: () => {},
  mergeMode: 'add' as const, onMergeMode: () => {},
  settings: withSettings(), onSettings: () => {},
  counts: { event: 139, ssa: 0, manoeuvres: 0 },
  canBuild: true,
}

describe('choosing the source', () => {
  it('shows what each source holds', () => {
    render(<PhasePanel {...base} counts={{ event: 139, ssa: 12, manoeuvres: 4 }} />)
    expect(screen.getByText(/Event file · 139/)).toBeTruthy()
    expect(screen.getByText(/SSA · 12 \+4 man\./)).toBeTruthy()
  })

  it('cannot pick SSA phases before any exist', () => {
    render(<PhasePanel {...base} />)
    expect(screen.getByRole('button', { name: /SSA · 0/ }).hasAttribute('disabled')).toBe(true)
  })

  it('asks which source wins only when both are shown', () => {
    const { rerender } = render(<PhasePanel {...base} />)
    expect(screen.queryByText(/Where they overlap/)).toBeNull()
    rerender(<PhasePanel {...base} source="both" />)
    expect(screen.getByText(/Where they overlap/)).toBeTruthy()
  })

  it('reports the choice', () => {
    const onSource = vi.fn()
    render(<PhasePanel {...base} counts={{ event: 5, ssa: 2, manoeuvres: 0 }} onSource={onSource} />)
    fireEvent.click(screen.getByRole('button', { name: /SSA · 2/ }))
    expect(onSource).toHaveBeenCalledWith('ssa')
  })
})

describe('building from the track', () => {
  it('needs a selection before it will build', () => {
    render(<PhasePanel {...base} />)
    expect(screen.getByRole('button', { name: /Phases from the selection/ }).hasAttribute('disabled')).toBe(true)
  })

  it('builds the selection under the name it was given', () => {
    const onBuildSelection = vi.fn()
    render(<PhasePanel {...base} selection={[T0, T0 + 120_000]} onBuildSelection={onBuildSelection} />)
    fireEvent.change(screen.getByLabelText('Run name'), { target: { value: 'J1.5 vs J2' } })
    fireEvent.click(screen.getByRole('button', { name: /Phases from the selection/ }))
    expect(onBuildSelection).toHaveBeenCalledWith('J1.5 vs J2')
  })

  it('offers nothing to build with below TL2', () => {
    render(<PhasePanel {...base} canBuild={false} selection={[T0, T0 + 120_000]} roleNote="Building phases is for TL2 and up." />)
    expect(screen.queryByRole('button', { name: /Phases from the selection/ })).toBeNull()
    expect(screen.getByText(/TL2 and up/)).toBeTruthy()
  })
})

describe('a timed test', () => {
  it('will not start without somewhere to start from', () => {
    render(<PhasePanel {...base} playUtc={null} />)
    expect(screen.getByRole('button', { name: /Start test/ }).hasAttribute('disabled')).toBe(true)
  })

  it('starts for the chosen number of minutes', () => {
    const onTestStart = vi.fn()
    render(<PhasePanel {...base} playUtc={T0} onTestStart={onTestStart} />)
    fireEvent.change(screen.getByLabelText('Test duration'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Start test/ }))
    expect(onTestStart).toHaveBeenCalledWith(5, '')
  })

  it('shows a running test and can stop it early', () => {
    const onTestStop = vi.fn()
    render(<PhasePanel {...base} playUtc={T0 + 30_000} test={{ startUtc: T0, plannedS: 120 }} onTestStop={onTestStop} />)
    expect(screen.getByText(/Test running from 10:00:00 · 2 min planned/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    expect(onTestStop).toHaveBeenCalled()
  })
})

describe('what the last build refused', () => {
  it('says how many were kept and the commonest reasons', () => {
    render(<PhasePanel {...base} build={{
      phases: [1, 2, 3], rejected: [1, 2, 3, 4, 5],
      reasons: [{ reason: 'TWS drifted', n: 3 }, { reason: 'turning', n: 2 }],
    } as never} />)
    expect(screen.getByText(/✓ 3 kept/)).toBeTruthy()
    expect(screen.getByText(/5 refused/)).toBeTruthy()
    expect(screen.getByText(/3 TWS drifted · 2 turning/)).toBeTruthy()
  })
})

describe('settings', () => {
  it('warns when the guard is shorter than a phase', () => {
    render(<PhasePanel {...base} settings={withSettings({ phaseLenS: 60, guardAfterS: 20 })} />)
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    expect(screen.getByText(/guard after a manoeuvre/i)).toBeTruthy()
  })

  it('passes a changed threshold back whole', () => {
    const onSettings = vi.fn()
    render(<PhasePanel {...base} onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    fireEvent.change(screen.getByLabelText('TWS drift'), { target: { value: '2' } })
    expect(onSettings.mock.calls[0][0].gate.twsDriftMaxKn).toBe(2)
    expect(onSettings.mock.calls[0][0].gate.awaDriftMaxDeg).toBe(15)
  })

  it('can turn manoeuvre phases off', () => {
    const onSettings = vi.fn()
    render(<PhasePanel {...base} onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    fireEvent.click(screen.getByLabelText(/Keep tacks/))
    expect(onSettings.mock.calls[0][0].manoeuvrePhases).toBe(false)
  })
})

describe('the log underneath', () => {
  it('says when the log is too coarse to build from', () => {
    render(<PhasePanel {...base} resolutionNote="This log has a row every ~6 s — too coarse to build phases from." />)
    expect(screen.getByText(/too coarse/)).toBeTruthy()
  })
})

describe('runs', () => {
  const run = { id: 'r1', name: 'Line-up 1', tags: [], from: T0, to: T0 + 120_000, createdAt: 1, kind: 'selection' as const, settings: withSettings() }

  it('lists a run and jumps to it', () => {
    const onJumpRun = vi.fn()
    render(<PhasePanel {...base} runs={[run]} onJumpRun={onJumpRun} />)
    fireEvent.click(screen.getByText(/Line-up 1/))
    expect(onJumpRun).toHaveBeenCalledWith(run)
  })

  it('deletes a run only where the user may build', () => {
    const onDeleteRun = vi.fn()
    const { rerender } = render(<PhasePanel {...base} runs={[run]} onDeleteRun={onDeleteRun} />)
    fireEvent.click(screen.getByLabelText('Delete run Line-up 1'))
    expect(onDeleteRun).toHaveBeenCalledWith(run)
    rerender(<PhasePanel {...base} canBuild={false} runs={[run]} onDeleteRun={onDeleteRun} />)
    expect(screen.queryByLabelText('Delete run Line-up 1')).toBeNull()
  })
})
