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
import type { TagKind, TagLabelGroup, TagScope } from './types'

export interface BaseTag {
  slug: string
  label: string
  color: string
  scope: TagScope
  section: string | null
  kind: TagKind
  minRole: string
  sort: number
  /** Seconds before the press the tag starts — people press late, always. */
  leadSec: number
  /** Seconds after the press it keeps running. */
  lagSec: number
  labelGroups: TagLabelGroup[]
  /** On the curated ~8-button bar, rather than only in the picker. */
  onButtonBar: boolean
  /** Shared vocabulary, private applications: every use is scope='personal',
   *  owned by whoever pressed it. See migration 0063. */
  privateByDefault?: boolean
}

// ── Descriptor vocabularies ─────────────────────────────────────────────────
// Categories say WHAT happened; descriptors say how. Kept deliberately small —
// rare codes depress coding consistency even when everyone agrees on the common
// ones, so each group is a handful of options a crew can hold in their head.
const QUALITY: TagLabelGroup = {
  group: 'Quality',
  options: ['textbook', 'good', 'scrappy', 'slow', 'bad'],
}
const CAUSE: TagLabelGroup = {
  group: 'Cause',
  options: ['call', 'trim', 'helm', 'crew work', 'kit', 'breeze', 'waves'],
}
const MANOEUVRE_LABELS: TagLabelGroup[] = [QUALITY, CAUSE]

const POS_C = '#1D9E75'   // point of sail
const WIND_C = '#06B6D4'  // breeze bands
const MANO_C = '#7F77DD'  // manoeuvres
const DAY_C = '#F59E0B'   // day structure

// Lead/lag defaults. A point tag gets 10 s of lead because that is roughly the
// gap between a moment happening and a human finding the button; a manoeuvre also
// wants its recovery in frame, hence the longer lag. A range tag leads by less —
// the crew drag its edges anyway.
const mk = (
  slug: string,
  label: string,
  color: string,
  opts: Partial<Omit<BaseTag, 'slug' | 'label' | 'color'>> = {}
): BaseTag => {
  const kind = opts.kind ?? 'point'
  return {
    slug,
    label,
    color,
    scope: opts.scope ?? 'general',
    section: opts.section ?? null,
    kind,
    minRole: opts.minRole ?? 'tl1',
    sort: opts.sort ?? 100,
    leadSec: opts.leadSec ?? (kind === 'range' ? 5 : 10),
    lagSec: opts.lagSec ?? (kind === 'range' ? 5 : 10),
    labelGroups: opts.labelGroups ?? [],
    onButtonBar: opts.onButtonBar ?? false,
    privateByDefault: opts.privateByDefault ?? false,
  }
}

// ── Notes and comments ──────────────────────────────────────────────────────
// Free text pinned to a moment, rather than vocabulary. Deliberately modelled as
// tags rather than as their own table: they then inherit the track, the day
// segments, the snap, filtering and export, and — for personal notes — the
// privacy that scope='personal' already gets from RLS.
const NOTE_TAGS: BaseTag[] = [
  // Yours alone. Shows in Campaign → Day → Personal notes; nobody else can read
  // it, and it never reaches an export.
  mk('note', 'Personal note', '#64748B', {
    sort: 5, onButtonBar: true, privateByDefault: true, leadSec: 15, lagSec: 15,
  }),
  // The crew's shared running commentary on a day. TL2 and up, because it is
  // the team's record rather than a private aide-memoire.
  mk('team-note', 'Team comment', '#7F77DD', {
    sort: 6, onButtonBar: true, minRole: 'tl2', leadSec: 15, lagSec: 15,
  }),
]

// ── General: the racing moments (racingTags.ts, verbatim) ───────────────────
// NONE of the racing moments are on the button bar, which looks wrong until you
// remember the first principle: the detector already finds every start, mark
// rounding, tack and gybe. A button for them would be a button nobody presses.
//
// The bar is for what the detector CANNOT know — how it felt, that something
// broke, that this is worth coming back to. See BUTTON_BAR_NOTE below.
const RACING: BaseTag[] = Object.entries(RACING_TAGS).map(([slug, label], i) =>
  mk(slug, label, RACE_RED, {
    sort: 10 + i,
    labelGroups: [QUALITY],
    onButtonBar: false,
    // A start is worth a minute of run-in; a mark rounding, the approach.
    leadSec: slug === 'race-start' ? 60 : 20,
    lagSec: slug === 'race-start' ? 30 : 20,
  })
)

