// timeline/buildCampaignTree.ts — the campaign spine (Phase 2).
// The timeline structure comes from the SESSION LIST (every training day + event
// the coach has synced), NOT from event files: a day node exists for every
// session regardless of whether it has an event file, log, video or photos.
// Event-file detail (races/tacks/marks/…) is merged in on top where present, and
// media presence (video/photo counts) rides on the day node. So:
//   • no event file → the day still shows, with its videos/photos/data;
//   • no media at all → the campaign entry (training block / event) still shows.
// Pure + testable. See docs/regatta-os-spec-and-plan-2026-07.md.

import type { TimelineNode } from './types'

export interface SessionRec {
  date: string // YYYY-MM-DD
  title?: string | null
  event?: string | null
  video_count?: number
  photo_count?: number
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'x'
const dayMs = (date: string, h: number) => Date.parse(`${date}T${String(h).padStart(2, '0')}:00:00Z`)

export function buildCampaignTree({ sessions, detail, boatId }: { sessions: SessionRec[]; detail: TimelineNode[]; boatId: string }): TimelineNode[] {
  // Persisted day nodes give us real t0/t1; their children (races/events) are kept.
  const detailDay = new Map<string, TimelineNode>() // date -> persisted day node
  for (const n of detail) if (n.kind === 'day') detailDay.set(n.id.split(':')[1] || '', n)

  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}/.test(s)
  const bySession = new Map(sessions.map((s) => [s.date, s]))
  const dates = new Set<string>()
  sessions.forEach((s) => { if (isDate(s.date)) dates.add(s.date.slice(0, 10)) })
  detailDay.forEach((_, d) => { if (isDate(d)) dates.add(d) })
  const dateList = Array.from(dates).sort()
  if (!dateList.length) return detail

  interface DayInfo { date: string; event: string; title: string; t0: number; t1: number; videos: number; photos: number }
  const days: DayInfo[] = dateList.map((date) => {
    const s = bySession.get(date)
    const pd = detailDay.get(date)
    const event = (s?.event || '').trim() || 'Training'
    return {
      date, event,
      title: s?.title || (s?.event ? s.event : 'Training day'),
      t0: pd?.t0 ?? dayMs(date, 9),
      t1: pd?.t1 ?? dayMs(date, 17),
      videos: s?.video_count ?? 0,
      photos: s?.photo_count ?? 0,
    }
  })

  const out: TimelineNode[] = []
  // Most recent day's year (fall back to the current year), never a bad 1900.
  const year = (dateList[dateList.length - 1] || '').slice(0, 4) || String(new Date().getUTCFullYear())
  const seasonId = `${boatId}:season:${year}`
  out.push({
    id: seasonId, parentId: null, kind: 'season',
    t0: Math.min(...days.map((d) => d.t0)), t1: Math.max(...days.map((d) => d.t1)),
    title: `Season ${year}`, source: 'auto', producer: 'campaign',
    metrics: { regattas: new Set(days.map((d) => d.event)).size, days: days.length },
  })

  const groups = new Map<string, DayInfo[]>()
  for (const d of days) { const a = groups.get(d.event); if (a) a.push(d); else groups.set(d.event, [d]) }
  const dayParent = new Map<string, string>()
  groups.forEach((ds, event) => {
    const regId = `${boatId}:regatta:${slug(event)}:${ds[0].date}`
    out.push({
      id: regId, parentId: seasonId, kind: 'regatta',
      t0: Math.min(...ds.map((d) => d.t0)), t1: Math.max(...ds.map((d) => d.t1)),
      title: event, source: 'auto', producer: 'campaign', metrics: { days: ds.length },
    })
    ds.forEach((d) => dayParent.set(d.date, regId))
  })

  for (const d of days) {
    out.push({
      id: `${boatId}:${d.date}:day`, parentId: dayParent.get(d.date) ?? seasonId, kind: 'day',
      t0: d.t0, t1: d.t1, title: d.title, subtitle: d.event !== 'Training' ? d.event : undefined,
      source: 'auto', producer: 'campaign',
      metrics: { videos: d.videos, photos: d.photos },
      meta: { date: d.date, regatta: d.event },
    })
  }

  // event-file detail (races/tacks/marks/sail changes) — parentId already points
  // at the day id we just (re)built, so they attach correctly.
  for (const n of detail) if (n.kind !== 'day') out.push(n)
  return out
}
