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

describe('generating phases over a stretch', () => {
  it('will not start without somewhere to start from', () => {
    render(<PhasePanel {...base} playUtc={null} />)
    expect(screen.getByRole('button', { name: /Generate phases/ }).hasAttribute('disabled')).toBe(true)
  })

  it('offers 30 s and starts on it by default — one phase at the default length', () => {
    const onTestStart = vi.fn()
    render(<PhasePanel {...base} playUtc={T0} onTestStart={onTestStart} />)
    expect((screen.getByLabelText('Duration') as HTMLSelectElement).value).toBe('30')
    fireEvent.click(screen.getByRole('button', { name: /Generate phases/ }))
    expect(onTestStart).toHaveBeenCalledWith(30, '')
  })

  it('takes the duration in seconds, whatever was picked', () => {
    const onTestStart = vi.fn()
    render(<PhasePanel {...base} playUtc={T0} onTestStart={onTestStart} />)
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate phases/ }))
    expect(onTestStart).toHaveBeenCalledWith(300, '')
  })

  it('shows what is being generated and can stop it early', () => {
    const onTestStop = vi.fn()
    render(<PhasePanel {...base} playUtc={T0 + 20_000} test={{ startUtc: T0, plannedS: 30 }} onTestStop={onTestStop} />)
    expect(screen.getByText(/Generating from 10:00:00 · 30 s planned/)).toBeTruthy()
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

describe('saving to the SSA phase database', () => {
  const withPhases = {
    ...base, counts: { event: 139, ssa: 6, manoeuvres: 2 }, playUtc: T0,
    uploadPlan: () => ({ mode: 'add' as const, toUpload: [1, 2, 3], overlapping: 1, standDownEvent: 0, manoeuvres: 2 }),
  }

  it('sits beside Generate phases for a coach, and uploads in the chosen mode', () => {
    const onUpload = vi.fn()
    render(<PhasePanel {...withPhases} canUpload onUpload={onUpload} />)
    fireEvent.click(screen.getByRole('button', { name: /Save to the SSA phase database/ }))
    expect(onUpload).toHaveBeenCalledWith('add')
  })

  it('is not offered below coach', () => {
    render(<PhasePanel {...withPhases} canUpload={false} />)
    expect(screen.queryByRole('button', { name: /Save to the SSA phase database/ })).toBeNull()
  })

  it('is not offered before anything has been generated', () => {
    render(<PhasePanel {...withPhases} canUpload counts={{ event: 139, ssa: 0, manoeuvres: 0 }} />)
    expect(screen.queryByRole('button', { name: /Save to the SSA phase database/ })).toBeNull()
  })

  it('says what it is doing while it uploads', () => {
    render(<PhasePanel {...withPhases} canUpload upload={{ state: 'busy', message: 'Uploading…' }} />)
    const btn = screen.getByRole('button', { name: /Saving…/ })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})

describe('which sections are in the comparison', () => {
  const sections = [
    { id: 's1', n: 1, color: '#FDE047', range: [T0, T0 + 60_000] as [number, number] },
    { id: 's2', n: 2, color: '#22D3EE', range: [T0 + 120_000, T0 + 180_000] as [number, number] },
  ]

  it('shows a button per section, all on to begin with', () => {
    render(<PhasePanel {...base} sections={sections} />)
    expect(screen.getByRole('button', { name: 'Section 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Section 2' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('reports a section being switched off', () => {
    const onToggleSection = vi.fn()
    render(<PhasePanel {...base} sections={sections} onToggleSection={onToggleSection} />)
    fireEvent.click(screen.getByRole('button', { name: 'Section 2' }))
    expect(onToggleSection).toHaveBeenCalledWith('s2')
  })

  it('shows a hidden section as off, so it can be brought back', () => {
    render(<PhasePanel {...base} sections={sections} hiddenSections={['s1']} />)
    expect(screen.getByRole('button', { name: 'Section 1' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Section 2' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('offers nothing when no section has been picked', () => {
    render(<PhasePanel {...base} />)
    expect(screen.queryByRole('button', { name: /^Section / })).toBeNull()
  })
})

describe('which races are in view', () => {
  const races = [{ n: 1, label: 'Race 5' }, { n: 2, label: 'Race 6' }]

  it('puts a button per race after Both, all on to begin with', () => {
    render(<PhasePanel {...base} races={races} />)
    expect(screen.getByRole('button', { name: 'Race 5 phases' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Race 6 phases' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('reports a race being switched off', () => {
    const onToggleRace = vi.fn()
    render(<PhasePanel {...base} races={races} onToggleRace={onToggleRace} />)
    fireEvent.click(screen.getByRole('button', { name: 'Race 6 phases' }))
    expect(onToggleRace).toHaveBeenCalledWith(2)
  })

  it('shows a hidden race as off, so it can come back', () => {
    render(<PhasePanel {...base} races={races} hiddenRaces={[1]} />)
    expect(screen.getByRole('button', { name: 'Race 5 phases' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('puts the sections after the races, as asked', () => {
    const sections = [{ id: 's1', n: 1, color: '#FDE047', range: [T0, T0 + 60_000] as [number, number] }]
    const { container } = render(<PhasePanel {...base} races={races} sections={sections} />)
    const labels = Array.from(container.querySelectorAll('button[aria-label]'))
      .map(b => b.getAttribute('aria-label'))
      .filter(l => l === 'Race 5 phases' || l === 'Section 1')
    expect(labels).toEqual(['Race 5 phases', 'Section 1'])
  })

  it('offers no race buttons on a day with no start guns', () => {
    render(<PhasePanel {...base} />)
    expect(screen.queryByRole('button', { name: /^Race .* phases$/ })).toBeNull()
  })
})
