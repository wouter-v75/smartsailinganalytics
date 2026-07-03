import type { TimelineNode } from './types'

// Which day the timeline lands on:
//   1) if a training/regatta is on TODAY (a day exists for today's date, in the
//      venue tz) → that day;
//   2) else the most recent day WITH DATA — a logfile (event-file detail nodes),
//      photos or video.
// Falls back to the most recent day, or undefined when there are none.
export function pickFocusDay(tree: TimelineNode[] | null | undefined, tzOffset = 0): string | undefined {
  if (!tree) return undefined
  const days = tree.filter((n) => n.kind === 'day')
  if (!days.length) return undefined

  const dateOf = (d: TimelineNode) => (d.meta?.date as string) || d.id.split(':')[1] || ''
  const today = new Date(Date.now() + tzOffset * 60000).toISOString().slice(0, 10)
  const todayDay = days.find((d) => dateOf(d) === today)
  if (todayDay) return todayDay.id

  const parentsWithChildren = new Set(tree.map((n) => n.parentId).filter(Boolean) as string[])
  const hasData = (d: TimelineNode) =>
    (d.metrics?.videos || 0) > 0 || (d.metrics?.photos || 0) > 0 || parentsWithChildren.has(d.id)
  const withData = days.filter(hasData)
  const pool = withData.length ? withData : days
  return pool.reduce((a, b) => (b.t0 > a.t0 ? b : a)).id
}
