'use client'
// src/components/boat/SailChartPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Boat → Sail chart. The crossover chart: which sail at each TWA × TWS.
//
// Laid out the way Expedition, the Sailing Performance crossover tool and
// PredictWind lay it out — TWA across, TWS up — with the boat's own polar drawn
// underneath: AWS and AWA isolines (light, dashed) and the upwind / downwind VMG
// target angles (red dotted). The isolines are what make a chart drawn in TRUE
// wind readable on deck, where the crew sees APPARENT wind on the instruments.
//
// EDITING. Click a shape to select it; its control points appear.
//   • drag a point to reshape        • drag inside the shape to move all of it
//   • double-click near the outline to add a point there
//   • Alt-click (or select + Delete) to remove a point — a shape keeps at least 3
//   • ⌘Z / Ctrl-Z undoes; nothing is stored until Save.
// It is a document the whole crew reads, so an explicit Save, as on the batten
// card: a mis-drag should not become the team's crossover chart.
//
// LINKS. Every shape is linked to the inventory sails it stands for. Import
// auto-links what it can (match.ts) and then asks about the rest: link to an
// existing sail, or add it to the inventory.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  type ChartPoint, type ChartSail, type SailChart, EMPTY_CHART, NEW_SAIL_COLOURS,
  parseCrossoverXml, toCrossoverXml, normaliseSailChart, defaultShape, groupForKind, newSailId, centroid,
} from '../../lib/sailchart/model'
import {
  outline, contains, insertIndex, apparent, bspAt, awsIsoline, awaIsoline, vmgLine, levels, type Range,
} from '../../lib/sailchart/geometry'
import { autoLink, matchSail, sailCode, type InventorySail } from '../../lib/sailchart/match'
import { parseSailGrid, gridToChart } from '../../lib/sailchart/grid'

const C = {
  card: '#071624', border: '#1E3A5A', accent: '#06B6D4', plot: '#f8fafc', grid: '#e2e8f0',
  text: '#cbd5e1', dim: '#8A97A9', head: '#e2e8f0', warn: '#F59E0B', ok: '#10B981', err: '#F87171',
}

export interface PanelSail extends InventorySail { kind?: string | null }

const KIND_FOR_GROUP: Record<string, string> = {
  headsails: 'jib', spinnakers: 'spinnaker', staysails: 'staysail', furlers: 'code', mainsails: 'mainsail',
}
const kindForGroup = (g: string) => KIND_FOR_GROUP[g.toLowerCase()] || 'other'

const AWA_LEVELS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 135, 150]

// A callback ref, not a ref object: the chart box does not exist on the first
// render (the panel shows "Loading…"), and an effect keyed on a ref object would
// run once against null and never measure the box that appears later.
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!el) return
    const set = () => setW(Math.max(300, el.clientWidth))
    set()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w]
}

const floorTo = (v: number, s: number) => Math.floor(v / s) * s
const ceilTo = (v: number, s: number) => Math.ceil(v / s) * s

function rangeOf(sails: ChartSail[]): Range {
  const pts = sails.flatMap(s => outline(s.points, 6))
  if (!pts.length) return { twaMin: 25, twaMax: 180, twsMin: 0, twsMax: 30 }
  const twas = pts.map(p => p.twa), twss = pts.map(p => p.tws)
  // Downwind always runs to 180°, and there is headroom above the windiest shape:
  // the range is frozen while a point is dragged, so a plot trimmed to the shapes
  // (+2°) put the kites' deepest points ON its right edge and a point could not be
  // pulled past it in one go — while the polar's downwind targets run to ~160°.
  return {
    twaMin: Math.max(0, floorTo(Math.min(...twas) - 2, 5)),
    twaMax: 180,
    twsMin: 0,
    twsMax: Math.max(10, ceilTo(Math.max(...twss) + 3, 2)),
  }
}

type Drag =
  | { kind: 'point'; sailId: string; index: number }
  | { kind: 'move'; sailId: string; from: ChartPoint; orig: ChartPoint[]; origLabel: ChartPoint | null }

