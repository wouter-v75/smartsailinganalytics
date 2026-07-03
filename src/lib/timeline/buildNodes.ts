// timeline/buildNodes.ts — the FIRST producer (Phase 2). Pure, testable.
// Turns a parsed Expedition event file (src/lib/xmlEventParse.js output) into the
// day's Timeline Tree: day → races → {start, tacks, gybes, mark roundings,
// finish}, plus sail-change events. Deterministic ids so re-running upserts the
// same nodes. Other producers (ICON weather, log segments, SailScan) will add
// their own nodes onto the same tree.

import type { TimelineNode, NodeKind } from './types'

// Loose shape of the event-file parser output we consume.
export interface ParsedEventLike {
  meta?: { location?: string; date?: string } | null
  raceGuns?: { utc: number; raceNum: number; label?: string }[]
  tackJibes?: { utc: number; isTack: boolean; isValid?: boolean; label?: string }[]
  markRoundings?: { utc: number; isTop: boolean; isValid?: boolean; label?: string }[]
  sailsUpEvents?: { utc: number; sails: string[]; label?: string }[]
  dayStartUtc?: number | null
  dayStopUtc?: number | null
}

const nid = (boatId: string, date: string, ...parts: (string | number)[]) =>
  [boatId, date, ...parts].join(':')

export function buildDayTimeline({ xml, boatId, date }: { xml: ParsedEventLike; boatId: string; date: string }): TimelineNode[] {
  const nodes: TimelineNode[] = []
  const guns = [...(xml.raceGuns || [])].filter((g) => Number.isFinite(g.utc)).sort((a, b) => a.utc - b.utc)
  const tj = (xml.tackJibes || []).filter((x) => Number.isFinite(x.utc))
  const mr = (xml.markRoundings || []).filter((x) => Number.isFinite(x.utc))
  const su = (xml.sailsUpEvents || []).filter((x) => Number.isFinite(x.utc))

  const allUtc = [...guns.map((g) => g.utc), ...tj.map((x) => x.utc), ...mr.map((x) => x.utc), ...su.map((x) => x.utc)]
  if (!allUtc.length && xml.dayStartUtc == null) return nodes

  const dayT0 = xml.dayStartUtc ?? Math.min(...allUtc)
  const dayT1 = xml.dayStopUtc ?? Math.max(...allUtc)
  const dayId = nid(boatId, date, 'day')
  nodes.push({
    id: dayId, parentId: null, kind: 'day', t0: dayT0, t1: dayT1,
    title: 'Race day', subtitle: xml.meta?.location || undefined, source: 'auto', producer: 'eventfile',
    metrics: { races: guns.length },
    meta: { date, regatta: xml.meta?.location || null },
  })

  // Race windows: [gun, next gun ?? day end].
  const races = guns.map((g, i) => ({ raceNum: g.raceNum || i + 1, start: g.utc, end: guns[i + 1]?.utc ?? dayT1 }))
  const raceOf = (utc: number) => races.find((r) => utc >= r.start && utc < r.end) || null
  const parentFor = (utc: number) => {
    const r = raceOf(utc)
    return r ? nid(boatId, date, 'race', r.raceNum) : dayId
  }

  for (const r of races) {
    const raceId = nid(boatId, date, 'race', r.raceNum)
    const rtj = tj.filter((x) => x.utc >= r.start && x.utc < r.end)
    const rmr = mr.filter((x) => x.utc >= r.start && x.utc < r.end)
    nodes.push({
      id: raceId, parentId: dayId, kind: 'race', t0: r.start, t1: r.end,
      title: `Race ${r.raceNum}`, source: 'auto', producer: 'eventfile',
      metrics: { tacks: rtj.filter((x) => x.isTack).length, gybes: rtj.filter((x) => !x.isTack).length, marks: rmr.length },
      meta: { raceNum: r.raceNum },
    })
    nodes.push({ id: nid(boatId, date, 'race', r.raceNum, 'start'), parentId: raceId, kind: 'start', t0: r.start, t1: r.start, title: 'Start', source: 'auto', producer: 'eventfile' })
    for (const x of rtj) {
      const kind: NodeKind = x.isTack ? 'tack' : 'gybe'
      nodes.push({ id: nid(boatId, date, 'race', r.raceNum, kind, x.utc), parentId: raceId, kind, t0: x.utc, t1: x.utc, title: x.isTack ? 'Tack' : 'Gybe', source: 'auto', producer: 'eventfile', meta: { valid: x.isValid !== false } })
    }
    for (const x of rmr) {
      nodes.push({ id: nid(boatId, date, 'race', r.raceNum, 'mark', x.utc), parentId: raceId, kind: 'mark', t0: x.utc, t1: x.utc, title: x.isTop ? 'Top mark' : 'Leeward gate', source: 'auto', producer: 'eventfile', meta: { top: !!x.isTop, valid: x.isValid !== false } })
    }
    nodes.push({ id: nid(boatId, date, 'race', r.raceNum, 'finish'), parentId: raceId, kind: 'finish', t0: r.end, t1: r.end, title: 'Finish', source: 'auto', producer: 'eventfile' })
  }

  // Training / no-race sessions: attach maneuvers + marks straight to the day.
  if (!races.length) {
    for (const x of tj) {
      const kind: NodeKind = x.isTack ? 'tack' : 'gybe'
      nodes.push({ id: nid(boatId, date, kind, x.utc), parentId: dayId, kind, t0: x.utc, t1: x.utc, title: x.isTack ? 'Tack' : 'Gybe', source: 'auto', producer: 'eventfile', meta: { valid: x.isValid !== false } })
    }
    for (const x of mr) {
      nodes.push({ id: nid(boatId, date, 'mark', x.utc), parentId: dayId, kind: 'mark', t0: x.utc, t1: x.utc, title: x.isTop ? 'Top mark' : 'Leeward gate', source: 'auto', producer: 'eventfile', meta: { top: !!x.isTop } })
    }
  }

  // Sail changes → parented to the race they fall in (or the day).
  for (const x of su) {
    nodes.push({ id: nid(boatId, date, 'sail', x.utc), parentId: parentFor(x.utc), kind: 'sail_change', t0: x.utc, t1: x.utc, title: x.label || x.sails?.join(' + ') || 'Sails changed', source: 'auto', producer: 'eventfile', meta: { sails: x.sails } })
  }

  return nodes.sort((a, b) => a.t0 - b.t0 || (a.t1 - a.t0) - (b.t1 - b.t0))
}
