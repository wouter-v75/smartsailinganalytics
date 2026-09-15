// src/lib/tagging/baseTags.ts
// ─────────────────────────────────────────────────────────────────────────────
// The base vocabulary — the tags SSA already uses, promoted to first-class tag
// definitions so the tagger starts full rather than empty.
//
// Three sources, all of them already in the app:
//   • racingTags.ts       the racing moments worth finding footage of
//   • computeAutoTags()   what the log + event file infer (point of sail, wind
//                         band, manoeuvres, race vs training)
//   • DayPhases.tsx       the shape of a sailing day (sail call, debrief, …)
//
// Plus a starter set per CREW SECTION, because a section tag list nobody has
// written yet is a section tag list nobody uses.
//
// Seeding is idempotent: every base tag carries `builtin: true` and a stable
// slug, and the seed route upserts on (team, boat, scope, section, slug).
// ─────────────────────────────────────────────────────────────────────────────

import { RACING_TAGS, RACE_RED } from '../racingTags'
import { CREW_SECTIONS } from './sections'
import type { TagKind, TagScope } from './types'

export interface BaseTag {
  slug: string
  label: string
  color: string
  scope: TagScope
  section: string | null
  kind: TagKind
  minRole: string
  sort: number
}

const POS_C = '#1D9E75'   // point of sail
const WIND_C = '#06B6D4'  // breeze bands
const MANO_C = '#7F77DD'  // manoeuvres
const DAY_C = '#F59E0B'   // day structure

const mk = (
  slug: string,
  label: string,
  color: string,
  opts: Partial<Omit<BaseTag, 'slug' | 'label' | 'color'>> = {}
): BaseTag => ({
  slug,
  label,
  color,
  scope: opts.scope ?? 'general',
  section: opts.section ?? null,
  kind: opts.kind ?? 'point',
  minRole: opts.minRole ?? 'tl1',
  sort: opts.sort ?? 100,
})

// ── General: the racing moments (racingTags.ts, verbatim) ───────────────────
const RACING: BaseTag[] = Object.entries(RACING_TAGS).map(([slug, label], i) =>
  mk(slug, label, RACE_RED, { sort: 10 + i })
)

// ── General: what computeAutoTags already emits ─────────────────────────────
const AUTO: BaseTag[] = [
  mk('upwind', 'Upwind', POS_C, { kind: 'range', sort: 30 }),
  mk('reach', 'Reach', POS_C, { kind: 'range', sort: 31 }),
  mk('downwind', 'Downwind', POS_C, { kind: 'range', sort: 32 }),
  mk('tack', 'Tack', '#1D9E75', { sort: 40 }),
  mk('gybe', 'Gybe', MANO_C, { sort: 41 }),
  mk('mark', 'Mark', '#F59E0B', { sort: 42 }),
  mk('race', 'Race', '#D85A30', { kind: 'range', sort: 50 }),
  mk('training', 'Training', '#94A3B8', { kind: 'range', sort: 51 }),
  mk('light-air', 'Light air', WIND_C, { kind: 'range', sort: 60 }),
  mk('breeze-on', 'Breeze on', WIND_C, { kind: 'range', sort: 61 }),
]

// ── General: the day's own structure (the DayPhases rows) ───────────────────
const DAY: BaseTag[] = [
  mk('dock-out', 'Dock out', DAY_C, { sort: 70 }),
  mk('dock-in', 'Dock in', DAY_C, { sort: 71 }),
  mk('warning-signal', 'Warning signal', DAY_C, { sort: 72 }),
  mk('sail-change', 'Sail change', DAY_C, { sort: 73 }),
  mk('lineup', 'Line-up', '#2DD4BF', { kind: 'range', sort: 74 }),
  mk('test', 'Test / mode change', '#2DD4BF', { kind: 'range', sort: 75 }),
  mk('incident', 'Incident', '#EF4444', { sort: 80 }),
  mk('gear-damage', 'Gear damage', '#EF4444', { sort: 81 }),
  mk('review', 'Review this', '#8B5CF6', { sort: 90 }),
]

// ── Section starters: one short list per crew section ────────────────────────
const SECTION_STARTERS: Record<string, [string, string][]> = {
  afterguard: [['call-good', 'Good call'], ['call-late', 'Late call'], ['laneloss', 'Lost the lane']],
  navigation: [['shift-left', 'Left shift'], ['shift-right', 'Right shift'], ['current', 'Current effect']],
  helm: [['steer-mode', 'Mode change'], ['overstand', 'Overstood'], ['low-fast', 'Low & fast']],
  trim: [['main-trim', 'Main trim'], ['jib-trim', 'Jib trim'], ['kite-trim', 'Kite trim'], ['twist', 'Twist change']],
  pit: [['hoist', 'Hoist'], ['drop', 'Drop'], ['pit-slow', 'Slow through the pit']],
  mast: [['halyard', 'Halyard issue'], ['stack', 'Stack move']],
  bow: [['peel', 'Peel'], ['bow-late', 'Late to the bow'], ['tack-line', 'Tack line']],
  grinders: [['gear-change', 'Gear change'], ['pedestal', 'Pedestal swap']],
  coaching: [['coach-note', 'Coach note'], ['drill', 'Drill']],
  shore: [['prep', 'Prep note'], ['logistics', 'Logistics']],
  media: [['hero-shot', 'Hero shot'], ['drone-up', 'Drone up'], ['b-roll', 'B-roll']],
}

const SECTIONS: BaseTag[] = CREW_SECTIONS.flatMap((s, si) =>
  (SECTION_STARTERS[s.key] || []).map(([slug, label], i) =>
    mk(slug, label, s.color, { scope: 'section', section: s.key, sort: 200 + si * 10 + i })
  )
)

/** Every base tag, general first then section starters. */
export const BASE_TAGS: BaseTag[] = [...RACING, ...AUTO, ...DAY, ...SECTIONS]

export const BASE_GENERAL_TAGS: BaseTag[] = BASE_TAGS.filter((t) => t.scope === 'general')
export const BASE_SECTION_TAGS: BaseTag[] = BASE_TAGS.filter((t) => t.scope === 'section')

/** Turn a free-typed tag into a slug the way the old tag list did (lower-kebab). */
export function slugify(input: string): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** A readable label for a slug that arrived without one (legacy tag lists). */
export function labelFromSlug(slug: string): string {
  const s = String(slug ?? '').replace(/-/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

/** Legacy `tag_lists` strings → general definitions, so an existing team's
 *  vocabulary survives the move to the tagger. Base tags win on slug clashes. */
export function migrateLegacyTagList(tags: readonly string[] | null | undefined): BaseTag[] {
  const taken = new Set(BASE_TAGS.map((t) => t.slug))
  const out: BaseTag[] = []
  for (const raw of tags || []) {
    const slug = slugify(String(raw))
    if (!slug || taken.has(slug)) continue
    taken.add(slug)
    out.push(mk(slug, labelFromSlug(slug), '#06B6D4', { sort: 500 + out.length }))
  }
  return out
}
