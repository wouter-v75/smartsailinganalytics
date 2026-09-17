'use client'
// src/components/analytics/PhasePanel.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Where the two sources of phases meet: the 30 s phases from the KND event file, and
// the ones SSA builds from the log itself. Choose which the charts read, set what a
// phase has to be to count, cut a selected stretch of the track into phases, or run a
// timed test — and see plainly what was refused and why.
//
// Nothing here writes to the cloud: building phases is local work (TL2+), and a coach
// uploads them from the review below the charts.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { PHASE_LENGTHS, TEST_DURATIONS_S, DEFAULT_TEST_S, durationLabel, settingsWarnings } from '../../lib/phaseSettings'
import { runLabel } from '../../lib/ssaPhases'
import { planSentence } from '../../lib/phaseUpload'

const C = {
  card: '#071624', border: '#1E3A5A', accent: '#06B6D4', dim: '#94A3B8',
  head: '#E2E8F0', warn: '#F59E0B', ok: '#10B981', quiet: '#64748B',
}
const btn = on => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
  border: `1px solid ${on ? C.accent : C.border}`, background: on ? '#06B6D420' : C.card, color: on ? C.accent : C.dim,
})
const field = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 6px', color: C.head, fontSize: 11 }
const label = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.quiet }
const hms = (utc, tz) => new Date(utc + (tz || 0) * 60000).toISOString().slice(11, 19)

