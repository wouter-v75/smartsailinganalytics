// Selecting a race on the Analytics track, and noticing when its finish is a guess.
//
// Expedition's event file records START guns and mark roundings, never a finish. So a
// race's end is inferred — the last mark rounding plus a grace, the next race's warning
// signal, or simply where the day's data stops — and everything measured over "the
// race" inherits that guess. The tagger already has a `race-finish` tag for exactly
// this; this module joins the two, so Analytics can select a race AND say, plainly,
// that nobody has told it where the race ended.

import { segmentDay, DEFAULT_FINISH_GRACE_SEC, type EndSource, type SegmentGun } from './tagging/segments'

export const FINISH_SLUG = 'race-finish'
export const START_SLUG = 'race-start'

export interface RaceOption {
  key: string                    // segmentDay's stable key: 'r1', 'r2', …
  raceNum: number
  label: string
  // The stretch segmentDay gives a race: it opens at the WARNING signal, so selecting a
  // race includes the start sequence, which is usually what somebody wants to look at.
  from: number
  gun: number | null             // the start gun itself, when the event file names it
  to: number                     // the finish, real or inferred
  endSource: EndSource
  hasFinish: boolean             // somebody tagged the finish
  suggestedFinish: number | null // where a finish tag would sit, when none is set
}

