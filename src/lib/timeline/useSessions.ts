'use client'
import { useEffect, useState } from 'react'
import type { SessionRec } from './buildCampaignTree'

// The campaign spine: every synced session (training day + event) for the boat,
// with video/photo counts. Cloud-authoritative (RLS-gated) — no local dependency.
export function useSessions(teamId?: string | null, boatId?: string | null): SessionRec[] | null {
  const [sessions, setSessions] = useState<SessionRec[] | null>(null)
  useEffect(() => {
    if (!teamId || !boatId) { setSessions([]); return }
    let alive = true
    setSessions(null)
    fetch(`/api/teams/${teamId}/boats/${boatId}/sessions`)
      .then((r) => r.json())
      .then((j) => { if (alive) setSessions(Array.isArray(j?.sessions) ? j.sessions : []) })
      .catch(() => { if (alive) setSessions([]) })
    return () => { alive = false }
  }, [teamId, boatId])
  return sessions
}
