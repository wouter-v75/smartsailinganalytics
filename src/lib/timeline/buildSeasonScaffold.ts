// timeline/buildSeasonScaffold.ts — the season/regatta producer (Phase 2).
// Days are produced one-per-upload (buildNodes), so the season + regatta
// structural nodes that SPAN many days are synthesised here from the fetched
// node set: group day nodes by regatta (venue), add a regatta node per group and
// one season node, and re-parent each day under its regatta. Deterministic ids;
// non-day nodes (races/events) pass through unchanged. Pure + testable — this is
// what turns a pile of days into "the whole season on one timeline".

import type { TimelineNode } from './types'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'x'
const parseId = (id: string) => { const p = id.split(':'); return { boatId: p[0] || 'boat', date: p[1] || '' } }
const regattaKey = (d: TimelineNode) => (d.meta?.regatta as string) || d.subtitle || 'Regatta'

export function buildSeasonScaffold(nodes: TimelineNode[]): TimelineNode[] {
  const days = nodes.filter((n) => n.kind === 'day')
  if (days.length <= 1) return nodes // nothing to group

  const boatId = parseId(days[0].id).boatId
  const year = days.map((d) => parseId(d.id).date.slice(0, 4)).filter(Boolean).sort()[0]
    || new Date(days[0].t0).getUTCFullYear().toString()

  const groups = new Map<string, TimelineNode[]>()
  for (const d of days) {
    const k = regattaKey(d)
    const a = groups.get(k)
    if (a) a.push(d); else groups.set(k, [d])
  }

  const out: TimelineNode[] = []
  const seasonId = `${boatId}:season:${year}`
  out.push({
    id: seasonId, parentId: null, kind: 'season',
    t0: Math.min(...days.map((d) => d.t0)), t1: Math.max(...days.map((d) => d.t1)),
    title: `Season ${year}`, source: 'auto', producer: 'scaffold',
    metrics: { regattas: groups.size, days: days.length },
  })

  const dayParent = new Map<string, string>()
  groups.forEach((ds, name) => {
    const regId = `${boatId}:regatta:${slug(name)}:${parseId(ds[0].id).date}`
    out.push({
      id: regId, parentId: seasonId, kind: 'regatta',
      t0: Math.min(...ds.map((d) => d.t0)), t1: Math.max(...ds.map((d) => d.t1)),
      title: name, source: 'auto', producer: 'scaffold', metrics: { days: ds.length },
    })
    for (const d of ds) dayParent.set(d.id, regId)
  })

  for (const n of nodes) {
    if (n.kind === 'day') out.push({ ...n, parentId: dayParent.get(n.id) ?? seasonId })
    else out.push(n)
  }
  return out
}
