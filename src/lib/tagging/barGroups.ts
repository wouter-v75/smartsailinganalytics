// src/lib/tagging/barGroups.ts
// ─────────────────────────────────────────────────────────────────────────────
// One button that stands for several tags.
//
// The button bar's whole design is that it stays short: rare codes depress how
// consistently a squad tags even when everyone agrees on the common ones, so the
// bar holds the handful of presses that happen every day and the rest live one
// tap deeper. That rule is what a GROUP is for — "Racing" is one button on the
// bar and five tags behind it, so the racing moments become reachable in two
// taps without costing five slots.
//
// Racing is grouped because the detector already finds most of these from the
// event file; the button is for the training day that has no event file, and for
// the moment the detector missed. A group with one member is not a group — the
// bar renders that member directly (see `resolveGroup`).
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { RACE_RED } from '../racingTags'
import type { TagDef } from './types'

export interface BarGroup {
  key: string
  label: string
  color: string
  /** Member slugs in the order the picker shows them. Missing ones are skipped,
   *  so a team that has archived "Gate" simply does not see it. */
  slugs: string[]
}

export const BAR_GROUPS: BarGroup[] = [
  {
    key: 'racing',
    label: 'Racing',
    color: RACE_RED,
    slugs: ['race-start', 'topmark', 'gate', 'mark', 'race-finish'],
  },
]

/** A thing the bar can draw: one tag, or one group standing for several. */
export type BarItem =
  | { kind: 'tag'; def: TagDef }
  | { kind: 'group'; group: BarGroup; members: TagDef[] }

/** The group's members, in the group's declared order, that this user may apply. */
export function groupMembers(group: BarGroup, defs: TagDef[]): TagDef[] {
  const bySlug = new Map<string, TagDef>()
  for (const d of defs) {
    // A def the user cannot apply is not an option; `canApply` is undefined on
    // the seed shapes used in tests and previews, which counts as allowed.
    if (d.canApply === false || d.archived) continue
    if (!bySlug.has(d.slug)) bySlug.set(d.slug, d)
  }
  return group.slugs.map((s) => bySlug.get(s)).filter((d): d is TagDef => !!d)
}

/**
 * What the bar draws, given the definitions on it and the definitions the team
 * has in total.
 *
 * Groups come LAST. The bar's first row is what gets pressed on the water with
 * one thumb; a group needs two taps and a decision, so it does not belong in
 * front of the note button.
 */
export function barItems(
  onBar: TagDef[],
  allDefs: TagDef[],
  groups: BarGroup[] = BAR_GROUPS
): BarItem[] {
  const items: BarItem[] = onBar
    .filter((d) => !d.archived && d.canApply !== false)
    .map((def) => ({ kind: 'tag' as const, def }))

  // A slug already on the bar is not repeated inside a group — pressing
  // "Racing" to reach a button you can see would be a puzzle, not a shortcut.
  const onBarSlugs = new Set(items.map((i) => (i.kind === 'tag' ? i.def.slug : '')))

  for (const group of groups) {
    const members = groupMembers(group, allDefs).filter((d) => !onBarSlugs.has(d.slug))
    if (members.length === 0) continue
    // One member is not a group. Draw the tag itself rather than making the crew
    // open a sheet to find a list of one.
    if (members.length === 1) items.push({ kind: 'tag', def: members[0] })
    else items.push({ kind: 'group', group, members })
  }

  return items
}
