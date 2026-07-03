// timeline/types.ts — the Timeline Tree node model (Phase 2 spine).
// One typed, timestamped node per moment of a racing programme. Structural nodes
// (season→regatta→day→race) give the semantic-zoom hierarchy; event nodes hang
// off a race/day. Every node carries its own time window (point events set
// t1===t0) so the same tree renders as the season timeline, the vertical day
// feed, and the race scrubber. See docs/regatta-os-spec-and-plan-2026-07.md.

export type NodeKind =
  // structural (the zoom hierarchy)
  | 'season' | 'regatta' | 'day' | 'race'
  // race events
  | 'start' | 'tack' | 'gybe' | 'mark' | 'finish'
  // day events
  | 'sail_change' | 'weather' | 'meeting' | 'note' | 'debrief' | 'analysis'

export type NodeSource = 'auto' | 'human' | 'ai'

export interface TimelineNode {
  id: string // deterministic → producers upsert idempotently
  parentId: string | null // tree edge; children hang off it
  kind: NodeKind
  t0: number // UTC ms (structural nodes span children)
  t1: number // UTC ms (point events: t1 === t0)
  title: string
  subtitle?: string
  source: NodeSource
  producer: string // 'eventfile' | 'icon' | 'log' | 'sailscan' | 'user' | 'ai'
  metrics?: Record<string, number> // denormalised for fast query/painting
  meta?: Record<string, unknown> // e.g. { raceNum, top, valid, sails }
}
