'use client'
// src/components/photos/useLidarForPhoto.ts
// ─────────────────────────────────────────────────────────────────────────────
// The boat's own lidar reading at the second a photograph was taken, for the
// columns beside the photographed sail shape.
//
// It returns null far more often than not, and each of those is deliberate:
// no session date, no active boat, a photo of a RIVAL, a day with no stored
// phases, a boat with no lidar, or a shutter that fell too far from any phase.
// A column of dashes reads as a missing measurement; no column reads as what it
// is, which is equipment that was never there.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { getActiveMembership } from '../../lib/active-membership'
import { expandPhases, type StoredPhase } from '../../lib/seasonCurves'
import type { PhaseStat } from '../../lib/phaseStats'
import {
  photoInstantMs, phaseAt, phaseHasLidar, lidarAppliesTo, toLogClockMs,
} from '../../lib/sailTrimLidar'

/**
 * How far from a phase a shutter may fall and still be described by it.
 *
 * A phase is 30 s. Minutes away is a different piece of sailing — the sheet and
 * the traveller have moved — so a disagreement would be trim, not measurement.
 */
export const MAX_GAP_MS = 45_000

/** One day's phases, so opening five photos on a day is one request. */
const cache = new Map<string, PhaseStat[]>()
let userIdOnce: Promise<string | null> | null = null

/** Exported for tests, which would otherwise leak a day into each other. */
export function clearLidarCache() { cache.clear(); userIdOnce = null }

/**
 * The signed-in user, resolved here rather than threaded down as a prop.
 *
 * PhotosTab holds no user id — it asks Supabase inside each async call — and
 * adding one would mean new state in a .jsx file that `tsc` does not check.
 * Asked once per page, because every photo card would otherwise ask again.
 */
function currentUserId(): Promise<string | null> {
  if (!userIdOnce) {
    userIdOnce = (async () => {
      try {
        const { getBrowserSupabase } = await import('../../lib/supabase/browser')
        const { data } = await getBrowserSupabase().auth.getUser()
        return data?.user?.id ?? null
      } catch { return null }
    })()
  }
  return userIdOnce
}

async function loadDay(teamId: string, boatId: string, date: string): Promise<PhaseStat[]> {
  const key = `${teamId}/${boatId}/${date}`
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const r = await fetch(`/api/teams/${teamId}/boats/${boatId}/phase-stats/${date}?full=1`)
    if (!r.ok) { cache.set(key, []); return [] }
    const j = (await r.json()) as { stats?: { phases?: StoredPhase[] } | null }
    const out = expandPhases(j.stats?.phases ?? [])
    cache.set(key, out)
    return out
  } catch {
    // Offline is not "no lidar", but it is "nothing to show", and the columns
    // simply do not appear. Not cached, so it is retried on the next photo.
    return []
  }
}

export function useLidarForPhoto({
  sessionDate,
  takenUtc,
  measuredAs,
  tzOffsetMin = null,
}: {
  /** The session's own date. Passed in rather than derived from the timestamp:
   *  a session date is the VENUE's day and an instant is UTC, and deriving one
   *  from the other is how a late-evening photo lands on the wrong day. */
  sessionDate?: string | null
  takenUtc?: string | number | null
  /** The boat the frame was MEASURED as. */
  measuredAs?: string | null
  /**
   * The VENUE's offset, minutes east of UTC — the session's own
   * tz_offset_minutes, which PhotosTab already holds as sessionTzOffset.
   *
   * Required, and null means no columns rather than a guess of zero. A phase's
   * timestamp is venue-local wall time in epoch clothing (flatLogParse builds it
   * with Date.UTC) and a photo's is a true instant; assuming they agree does not
   * show up as an error, it shows up as the WRONG phase quietly printed beside
   * the photograph.
   */
  tzOffsetMin?: number | null
}): PhaseStat | null {
  const [phase, setPhase] = useState<PhaseStat | null>(null)

  useEffect(() => {
    let dead = false
    setPhase(null)
    const at = photoInstantMs(takenUtc)
    if (!sessionDate || at == null || tzOffsetMin == null) return
    const atLogClock = toLogClockMs(at, tzOffsetMin)

    void (async () => {
      const userId = await currentUserId()
      if (dead || !userId) return
      const m = getActiveMembership(userId)
      if (!m?.boat_id) return
      // Our lidar describes our rig, so a rival's photograph gets no columns.
      if (!lidarAppliesTo(measuredAs, m.boat_name)) return

      const phases = await loadDay(m.team_id, m.boat_id, sessionDate)
      if (dead || !phases.length) return
      const hit = phaseAt(phases, atLogClock)
      if (!hit || hit.gapMs > MAX_GAP_MS) return
      if (!phaseHasLidar(hit.phase)) return
      setPhase(hit.phase)
    })()
    return () => { dead = true }
  }, [sessionDate, takenUtc, measuredAs, tzOffsetMin])

  return phase
}
