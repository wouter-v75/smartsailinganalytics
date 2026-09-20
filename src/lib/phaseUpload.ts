// Putting a day's built phases in front of the team.
//
// The upload is not a merge. Both sides are kept — the event file's phases stay exactly
// as they arrived, the built ones go up as their own set — and the CHOICE of what wins
// where they overlap is recorded beside them. That is what makes it reversible: a later
// coach can see that an upload was made in 'override' mode, what it stood down, and put
// it back.

import { mergePhases, resolutionOf, type MergeMode, type PhaseRun } from './ssaPhases'
import type { BuiltPhase } from './buildPhases'
import type { PhaseSettings } from './phaseSettings'
import type { Phase } from './phaseStats'

export interface UploadPlan {
  mode: MergeMode
  toUpload: BuiltPhase[]
  overlapping: number      // built phases that cover the same water as an event phase
  standDownEvent: number   // event phases 'override' would set aside
  manoeuvres: number
}

// What an upload would do, before anybody presses the button. Shown as a sentence, not
// a diff: the question a coach is answering is "whose phases win here?".
export function planUpload(
  eventPhases: Phase[] | null | undefined,
  builtPhases: BuiltPhase[] | null | undefined,
  mode: MergeMode
): UploadPlan {
  const built = builtPhases || []
  const m = mergePhases(eventPhases, built, mode)
  const clashing = new Set(m.overlaps.map(o => o.ssaUtc))
  return {
    mode,
    // In 'add' the overlapping ones are not uploaded at all: they would be a second
    // average of seconds the event file already covers.
    toUpload: mode === 'add' ? built.filter(p => p.kind !== 'steady' || !clashing.has(p.utc)) : built,
    overlapping: clashing.size,
    standDownEvent: mode === 'override' ? m.droppedEvent : 0,
    manoeuvres: built.filter(p => p.kind !== 'steady').length,
  }
}

export interface UploadResult {
  ok: boolean
  error?: string
  needsMigration?: boolean
  set?: { id: string; phase_count: number; created_at: string }
}

export async function uploadPhaseSet(
  teamId: string,
  boatId: string,
  date: string,
  payload: {
    plan: UploadPlan
    eventPhases: Phase[] | null | undefined
    builtPhases: BuiltPhase[]
    runs: PhaseRun[]
    settings: PhaseSettings
    note?: string
    userId?: string | null
  }
): Promise<UploadResult> {
  const { plan, eventPhases, builtPhases, runs, settings, note, userId } = payload
  if (!plan.toUpload.length) return { ok: false, error: 'nothing to upload — every phase is covered by the event file' }
  const merged = mergePhases(eventPhases, builtPhases, plan.mode)
  try {
    const res = await fetch(`/api/teams/${teamId}/boats/${boatId}/phases/${date}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phases: plan.toUpload,
        runs,
        settings,
        mode: plan.mode,
        resolution: resolutionOf(merged, plan.mode, userId),
        note: note || null,
      }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j?.set?.id) {
      return {
        ok: false,
        needsMigration: !!j?.needsMigration,
        error: j?.error === 'unauth'
          ? 'not signed in — sign in again'
          : j?.error || `the server answered ${res.status}`,
      }
    }
    return { ok: true, set: j.set }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not reach the server' }
  }
}

// One sentence describing what pressing Upload will do.
export function planSentence(plan: UploadPlan): string {
  const n = plan.toUpload.length
  const bits = [`${n} phase${n === 1 ? '' : 's'}`]
  if (plan.manoeuvres) bits.push(`${plan.manoeuvres} of them tacks or gybes, kept for calibration`)
  if (plan.mode === 'add' && plan.overlapping) {
    bits.push(`${plan.overlapping} left out where the event file already covers the same seconds`)
  }
  if (plan.mode === 'override' && plan.standDownEvent) {
    bits.push(`${plan.standDownEvent} event-file phase${plan.standDownEvent === 1 ? '' : 's'} stood aside in those ranges`)
  }
  return bits.join(' · ')
}

// ── Reading a set back ──────────────────────────────────────────────────────
// This route had a POST and no caller for its GET: uploadPhaseSet() put a set
// in front of the team and NOTHING in the app ever asked for one. A coach's
// upload reached the database and stopped there — the same shape as the
// device-locality traps in CLAUDE.md, where data reaches the cloud and the app
// never reads it back.

export interface ActivePhaseSet {
  id: string
  date: string
  source: string | null
  phase_len_s: number | null
  phase_count: number
  resolution_mode: string | null
  note: string | null
  created_at: string
  created_by_user_id: string | null
  settings: PhaseSettings | null
  runs: PhaseRun[]
  phases: BuiltPhase[]
}

export interface PhaseSetHistoryRow {
  id: string
  phase_count: number
  created_at: string
  created_by_user_id: string | null
  note: string | null
}

/**
 * The phase set in force for this session, and the ones stood down before it.
 * Returns nulls rather than throwing: a team with no uploaded set is the normal
 * case, and so is a browser that is offline.
 */
export async function fetchPhaseSets(
  teamId: string,
  boatId: string,
  date: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ active: ActivePhaseSet | null; history: PhaseSetHistoryRow[]; needsMigration?: boolean }> {
  try {
    const res = await fetchImpl(`/api/teams/${teamId}/boats/${boatId}/phases/${date}`)
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return { active: null, history: [], needsMigration: !!j?.needsMigration }
    return {
      active: j?.active ?? null,
      history: Array.isArray(j?.history) ? j.history : [],
    }
  } catch {
    return { active: null, history: [] }
  }
}

