// Several stretches of one day, compared side by side.
//
// One selection answers "how did this bit go". Two answer "which was better" — the
// line-up before the sail change against the one after, this beat against the next.
// That is the question people actually bring to a track, so a selection is a LIST.
//
// Each section keeps its own colour for as long as it exists, and everything that shows
// a section — the track, the charts, the averages beside them — uses that same colour.
// A section's number is its position in the list, so removing the first renumbers the
// rest rather than leaving a gap where somebody would look for it.

import type { TimeRange } from './trackSelection'
import { orderedRange } from './trackSelection'

// Distinct against the dark chart ground and against each other, in the order a
// colour-blind reader can still tell apart: yellow, cyan, violet, orange, green, pink.
export const SECTION_COLORS = ['#FDE047', '#22D3EE', '#A78BFA', '#FB923C', '#4ADE80', '#F472B6'] as const

export const MAX_SECTIONS = SECTION_COLORS.length

export interface TrackSection {
  id: string
  range: TimeRange
  color: string
  n: number            // 1-based, what the chip says
}

let seq = 0
const nextId = () => `sec-${Date.now().toString(36)}-${(seq++).toString(36)}`

const renumber = (sections: TrackSection[]): TrackSection[] =>
  sections.map((s, i) => ({ ...s, n: i + 1, color: SECTION_COLORS[i % SECTION_COLORS.length] }))

// A new stretch goes on the end. Sections may overlap — two line-ups over the same
// water are a fair comparison, and refusing that would be the tool arguing with the
// question.
export function addSection(sections: readonly TrackSection[], range: TimeRange | null | undefined): TrackSection[] {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return [...sections]
  const [a, b] = orderedRange(range[0], range[1])
  if (a === b) return [...sections]
  if (sections.length >= MAX_SECTIONS) return [...sections]
  return renumber([...sections, { id: nextId(), range: [a, b] as TimeRange, color: '', n: 0 }])
}

export function removeSection(sections: readonly TrackSection[], id: string): TrackSection[] {
  return renumber(sections.filter(s => s.id !== id))
}

export const clearSections = (): TrackSection[] => []

// Which section a moment belongs to — the first, when they overlap, so a point has one
// colour rather than flickering between two.
export function sectionOf(sections: readonly TrackSection[], utc: number): TrackSection | null {
  if (!Number.isFinite(utc)) return null
  return sections.find(s => utc >= s.range[0] && utc <= s.range[1]) || null
}

export const inSections = (utc: number, sections: readonly TrackSection[]): boolean =>
  !sections.length || sectionOf(sections, utc) != null

// A phase belongs to the section its MIDPOINT falls in, as with a single selection: a
// 30 s phase half in and half out is not an average of the stretch somebody chose.
export const phaseSection = (
  p: { utc: number; endUtc: number }, sections: readonly TrackSection[]
): TrackSection | null => sectionOf(sections, (p.utc + p.endUtc) / 2)

export const phaseInSections = (
  p: { utc: number; endUtc: number }, sections: readonly TrackSection[]
): boolean => !sections.length || phaseSection(p, sections) != null

// The span every section sits inside — what to zoom the charts to when the first
// section is picked.
export function sectionsSpan(sections: readonly TrackSection[]): TimeRange | null {
  if (!sections.length) return null
  return [
    Math.min(...sections.map(s => s.range[0])),
    Math.max(...sections.map(s => s.range[1])),
  ]
}

export interface SectionAverage {
  id: string
  n: number
  color: string
  mean: number | null
  count: number
}

// The mean of one channel inside each section, for the figures printed beside a chart.
// A section with nothing in it reports null rather than 0 — no data is not a zero, and
// a zero in a speed column is a lie somebody will act on.
export function sectionAverages(
  rows: readonly { utc: number }[] | null | undefined,
  sections: readonly TrackSection[],
  value: (row: never) => number | null | undefined
): SectionAverage[] {
  return sections.map(s => {
    let sum = 0, n = 0
    for (const r of rows || []) {
      if (!Number.isFinite(r?.utc) || r.utc < s.range[0] || r.utc > s.range[1]) continue
      const v = value(r as never)
      if (typeof v === 'number' && Number.isFinite(v)) { sum += v; n++ }
    }
    return { id: s.id, n: s.n, color: s.color, mean: n ? sum / n : null, count: n }
  })
}

// What the button offers next — the wording changes once a section exists, because
// "select a section" beside an existing one reads as "start again".
export const selectButtonLabel = (sections: readonly TrackSection[]): string =>
  sections.length ? `✂ Select section ${sections.length + 1}` : '✂ Select a section of the track'

export const sectionLabel = (s: TrackSection): string => `Section ${s.n}`
