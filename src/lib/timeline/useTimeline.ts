'use client'
import { useCallback, useEffect, useState } from 'react'
import type { TimelineNode } from './types'

// Fetch a boat's timeline nodes (optionally one day) from /api/teams/[teamId]/timeline.
// nodes === null while loading. Returns { nodes, error, reload }.
export function useTimeline(teamId?: string | null, boatId?: string | null, date?: string | null) {
  const [nodes, setNodes] = useState<TimelineNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!teamId || !boatId) { setNodes([]); return }
    setNodes(null); setError(null)
    const u = new URL(`/api/teams/${teamId}/timeline`, window.location.origin)
    u.searchParams.set('boat_id', boatId)
    if (date) u.searchParams.set('date', date)
    fetch(u.toString())
      .then((r) => r.json())
      .then((j) => {
        if (j?.error) throw new Error(j.error)
        setNodes(Array.isArray(j?.nodes) ? j.nodes : [])
      })
      .catch((e) => { setError(String(e?.message || e)); setNodes([]) })
  }, [teamId, boatId, date])

  useEffect(() => { load() }, [load])
  return { nodes, error, reload: load }
}