export default function SailChartPanel({
  teamId, boatId, canEdit, isMobile, sails, polar, polarName, onCreateSail,
}: {
  teamId: string; boatId: string; canEdit: boolean; isMobile?: boolean
  sails: PanelSail[]
  /** A prepared polarCalc polar (polarFromData), or null when the boat has none. */
  polar: any | null
  polarName?: string | null
  onCreateSail: (body: { name: string; kind: string; category?: string | null }) => Promise<PanelSail>
}) {
  const [chart, setChart] = useState<SailChart>(EMPTY_CHART)
  const [saved, setSaved] = useState<string>('')        // JSON of the stored chart, for the dirty check
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [selPt, setSelPt] = useState<number | null>(null)
  const [hover, setHover] = useState<ChartPoint | null>(null)
  const [show, setShow] = useState({ aws: true, awa: true, vmg: true })
  const [hiddenGroups, setHiddenGroups] = useState<string[]>([])
  const [history, setHistory] = useState<ChartSail[][]>([])
  const [addPick, setAddPick] = useState('')
  const drag = useRef<Drag | null>(null)
  const frozenRange = useRef<Range | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const url = `/api/teams/${teamId}/boats/${boatId}/sailchart`

  useEffect(() => {
    let alive = true
    setLoading(true); setErr('')
    fetch(url).then(r => r.json()).then(j => {
      if (!alive) return
      if (j.error) { setErr(j.error); return }
      const c = normaliseSailChart(j.chart)
      setChart(c); setSaved(JSON.stringify(c)); setUpdatedAt(j.updatedAt)
    }).catch(e => alive && setErr(String(e))).finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [url])

  const dirty = JSON.stringify(chart) !== saved
  const sailById = useMemo(() => Object.fromEntries(sails.map(s => [s.id, s])), [sails])

  // ── edits ────────────────────────────────────────────────────────────────
  // History is pushed from the CURRENT render's chart, never from inside a state
  // updater: React may run an updater twice, which would record every edit twice.
  const pushHistory = () => setHistory(h => [...h.slice(-49), chart.sails])
  const commit = (next: ChartSail[]) => {
    pushHistory()
    setChart(c => ({ ...c, sails: next }))
  }
  const updateSail = (id: string, patch: Partial<ChartSail>) => {
    pushHistory()
    setChart(c => ({ ...c, sails: c.sails.map(s => (s.id === id ? { ...s, ...patch } : s)) }))
  }
  const undo = () => {
    if (!history.length) return
    const prev = history[history.length - 1]
    setChart(c => ({ ...c, sails: prev }))
    setHistory(history.slice(0, -1))
  }

  const selected = chart.sails.find(s => s.id === selId) || null

  const removePoint = (id: string, index: number) => {
    const s = chart.sails.find(x => x.id === id)
    if (!s) return
    if (s.points.length <= 3) { setMsg('A shape needs at least 3 points.'); return }
    updateSail(id, { points: s.points.filter((_, i) => i !== index) })
    setSelPt(null)
  }

  // The key handler reads this render's state through a ref, so the listener is
  // attached once instead of on every render.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  onKeyRef.current = (e: KeyboardEvent) => {
    if (!canEdit) return
    const t = e.target as HTMLElement
    if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selId && selPt != null) { e.preventDefault(); removePoint(selId, selPt) }
    else if (e.key === 'Escape') { setSelId(null); setSelPt(null) }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── import / export / save ───────────────────────────────────────────────
  const importFile = async (f: File) => {
    setErr(''); setMsg('')
    try {
      // Either an Expedition crossover XML, or the older nav table (TWS rows ×
      // TWA columns, a sail per cell), which is converted into curved shapes.
      const text = await f.text()
      const isXml = /<\s*crossoverchart\b/i.test(text)
      const parsed = isXml ? parseCrossoverXml(text, f.name) : gridToChart(parseSailGrid(text), f.name)
      if (chart.sails.length && !window.confirm(`Replace the current chart (${chart.sails.length} sails) with ${f.name} (${parsed.sails.length})? Nothing is stored until you press Save.`)) return
      const r = autoLink(parsed.sails, sails)
      pushHistory()
      setChart({ ...parsed, sails: r.sails })
      setSelId(null)
      const names = r.unmatched.map(id => r.sails.find(s => s.id === id)?.name).filter(Boolean)
      setMsg(`Imported ${parsed.sails.length} sail shapes${isXml ? '' : ' (converted from the sail table — check the edges, then Save)'}; linked ${r.linked} to the inventory.` +
        (names.length ? ` ${names.length} need you below: ${names.join(', ')}.` : ''))
    } catch (e: any) { setErr(e?.message || String(e)) }
  }

  const exportXml = () => {
    const blob = new Blob([toCrossoverXml(chart)], { type: 'application/xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = chart.fileName ? chart.fileName.replace(/\.xml$/i, '') + '_SSA.xml' : 'sailchart.xml'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const save = async () => {
    setBusy(true); setErr('')
    try {
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chart }) })
      const j = await r.json()
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`)
      const c = normaliseSailChart(j.chart)
      setChart(c); setSaved(JSON.stringify(c)); setUpdatedAt(j.updatedAt)
      setMsg('Saved.')
    } catch (e: any) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }

  const discard = () => {
    if (!window.confirm('Discard unsaved changes?')) return
    setChart(normaliseSailChart(JSON.parse(saved || '{}'))); setHistory([]); setSelId(null)
  }

  // ── add a sail ───────────────────────────────────────────────────────────
  const linkedIds = new Set(chart.sails.flatMap(s => s.sailIds))
  const addable = sails.filter(s => !s.retired && !linkedIds.has(s.id))

  const addSail = () => {
    let shape: ChartSail
    const colour = NEW_SAIL_COLOURS[chart.sails.length % NEW_SAIL_COLOURS.length]
    if (addPick === '__new') {
      const name = (window.prompt('Name of the new chart sail (e.g. J4, A3, FR0):') || '').trim()
      if (!name) return
      shape = blankShape(name, 'Headsails', null, colour, [])
    } else {
      const inv = sailById[addPick]
      if (!inv) return
      const group = groupForKind(inv.kind)
      shape = blankShape(sailCode(inv.name) || inv.name, group, inv.kind, colour, [inv.id])
      shape.alias = [inv.name]
    }
    commit([...chart.sails, shape])
    setSelId(shape.id); setSelPt(null); setAddPick('')
    setMsg(`Added ${shape.name}. Drag its points into place; double-click the outline to add more.`)
  }

  // ── links ────────────────────────────────────────────────────────────────
  const link = (shapeId: string, sailId: string) => {
    const s = chart.sails.find(x => x.id === shapeId)
    if (!s || !sailId || s.sailIds.includes(sailId)) return
    updateSail(shapeId, { sailIds: [...s.sailIds, sailId] })
  }
  const unlink = (shapeId: string, sailId: string) => {
    const s = chart.sails.find(x => x.id === shapeId)
    if (s) updateSail(shapeId, { sailIds: s.sailIds.filter(x => x !== sailId) })
  }
  const addToInventory = async (shape: ChartSail) => {
    const name = (window.prompt(`Add "${shape.name}" to the sail inventory as:`, shape.alias[0] || shape.name) || '').trim()
    if (!name) return
    setBusy(true); setErr('')
    try {
      const created = await onCreateSail({ name, kind: kindForGroup(shape.group), category: sailCode(shape.name) || null })
      updateSail(shape.id, { sailIds: [...shape.sailIds, created.id] })
      setMsg(`${name} added to the inventory and linked to ${shape.name}. Save the chart to keep the link.`)
    } catch (e: any) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }
  const rematch = () => {
    const r = autoLink(chart.sails, sails)
    commit(r.sails)
    setMsg(`Linked ${r.linked} more; ${r.unmatched.length} still unlinked.`)
  }

  // ── geometry / scales ────────────────────────────────────────────────────
  const [boxRef, width] = useWidth()
  const liveRange = useMemo(() => rangeOf(chart.sails), [chart.sails])
  const range = (drag.current && frozenRange.current) || liveRange
  const H = isMobile ? 420 : 600
  const M = { l: 40, r: 14, t: 14, b: 30 }
  const pw = width - M.l - M.r, ph = H - M.t - M.b
  const sx = pw / (range.twaMax - range.twaMin), sy = ph / (range.twsMax - range.twsMin)
  const X = (twa: number) => M.l + (twa - range.twaMin) * sx
  const Y = (tws: number) => M.t + (range.twsMax - tws) * sy
  const toData = (e: { clientX: number; clientY: number }): ChartPoint => {
    const r = svgRef.current!.getBoundingClientRect()
    return { twa: range.twaMin + (e.clientX - r.left - M.l) / sx, tws: range.twsMax - (e.clientY - r.top - M.t) / sy }
  }
  const path = (pts: ChartPoint[], close = false) =>
    pts.length ? 'M' + pts.map(p => `${X(p.twa).toFixed(1)},${Y(p.tws).toFixed(1)}`).join('L') + (close ? 'Z' : '') : ''

  const groups = useMemo(() => Array.from(new Set(chart.sails.map(s => s.group))), [chart.sails])
  const shown = chart.sails.filter(s => s.visible && !hiddenGroups.includes(s.group))
  const outlines = useMemo(
    () => Object.fromEntries(chart.sails.map(s => [s.id, outline(s.points, 12, !!s.extra?.straight)])),
    [chart.sails])

  // Polar overlays — recomputed only when the polar or the axes change.
  const rangeKey = `${range.twaMin}|${range.twaMax}|${range.twsMax}`
  const overlays = useMemo(() => {
    if (!polar) return null
    const aws = levels(4, Math.min(40, range.twsMax + 14), 2).map(v => ({ v, pts: awsIsoline(polar, v, range) }))
    const awa = AWA_LEVELS.map(v => ({ v, pts: awaIsoline(polar, v, range) }))
    return { aws, awa, up: vmgLine(polar, 'up', range), dn: vmgLine(polar, 'down', range) }
  }, [polar, rangeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── pointer handling ─────────────────────────────────────────────────────
  const hitShape = (p: ChartPoint): ChartSail | null => {
    for (let i = shown.length - 1; i >= 0; i--) if (contains(outlines[shown[i].id], p)) return shown[i]
    return null
  }
  const onBgDown = (e: React.PointerEvent) => {
    const p = toData(e)
    // the selected shape wins, even under another one: it is the one being edited
    const hit = selected && contains(outlines[selected.id], p) ? selected : hitShape(p)
    if (!hit) { setSelId(null); setSelPt(null); return }
    if (hit.id !== selId) { setSelId(hit.id); setSelPt(null); return }
    if (!canEdit) return
    pushHistory()
    frozenRange.current = range
    drag.current = { kind: 'move', sailId: hit.id, from: p, orig: hit.points, origLabel: hit.label }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onHandleDown = (e: React.PointerEvent, sailId: string, index: number) => {
    e.stopPropagation()
    if (!canEdit) return
    if (e.altKey) { removePoint(sailId, index); return }
    setSelPt(index)
    pushHistory()
    frozenRange.current = range
    drag.current = { kind: 'point', sailId, index }
    ;(svgRef.current as Element | null)?.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const p = toData(e)
    setHover(p)
    const d = drag.current
    if (!d) return
    const clampPt = (q: ChartPoint) => ({
      twa: Math.round(Math.max(0, Math.min(180, q.twa)) * 10) / 10,
      tws: Math.round(Math.max(0, Math.min(60, q.tws)) * 10) / 10,
    })
    if (d.kind === 'point') {
      setChart(c => ({ ...c, sails: c.sails.map(s => s.id !== d.sailId ? s
        : { ...s, points: s.points.map((q, i) => (i === d.index ? clampPt(p) : q)) }) }))
    } else {
      const dx = p.twa - d.from.twa, dy = p.tws - d.from.tws
      setChart(c => ({ ...c, sails: c.sails.map(s => s.id !== d.sailId ? s : {
        ...s,
        points: d.orig.map(q => clampPt({ twa: q.twa + dx, tws: q.tws + dy })),
        label: d.origLabel ? clampPt({ twa: d.origLabel.twa + dx, tws: d.origLabel.tws + dy }) : null,
      }) }))
    }
  }
  const onUp = () => {
    if (drag.current) {
      drag.current = null
      frozenRange.current = null
      // a click that did not move anything should not leave an undo step behind
      setHistory(h => (h.length && JSON.stringify(h[h.length - 1]) === JSON.stringify(chart.sails) ? h.slice(0, -1) : h))
    }
  }
  const onDouble = (e: React.MouseEvent) => {
    if (!canEdit || !selected) return
    const p = toData(e)
    const at = insertIndex(selected.points, p, sx, sy)
    const pts = [...selected.points]
    pts.splice(at, 0, { twa: Math.round(p.twa * 10) / 10, tws: Math.round(p.tws * 10) / 10 })
    updateSail(selected.id, { points: pts })
    setSelPt(at)
  }

  // hover readout
  const readout = useMemo(() => {
    if (!hover || hover.twa < range.twaMin || hover.twa > range.twaMax || hover.tws < 0 || hover.tws > range.twsMax) return null
    const bsp = polar ? bspAt(polar, hover.tws, hover.twa) : null
    const app = bsp != null ? apparent(hover.tws, hover.twa, bsp) : null
    const under = shown.filter(s => contains(outlines[s.id], hover)).map(s => s.name)
    return { ...hover, bsp, app, under }
  }, [hover, polar, shown, outlines, range])

  // ── render ───────────────────────────────────────────────────────────────
  const inputS: React.CSSProperties = { background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '5px 7px', fontSize: 12 }
  const btn = (bg: string, fg = '#001018'): React.CSSProperties => ({ background: bg, border: 'none', borderRadius: 6, color: fg, fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer' })
  const chip = (on: boolean): React.CSSProperties => ({
    fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 9px', cursor: 'pointer', border: 'none',
    background: on ? C.accent : '#0F2A45', color: on ? '#001018' : '#94A3B8',
  })

  const xTicks = levels(range.twaMin, range.twaMax, 5)
  const xLabelEvery = sx * 5 >= 26 ? 5 : sx * 10 >= 26 ? 10 : 20 // keep tick labels ~26 px apart
  const yTicks = levels(range.twsMin, range.twsMax, 1)
  const unlinked = chart.sails.filter(s => !s.sailIds.length)

  if (loading) return <div style={{ color: C.dim, fontSize: 12 }}>Loading sail chart…</div>

  return (
    <div>
      {/* toolbar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: C.head, marginRight: 4 }}>Sail chart</span>
        {chart.fileName && <span style={{ fontSize: 11, color: C.dim }}>{chart.fileName}</span>}
        {updatedAt && <span style={{ fontSize: 10, color: C.dim }}>saved {new Date(updatedAt).toLocaleString()}</span>}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <>
            <input ref={fileRef} type="file" accept=".xml,.txt,.csv,.tsv,text/xml,application/xml,text/plain,text/csv" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = '' }} />
            <button style={btn('#0F2A45', C.head)} onClick={() => fileRef.current?.click()}>⇪ Import chart</button>
          </>
        )}
        {chart.sails.length > 0 && <button style={btn('#0F2A45', C.head)} onClick={exportXml}>⇩ Export XML</button>}
        {canEdit && (
          <>
            <button style={{ ...btn('#0F2A45', C.head), opacity: history.length ? 1 : 0.4 }} disabled={!history.length} onClick={undo} title="⌘Z">↶ Undo</button>
            {dirty && <button style={btn('#0F2A45', C.warn)} onClick={discard}>Discard</button>}
            <button style={{ ...btn(dirty ? C.ok : '#0F2A45', dirty ? '#001018' : C.dim), opacity: busy ? 0.6 : 1 }}
              disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : dirty ? 'Save chart' : 'Saved'}</button>
          </>
        )}
      </div>

      {err && <div style={{ color: C.err, fontSize: 12, marginBottom: 8 }}>Error: {err}</div>}
      {msg && <div style={{ color: C.accent, fontSize: 12, marginBottom: 8 }}>{msg}</div>}

      {chart.sails.length === 0 && (
        <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: '18px 16px', color: C.dim, fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.head, marginBottom: 4 }}>No sail chart yet</div>
          Import an Expedition crossover chart (<code>&lt;crossoverchart&gt;</code> XML) or an older nav sail table
          (TWS rows × TWA columns, a sail name per cell — .txt or .csv, either way round), which is converted into
          curved shapes{canEdit ? '; or add sails one by one below and draw them' : ''}.
          {!polar && ' The boat has no polar on the Targets tab, so the AWA/AWS and VMG lines will not be drawn.'}
        </div>
      )}

      {/* overlay + group toggles */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: C.dim }}>Polar{polarName ? ` (${polarName})` : ''}:</span>
        {polar ? (
          <>
            <button style={chip(show.aws)} onClick={() => setShow(s => ({ ...s, aws: !s.aws }))}>AWS lines</button>
            <button style={chip(show.awa)} onClick={() => setShow(s => ({ ...s, awa: !s.awa }))}>AWA lines</button>
            <button style={chip(show.vmg)} onClick={() => setShow(s => ({ ...s, vmg: !s.vmg }))}>VMG targets</button>
          </>
        ) : <span style={{ fontSize: 11, color: C.warn }}>none on file — load one on Targets</span>}
        {groups.length > 1 && <span style={{ fontSize: 11, color: C.dim, marginLeft: 10 }}>Show:</span>}
        {groups.length > 1 && groups.map(g => (
          <button key={g} style={chip(!hiddenGroups.includes(g))}
            onClick={() => setHiddenGroups(h => (h.includes(g) ? h.filter(x => x !== g) : [...h, g]))}>{g}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* chart */}
        <div ref={boxRef} style={{ flex: '1 1 480px', minWidth: 0, position: 'relative' }}>
          <svg ref={svgRef} width={width} height={H}
            style={{ display: 'block', background: C.plot, borderRadius: 8, touchAction: 'none', userSelect: 'none', cursor: drag.current ? 'grabbing' : 'default' }}
            onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onPointerLeave={() => setHover(null)} onDoubleClick={onDouble}>
            <defs>
              <clipPath id="sc-plot"><rect x={M.l} y={M.t} width={pw} height={ph} /></clipPath>
            </defs>
            {/* grid */}
            {xTicks.map(v => (
              <g key={`x${v}`}>
                <line x1={X(v)} x2={X(v)} y1={M.t} y2={M.t + ph} stroke={C.grid} strokeWidth={v % 10 === 0 ? 1 : 0.5} />
                {v % xLabelEvery === 0 && <text x={X(v)} y={H - 10} fontSize={10} fill="#334155" textAnchor="middle">{v}</text>}
              </g>
            ))}
            {yTicks.map(v => (
              <g key={`y${v}`}>
                <line x1={M.l} x2={M.l + pw} y1={Y(v)} y2={Y(v)} stroke={C.grid} strokeWidth={v % 5 === 0 ? 1 : 0.5} />
                {(sy >= 14 || v % 2 === 0) && <text x={M.l - 6} y={Y(v) + 3} fontSize={10} fill="#334155" textAnchor="end">{v}</text>}
              </g>
            ))}
            <text x={M.l + pw / 2} y={H - 0} fontSize={10} fill="#64748b" textAnchor="middle">TWA °</text>
            <text x={10} y={M.t + ph / 2} fontSize={10} fill="#64748b" textAnchor="middle" transform={`rotate(-90 10 ${M.t + ph / 2})`}>TWS kn</text>

            <g clipPath="url(#sc-plot)">
              {/* sails */}
              {shown.map(s => {
                const sel = s.id === selId
                const lab = s.label || centroid(s.points)
                return (
                  <g key={s.id}>
                    <path d={path(outlines[s.id], true)} fill={s.colour} fillOpacity={s.opacity / 100 * (selId && !sel ? 0.6 : 1)}
                      stroke={s.colour} strokeWidth={sel ? s.lineWidth + 1.5 : s.lineWidth}
                      strokeDasharray={s.dashed ? '6 4' : undefined} />
                    <text x={X(lab.twa)} y={Y(lab.tws)} fontSize={14} fontWeight={800} fill="#0f172a" textAnchor="middle" dominantBaseline="middle"
                      style={{ pointerEvents: 'none' }}>{s.name}</text>
                  </g>
                )
              })}

              {/* polar overlays, over the fills so they stay legible, thin and dashed */}
              {overlays && show.aws && overlays.aws.map(l => l.pts.length > 1 && (
                <g key={`aws${l.v}`} style={{ pointerEvents: 'none' }}>
                  <path d={path(l.pts)} fill="none" stroke="#2563eb" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="5 4" />
                  <text x={X(l.pts[Math.floor(l.pts.length * 0.62)].twa)} y={Y(l.pts[Math.floor(l.pts.length * 0.62)].tws) - 2}
                    fontSize={9} fill="#1d4ed8" fillOpacity={0.8}>aws{l.v}</text>
                </g>
              ))}
              {overlays && show.awa && overlays.awa.map(l => l.pts.length > 1 && (
                <g key={`awa${l.v}`} style={{ pointerEvents: 'none' }}>
                  <path d={path(l.pts)} fill="none" stroke="#16a34a" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="5 4" />
                  {(() => { const q = labelAt(l.pts, range.twsMax * 0.5); return (
                    <text x={X(q.twa) + 2} y={Y(q.tws) - 3} fontSize={9} fill="#15803d" fillOpacity={0.85}>awa{l.v}</text>) })()}
                </g>
              ))}
              {overlays && show.vmg && [overlays.up, overlays.dn].map((pts, i) => pts.length > 1 && (
                <path key={`vmg${i}`} d={path(pts)} fill="none" stroke="#dc2626" strokeWidth={3} strokeDasharray="4 5"
                  strokeLinecap="round" style={{ pointerEvents: 'none' }} />
              ))}

              {/* the selected shape's control points */}
              {selected && (
                <g>
                  <path d={path(selected.points, true)} fill="none" stroke="#0f172a" strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2 3" style={{ pointerEvents: 'none' }} />
                  {selected.points.map((p, i) => (
                    <circle key={i} cx={X(p.twa)} cy={Y(p.tws)} r={selPt === i ? 7 : 5.5}
                      fill={selPt === i ? '#0f172a' : '#fff'} stroke="#0f172a" strokeWidth={1.5}
                      style={{ cursor: canEdit ? 'grab' : 'default' }}
                      onPointerDown={e => onHandleDown(e, selected.id, i)} />
                  ))}
                </g>
              )}
            </g>
            <rect x={M.l} y={M.t} width={pw} height={ph} fill="none" stroke="#94a3b8" style={{ pointerEvents: 'none' }} />
          </svg>

          {/* The hover readout sits in a strip UNDER the plot, never over it: floated in
              a corner it covered the deep, windy end of the chart — exactly where the
              kites' points are — so they could not be seen or grabbed. Fixed height,
              so the page does not jump as the pointer enters and leaves the plot. */}
          <div style={{ marginTop: 6, minHeight: 20, display: 'flex', flexWrap: 'wrap', gap: '2px 12px', alignItems: 'center',
            background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 9px',
            color: '#e2e8f0', fontSize: 11, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
            {readout ? (
              <>
                <span>TWA {readout.twa.toFixed(0)}° · TWS {readout.tws.toFixed(1)} kn</span>
                {readout.bsp != null && readout.app && <span>BSP {readout.bsp.toFixed(1)} · AWA {readout.app.awa.toFixed(0)}° · AWS {readout.app.aws.toFixed(1)}</span>}
                <span style={{ fontWeight: 700 }}>{readout.under.length ? readout.under.join(' · ') : <span style={{ color: '#94a3b8', fontWeight: 400 }}>no sail</span>}</span>
              </>
            ) : <span style={{ color: C.dim }}>Point at the chart for TWA, TWS, boat speed, apparent wind and the sail there.</span>}
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
            Click a sail to select it.{canEdit && ' Drag a point to reshape, drag inside to move the whole sail, double-click near the outline to add a point, Alt-click a point (or select it + Delete) to remove it. ⌘Z undoes.'}
          </div>
        </div>

        {/* side panel */}
        <div style={{ flex: isMobile ? '1 1 100%' : '0 1 300px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {canEdit && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.head, marginBottom: 6 }}>Add a sail to the chart</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select style={{ ...inputS, flex: 1, minWidth: 0 }} value={addPick} onChange={e => setAddPick(e.target.value)}>
                  <option value="">Choose from inventory…</option>
                  {addable.map(s => <option key={s.id} value={s.id}>{s.name}{s.kind ? ` · ${s.kind}` : ''}</option>)}
                  <option value="__new">Not in the inventory (type a name)…</option>
                </select>
                <button style={{ ...btn(C.accent), opacity: addPick ? 1 : 0.4 }} disabled={!addPick} onClick={addSail}>Add</button>
              </div>
            </div>
          )}

          {selected && (
            <SelectedEditor key={selected.id} sail={selected} canEdit={canEdit} groups={groups} inputS={inputS}
              onPatch={(p) => updateSail(selected.id, p)}
              onDelete={() => { if (window.confirm(`Remove ${selected.name} from the chart? (The inventory sail is not touched.)`)) { commit(chart.sails.filter(s => s.id !== selected.id)); setSelId(null) } }}
              onClose={() => { setSelId(null); setSelPt(null) }} />
          )}

          {/* inventory links */}
          {chart.sails.length > 0 && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: C.head }}>Inventory links</span>
                {unlinked.length > 0 && <span style={{ fontSize: 11, color: C.warn }}>{unlinked.length} unlinked</span>}
                <span style={{ flex: 1 }} />
                {canEdit && unlinked.length > 0 && <button style={{ ...btn('#0F2A45', C.head), padding: '3px 8px', fontSize: 11 }} onClick={rematch}>Auto-match</button>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: isMobile ? undefined : 420, overflowY: 'auto' }}>
                {[...unlinked, ...chart.sails.filter(s => s.sailIds.length)].map(s => (
                  <LinkRow key={s.id} shape={s} sails={sails} sailById={sailById} canEdit={canEdit} busy={busy} inputS={inputS}
                    selected={s.id === selId} onSelect={() => { setSelId(s.id); setSelPt(null) }}
                    onLink={id => link(s.id, id)} onUnlink={id => unlink(s.id, id)} onAdd={() => addToInventory(s)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// The isoline point nearest a given TWS — AWA lines bunch together in light air,
// so they are labelled mid-chart, where they are spread out.
function labelAt(pts: ChartPoint[], tws: number): ChartPoint {
  return pts.reduce((b, p) => (Math.abs(p.tws - tws) < Math.abs(b.tws - tws) ? p : b), pts[0])
}

function blankShape(name: string, group: string, kind: string | null | undefined, colour: string, sailIds: string[]): ChartSail {
  return {
    id: newSailId(), name, group, colour, alias: [], points: defaultShape(kind, group),
    opacity: 40, dashed: /stay/i.test(group), lineWidth: 2, label: null, visible: true, sailIds,
  }
}

function SelectedEditor({ sail, canEdit, groups, inputS, onPatch, onDelete, onClose }: {
  sail: ChartSail; canEdit: boolean; groups: string[]; inputS: React.CSSProperties
  onPatch: (p: Partial<ChartSail>) => void; onDelete: () => void; onClose: () => void
}) {
  const [name, setName] = useState(sail.name)
  const [alias, setAlias] = useState(sail.alias.join('; '))
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.dim }
  const lab: React.CSSProperties = { width: 56, flexShrink: 0 }
  return (
    <div style={{ background: C.card, border: `1px solid ${C.accent}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: sail.colour }} />
        <span style={{ fontSize: 13, fontWeight: 800, color: C.head }}>{sail.name}</span>
        <span style={{ fontSize: 11, color: C.dim }}>{sail.points.length} points</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 14 }}>×</button>
      </div>
      {canEdit && (
        <>
          <label style={row}><span style={lab}>Name</span>
            <input style={{ ...inputS, flex: 1 }} value={name} onChange={e => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== sail.name && onPatch({ name: name.trim() })} /></label>
          <label style={row}><span style={lab}>Group</span>
            <input style={{ ...inputS, flex: 1 }} list="sc-groups" defaultValue={sail.group}
              onBlur={e => e.target.value.trim() && e.target.value.trim() !== sail.group && onPatch({ group: e.target.value.trim() })} />
            <datalist id="sc-groups">{Array.from(new Set([...groups, 'Headsails', 'Spinnakers', 'Staysails', 'Furlers'])).map(g => <option key={g} value={g} />)}</datalist>
          </label>
          <label style={row}><span style={lab}>Aliases</span>
            <input style={{ ...inputS, flex: 1 }} value={alias} placeholder="J3-A; J3-B" onChange={e => setAlias(e.target.value)}
              onBlur={() => onPatch({ alias: alias.split(/[;,]/).map(x => x.trim()).filter(Boolean) })} /></label>
          <label style={row}><span style={lab}>Colour</span>
            <input type="color" value={sail.colour} onChange={e => onPatch({ colour: e.target.value })}
              style={{ width: 34, height: 22, border: 'none', background: 'none', padding: 0 }} />
            <span style={{ marginLeft: 8 }}>Fill</span>
            <input type="range" min={5} max={90} value={sail.opacity} onChange={e => onPatch({ opacity: Number(e.target.value) })} style={{ flex: 1 }} />
          </label>
          <label style={row}><span style={lab}>Outline</span>
            <input type="checkbox" checked={sail.dashed} onChange={e => onPatch({ dashed: e.target.checked })} /> dashed
            <input type="checkbox" checked={sail.visible} onChange={e => onPatch({ visible: e.target.checked })} style={{ marginLeft: 10 }} /> visible
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onPatch({ label: null })} style={{ background: '#0F2A45', color: C.head, border: 'none', borderRadius: 6, fontSize: 11, padding: '4px 8px', cursor: 'pointer' }}>Centre label</button>
            <span style={{ flex: 1 }} />
            <button onClick={onDelete} style={{ background: 'none', color: C.err, border: `1px solid ${C.err}`, borderRadius: 6, fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}>Remove from chart</button>
          </div>
        </>
      )}
      {!canEdit && sail.alias.length > 0 && <div style={{ fontSize: 11, color: C.dim }}>Aliases: {sail.alias.join(', ')}</div>}
    </div>
  )
}

