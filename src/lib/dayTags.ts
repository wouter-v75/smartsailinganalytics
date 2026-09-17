// The day's tags, as Analytics draws them.
//
// The tagger and Analytics were showing the same day through two different vocabularies:
// the tagger drew `ssa_tag_events` with the team's own labels and colours, while
// Analytics drew the event file's tacks, gybes and roundings with its own names and its
// own palette. Two names for one moment is two moments as far as a reader is concerned.
//
// So this module does no formatting of its own. It fetches the tags and hands them
// through the TAGGER's helpers — markerStyle for the size hierarchy (a turn is small, a
// moment is full size), markerTip and markerLabel for what it says, sessionClock for the
// time — so the two screens cannot drift apart. If a team renames a tag or changes its
// colour, both screens change together.

import { markerStyle, markerTip, markerLabel, MANOEUVRE_SLUGS } from './tagging/markers'
import type { TagEvent } from './tagging/types'

export interface TrackTag {
  id: string
  slug: string
  label: string                 // the team's own label, never a second name for it
  color: string                 // the team's own colour
  t0: number
  t1: number
  isManoeuvre: boolean
  r: number                     // the tagger's size hierarchy, so the track reads the same
  strokeWidth: number
  clock: string                 // session clock, never the device's
  sails: string | null          // what was up from here on (sail changes only)
  aboard: string | null
  ariaLabel: string
}

export async function fetchDayTags(teamId: string, boatId: string, date: string): Promise<TagEvent[]> {
  try {
    const res = await fetch(`/api/teams/${teamId}/tags/events?boat_id=${boatId}&date=${date}`)
    if (!res.ok) return []
    const j = await res.json().catch(() => ({}))
    return Array.isArray(j?.events) ? j.events : []
  } catch { return [] }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// One drawable per tag, in time order.
export function trackTags(events: readonly TagEvent[] | null | undefined, tzOffsetMin = 0): TrackTag[] {
  const day = (events || []).filter(e => e && isNum(e.t0))
  return day
    .map(e => {
      const style = markerStyle(e.slug)
      const tip = markerTip(e, tzOffsetMin, day)
      return {
        id: e.id,
        slug: e.slug,
        label: e.label,
        color: e.color,
        t0: e.t0,
        t1: isNum(e.t1) ? e.t1 : e.t0,
        isManoeuvre: MANOEUVRE_SLUGS.has(e.slug),
        r: style.r,
        strokeWidth: style.strokeWidth,
        clock: tip.clock,
        sails: tip.sails,
        aboard: tip.aboard,
        ariaLabel: markerLabel(e, tzOffsetMin, day),
      }
    })
    .sort((a, b) => a.t0 - b.t0)
}

export interface TagLegendRow { slug: string; label: string; color: string; n: number }

// What kinds of tag this day holds, commonest last so the routine turns do not head the
// list. Labels and colours are the team's, so the legend matches the tagger's buttons.
export function tagLegend(events: readonly TagEvent[] | null | undefined): TagLegendRow[] {
  const by = new Map<string, TagLegendRow>()
  for (const e of events || []) {
    if (!e?.slug) continue
    const row = by.get(e.slug)
    if (row) row.n++
    else by.set(e.slug, { slug: e.slug, label: e.label, color: e.color, n: 1 })
  }
  return Array.from(by.values()).sort((a, b) => a.n - b.n || a.label.localeCompare(b.label))
}

// The tags inside a selected stretch of the track. A tag counts as inside when it
// overlaps the range at all: a sail change one second before the selection still
// decides what was flying through it.
export function tagsInRange(
  events: readonly TagEvent[] | null | undefined,
  range: [number, number] | null | undefined
): TagEvent[] {
  const day = (events || []).filter(e => e && isNum(e.t0))
  if (!range) return [...day]
  const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]]
  return day.filter(e => (isNum(e.t1) ? e.t1 : e.t0) >= a && e.t0 <= b)
}
