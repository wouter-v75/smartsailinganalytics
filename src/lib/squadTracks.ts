// src/lib/squadTracks.ts
// ─────────────────────────────────────────────────────────────────────────────
// The OTHER boats that sailed the same day.
//
// A squad trains together, and almost every question a dinghy coach asks is
// comparative — who was higher, who was faster, who came out of the tack ahead.
// The analytics map showed one boat because SSA grew up around one boat; this
// fetches the rest of the team's tracks for the same date so they can be drawn
// alongside and switched on and off.
//
// It reads through the SAME per-boat session route the active boat uses, so RLS
// decides what comes back: a sailor sees the boats their membership covers and
// no more. There is deliberately no service-key path here.
//
// Tracks are thinned hard. Six boats at 10 Hz is millions of points, and a
// reference track only has to show WHERE a boat went — the active boat keeps its
// full resolution and its colour modes.
// ─────────────────────────────────────────────────────────────────────────────

export interface SquadTrackRow { utc: number; lat: number; lon: number }

export interface SquadTrack {
  boatId: string
  boatName: string
  sailNumber: string | null
  rows: SquadTrackRow[]
  /** Stable per boat, so a boat keeps its colour across sessions. */
  colour: string
}

/**
 * Distinct from the track-colour ramps, which mean speed or VMG. These are
 * identity colours and must not be read as a value.
 */
export const SQUAD_COLOURS = [
  '#F472B6', '#A78BFA', '#34D399', '#FBBF24', '#60A5FA',
  '#FB923C', '#22D3EE', '#A3E635',
]

/** Same boat, same colour, every day — from the id, not the load order. */
export function colourForBoat(boatId: string): string {
  let h = 0
  for (let i = 0; i < boatId.length; i++) h = (h * 31 + boatId.charCodeAt(i)) >>> 0
  return SQUAD_COLOURS[h % SQUAD_COLOURS.length]
}

/** One point per `stepMs`, keeping the first of each bucket. */
export function thinTrack(rows: any[], stepMs = 4000): SquadTrackRow[] {
  const out: SquadTrackRow[] = []
  let bucket = -Infinity
  for (const r of rows || []) {
    const lat = r?.lat, lon = r?.lon, utc = r?.utc
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(utc)) continue
    const b = Math.floor(utc / stepMs)
    if (b === bucket) continue
    bucket = b
    out.push({ utc, lat, lon })
  }
  return out
}

export interface LoadOpts {
  teamId: string
  date: string
  /** The boat already on screen — excluded, it is drawn at full resolution. */
  excludeBoatId?: string | null
  stepMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Every other boat in the team that has a session with a track on this date.
 * Boats without one are simply absent — this is not an error path.
 */
export async function loadSquadTracks(opts: LoadOpts): Promise<SquadTrack[]> {
  const f = opts.fetchImpl || fetch
  let boats: Array<{ id: string; name: string; sail_number: string | null }> = []
  try {
    const res = await f(`/api/teams/${opts.teamId}/boats`)
    if (!res.ok) return []
    const j = await res.json()
    boats = j?.boats || j || []
  } catch { return [] }

  const others = boats.filter((b) => b.id && b.id !== opts.excludeBoatId)
  const loaded = await Promise.all(others.map(async (b) => {
    try {
      const res = await f(`/api/teams/${opts.teamId}/boats/${b.id}/sessions/${opts.date}`)
      if (!res.ok) return null
      const j = await res.json()
      const rows = thinTrack(j?.session?.log_data?.rows || j?.log_data?.rows || [], opts.stepMs)
      if (rows.length < 2) return null
      return {
        boatId: b.id,
        boatName: b.name,
        sailNumber: b.sail_number ?? null,
        rows,
        colour: colourForBoat(b.id),
      } as SquadTrack
    } catch { return null }
  }))

  return loaded
    .filter((t): t is SquadTrack => t != null)
    .sort((a, b) => a.boatName.localeCompare(b.boatName))
}