function LinkRow({ shape, sails, sailById, canEdit, busy, inputS, selected, onSelect, onLink, onUnlink, onAdd }: {
  shape: ChartSail; sails: PanelSail[]; sailById: Record<string, PanelSail>; canEdit: boolean; busy: boolean
  inputS: React.CSSProperties; selected: boolean
  onSelect: () => void; onLink: (id: string) => void; onUnlink: (id: string) => void; onAdd: () => void
}) {
  const unlinked = !shape.sailIds.length
  const suggestion = useMemo(() => (unlinked ? matchSail(shape, sails) : null), [unlinked, shape, sails])
  return (
    <div style={{ borderTop: `1px solid #0d2236`, paddingTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: shape.colour, flexShrink: 0 }} />
        <button onClick={onSelect} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: selected ? C.accent : C.head, fontWeight: 800, fontSize: 12 }}>{shape.name}</button>
        {shape.sailIds.map(id => (
          <span key={id} style={{ fontSize: 11, borderRadius: 4, padding: '1px 6px',
            background: sailById[id] ? '#0F2A45' : '#3b1d1d', color: sailById[id] ? C.text : C.err }}>
            {sailById[id]?.name || 'no longer in the inventory'}
            {canEdit && <span onClick={() => onUnlink(id)} style={{ marginLeft: 5, cursor: 'pointer', color: C.dim }}>×</span>}
          </span>
        ))}
        {unlinked && <span style={{ fontSize: 11, color: C.warn }}>
          {suggestion?.retiredOnly ? 'only matches a retired sail' : 'no match in the inventory'}
        </span>}
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <select style={{ ...inputS, flex: 1, minWidth: 0, fontSize: 11, padding: '3px 5px' }} value=""
            onChange={e => e.target.value && onLink(e.target.value)}>
            <option value="">{unlinked ? 'Link to an inventory sail…' : '+ link another sail…'}</option>
            {sails.filter(s => !shape.sailIds.includes(s.id)).map(s => (
              <option key={s.id} value={s.id}>{s.name}{s.retired ? ' (retired)' : ''}</option>
            ))}
          </select>
          {unlinked && (
            <button disabled={busy} onClick={onAdd} style={{ background: C.accent, color: '#001018', border: 'none', borderRadius: 6,
              fontWeight: 700, fontSize: 11, padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ Add to inventory</button>
          )}
        </div>
      )}
    </div>
  )
}