export default function PhasePanel({
  source, onSource, mergeMode, onMergeMode,
  settings, onSettings,
  counts = { event: 0, ssa: 0, manoeuvres: 0 },
  sections = [], hiddenSections = [], onToggleSection = null,
  build = null,                       // last build: { reasons, rejected, phases }
  runs = [], onDeleteRun = null, onJumpRun = null,
  selection = null,                   // [utc0, utc1] picked on the track
  onBuildSelection = null,
  test = null,                        // { startUtc, plannedS } while one is running
  onTestStart = null, onTestStop = null,
  playUtc = null, tzOffsetMin = 0,
  canBuild = false, canUpload = false, roleNote = null, resolutionNote = null,
  tagOptions = [],
  asideCount = 0, onRestoreAside = null,
  settingsMeta = null,                // { source, updatedAt, saveForBoat }
  uploadPlan = null, onUpload = null, upload = null,
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [testS, setTestS] = React.useState(DEFAULT_TEST_S)
  const [uploadMode, setUploadMode] = React.useState('add')
  const [savingSettings, setSavingSettings] = React.useState(null)   // error text, or ''
  const warnings = settingsWarnings(settings)
  const set = patch => onSettings?.({ ...settings, ...patch })
  const setGate = patch => onSettings?.({ ...settings, gate: { ...settings.gate, ...patch } })
  const hasSsa = counts.ssa > 0 || counts.manoeuvres > 0

  const sources = [
    ['event', `Event file · ${counts.event}`],
    ['ssa', `SSA · ${counts.ssa}${counts.manoeuvres ? ` +${counts.manoeuvres} man.` : ''}`],
    ['both', 'Both'],
  ]

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 10, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.head, letterSpacing: 1, textTransform: 'uppercase' }}>Phases</span>
        {sources.map(([v, text]) => (
          <button key={v} onClick={() => onSource?.(v)} aria-pressed={source === v}
            disabled={v === 'ssa' && !hasSsa} style={{ ...btn(source === v), opacity: v === 'ssa' && !hasSsa ? 0.4 : 1 }}>
            {text}
          </button>
        ))}
        {source === 'both' && (
          <label style={label}>
            Where they overlap
            <select value={mergeMode} aria-label="Where the sources overlap" onChange={e => onMergeMode?.(e.target.value)} style={{ ...field, cursor: 'pointer' }}>
              <option value="add">keep the event phase</option>
              <option value="override">keep the SSA phase</option>
            </select>
          </label>
        )}
        {/* Which sections are in the comparison. All of them, until somebody says
            otherwise — switching one off takes it out of the charts without losing
            the stretch itself. */}
        {sections.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 1, height: 18, background: C.border, margin: '0 2px' }} />
            {sections.map(sec => {
              const on = !hiddenSections.includes(sec.id)
              return (
                <button key={sec.id} onClick={() => onToggleSection?.(sec.id)} aria-pressed={on}
                  aria-label={`Section ${sec.n}`} title={`Section ${sec.n}${on ? '' : ' — hidden'}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
                    borderRadius: 6, padding: '4px 9px', cursor: 'pointer',
                    border: `1px solid ${on ? sec.color : C.border}`,
                    background: on ? `${sec.color}1f` : C.card, color: on ? C.head : C.quiet,
                  }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: sec.color, opacity: on ? 1 : 0.35 }} aria-hidden />
                  {sec.n}
                </button>
              )
            })}
          </span>
        )}
        <button onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ ...btn(open), marginLeft: 'auto' }}>
          {open ? '▾' : '▸'} Settings
        </button>
      </div>

      {asideCount > 0 && (
        <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>
          {asideCount} SSA phase{asideCount === 1 ? '' : 's'} set aside when the event file was imported — kept, not charted.
          {onRestoreAside && (
            <button onClick={onRestoreAside} style={{ ...btn(false), fontSize: 10, padding: '2px 8px', marginLeft: 8 }}>
              Bring them back
            </button>
          )}
        </div>
      )}
      {roleNote && <div style={{ fontSize: 10, color: C.quiet, marginTop: 6 }}>{roleNote}</div>}
      {resolutionNote && <div style={{ fontSize: 11, color: C.warn, marginTop: 6 }}>⚠ {resolutionNote}</div>}

      {/* ── Build from a selection, or run a timed test ───────────────────── */}
      {canBuild && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <input value={name} onChange={e => setName(e.target.value)} list="ssa-phase-tags"
            placeholder="Name this run — e.g. J1.5 vs J2, race 3 beat"
            aria-label="Run name" style={{ ...field, flex: '1 1 220px', minWidth: 160 }} />
          <datalist id="ssa-phase-tags">{tagOptions.map(t => <option key={t} value={t} />)}</datalist>

          {test ? (
            <>
              <span style={{ fontSize: 11, color: C.accent }}>
                ● Generating from {hms(test.startUtc, tzOffsetMin)} · {durationLabel(test.plannedS)} planned
              </span>
              <button onClick={() => onTestStop?.(name)} style={{ ...btn(true), borderColor: C.ok, color: C.ok }}>■ Stop</button>
            </>
          ) : (
            <>
              <button onClick={() => onBuildSelection?.(name)} disabled={!selection}
                title={selection ? undefined : 'Select a stretch of the track first (✂ Select section on the map)'}
                style={{ ...btn(!!selection), opacity: selection ? 1 : 0.45 }}>
                ✂ Phases from the selection
              </button>
              <label style={label}>
                Duration
                <select value={testS} aria-label="Duration" onChange={e => setTestS(Number(e.target.value))} style={{ ...field, cursor: 'pointer' }}>
                  {TEST_DURATIONS_S.map(sec => <option key={sec} value={sec}>{durationLabel(sec)}</option>)}
                </select>
              </label>
              <button onClick={() => onTestStart?.(testS, name)} disabled={playUtc == null}
                title={playUtc == null ? 'Put the timeline where the stretch starts' : undefined}
                style={{ ...btn(playUtc != null), opacity: playUtc == null ? 0.45 : 1 }}>
                ▶ Generate phases
              </button>
              {/* Coach and up: the same upload the review below describes, next to the
                  button that made the phases — which is where somebody is looking when
                  they decide these are worth keeping. The mode and what it will do stay
                  visible below, so this is a shortcut, not a hidden decision. */}
              {canUpload && uploadPlan && hasSsa && (
                <button onClick={() => onUpload?.(uploadMode)} disabled={upload?.state === 'busy'}
                  title={`${planSentence(uploadPlan(uploadMode))} · ${uploadMode === 'add' ? 'added to' : 'overriding'} the event file's phases`}
                  style={{ ...btn(true), opacity: upload?.state === 'busy' ? 0.6 : 1 }}>
                  {upload?.state === 'busy' ? '☁ Saving…' : '☁ Save to the SSA phase database'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── What the last build made of the log ───────────────────────────── */}
      {build && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.dim }}>
          <span style={{ color: C.ok }}>✓ {build.phases?.length || 0} kept</span>
          {build.rejected?.length ? <span> · {build.rejected.length} refused</span> : null}
          {build.reasons?.length ? (
            <span style={{ color: C.quiet }}>
              {' · '}{build.reasons.slice(0, 4).map(r => `${r.n} ${r.reason}`).join(' · ')}
            </span>
          ) : null}
        </div>
      )}

      {/* ── Upload to the team (coach and up) ─────────────────────────────── */}
      {canUpload && uploadPlan && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={label}>
            Where these overlap the event file
            <select value={uploadMode} aria-label="Upload mode" onChange={e => setUploadMode(e.target.value)} style={{ ...field, cursor: 'pointer' }}>
              <option value="add">add to the event phases</option>
              <option value="override">override the event phases</option>
            </select>
          </label>
          <span style={{ fontSize: 10, color: C.quiet, flex: '1 1 200px' }}>{planSentence(uploadPlan(uploadMode))}</span>
          <button onClick={() => onUpload?.(uploadMode)} disabled={upload?.state === 'busy'}
            style={{ ...btn(true), opacity: upload?.state === 'busy' ? 0.6 : 1 }}>
            {upload?.state === 'busy' ? '☁ Uploading…' : '☁ Upload to the team'}
          </button>
          {upload && upload.state !== 'busy' && (
            <span style={{ fontSize: 11, color: upload.state === 'ok' ? C.ok : C.warn }}>
              {upload.state === 'ok' ? '✓ ' : '⚠ '}{upload.message}
            </span>
          )}
        </div>
      )}

      {/* ── Runs ──────────────────────────────────────────────────────────── */}
      {runs.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {runs.map(r => (
            <span key={r.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: C.head,
              border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 4px 2px 9px',
            }}>
              <button onClick={() => onJumpRun?.(r)} title="Jump to this run"
                style={{ background: 'none', border: 'none', color: C.head, cursor: 'pointer', fontSize: 10, padding: 0 }}>
                {runLabel(r)} <span style={{ color: C.quiet }}>· {hms(r.from, tzOffsetMin)}</span>
              </button>
              {canBuild && onDeleteRun && (
                <button onClick={() => onDeleteRun(r)} aria-label={`Delete run ${runLabel(r)}`}
                  style={{ background: 'none', border: 'none', color: C.quiet, cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>×</button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* ── Settings ──────────────────────────────────────────────────────── */}
      {open && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={label}>
              Phase
              <select value={settings.phaseLenS} onChange={e => set({ phaseLenS: Number(e.target.value) })} style={{ ...field, cursor: 'pointer' }}>
                {PHASE_LENGTHS.map(s => <option key={s} value={s}>{s} s</option>)}
              </select>
            </label>
            <label style={label}>
              Guard before / after a manoeuvre
              <input type="number" min={0} max={300} value={settings.guardBeforeS} aria-label="Guard before"
                onChange={e => set({ guardBeforeS: Number(e.target.value) })} style={{ ...field, width: 56 }} />
              <input type="number" min={0} max={300} value={settings.guardAfterS} aria-label="Guard after"
                onChange={e => set({ guardAfterS: Number(e.target.value) })} style={{ ...field, width: 56 }} />
              s
            </label>
            <label style={label}>
              <input type="checkbox" checked={settings.manoeuvrePhases}
                onChange={e => set({ manoeuvrePhases: e.target.checked })} />
              Keep tacks &amp; gybes as phases (calibration)
            </label>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
            {[
              ['AWA', 'awaDriftMaxDeg', 'awaSpreadMaxDeg', '°'],
              ['TWS', 'twsDriftMaxKn', 'twsSpreadMaxKn', ' kn'],
              ['BSP', 'bspDriftMaxKn', 'bspSpreadMaxKn', ' kn'],
            ].map(([name_, driftKey, spreadKey, unit]) => (
              <label key={name_} style={label}>
                {name_} drift / swing
                <input type="number" step="0.5" value={settings.gate[driftKey]} aria-label={`${name_} drift`}
                  onChange={e => setGate({ [driftKey]: Number(e.target.value) })} style={{ ...field, width: 52 }} />
                <input type="number" step="0.5" value={settings.gate[spreadKey]} aria-label={`${name_} swing`}
                  onChange={e => setGate({ [spreadKey]: Number(e.target.value) })} style={{ ...field, width: 52 }} />
                {unit}
              </label>
            ))}
            <label style={label}>
              Turn
              <input type="number" step="0.5" value={settings.gate.rotMaxDegS} aria-label="Rate of turn"
                onChange={e => setGate({ rotMaxDegS: Number(e.target.value) })} style={{ ...field, width: 52 }} />
              °/s
            </label>
          </div>

          {settingsMeta && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 10, color: C.quiet }}>
              <span>
                {settingsMeta.source === 'boat'
                  ? `The boat's numbers${settingsMeta.updatedAt ? ` · saved ${new Date(settingsMeta.updatedAt).toLocaleDateString()}` : ''}`
                  : settingsMeta.source === 'device' ? 'Changed on this device only' : 'App defaults'}
              </span>
              {canUpload && settingsMeta.saveForBoat && (
                <button onClick={async () => setSavingSettings(await settingsMeta.saveForBoat() || '')}
                  style={{ ...btn(false), fontSize: 10, padding: '2px 8px' }}>
                  Save for the boat
                </button>
              )}
              {savingSettings === '' && <span style={{ color: C.ok }}>✓ saved for the boat</span>}
              {savingSettings && <span style={{ color: C.warn }}>⚠ {savingSettings}</span>}
            </div>
          )}
          {warnings.map(w => (
            <div key={w} style={{ fontSize: 10, color: C.warn, marginTop: 6 }}>⚠ {w}</div>
          ))}
          <div style={{ fontSize: 9, color: C.quiet, marginTop: 8, lineHeight: 1.5 }}>
            A phase is refused when its end no longer looks like its start — the mean of its last third against
            its first third. Swing is a guard rail, not the test: a masthead unit swinging in a seaway is what
            averaging is for. The point of sail is read from AWA, never heading, because a wind shift under the
            autopilot turns the boat without changing the sailing.
          </div>
        </div>
      )}
    </div>
  )
}
