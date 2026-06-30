// src/lib/boatConfigPrefetch.ts
// ─────────────────────────────────────────────────────────────────────────────
// Eager warm-up for the Boat Config tab. Called on app open (once the active
// membership is known) so the sail inventory, scans, polar and rig baseline are
// already in memory before the user clicks the tab — BoatConfigTab seeds its
// state from this cache for an instant render, then revalidates in the
// background via its own effects. Module-level cache, team+boat scoped.
// ─────────────────────────────────────────────────────────────────────────────

export interface BoatConfigCache {
  sails?: any[]
  scans?: any[]
  polar?: any
  rigTune?: any
  at: number
}

const store = new Map<string, BoatConfigCache>()
const key = (t: string, b: string) => `${t}::${b}`
const FRESH_MS = 30_000

export async function prefetchBoatConfig(teamId?: string | null, boatId?: string | null): Promise<void> {
  if (!teamId || !boatId) return
  const k = key(teamId, boatId)
  const cur = store.get(k)
  if (cur && Date.now() - cur.at < FRESH_MS) return // already warm
  try {
    const [s, sc, p, rt] = await Promise.all([
      fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=40`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/teams/${teamId}/polars?boat_id=${boatId}&active=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/teams/${teamId}/rig-tunes?boat_id=${boatId}&active=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    store.set(k, {
      sails: s?.sails,
      scans: sc?.scans,
      polar: (p?.polars || [])[0] || null,
      rigTune: (rt?.rigTunes || [])[0] || null,
      at: Date.now(),
    })
  } catch {
    /* non-fatal — the tab's own effects will still fetch on open */
  }
}

export function getPrefetchedBoatConfig(teamId?: string | null, boatId?: string | null): BoatConfigCache | null {
  if (!teamId || !boatId) return null
  return store.get(key(teamId, boatId)) || null
}