interface RaceInput {
  guns?: { utc: number; raceNum?: number }[] | null
  markRoundings?: { utc: number }[] | null
  dayStartUtc?: number | null
  dayStopUtc?: number | null
  dataT0?: number | null
  dataT1?: number | null
  finishGraceSec?: number
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// The day's finish tags, as segmentDay wants them. A point tag's t0 IS the finish.
export function finishesFromTags(events: { slug?: string; t0?: number }[] | null | undefined): SegmentGun[] {
  return (events || [])
    .filter(e => e?.slug === FINISH_SLUG && isNum(e.t0))
    .map(e => ({ utc: e.t0 as number }))
    .sort((a, b) => a.utc - b.utc)
}

// The day's STARTS, from the tagger when it has any.
//
// The tagger is seeded with a race-start tag per gun in the event file, and somebody can
// then delete one — a general recall, a start that was never sailed, a gun for another
// class that the file recorded anyway. Once that has been done, the tags are the day's
// account of which races exist, and the event file is a stale copy of it: a deleted
// start must take its race out of the charts, the map and the Start tab alike.
//
// With no start tags at all, nothing has been curated and the event file stands.
export function startsFromTags(
  events: { slug?: string; t0?: number; label?: string }[] | null | undefined
): SegmentGun[] {
  return (events || [])
    .filter(e => e?.slug === START_SLUG && isNum(e.t0))
    .sort((a, b) => (a.t0 as number) - (b.t0 as number))
    .map((e, i) => {
      // "Race 5 start" keeps its number; anything else is numbered by its place in the day.
      const named = /race\s*(\d+)/i.exec(e.label || '')
      return { utc: e.t0 as number, raceNum: named ? Number(named[1]) : i + 1 }
    })
}

export interface Gun { utc: number; raceNum?: number; label?: string; color?: string }

export function effectiveGuns(
  xml: { raceGuns?: Gun[] | null } | null | undefined,
  events: { slug?: string; t0?: number; label?: string }[] | null | undefined
): Gun[] {
  const tagged = startsFromTags(events)
  if (tagged.length) {
    return tagged.map(g => ({
      utc: g.utc, raceNum: g.raceNum,
      label: `Race ${g.raceNum ?? '?'} start`, color: '#EF4444',
    }))
  }
  return (xml?.raceGuns || []).filter(g => isNum(g?.utc)).sort((a, b) => a.utc - b.utc)
}

// Where to suggest the finish for a race nobody has tagged: the last mark rounding
// inside it plus the same grace segmentDay uses, which is the best guess available
// from the event file. Failing that, the end the segmenter settled on.
function suggestFor(from: number, to: number, marks: { utc: number }[], graceMs: number): number {
  const inside = marks.filter(m => isNum(m?.utc) && m.utc > from && m.utc <= to).map(m => m.utc)
  if (!inside.length) return to
  return Math.min(Math.max(...inside) + graceMs, to)
}

// Every race of the day, ready for a picker: its span, and whether its end is known or
// guessed. Training days (no start guns) return nothing — there is no race to pick.
export function raceOptions(
  input: RaceInput,
  finishes: SegmentGun[] | null | undefined = null
): RaceOption[] {
  const graceMs = (input.finishGraceSec ?? DEFAULT_FINISH_GRACE_SEC) * 1000
  const marks = (input.markRoundings || []).filter(m => isNum(m?.utc)) as { utc: number }[]
  const segments = segmentDay({
    guns: input.guns || null,
    finishes: finishes || null,
    markRoundings: marks,
    dayStartUtc: input.dayStartUtc ?? null,
    dayStopUtc: input.dayStopUtc ?? null,
    dataT0: input.dataT0 ?? null,
    dataT1: input.dataT1 ?? null,
    finishGraceSec: input.finishGraceSec,
  })
  const gunOf = (raceNum: number): number | null => {
    const hit = (input.guns || []).find(g => g?.raceNum === raceNum)
    if (hit && isNum(hit.utc)) return hit.utc
    // Unnumbered guns: the nth gun is race n, which is how segmentDay reads them too.
    const ordered = (input.guns || []).filter(g => isNum(g?.utc)).sort((a, b) => a.utc - b.utc)
    return ordered[raceNum - 1] && isNum(ordered[raceNum - 1].utc) ? ordered[raceNum - 1].utc : null
  }
  return segments
    .filter(s => s.kind === 'race' && s.raceNum != null)
    .map(s => ({
      key: s.key,
      raceNum: s.raceNum as number,
      label: s.label,
      from: s.t0,
      gun: gunOf(s.raceNum as number),
      to: s.t1,
      endSource: s.endSource,
      hasFinish: s.endSource === 'finish',
      suggestedFinish: s.endSource === 'finish' ? null : suggestFor(s.t0, s.t1, marks, graceMs),
    }))
}

// What to say about a race whose finish nobody has set. Names how the end was guessed,
// because that decides how wrong it might be.
export function finishNote(o: RaceOption | null | undefined): string | null {
  if (!o || o.hasFinish) return null
  const how = o.endSource === 'last-mark' ? 'the last mark rounding plus 3 min'
    : o.endSource === 'next-warning' ? "the next race's warning signal"
    : o.endSource === 'day-stop' ? 'the end of the day'
    : 'the end of the log'
  return `No finish tag for race ${o.raceNum} — this stretch ends at ${how}. Drag the flashing marker to the finish and save it.`
}

export interface SaveFinishResult { ok: boolean; error?: string }

// Write the finish as a real tag, so every other screen — segments, the tagger, the
// reports — sees the same finish rather than Analytics keeping a private one.
export async function saveFinishTag(
  teamId: string, boatId: string, date: string, utc: number
): Promise<SaveFinishResult> {
  try {
    const res = await fetch(`/api/teams/${teamId}/tags/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: boatId, session_date: date, slug: FINISH_SLUG, at: utc }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j?.event?.id) {
      return {
        ok: false,
        error: j?.error === 'unauth' ? 'not signed in' : j?.error || `the server answered ${res.status}`,
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not reach the server' }
  }
}

export async function fetchFinishTags(teamId: string, boatId: string, date: string): Promise<SegmentGun[]> {
  try {
    const res = await fetch(`/api/teams/${teamId}/tags/events?boat_id=${boatId}&date=${date}`)
    if (!res.ok) return []
    const j = await res.json().catch(() => ({}))
    return finishesFromTags(j?.events || [])
  } catch { return [] }
}
