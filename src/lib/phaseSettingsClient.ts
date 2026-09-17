// The boat's phase thresholds, from the cloud when they are there and from this device
// when they are not.
//
// Order matters: a boat's stored settings beat whatever this laptop last used, because
// the numbers decide what is allowed to become performance data and the team should be
// judging every day by the same ones. The local copy is a fallback for an offline
// device, and for a team that has not set any yet.

import { withSettings, type PhaseSettings } from './phaseSettings'

const key = (boatId: string) => `ssa:phase-settings:${boatId}`

export function readLocalSettings(boatId?: string | null): PhaseSettings | null {
  if (!boatId) return null
  try {
    const raw = localStorage.getItem(key(boatId))
    return raw ? withSettings(JSON.parse(raw)) : null
  } catch { return null }
}

export function writeLocalSettings(boatId: string | null | undefined, settings: PhaseSettings): void {
  try { if (boatId) localStorage.setItem(key(boatId), JSON.stringify(settings)) } catch { /* private window */ }
}

export interface BoatSettingsState {
  settings: PhaseSettings
  source: 'boat' | 'device' | 'default'
  updatedAt: string | null
  needsMigration: boolean
}

export async function fetchBoatPhaseSettings(teamId: string, boatId: string): Promise<BoatSettingsState> {
  const local = readLocalSettings(boatId)
  const fallback: BoatSettingsState = {
    settings: local || withSettings(), source: local ? 'device' : 'default', updatedAt: null, needsMigration: false,
  }
  try {
    const res = await fetch(`/api/teams/${teamId}/boats/${boatId}/phase-settings`)
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return { ...fallback, needsMigration: !!j?.needsMigration }
    if (!j?.settings) return fallback
    return { settings: withSettings(j.settings), source: 'boat', updatedAt: j.updatedAt ?? null, needsMigration: false }
  } catch {
    return fallback
  }
}

// Coach and up (the database says so too). Returns the error to show, or null.
export async function saveBoatPhaseSettings(
  teamId: string, boatId: string, settings: PhaseSettings
): Promise<string | null> {
  try {
    const res = await fetch(`/api/teams/${teamId}/boats/${boatId}/phase-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return j?.error === 'unauth' ? 'not signed in' : j?.error || `the server answered ${res.status}`
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'could not reach the server'
  }
}