// ── General: what computeAutoTags already emits ─────────────────────────────
const AUTO: BaseTag[] = [
  mk('upwind', 'Upwind', POS_C, { kind: 'range', sort: 30 }),
  mk('reach', 'Reach', POS_C, { kind: 'range', sort: 31 }),
  mk('downwind', 'Downwind', POS_C, { kind: 'range', sort: 32 }),
  mk('tack', 'Tack', '#1D9E75', {
    sort: 40, labelGroups: MANOEUVRE_LABELS, leadSec: 20, lagSec: 40,
  }),
  mk('gybe', 'Gybe', MANO_C, {
    sort: 41, labelGroups: MANOEUVRE_LABELS, leadSec: 20, lagSec: 40,
  }),
  mk('mark', 'Mark', '#F59E0B', { sort: 42, labelGroups: [QUALITY], leadSec: 20, lagSec: 20 }),
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
  mk('sail-change', 'Sail change', DAY_C, {
    sort: 73, onButtonBar: true, leadSec: 20, lagSec: 20,
    labelGroups: [{ group: 'Change', options: ['hoist', 'drop', 'peel', 'reef', 'unreef'] }],
  }),
  // Two-boat testing: a run is only believed after three or four repeats, so the
  // repeat number rides along as a descriptor and the season's runs group by it.
  mk('lineup', 'Line-up', '#2DD4BF', {
    kind: 'range', sort: 74, onButtonBar: true,
    labelGroups: [
      { group: 'Side', options: ['windward', 'leeward'] },
      { group: 'Run', options: ['1', '2', '3', '4', '5+'] },
      { group: 'Result', options: ['faster', 'level', 'slower'] },
    ],
  }),
  mk('test', 'Test / mode change', '#2DD4BF', {
    kind: 'range', sort: 75,
    labelGroups: [{ group: 'Testing', options: ['rig', 'sail', 'trim mode', 'foil', 'crew weight'] }],
  }),
  mk('incident', 'Incident', '#EF4444', { sort: 80, onButtonBar: true, leadSec: 20, lagSec: 20 }),
  mk('gear-damage', 'Gear damage', '#EF4444', {
    sort: 81, onButtonBar: true, leadSec: 20, lagSec: 20,
    labelGroups: [{ group: 'Where', options: ['rig', 'sail', 'deck gear', 'winch', 'foil', 'electronics'] }],
  }),
  // The catch-all: "something happened here, come back to it". The most-pressed
  // button on any tagging tool, and the one that feeds the debrief reel.
  mk('review', 'Review this', '#8B5CF6', {
    sort: 90, onButtonBar: true, leadSec: 20, lagSec: 20,
    labelGroups: [{ group: 'For', options: ['debrief', 'coach', 'design', 'me'] }],
  }),
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
    mk(slug, label, s.color, {
      scope: 'section', section: s.key, sort: 200 + si * 10 + i,
      labelGroups: [QUALITY], leadSec: 15, lagSec: 15,
    })
  )
)

// ── What earns a place on the button bar ────────────────────────────────────
// Seven buttons, and every one of them marks something no algorithm can infer:
//
//   Personal note   how it felt, privately
//   Team comment    how it felt, to the crew  (TL2+)
//   Review this     come back to this
//   Incident        something went wrong
//   Gear damage     the engineer's one press
//   Sail change     the trimmer's, and the only racing moment here — because on
//                   a training day there is no event file to detect it from
//   Line-up         the start and end of a two-boat test run
//
// Kept short on purpose: rare codes depress how consistently a squad tags, even
// when everyone agrees on the common ones. The full vocabulary lives one tap
// deeper, in the picker.

/** Every base tag, general first then section starters. */
export const BASE_TAGS: BaseTag[] = [...NOTE_TAGS, ...RACING, ...AUTO, ...DAY, ...SECTIONS]

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
    // NOT String(raw) — `tag_lists.tags` is JSONB, so a null or a number can be
    // sitting in there, and coercing first turns null into the string "null" and
    // mints a tag called "Null". slugify already handles nullish input; anything
    // that is not a string has no business becoming vocabulary.
    if (typeof raw !== 'string') continue
    const slug = slugify(raw)
    if (!slug || taken.has(slug)) continue
    taken.add(slug)
    out.push(mk(slug, labelFromSlug(slug), '#06B6D4', { sort: 500 + out.length }))
  }
  return out
}
