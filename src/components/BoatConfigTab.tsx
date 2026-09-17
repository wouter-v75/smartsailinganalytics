'use client'
// src/components/BoatConfigTab.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Boat Config — sub-tabs:
//   • Sail inventory  — SSA-owned master list of sail tags (name, build date,
//                       status, certificate). Editable by TL3+. Scans + daily
//                       configs link to these sails.
//   • Sail shapes     — structured trim-stripe scans (ingested from North).
//   • Polar           — target speed reference (design VPP, via lib/polarCalc).
//   • Battens         — the laminated batten card: stiffness + turns per batten
//                       (numbered from the top) per wind band. Boat setup, so
//                       the same TL3+ gate as the rest of this tab.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { uploadBlobToStorage } from '../lib/bunny-storage-upload'
import { parseSailList, sailKindFromType } from '../lib/sailListParse'
import { extractLargestJpegBlob, extractJpegBlobs } from '../lib/pdfImageExtract'
import { getLogData, getXmlData } from '../lib/localStore'
import { enrichScan, type ScanTags } from '../lib/scanEnrich'
import { parseDesignShapes } from '../lib/designShapeParse'
import { scanLocalDateISO, scanLocalHM } from '../lib/scanTime'
import { getPrefetchedBoatConfig } from '../lib/boatConfigPrefetch'
import SailScanDetail from './SailScanDetail'
import SailScanCompare from './SailScanCompare'
import LogProfilePanel from './LogProfilePanel'
import SailDesignShapes from './SailDesignShapes'
import targetsV14 from '../data/targets-v1.4.json'
import { parsePolarText, parsePolarWorkbook, buildPolarData, type PolarVersion } from '../lib/polarFile'
import { readXlsx } from '../lib/xlsxRead'
import { sailPatchFrom } from '../lib/sailEdit'
import { useUiNext } from '../lib/ui-flags'
import BoatConfigNext from './boat/BoatConfigNext'
import BattenCardPanel from './boat/BattenCardPanel'

interface Sail {
  id: string
  boat_id?: string
  name: string
  kind?: string | null
  category?: string | null
  sailmaker?: string | null
  build_date?: string | null
  in_service_date?: string | null
  retired?: boolean
  certificate_key?: string | null
  certificate_name?: string | null
  notes?: string | null
  specs?: any
}
interface Stripe { pos?: number; camber?: number; draft?: number; twist?: number; entry?: number; exit?: number }
interface Scan {
  id: string; sail_id?: string | null; captured_at?: string | null; source?: string | null
  tws_kn?: number | null; stripes?: Stripe[]; conditions?: any; photo_url?: string | null
}

const C = {
  bg: '#04101c', card: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  text: '#cbd5e1', dim: '#8A97A9', head: '#e2e8f0', warn: '#F59E0B', ok: '#10B981',
}
const EDIT_ROLES = ['admin', 'team_manager', 'coach', 'tl3']
const fmt = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d))
const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'
const fmtClock = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

export default function BoatConfigTab({
  teamId, boatId, role, isMobile, config, sessionTzOffset = 0,
}: { teamId: string; boatId: string; role?: string; config?: any; isMobile?: boolean; sessionTzOffset?: number }) {
  const boatName: string | null = config?.boatName || null
  const canEdit = EDIT_ROLES.includes(role || '')
  const isAdmin = role === 'admin'
  // Consultants (e.g. a sailmaker) may VIEW the sail inventory + sail data, but
  // not the boat's proprietary tuning: Rig settings, Targets, Log profile.
  const canSeeTuning = role !== 'consultant'
  // Seed from the on-open prefetch (lib/boatConfigPrefetch) so the tab renders
  // instantly with the team's sails/scans/polar/rig; the effects below still
  // revalidate in the background.
  const pf = getPrefetchedBoatConfig(teamId, boatId)
  const [view, setView] = useState<'inventory' | 'shapes' | 'rig' | 'polar' | 'log' | 'battens'>('inventory')
  const uiNext = useUiNext() // ?ui=next → redesigned reference screen (Phase 1)
  const [sails, setSails] = useState<Sail[]>(() => (pf?.sails as Sail[]) || [])
  const [scans, setScans] = useState<Scan[]>(() => (pf?.scans as Scan[]) || [])
  const [loading, setLoading] = useState(!pf?.sails)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string>('') // sail id being mutated
  const [polar, setPolar] = useState<any>(() => pf?.polar ?? null)          // active polar row (DB)
  const [matrixKey, setMatrixKey] = useState<'bsp' | 'heel' | 'rudder' | 'awa'>('bsp')
  const [importing, setImporting] = useState(false)
  const [polarVersions, setPolarVersions] = useState<any[]>([])              // every polar row for this boat
  const [polarUpload, setPolarUpload] = useState<PolarUpload | null>(null)   // parsed file awaiting save
  const [polarMsg, setPolarMsg] = useState('')
  const [polarSync, setPolarSync] = useState<PolarSync>({ at: null, error: null })   // last read of the cloud
  const [polarSave, setPolarSave] = useState<PolarSaveStatus | null>(null)           // what the last upload did
  const [rigTune, setRigTune] = useState<any>(() => pf?.rigTune ?? null)      // active rig baseline row (DB)
  const [rigBusy, setRigBusy] = useState(false)
  const [rigErr, setRigErr] = useState('')
  const [rigPdfUrl, setRigPdfUrl] = useState<string | null>(null) // admin-only signed PDF URL
  const [selectedScan, setSelectedScan] = useState<any>(null) // open scan detail modal
  const [compareMode, setCompareMode] = useState(false) // multi-select to compare scans
  const [cmpIds, setCmpIds] = useState<string[]>([]) // up to 6 selected scan ids
  const [compareScans, setCompareScans] = useState<any[] | null>(null)
  const [scanTags, setScanTags] = useState<Record<string, ScanTags>>({}) // scanId → derived tags/averages
  const [designSail, setDesignSail] = useState<any>(null) // open design-shapes popup
  const [scanSort, setScanSort] = useState<'sail' | 'date'>('sail') // default: by sail, then date
  const [scanTwsBand, setScanTwsBand] = useState<string>('') // '' = all, else '10-15' / '25+'

  const loadSails = () =>
    fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`).then((r) => r.json())

  useEffect(() => {
    if (!teamId || !boatId) return
    let alive = true
    setLoading(true); setErr('')
    Promise.all([
      loadSails(),
      fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=40`).then((r) => r.json()),
    ])
      .then(([s, sc]) => {
        if (!alive) return
        if (s.error || sc.error) setErr(s.error || sc.error)
        setSails(s.sails || []); setScans(sc.scans || [])
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [teamId, boatId]) // eslint-disable-line react-hooks/exhaustive-deps

  // All versions for this boat (active first); the active one drives the tab. A failed
  // read used to fall back to an empty list, which looks exactly like "no polar on file"
  // — so a sign-in or server problem read as lost data. Say which it is, and hand the
  // list back so an upload can check its rows really landed.
  const loadPolar = useCallback(async (): Promise<any[]> => {
    if (!teamId || !boatId) return []
    try {
      const res = await fetch(`/api/teams/${teamId}/polars?boat_id=${boatId}`)
      const j = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        setPolarSync({ at: Date.now(), error: j?.error === 'unauth' ? 'not signed in' : j?.error || `HTTP ${res.status}` })
        return []
      }
      const list = j.polars || []
      setPolarVersions(list)
      setPolar(list.find((p: any) => p.is_active) || null)
      setPolarSync({ at: Date.now(), error: null })
      return list
    } catch (e: any) {
      setPolarSync({ at: Date.now(), error: String(e?.message || e) })
      return []
    }
  }, [teamId, boatId])
  useEffect(() => { loadPolar() }, [loadPolar])

  const loadRigTune = useCallback(() => {
    if (!teamId || !boatId) return
    fetch(`/api/teams/${teamId}/rig-tunes?boat_id=${boatId}&active=1`)
      .then((r) => (r.ok ? r.json() : { rigTunes: [] }))
      .then((j) => setRigTune((j.rigTunes || [])[0] || null))
      .catch(() => {})
  }, [teamId, boatId])
  useEffect(() => { loadRigTune() }, [loadRigTune])

  // Enrich scans with window averages + event-file tags from the day's local
  // log/event file (point-of-sail, sail, location, avg TWS/TWA).
  useEffect(() => {
    if (view !== 'shapes' || !scans.length) return
    let alive = true
    ;(async () => {
      const dayOf = (s: any) => String(s.conditions?.captured_local || s.captured_at || '').slice(0, 10)
      const days = Array.from(new Set(scans.map(dayOf).filter(Boolean)))
      const logByDay: Record<string, any> = {}, xmlByDay: Record<string, any> = {}
      for (const d of days) {
        try { logByDay[d] = await getLogData(d) } catch { /* none */ }
        try { xmlByDay[d] = await getXmlData(d) } catch { /* none */ }
      }
      if (!alive) return
      const map: Record<string, ScanTags> = {}
      for (const s of scans) {
        const d = dayOf(s)
        const ld = logByDay[d]
        const rows = Array.isArray(ld) ? ld : Array.isArray(ld?.rows) ? ld.rows : []
        map[s.id] = enrichScan(s, rows, xmlByDay[d])
      }
      setScanTags(map)
    })()
    return () => { alive = false }
  }, [view, scans])

  // Admin-only: fetch a short-lived signed URL for the stored source PDF.
  useEffect(() => {
    setRigPdfUrl(null)
    if (!isAdmin || !rigTune?.id || !rigTune?.report_key) return
    let alive = true
    fetch(`/api/teams/${teamId}/rig-tunes/${rigTune.id}/url`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.url) setRigPdfUrl(j.url) })
      .catch(() => {})
    return () => { alive = false }
  }, [isAdmin, rigTune?.id, rigTune?.report_key, teamId])

  // Upload + parse a rig tuning sheet PDF → stored as the active baseline,
  // effective-dated today. The original PDF is also stored (Bunny) so admins can
  // download it. TL3+ only (RLS also enforces it).
  const importRigTune = async (file: File) => {
    setRigBusy(true); setRigErr('')
    try {
      // Stash the original PDF in storage first (non-fatal if it fails — the
      // parsed table still gets saved).
      let reportKey: string | null = null
      try {
        const key = `teams/${teamId}/boats/${boatId}/rig-tunes/${Date.now()}-${file.name}`
        await uploadBlobToStorage({ key, blob: file, contentType: 'application/pdf' })
        reportKey = key
      } catch { /* keep going — store the parsed data regardless */ }

      const fd = new FormData()
      fd.append('boat_id', boatId)
      if (reportKey) fd.append('report_key', reportKey)
      fd.append('file_name', file.name)

      // The rig PDF is ALREADY in Bunny (uploaded just above — we keep rig sheets, so
      // this isn't a transit copy). Sending the bytes a second time in the request body
      // is pure waste, and for a photo-heavy sheet it blows the body limit: the platform
      // answers with a plain-text "Request Entity Too Large" and `.json()` on that threw
      // `Unexpected token 'R'`. Above the limit, let the server read it back from storage.
      // Below it, keep the inline path so a failed Bunny upload can still import.
      const INLINE_MAX = 3_500_000
      if (file.size <= INLINE_MAX || !reportKey) fd.append('file', file)

      const res = await fetch(`/api/teams/${teamId}/rig-tunes`, { method: 'POST', body: fd })
      // Never .json() blindly — an infrastructure rejection (413, 502…) is text/HTML.
      const raw = await res.text()
      let r: any = null
      try { r = JSON.parse(raw) } catch { /* not JSON */ }
      if (!r) {
        setRigErr(
          res.status === 413
            ? `File too large for the server (${(file.size / 1048576).toFixed(1)} MB)`
            : `Server returned ${res.status}: ${raw.slice(0, 120)}`
        )
        return
      }
      if (r.error) setRigErr(r.error); else loadRigTune()
    } catch (e: any) { setRigErr(String(e?.message || e)) }
    finally { setRigBusy(false) }
  }

  // Import the bundled V1.4 targets (parsed from the JV VPP) as the boat's
  // active polar. TL3+ only (RLS also enforces it).
  const importTargets = async () => {
    setImporting(true); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/polars`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boat_id: boatId,
          name: (targetsV14 as any).name || 'V1.4 Targets',
          source: 'design_vpp',
          valid_from: (targetsV14 as any).valid_from || null,
          data: targetsV14,
          activate: true,
        }),
      }).then((x) => x.json())
      if (r.error) setErr(r.error); else loadPolar()
    } catch (e: any) { setErr(String(e?.message || e)) }
    finally { setImporting(false) }
  }

  // Upload polars: a text polar (Expedition or TWS×TWA grid), or a polar workbook
  // with one sheet per version. Every chosen version is saved as its OWN polars row
  // for this boat, so the development history stays on file; one becomes active.
  const pickPolarFile = async (file: File) => {
    setPolarMsg('')
    try {
      const versions: PolarVersion[] = /\.xlsx$/i.test(file.name)
        ? parsePolarWorkbook(await readXlsx(await file.arrayBuffer()))
        : [{ name: file.name.replace(/\.[^.]+$/, ''), entries: parsePolarText(await file.text()), notes: null, headline: null }]
      if (!versions.length) throw new Error('no sheet with a TWS/TWA polar grid')
      const onFile = new Set(polarVersions.map((v: any) => String(v.name).trim().toLowerCase()))
      const today = new Date().toISOString().slice(0, 10)
      const latest = versions.length - 1
      setPolarUpload({
        fileName: file.name, source: 'design_vpp', activeIdx: latest,
        versions: versions.map((v, i) => {
          const stored = onFile.has(v.name.trim().toLowerCase())
          return { ...v, stored, include: !stored, validFrom: i === latest ? today : '' }
        }),
      })
    } catch (e: any) {
      setPolarUpload(null)
      setPolarMsg(`Could not read ${file.name}: ${e?.message || e}`)
    }
  }

  const savePolarUpload = async () => {
    if (!polarUpload) return
    const { fileName, versions, source, activeIdx } = polarUpload
    const chosen = versions.map((v, i) => ({ v, i })).filter(({ v }) => v.include)
    if (chosen.some(({ v }) => !v.name.trim())) { setPolarMsg('Every version needs a name'); return }
    // The version to activate goes last, so it ends up as the boat's active polar.
    chosen.sort((a, b) => Number(a.i === activeIdx) - Number(b.i === activeIdx))
    const act = activeIdx != null ? versions[activeIdx] : null
    setImporting(true); setPolarMsg('')
    const status: PolarSaveStatus = {
      fileName,
      rows: chosen.map(({ v }) => ({ name: v.name.trim(), state: 'waiting' as const })),
      startedAt: Date.now(), finishedAt: null, verified: 'pending', activeName: act ? act.name.trim() : null,
    }
    const show = (patch: Partial<PolarSaveStatus> = {}) => setPolarSave({ ...status, ...patch, rows: [...status.rows] })
    show()
    try {
      for (let k = 0; k < chosen.length; k++) {
        const { v, i } = chosen[k]
        const name = v.name.trim()
        status.rows[k] = { name, state: 'saving' }; show()
        const data = buildPolarData(v.entries, {
          name, version: name, source, valid_from: v.validFrom || null, file_name: fileName,
          source_note: v.notes, headline: v.headline,
        })
        let res: Response
        try {
          res = await fetch(`/api/teams/${teamId}/polars`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              boat_id: boatId, name, source, valid_from: v.validFrom || null, data, notes: v.notes, activate: i === activeIdx,
            }),
          })
        } catch (e: any) {
          // No answer at all — offline, asleep, or the dev server restarted mid-upload.
          status.rows[k] = { name, state: 'failed', detail: `the connection dropped (${String(e?.message || e)})` }
          show({ finishedAt: Date.now(), verified: 'failed' })
          setPolarMsg(`${name}: the connection dropped — nothing from this version on was uploaded`)
          return
        }
        const j = await res.json().catch(() => ({} as any))
        // Only an id handed back by the server means the row exists in the cloud.
        if (!res.ok || j?.error || !j?.polar?.id) {
          const why = j?.error === 'unauth'
            ? 'not signed in — sign in again and re-upload'
            : j?.error || `the server answered ${res.status}`
          status.rows[k] = { name, state: 'failed', detail: why }
          show({ finishedAt: Date.now(), verified: 'failed' })
          setPolarMsg(`${name}: ${why}. Nothing from this version on was uploaded — the file is still here, press Save again.`)
          return
        }
        status.rows[k] = { name, state: 'saved', id: j.polar.id }
        show()
      }
      // Activating a version that is already on file (not uploaded again).
      if (act && !act.include) {
        const row = polarVersions.find((p: any) => String(p.name).trim().toLowerCase() === act.name.trim().toLowerCase())
        if (row && !row.is_active) {
          const res = await fetch(`/api/teams/${teamId}/polars/${row.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activate: true }),
          })
          const j = await res.json().catch(() => ({} as any))
          if (!res.ok || j?.error) {
            const why = j?.error || `the server answered ${res.status}`
            show({ finishedAt: Date.now(), verified: 'failed' })
            setPolarMsg(`Could not make “${act.name.trim()}” active: ${why}`)
            return
          }
        }
      }
      // Read the cloud back: an upload counts as landed only when the rows come back.
      const list = await loadPolar()
      const byName = new Map(list.map((p: any) => [String(p.name).trim().toLowerCase(), p]))
      let missing = 0
      status.rows = status.rows.map((r) => {
        const row: any = byName.get(r.name.toLowerCase())
        if (!row) { missing++; return { ...r, state: 'failed' as const, detail: 'not there when the cloud was read back' } }
        return { ...r, id: row.id, at: row.created_at }
      })
      const cloudActive = String(list.find((p: any) => p.is_active)?.name || '').trim().toLowerCase()
      const activeOk = !status.activeName || cloudActive === status.activeName.toLowerCase()
      show({ finishedAt: Date.now(), verified: missing || !activeOk ? 'partial' : 'ok' })
      if (missing) setPolarMsg(`${missing} version${missing === 1 ? '' : 's'} did not come back when the cloud was read — upload again.`)
      else if (!activeOk) setPolarMsg(`Uploaded, but the cloud's active polar is “${cloudActive || 'none'}”, not “${status.activeName}”.`)
      else setPolarUpload(null)
    } catch (e: any) {
      setPolarMsg(String(e?.message || e))
      show({ finishedAt: Date.now(), verified: 'failed' })
    }
    finally { setImporting(false); loadPolar() }
  }

  const activatePolar = async (id: string) => {
    setImporting(true); setPolarMsg('')
    try {
      const r = await fetch(`/api/teams/${teamId}/polars/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activate: true }),
      }).then((x) => x.json())
      if (r.error) setPolarMsg(r.error); else loadPolar()
    } catch (e: any) { setPolarMsg(String(e?.message || e)) }
    finally { setImporting(false) }
  }

  const refreshSails = async () => {
    const s = await loadSails()
    if (s.error) setErr(s.error); else setSails(s.sails || [])
  }
  const createSail = async (body: any) => {
    setBusy('new'); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boat_id: boatId, ...body }),
      }).then((x) => x.json())
      if (r.error) setErr(r.error); else await refreshSails()
    } finally { setBusy('') }
  }
  const createSailReturning = async (body: any): Promise<Sail> => {
    const r = await fetch(`/api/teams/${teamId}/sails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: boatId, ...body }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshSails()
    return r.sail
  }
  const refreshScans = async () => {
    const r = await fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=40`).then((x) => x.json())
    if (r.error) setErr(r.error); else setScans(r.scans || [])
  }
  // Import the boat's sail inventory from an Expedition event file's <saillist>.
  const importSailList = async (file: File) => {
    const text = await file.text()
    const parsed = parseSailList(text)
    if (!parsed.items.length) throw new Error('No <saillist> found in this event file.')
    const r = await fetch(`/api/teams/${teamId}/sails/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: boatId, boat_name: parsed.boatName, sails: parsed.items }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    if (r.sails) setSails(r.sails); else await refreshSails()
    return { ...r, boatName: parsed.boatName }
  }
  // Match a design sail code (MN / J1 / J1.5 / J2 / J3) to an inventory sail.
  const matchDesignSail = (code: string): Sail | null => {
    if (code === 'MN') return sails.find((s) => s.kind === 'mainsail' || /^(MAIN|MN)\b/i.test(s.category || s.name || '')) || null
    const target = code.toUpperCase()
    return sails.find((s) => {
      const c = (s.category || s.name || '').toUpperCase().replace(/_\d{4}$/, '').trim()
      return c === target
    }) || null
  }
  // Parse the design CSV and store per-sail shapes in specs.design_shapes.
  const importDesignShapes = async (file: File) => {
    const text = await file.text()
    const parsed = parseDesignShapes(text)
    if (!parsed.rows.length) throw new Error('No design shapes found in this CSV.')
    const bySail: Record<string, any[]> = {}
    for (const r of parsed.rows) (bySail[r.sail] ||= []).push(r)

    let matched = 0
    const unmatched: string[] = []
    for (const [code, rows] of Object.entries(bySail)) {
      const inv = matchDesignSail(code)
      if (!inv) { unmatched.push(code); continue }
      // group rows into TWS condition blocks
      const byCond: Record<string, any> = {}
      for (const r of rows) {
        const key = `${r.tws}|${r.pairedJib}`
        ;(byCond[key] ||= { tws: r.tws, pairedJib: r.pairedJib, conditionName: r.conditionName, sections: [] }).sections.push({
          posPct: r.posPct, section: r.section, frontPct: r.frontPct, draft: r.draft, camber: r.camber, backPct: r.backPct,
          leadPct: r.leadPct, trailPct: r.trailPct, leadAngle: r.leadAngle, twist: r.twist, trailAngle: r.trailAngle, sectionAngle: r.sectionAngle,
        })
      }
      const design = { source_file: file.name, units: 'design-fraction', uploaded_at: new Date().toISOString(), conditions: Object.values(byCond) }
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inv.id, specs: { ...(inv.specs || {}), design_shapes: design } }),
      }).then((x) => x.json())
      if (r.error) throw new Error(r.error)
      matched++
    }
    await refreshSails()
    return { matched, unmatched, sails: parsed.sails }
  }
  const importScan = async (file: File, sailId: string | null, onStatus?: (m: string) => void) => {
    const fd = new FormData()
    fd.append('boat_id', boatId)
    if (sailId) fd.append('sail_id', sailId)
    // The report's stamp is a venue-LOCAL wall-clock. Without this the server can't
    // turn it into true UTC, and the scan lands one venue offset late (a 13:39 scan
    // showed as 15:39 in CEST). SailScanImport always sent it; this path never did.
    fd.append('tz_offset_min', String(sessionTzOffset ?? 0))
    // Stash the analysed sail photo(s) for the detail view. A Comparison report
    // embeds TWO photos (left, right) → upload both and send keys in scan order;
    // a single report embeds one → the existing single-photo path.
    onStatus?.('Reading data…')
    try {
      const blobs = await extractJpegBlobs(file) // big photos only, byte order
      if (blobs.length >= 2) {
        onStatus?.('Uploading photos…')
        const keys: string[] = []
        for (let i = 0; i < blobs.length; i++) {
          const key = `teams/${teamId}/boats/${boatId}/sail-scans/${Date.now()}-${i}-photo.jpg`
          await uploadBlobToStorage({ key, blob: blobs[i], contentType: 'image/jpeg' })
          keys.push(key)
        }
        fd.append('photo_keys', JSON.stringify(keys))
      } else {
        const blob = await extractLargestJpegBlob(file)
        if (blob) {
          onStatus?.('Uploading document…')
          const key = `teams/${teamId}/boats/${boatId}/sail-scans/${Date.now()}-photo.jpg`
          await uploadBlobToStorage({ key, blob, contentType: 'image/jpeg' })
          fd.append('photo_key', key)
        }
      }
    } catch { /* non-fatal: scan still imports without the photo */ }

    // A photo-heavy SailScan PDF is 10-12 MB and blows the API's request-body limit:
    // the platform rejects it with a PLAIN-TEXT "Request Entity Too Large" before any
    // of our code runs, and `.then(x => x.json())` on that threw the mystifying
    // `Unexpected token 'R'`. Only the report's TEXT is needed server-side (0.6 KB for
    // an 11 MB file), so park a large PDF in Bunny and hand the API a key to fetch.
    // The server deletes it as soon as it has read the text — transit only, never kept.
    // Small text-only exports (~350 KB) keep the simple inline path.
    const INLINE_MAX = 3_500_000
    if (file.size > INLINE_MAX) {
      onStatus?.('Uploading report…')
      const key = `tmp/sail-scan-imports/${teamId}/${Date.now()}-report.pdf`
      await uploadBlobToStorage({ key, blob: file, contentType: 'application/pdf' })
      fd.append('file_key', key)
      fd.append('file_name', file.name)
    } else {
      fd.append('file', file)
    }

    onStatus?.('Importing…')
    const res = await fetch(`/api/teams/${teamId}/sail-scans`, { method: 'POST', body: fd })
    // Never .json() blindly — an infrastructure rejection (413, 502…) is text/HTML.
    const raw = await res.text()
    let r: any = null
    try { r = JSON.parse(raw) } catch { /* not JSON */ }
    if (!r) {
      throw new Error(
        res.status === 413
          ? `File too large for the server (${(file.size / 1048576).toFixed(1)} MB)`
          : `Server returned ${res.status}: ${raw.slice(0, 120)}`
      )
    }
    if (r.error) throw new Error(r.error)
    await refreshScans()
    return r // { scans, parsed: ParsedScan[], count, format }
  }
  const patchScanSail = async (id: string, sail_id: string | null) => {
    const r = await fetch(`/api/teams/${teamId}/sail-scans`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, sail_id }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshScans()
  }
  const deleteScan = async (id: string) => {
    const r = await fetch(`/api/teams/${teamId}/sail-scans?id=${id}`, { method: 'DELETE' }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshScans()
  }
  // Capture time. Sends the PAIR (venue-local wall clock + true UTC) so the two
  // representations a scan carries cannot drift; see lib/scanTime.ts.
  const patchScanTime = async (id: string, captured_at: string, captured_local: string) => {
    const r = await fetch(`/api/teams/${teamId}/sail-scans`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, captured_at, captured_local }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshScans()
  }
  const patchScanNotes = async (id: string, notes: string) => {
    const r = await fetch(`/api/teams/${teamId}/sail-scans`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, notes }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshScans()
  }
  const patchSail = async (id: string, fields: any) => {
    setBusy(id); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      }).then((x) => x.json())
      if (r.error) setErr(r.error); else await refreshSails()
    } finally { setBusy('') }
  }
  const deleteSail = async (sail: Sail) => {
    if (!window.confirm(`Delete sail "${sail.name}"? Linked scans stay but become unassigned.`)) return
    setBusy(sail.id); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/sails?id=${sail.id}`, { method: 'DELETE' }).then((x) => x.json())
      if (r.error) setErr(r.error); else await refreshSails()
    } finally { setBusy('') }
  }
  const uploadCert = async (sail: Sail, file: File) => {
    setBusy(sail.id); setErr('')
    try {
      const key = `teams/${teamId}/sails/${sail.id}/cert-${Date.now()}-${file.name}`
      await uploadBlobToStorage({ key, blob: file, contentType: file.type })
      await patchSail(sail.id, { certificate_key: key, certificate_name: file.name })
    } catch (e: any) { setErr('Certificate upload failed: ' + (e?.message || e)) }
    finally { setBusy('') }
  }

  const sailById = useMemo(() => Object.fromEntries(sails.map((s) => [s.id, s])), [sails])
  const targets: any = polar?.data || null  // { tws, twa, headline, matrices, matrix_meta }

  // ── sail-shapes list: TWS-band filter + sort (by sail / by date) ──
  const TWS_BANDS = ['0-5', '5-10', '10-15', '15-20', '20-25', '25+']
  const scanTws = (sc: Scan) => scanTags[sc.id]?.avgTws ?? sc.tws_kn ?? null
  const bandOf = (v: number | null): string | null => {
    if (v == null || Number.isNaN(v)) return null
    if (v >= 25) return '25+'
    const lo = Math.floor(v / 5) * 5
    return `${lo}-${lo + 5}`
  }
  const scanSailName = (sc: Scan) => {
    const sail = sc.sail_id ? sailById[sc.sail_id] : null
    return sail?.category || sail?.name || sc.conditions?.sail_code || scanTags[sc.id]?.activeSails?.[0] || 'unassigned'
  }
  const tMs = (sc: Scan) => (sc.captured_at ? new Date(sc.captured_at).getTime() : 0)
  const displayedScans = useMemo(() => {
    let list = scans.filter((sc) => !scanTwsBand || bandOf(scanTws(sc)) === scanTwsBand)
    list = [...list].sort((a, b) => {
      if (scanSort === 'sail') {
        const c = scanSailName(a).localeCompare(scanSailName(b))
        if (c) return c
      }
      return tMs(b) - tMs(a) // newest first
    })
    return list
  }, [scans, scanTags, scanTwsBand, scanSort, sailById]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── shared styles ──
  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: C.dim, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}` }
  const td: React.CSSProperties = { padding: '6px 8px', color: C.text, fontSize: 12, borderBottom: `1px solid #0d2236` }
  const input: React.CSSProperties = { background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '5px 7px', fontSize: 12 }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer' })
  const subBtn = (id: string, label: string) => (
    <button onClick={() => setView(id as any)} style={{
      padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
      background: view === id ? C.accent : '#0F2A45', color: view === id ? '#001018' : '#94A3B8',
    }}>{label}</button>
  )

  if (uiNext) return <BoatConfigNext teamId={teamId} boatId={boatId} boatName={boatName} />

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: C.bg, padding: isMobile ? 10 : 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.head }}>Boat configuration</h2>
        <span style={{ fontSize: 10, color: C.dim }}>{canEdit ? 'inventory editable · TL3+' : 'read-only'}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {subBtn('inventory', 'Sail inventory')}
        {subBtn('shapes', 'Sail data')}
        {canSeeTuning && subBtn('rig', 'Rig settings')}
        {canSeeTuning && subBtn('polar', 'Targets')}
        {canSeeTuning && subBtn('battens', 'Battens')}
        {canSeeTuning && subBtn('log', 'Log profile')}
      </div>

      {err && <div style={{ color: C.warn, fontSize: 12, marginBottom: 12 }}>Error: {err}</div>}
      {loading && <div style={{ color: C.dim, fontSize: 12 }}>Loading…</div>}

      {/* ── BATTENS ────────────────────────────────────────────────── */}
      {view === 'battens' && canSeeTuning && (
        <BattenCardPanel teamId={teamId} boatId={boatId} canEdit={canEdit} isMobile={isMobile} />
      )}

      {/* ── SAIL INVENTORY ─────────────────────────────────────────── */}
      {view === 'inventory' && (
        <div>
          {canEdit && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ImportSailListForm onImport={importSailList} btn={btn} input={input} />
              <ImportDesignShapesForm onImport={importDesignShapes} btn={btn} input={input} />
              <AddSailForm onAdd={createSail} busy={busy === 'new'} input={input} btn={btn} />
            </div>
          )}
          {sails.length === 0 && !loading ? (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>No sails yet.{canEdit ? ' Import an event file’s sail list, or add one above.' : ''}</div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Cat</th><th style={th}>Sail name</th><th style={th}>Kind</th>
                    <th style={th}>Sail type</th><th style={th}>Grp</th><th style={th}>Wt (kg)</th>
                    <th style={th}>Build date</th><th style={th}>Status</th><th style={th}>Certificate</th>
                    <th style={th}>Sailshape design</th>
                    {canEdit && <th style={th}></th>}
                  </tr>
                </thead>
                <tbody>
                  {sails.map((s) => (
                    <SailRow key={s.id} sail={s} canEdit={canEdit} busy={busy === s.id}
                      td={td} input={input} btn={btn}
                      onPatch={(f: any) => patchSail(s.id, f)} onCert={(f: File) => uploadCert(s, f)} onDelete={() => deleteSail(s)}
                      onShowDesign={() => setDesignSail(s)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── SAIL SHAPES (scans) ────────────────────────────────────── */}
      {view === 'shapes' && (
        <div>
          {canEdit && (
            <ImportScanForm sails={sails} input={input} btn={btn}
              onImport={importScan} onCreateSail={createSailReturning} />
          )}
          {scans.length === 0 && !loading ? (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>No scans yet. Import a North report above, or ingest via the API.</div>
          ) : (
          <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <span style={{ fontSize: 11, color: C.dim }}>TWS</span>
            <select value={scanTwsBand} onChange={(e) => setScanTwsBand(e.target.value)} style={{ ...input, padding: '4px 6px' }}>
              <option value="">all</option>
              {TWS_BANDS.map((b) => <option key={b} value={b}>{b} kn</option>)}
            </select>
            <span style={{ fontSize: 11, color: C.dim, marginLeft: 6 }}>Sort</span>
            {(['sail', 'date'] as const).map((s) => (
              <button key={s} onClick={() => setScanSort(s)} style={{
                fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', border: 'none',
                background: scanSort === s ? C.accent : '#0F2A45', color: scanSort === s ? '#001018' : '#94A3B8',
              }}>{s === 'sail' ? 'By sail · date' : 'By date'}</button>
            ))}
            <button onClick={() => { setCompareMode((v) => !v); setCmpIds([]) }} style={{
              fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', border: 'none', marginLeft: 8,
              background: compareMode ? '#10B981' : '#0F2A45', color: compareMode ? '#001018' : '#94A3B8',
            }}>{compareMode ? 'Comparing…' : '⇄ Compare'}</button>
            {compareMode && (
              <button
                disabled={cmpIds.length < 2}
                onClick={() => {
                  const picked = cmpIds.map((id) => scans.find((s) => s.id === id)).filter(Boolean)
                  if (picked.length >= 2) setCompareScans(picked)
                }}
                style={{ fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 12px', border: 'none',
                  cursor: cmpIds.length >= 2 ? 'pointer' : 'default', opacity: cmpIds.length >= 2 ? 1 : 0.45,
                  background: C.accent, color: '#001018' }}>Compare {cmpIds.length}/6 ›</button>
            )}
            <span style={{ fontSize: 11, color: C.dim, marginLeft: 'auto' }}>{displayedScans.length} of {scans.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {displayedScans.map((sc, idx) => {
              const sail = sc.sail_id ? sailById[sc.sail_id] : null
              const tag = scanTags[sc.id]
              const groupName = scanSailName(sc)
              const showHeader = scanSort === 'sail' && (idx === 0 || scanSailName(displayedScans[idx - 1]) !== groupName)
              const name = sail?.category || sail?.name || sc.conditions?.sail_code || tag?.activeSails?.[0] || 'unassigned'
              const pos = tag?.pointOfSail
              const posColor = pos === 'upwind' ? '#F4B084' : pos === 'downwind' ? '#A8D5BA' : pos === 'reaching' ? '#B4C7E7' : C.border
              const chip = (t: string, bg = '#0F2A45', col = C.text) => (
                <span style={{ fontSize: 10, color: col, background: bg, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{t}</span>
              )
              return (
                <React.Fragment key={sc.id}>
                {showHeader && (
                  <div style={{ fontSize: 12, fontWeight: 800, color: C.head, margin: '8px 2px 2px' }}>{groupName}</div>
                )}
                <div
                  onClick={() => {
                    if (compareMode) setCmpIds((prev) => prev.includes(sc.id) ? prev.filter((x) => x !== sc.id) : [...prev, sc.id].slice(-6))
                    else setSelectedScan(sc)
                  }}
                  title={compareMode ? 'Select to compare' : 'Open scan detail'}
                  style={{ display: 'flex', gap: 10, alignItems: 'center', borderRadius: 8, padding: '6px 8px', cursor: 'pointer',
                    border: `1px solid ${compareMode && cmpIds.includes(sc.id) ? '#10B981' : C.border}`,
                    boxShadow: compareMode && cmpIds.includes(sc.id) ? '0 0 0 1px #10B981 inset' : 'none' }}>
                  {compareMode && (
                    <span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 4, border: `1px solid ${cmpIds.includes(sc.id) ? '#10B981' : C.border}`, background: cmpIds.includes(sc.id) ? '#10B981' : 'transparent', color: '#001018', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{cmpIds.includes(sc.id) ? '✓' : ''}</span>
                  )}
                  {/* thumbnail */}
                  <div style={{ width: 54, height: 54, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: '#071624', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {sc.photo_url ? <img src={sc.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 18 }}>⛵</span>}
                  </div>
                  {/* main */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: C.accent, fontSize: 13 }}>{name}</span>
                      {sc.conditions?.sail_type && <span style={{ fontSize: 10, color: sc.conditions.sail_type === 'main' ? '#34D399' : '#FBBF24' }}>{sc.conditions.sail_type}</span>}
                      {pos && chip(pos, posColor + '33', C.head)}
                      {tag?.location && chip(`📍 ${tag.location}`)}
                    </div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.dim, marginTop: 3, flexWrap: 'wrap' }}>
                      <span>TWS <b style={{ color: C.text }}>{fmt(tag?.avgTws ?? sc.tws_kn)}</b> kt</span>
                      <span>TWA <b style={{ color: C.text }}>{tag?.avgTwa != null ? fmt(tag.avgTwa, 0) : '—'}</b>°</span>
                      <span>{fmtDate(scanLocalDateISO(sc, sessionTzOffset)) || '—'}</span>
                      <span>{scanLocalHM(sc, sessionTzOffset)}</span>
                    </div>
                  </div>
                  {!compareMode && (
                    <button onClick={(e) => { e.stopPropagation(); setSelectedScan(sc) }}
                      style={{ background: C.accent, border: 'none', borderRadius: 8, color: '#001018', fontWeight: 700, fontSize: 13, padding: '7px 14px', cursor: 'pointer', flexShrink: 0 }}>Details ›</button>
                  )}
                </div>
                </React.Fragment>
              )
            })}
          </div>
          </>
          )}
        </div>
      )}

      {/* ── RIG SETTINGS (tuning baseline) ─────────────────────────── */}
      {view === 'rig' && canSeeTuning && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: C.head }}>
              {rigTune ? rigTune.name : 'Rig tuning baseline'}
            </span>
            {rigTune?.effective_date && (
              <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>
                effective {fmtDate(rigTune.effective_date)}
              </span>
            )}
            {rigTune?.revision && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{rigTune.revision}</span>}
            {canEdit && (
              <label style={{ ...btn('#06B6D4'), marginLeft: 'auto', opacity: rigBusy ? 0.6 : 1, cursor: rigBusy ? 'default' : 'pointer' }}>
                {rigBusy ? 'Parsing…' : rigTune ? 'Upload new sheet' : 'Upload rig PDF'}
                <input type="file" accept="application/pdf,.pdf" disabled={rigBusy} style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importRigTune(f); e.currentTarget.value = '' }} />
              </label>
            )}
          </div>
          {rigErr && <div style={{ fontSize: 11, color: '#F59E0B', marginBottom: 8 }}>{rigErr}</div>}

          {!rigTune ? (
            <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', color: C.dim }}>
              <div style={{ fontSize: 12, maxWidth: 520, margin: '0 auto', lineHeight: 1.5 }}>
                Upload the JV76 “Sailing Info Summary” rig sheet (PDF). SSA parses the upwind and
                reaching/downwind tables into per-sail-combination settings and stores them as the
                boat’s active baseline, effective from today.
              </div>
            </div>
          ) : (
            <>
              <RigSettingsTables rigTune={rigTune} teamId={teamId} canEdit={canEdit} boatName={config?.boatName} sails={sails} />
              <RigTuneTable data={rigTune.data} />
            </>
          )}

          {/* Admin-only: source PDF thumbnail + download. */}
          {isAdmin && rigTune?.report_key && (
            <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, width: '100%' }}>Source document (admin)</div>
              <div style={{ width: 150, height: 200, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: '#0a1c2e' }}>
                {rigPdfUrl ? (
                  <embed src={`${rigPdfUrl}#toolbar=0&navpanes=0&view=FitH`} type="application/pdf" style={{ width: '100%', height: '100%' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 11 }}>📄 loading…</div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: C.text }}>{rigTune.report_ref || 'rig sheet.pdf'}</span>
                {rigPdfUrl ? (
                  <a href={rigPdfUrl} target="_blank" rel="noopener noreferrer" download
                    style={{ ...btn('#06B6D4'), textDecoration: 'none', display: 'inline-block', width: 'fit-content' }}>⬇ Download PDF</a>
                ) : (
                  <span style={{ fontSize: 11, color: C.dim }}>preparing link…</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── LOG PROFILE (per-boat channel aliases) ──────────────────── */}
      {view === 'log' && canSeeTuning && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.head, marginBottom: 10 }}>Log profile</div>
          <LogProfilePanel canEdit={canEdit} />
        </div>
      )}

      {/* ── TARGETS (active polar) ─────────────────────────────────── */}
      {view === 'polar' && canEdit && (
        <PolarUploadForm
          upload={polarUpload} setUpload={setPolarUpload} onPick={pickPolarFile}
          onSave={savePolarUpload} busy={importing} msg={polarMsg} btn={btn} input={input}
          save={polarSave} cloud={{ count: polarVersions.length, activeName: polar?.name || null, ...polarSync }}
          onRecheck={loadPolar}
        />
      )}
      {view === 'polar' && (
        !targets ? (
          <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', color: C.dim }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.head, marginBottom: 6 }}>No targets loaded</div>
            <div style={{ fontSize: 12, maxWidth: 460, margin: '0 auto 12px', lineHeight: 1.5 }}>
              Load the boat’s VPP targets — the laminated TARGETS sheet plus the BSP (polar),
              heel, rudder and AWA matrices.
            </div>
            {canEdit && (
              <button onClick={importTargets} disabled={importing} style={{ ...btn('#06B6D4'), opacity: importing ? 0.6 : 1 }}>
                {importing ? 'Importing…' : 'Import V1.4 Targets (JV VPP)'}
              </button>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.head }}>{polar?.name || targets.name}</span>
              {targets.source_note && <span style={{ fontSize: 11, color: C.dim }}>{targets.source_note}</span>}
              {targets.wind_reference && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{targets.wind_reference}</span>}
              <button onClick={() => printTargets(targets, polar?.name || targets.name)} style={{ ...btn('#10B981'), marginLeft: 'auto' }}>⎙ Print</button>
              {canEdit && (
                <button onClick={importTargets} disabled={importing} style={{ ...btn('#0F2A45'), color: C.head, opacity: importing ? 0.6 : 1 }}>
                  {importing ? 'Re-importing…' : 'Re-import'}
                </button>
              )}
            </div>

            <TargetsTable targets={targets} uploadedAt={polar?.created_at} />

            <div style={{ display: 'flex', gap: 6, margin: '18px 0 10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.dim, marginRight: 4 }}>Matrix:</span>
              {(['bsp', 'heel', 'rudder', 'awa'] as const).filter((k) => targets.matrices?.[k]?.length).map((k) => (
                <button key={k} onClick={() => setMatrixKey(k)} style={{
                  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', border: 'none',
                  background: matrixKey === k ? C.accent : '#0F2A45', color: matrixKey === k ? '#001018' : '#94A3B8',
                }}>{targets.matrix_meta?.[k]?.label || k}</button>
              ))}
            </div>
            <MatrixTable targets={targets} mkey={targets.matrices?.[matrixKey] ? matrixKey : 'bsp'} uploadedAt={polar?.created_at} />
          </div>
        )
      )}
      {view === 'polar' && polarVersions.length > 0 && (
        <PolarVersions versions={polarVersions} canEdit={canEdit} busy={importing} onActivate={activatePolar} th={th} td={td} btn={btn} sync={polarSync} />
      )}

      {selectedScan && (
        <SailScanDetail
          scan={selectedScan}
          teamId={teamId}
          sails={sails}
          canEdit={canEdit}
          boatName={boatName}
          tags={scanTags[selectedScan.id]}
          sailName={(selectedScan.sail_id ? sailById[selectedScan.sail_id]?.name : null) || selectedScan.conditions?.sail_name_in_report}
          onReassign={async (sailId: string | null) => { await patchScanSail(selectedScan.id, sailId); setSelectedScan((p: any) => p ? { ...p, sail_id: sailId } : p) }}
          onSaveNotes={async (notes: string) => { await patchScanNotes(selectedScan.id, notes); setSelectedScan((p: any) => p ? { ...p, notes } : p) }}
          onSaveTime={async (captured_at: string, captured_local: string) => {
            await patchScanTime(selectedScan.id, captured_at, captured_local)
            // keep the open modal in step with what was just written
            setSelectedScan((p: any) => p ? { ...p, captured_at, conditions: { ...(p.conditions || {}), captured_local } } : p)
          }}
          onDelete={async () => { await deleteScan(selectedScan.id); setSelectedScan(null) }}
          onClose={() => setSelectedScan(null)}
          sessionTzOffset={sessionTzOffset}
        />
      )}

      {compareScans && (
        <SailScanCompare
          scans={compareScans}
          sails={sails}
          tags={compareScans.map((s) => scanTags[s.id])}
          boatName={boatName}
          sessionTzOffset={sessionTzOffset}
          onClose={() => { setCompareScans(null); setCompareMode(false); setCmpIds([]) }}
        />
      )}

      {designSail && (
        <SailDesignShapes sail={designSail} onClose={() => setDesignSail(null)} />
      )}
    </div>
  )
}

// ── Heat shade for a value within a matrix's range (blue→white→red) ───────────
function heat(v: number | null, lo: number, hi: number): string {
  if (v == null || Number.isNaN(v)) return 'transparent'
  const t = hi === lo ? 0.5 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  // 0 = cool blue, 1 = warm red
  const r = Math.round(t < 0.5 ? 120 + t * 270 : 255)
  const g = Math.round(t < 0.5 ? 150 + t * 210 : 255 - (t - 0.5) * 300)
  const b = Math.round(t < 0.5 ? 235 - t * 120 : 200 - (t - 0.5) * 300)
  return `rgba(${r},${g},${Math.max(0, b)},0.55)`
}

// Screen-only "uploaded" caption (bottom-right). Not part of the print sheet.
function UploadedCaption({ uploadedAt }: { uploadedAt?: string | null }) {
  if (!uploadedAt) return null
  return (
    <div style={{ textAlign: 'right', fontSize: 10, color: C.dim, marginTop: 4 }}>
      Uploaded {new Date(uploadedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
    </div>
  )
}

// ── Rig tuning baseline (per sail-combination columns, Targets-style) ─────────
const RIG_SEC_TINT: Record<string, string> = {
  upwind: 'rgba(244,176,132,0.45)',   // orange
  reaching: 'rgba(180,199,231,0.45)', // blue
  downwind: 'rgba(168,213,186,0.5)',  // green
}
type RigField = { key: string; label: string; render: (c: any) => string; reachingOnly?: boolean }
// Upwind sub-table fields (unchanged: Jib Tack, Main Cunningham, Mastbase Position FWD).
const UPWIND_FIELDS: RigField[] = [
  { key: 'twsAtMh', label: 'TWS @ MH (kt)', render: (c) => (c.twsAtMh ?? '—') },
  { key: 'mastbasePosition', label: 'Mastbase Position', render: (c) => (c.mastbasePosition ?? '—') },
  { key: 'shimStack', label: 'Shim Stack (mm)', render: (c) => (c.shimStack ?? '—') },
  { key: 'headstayT', label: 'Headstay (t)', render: (c) => (c.headstayT != null ? fmt(c.headstayT, 1) : '—') },
  { key: 'jibTackT', label: 'Jib Tack (t)', render: (c) => (c.jibTackT != null ? fmt(c.jibTackT, 1) : '—') },
  { key: 'mainCunninghamT', label: 'Main Cunningham (t)', render: (c) => (c.mainCunninghamT != null ? fmt(c.mainCunninghamT, 1) : '—') },
  { key: 'upperDeflectorCylStroke', label: 'Upper Defl. Stroke', render: (c) => (c.upperDeflectorCylStroke ?? '—') },
  { key: 'lowerDeflectorCylStroke', label: 'Lower Defl. Stroke', render: (c) => (c.lowerDeflectorCylStroke ?? '—') },
]
// Reaching sub-table fields (Reaching-only edits): Mastbase Position in mm (#4);
// Bowsprit Tack moved above Headstay (#6); GS Tack replaces Jib Tack (#7);
// Main Cunningham removed (#8). mmPos() is hoisted (function decl below).
const REACHING_FIELDS: RigField[] = [
  { key: 'twsAtMh', label: 'TWS @ MH (kt)', render: (c) => (c.twsAtMh ?? '—') },
  { key: 'mastbasePosition', label: 'Mastbase Position (mm)', render: (c) => mmPos(c.mastbasePosition) },
  { key: 'shimStack', label: 'Shim Stack (mm)', render: (c) => (c.shimStack ?? '—') },
  { key: 'bowspritTackT', label: 'Bowsprit Tack (t)', render: (c) => (c.bowspritTackT != null ? fmt(c.bowspritTackT, 1) : '—') },
  { key: 'headstayT', label: 'Headstay (t)', render: (c) => (c.headstayT != null ? fmt(c.headstayT, 1) : '—') },
  { key: 'gsTackT', label: 'GS Tack (t)', render: (c) => (c.gsTackT != null ? fmt(c.gsTackT, 1) : '—') },
  { key: 'upperDeflectorCylStroke', label: 'Upper Defl. Stroke', render: (c) => (c.upperDeflectorCylStroke ?? '—') },
  { key: 'lowerDeflectorCylStroke', label: 'Lower Defl. Stroke', render: (c) => (c.lowerDeflectorCylStroke ?? '—') },
]

// ── Rig SETTINGS grid — Upwind + Reaching, one column per sheet column ───────
// Columns ARE the parsed rig-sheet columns: every upwind column for Upwind; every
// reaching column PLUS the downwind columns appended for Reaching. Each column is
// headed by its TWS @ MH. Sheet-derived rows render read-only from the column; the
// rows the sheet doesn't carry (Main Cun, Vang, Bobstay, GS Tack) are hand-entered
// and saved as a per-column overlay; Main 50% camber auto-fills from the mainsail's
// SailScan design.

// #5: show the butt / mastbase position in mm rather than the sheet's 'N FWD/AFT'
// wording (AFT -> negative). The number is taken as-is from the sheet.
function mmPos(v: any): string {
  const str = String(v ?? '').trim()
  if (!str) return ''
  const m = str.match(/-?\d+(?:\.\d+)?/)
  if (!m) return str
  const n = Number(m[0])
  return `${/aft/i.test(str) ? -Math.abs(n) : n} mm`
}
const sectionCols = (cols: any[], section: string) => (cols || []).filter((c) => c && c.section === section)
const twsNum = (c: any): number | null => {
  if (c == null) return null
  if (typeof c.twsMhKn === 'number') return c.twsMhKn
  const str = String(c.twsAtMh ?? '').trim()
  if (!str || /awa/i.test(str)) return null
  const m = str.match(/^(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}
// Reaching columns hidden from BOTH the grid and the RigSubTable (downwind untouched).
// Keyed by headsail + TWS so the two BRO & J3 & GS columns (16/18) are distinguishable.
const HIDDEN_REACHING_COLS: { headsail: string; tws: number }[] = [
  { headsail: 'Jib', tws: 7 },
  { headsail: 'MOFO & GS', tws: 11 },
  { headsail: 'BRO & J3 & GS', tws: 18 }, // the 35AWA one (confirmed TWS 18)
]
const isHiddenReachingCol = (c: any): boolean =>
  c?.section === 'reaching' && HIDDEN_REACHING_COLS.some((h) => h.headsail === (c?.headsail || '') && twsNum(c) === h.tws)

// ── The rig team's printed Backstay Guide, rebuilt ───────────────────────────
// The card is ONE 8-column grid: a label column plus seven data columns. The
// TWS block fills all seven; the Sails block puts its five sail combinations in
// columns 1-5 and the downwind crib in the last two — which is exactly how the
// two blocks line up on the printed sheet, and why both share one column ruler.
//
// The values below are the guide as issued (GUIDE_REV / GUIDE_DATE). They are
// the table's CONTENT, not a fallback for missing data: every cell is editable
// and a team's edit is saved over the top and versioned, as before.
const GUIDE_REV = 'v1.2'
const GUIDE_DATE = 'Sept 2026'

const GUIDE_BLUE = '#94DCF8'
const GUIDE_BLUE_RGB: [number, number, number] = [148, 220, 248]
const GUIDE_PEACH = '#FBE2D5'
const GUIDE_PEACH_RGB: [number, number, number] = [251, 226, 213]
const GUIDE_RED = '#FF0000'
const GUIDE_RED_RGB: [number, number, number] = [255, 0, 0]
const GUIDE_GREEN = '#00B050'
const GUIDE_GREEN_RGB: [number, number, number] = [0, 176, 80]
const GUIDE_TITLE = '#0070C0'
const GUIDE_TITLE_RGB: [number, number, number] = [0, 112, 192]
const GUIDE_ORANGE = '#C55A11'
const GUIDE_ORANGE_RGB: [number, number, number] = [197, 90, 17]
const INK = '#000000'
const INK_RGB: [number, number, number] = [0, 0, 0]

// Columns 10 / 14 / 18 carry the blue band on the card. The Sails block sees the
// same ruler, so its MHO and BRO/J1 columns band for free.
const BANDED_COLS = [1, 3, 5]
const N_COLS = 7

// red: indices of the columns the guide prints in red (a limit, not a value —
// so the marking stays put when a cell is edited).
type GuideRow = { key: string; label: string; boldTail?: boolean; vals: string[]; red?: number[] }

const TWS_COLS = ['<8', '10', '12', '14', '16', '18', '20+']
const TWS_ROWS: GuideRow[] = [
  { key: 'shim', label: 'Shim (mm)', vals: ['-25', '-15', '-10', '-5', 'Full', 'Full', 'Full'] },
  { key: 'butt', label: 'Butt Posn (mm)', vals: ['62', '58', '56', '54', '54', '52', '52'] },
  { key: 'forestay', label: 'Forestay/Total (T)', boldTail: true, red: [4, 5, 6], vals: ['10 / 12', '12 / 14', '14 / 16', '16 / 19', '17 / 20', '17 / 20', '17 / 20'] },
  { key: 'upDef', label: 'UpDef', vals: ['95%', '95%', '100%', '100%', '100%', '98%', '97%'] },
  { key: 'lowDef', label: 'LowDef', vals: ['75%', '65%', '60%', '60%', '50%', '45%', '45%'] },
  { key: 'vang', label: 'Vang (T)', vals: ['', '', '', '1', '1.5', '2', '2 *'] },
  { key: 'cunn', label: 'Cunn Posn (mm)', red: [6], vals: ['-15', '-20', '-40', '-70', '-95', '-115', '-130'] },
]
const TWS_WIDE = [0, 1] // green "WIDE" markers under <8 and 10

const SAIL_COLS = ['Jib / GS', 'MHO', 'MHO/GS', 'BRO / J1', 'BRO/J3/GS']
const SAIL_ROWS: GuideRow[] = [
  { key: 'shimsMin', label: 'Shims (Min)', vals: ['', '-25', '-10', '-25', '-10'] },
  { key: 'bobstay', label: 'Bobstay (T)', red: [3, 4], vals: ['-', '11.1', '11.1', '14.5', '14.5'] },
  { key: 'tackline', label: 'Tackline 2:1 (T)', red: [3, 4], vals: ['-', '2.5', '2.5', '3.25', '3.25'] },
  { key: 'fsLimit', label: 'FS Limit (T)', vals: ['13', '4.5', '5', '5', '6'] },
  { key: 'gsTack', label: 'GS Tack (T)', red: [0, 2, 4], vals: ['2.5', '-', '2.5', '-', '2.5'] },
  { key: 'backstay', label: 'Backstay (T)-Ref', red: [0, 4], vals: ['10.5', '7', '7', '8.5', '10.5'] },
  { key: 'upDefT', label: 'UpDef. Target', vals: ['95%', '25%', '25%', '25%', '25%'] },
  { key: 'lowDefT', label: 'LowDef. Target', vals: ['50%', '40%', '55%', '40%', '55%'] },
]
const SAIL_WIDE = [1, 3] // green "WIDE" markers under MHO and BRO / J1

// Downwind crib — the peach panel filling the last two columns beside the Sails
// block. Its header sits on the first Sails row; the five bands follow.
const DWD_HEAD: [string, string] = ['TWS', 'Up/Low/FS'] // the "FS" prints red
const DWD_BANDS: { tws: string; val: string }[] = [
  { tws: '8', val: '80/100/3' },
  { tws: '12', val: '60/90/4' },
  { tws: '15', val: '50/80/5' },
  { tws: '18', val: '30/60/6' },
  { tws: '20+', val: '20/45/7' },
]
const GUIDE_NOTE = '* Max Bend 360mm'

// The card's one-line baseline, above the TWS block. Assembled from the same
// editable reference fields the old chip row used, plus V1s / FS.
const REF_ITEMS: { key: 'float' | 'shims' | 'butt' | 'rake' | 'v1s' | 'fs'; label: string; ph: string }[] = [
  { key: 'float', label: 'Float', ph: '500Bar' },
  { key: 'shims', label: 'Shim', ph: '35mm' },
  { key: 'butt', label: 'Butt', ph: '54mm' },
  { key: 'rake', label: 'Rake', ph: '4.25deg' },
  { key: 'v1s', label: 'V1s', ph: '11.0T' },
  { key: 'fs', label: 'FS', ph: '3.3T' },
]
const GUIDE_REF_VALUES: Record<string, string> = { float: '500Bar', shims: '35mm', butt: '54mm', rake: '4.25deg', v1s: '11.0T', fs: '3.3T' }
const floatLine = (v: (k: string) => string): string =>
  `Float (All Up): ${v('float')} @ ${v('shims')} Shim / Butt ${v('butt')} / Rake ${v('rake')} / V1s ${v('v1s')}/FS ${v('fs')}`

// "10 / 12" and "80/100/3" both bold (and colour) only the part after the last
// slash — the total, and the forestay figure in the downwind crib.
const splitTail = (v: string): [string, string] => {
  const i = v.lastIndexOf('/')
  return i < 0 ? [v, ''] : [v.slice(0, i + 1), v.slice(i + 1)]
}
const bandBg = (i: number) => (BANDED_COLS.includes(i) ? GUIDE_BLUE : '#FFFFFF')
const bandRgb = (i: number): [number, number, number] => (BANDED_COLS.includes(i) ? GUIDE_BLUE_RGB : [255, 255, 255])

// Saved overlay: per section, per display-column index, the hand-entered rows.
type ManualCell = Record<string, string>
type RigReference = { rake?: string; shims?: string; butt?: string; float?: string; v1s?: string; fs?: string; revision?: string; date?: string }
type RigSettings = { schema?: string; upwind: Record<string, ManualCell>; reaching: Record<string, ManualCell>; downwind: Record<string, ManualCell>; reference?: RigReference }
// Overrides are keyed by COLUMN INDEX, so they only mean anything against the
// layout they were typed into. The pre-guide table had different columns and a
// different row set, and three keys (vang, bobstay, gsTack) happen to collide —
// an ungated read would drop a stale number into the wrong TWS column. So an
// overlay is honoured only when it was saved against this layout; anything older
// falls back to the guide as issued.
const SETTINGS_SCHEMA = 'backstay-guide-1'
const isGuideLayout = (raw: any): boolean => raw?.schema === SETTINGS_SCHEMA
const emptySettings = (): RigSettings => ({ schema: SETTINGS_SCHEMA, upwind: {}, reaching: {}, downwind: {}, reference: {} })
function normSettings(raw: any): RigSettings {
  const out = emptySettings()
  if (!isGuideLayout(raw)) return out
  for (const sec of ['upwind', 'reaching'] as const) {
    const s = raw?.[sec]
    if (!s || typeof s !== 'object') continue
    for (const [k, v] of Object.entries(s)) {
      if (!v || typeof v !== 'object') continue
      const cell: ManualCell = {}
      // Preserve EVERY hand-entered override (any row can be overridden now), not
      // just the original manual rows.
      for (const [mk, val] of Object.entries(v as any)) { if (typeof val === 'string' && val) cell[mk] = val }
      if (Object.keys(cell).length) out[sec][k] = cell
    }
  }
  const dw = raw?.downwind
  if (dw && typeof dw === 'object') {
    for (const [k, v] of Object.entries(dw)) if (v && typeof v === 'object') out.downwind[k] = { ...(v as any) }
  }
  const ref = raw?.reference
  if (ref && typeof ref === 'object') {
    const r: RigReference = {}
    for (const [k, v] of Object.entries(ref)) if (typeof v === 'string' && v) (r as any)[k] = v
    if (Object.keys(r).length) out.reference = r
  }
  return out
}
const rbtn = (bg: string): React.CSSProperties => ({ background: bg, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer' })

let rigJsPdf: Promise<any> | null = null
function loadJsPdf(): Promise<any> {
  const w = window as any
  if (w.jspdf?.jsPDF) return Promise.resolve(w.jspdf.jsPDF)
  if (!rigJsPdf) {
    rigJsPdf = new Promise((res, rej) => {
      const s = document.createElement('script')
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
      s.onload = () => res((window as any).jspdf.jsPDF)
      s.onerror = () => rej(new Error('failed to load jsPDF'))
      document.head.appendChild(s)
    })
  }
  return rigJsPdf
}

type RigVersion = { id: string; settings: RigSettings; notes: string | null; saved_at: string; saved_by: string | null }
const fmtWhen = (iso?: string | null) => (iso
  ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—')

function RigSettingsTables({ rigTune, teamId, canEdit, boatName }: {
  rigTune: any; teamId: string; canEdit: boolean; boatName?: string | null; sails?: any[]
}) {
  const [tbl, setTbl] = useState<RigSettings>(() => normSettings(rigTune?.data?.settingsTable))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const snapshot = React.useRef<RigSettings | null>(null)
  const edit = canEdit && editing
  const [savedAt, setSavedAt] = useState<string | null>(rigTune?.data?.settingsSavedAt || null)
  const [savedNotes, setSavedNotes] = useState<string>(rigTune?.data?.settingsNotes || '')
  const [noteDraft, setNoteDraft] = useState('')
  const [versions, setVersions] = useState<RigVersion[] | null>(null)
  const [showHist, setShowHist] = useState(false)
  const [viewing, setViewing] = useState<RigVersion | null>(null)

  const loadVersions = React.useCallback(async () => {
    if (!rigTune?.id) return
    try {
      const j = await fetch(`/api/teams/${teamId}/rig-tunes/${rigTune.id}/versions`).then((x) => x.json())
      setVersions(Array.isArray(j?.versions) ? j.versions : [])
    } catch { setVersions([]) }
  }, [teamId, rigTune?.id])

  useEffect(() => {
    setTbl(normSettings(rigTune?.data?.settingsTable))
    setSavedAt(rigTune?.data?.settingsSavedAt || null)
    setSavedNotes(rigTune?.data?.settingsNotes || '')
    setDirty(false); setMsg(''); setEditing(false); setViewing(null); setNoteDraft(''); setVersions(null)
  }, [rigTune?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (showHist && versions == null) loadVersions() }, [showHist, versions, loadVersions])

  const current = React.useRef<{ tbl: RigSettings; at: string | null; notes: string } | null>(null)
  const viewVersion = (v: RigVersion) => {
    if (!viewing) current.current = { tbl, at: savedAt, notes: savedNotes }
    setViewing(v); setTbl(normSettings(v.settings)); setEditing(false); setDirty(false); setMsg('')
  }
  const backToCurrent = () => {
    const c = current.current
    if (c) { setTbl(c.tbl); setSavedAt(c.at); setSavedNotes(c.notes) }
    setViewing(null); setDirty(false); setMsg('')
  }
  const restoreVersion = (v: RigVersion) => {
    setViewing(null); setTbl(normSettings(v.settings)); setEditing(true); setDirty(true)
    setNoteDraft(`Restored the table saved ${fmtWhen(v.saved_at)}${v.notes ? ` — ${v.notes}` : ''}`)
    setMsg('Restored into the editor — Save to keep it.')
  }

  const startEdit = () => { snapshot.current = tbl; setEditing(true); setNoteDraft(''); setMsg('') }
  const cancelEdit = () => {
    if (snapshot.current) setTbl(snapshot.current)
    setEditing(false); setDirty(false); setMsg(''); setNoteDraft('')
  }

  const setCell = (sec: 'upwind' | 'reaching', colIdx: number, key: string, val: string) => {
    setTbl((p) => {
      const k = String(colIdx)
      return { ...p, [sec]: { ...p[sec], [k]: { ...(p[sec]?.[k] || {}), [key]: val } } }
    })
    setDirty(true); setMsg('')
  }
  const setRef = (key: string, val: string) => {
    setTbl((p) => ({ ...p, reference: { ...(p.reference || {}), [key]: val } }))
    setDirty(true); setMsg('')
  }
  // Reference fields, like the cells, start from the guide and keep a team's edit.
  const refVal = (k: string): string => {
    const ov = (tbl.reference as any)?.[k]
    return ov !== undefined ? ov : (GUIDE_REF_VALUES[k] ?? '')
  }
  const refRevision = (tbl.reference?.revision ?? rigTune?.revision ?? GUIDE_REV) as string
  const refDate = (tbl.reference?.date ?? rigTune?.data?.sheetDate ?? GUIDE_DATE) as string

  // Cell content: the guide as issued, with a team's saved edit layered over it.
  // A stored empty string shows empty (so backspacing mid-edit doesn't snap back
  // to the guide); clearing and saving drops the key, restoring the guide value.
  const cellValue = (sec: 'upwind' | 'reaching', rowKey: string, colIdx: number, guideVal: string): string => {
    const ov = tbl[sec]?.[String(colIdx)]?.[rowKey]
    return ov !== undefined ? ov : guideVal
  }
  const dwdValue = (rowIdx: number, key: 'tws' | 'val'): string => {
    const ov = tbl.downwind?.[String(rowIdx)]?.[key]
    return ov !== undefined ? ov : (DWD_BANDS[rowIdx]?.[key] ?? '')
  }
  const setDwd = (rowIdx: number, key: string, val: string) => {
    setTbl((p) => ({ ...p, downwind: { ...p.downwind, [String(rowIdx)]: { ...(p.downwind?.[String(rowIdx)] || {}), [key]: val } } }))
    setDirty(true); setMsg('')
  }

  const save = async () => {
    if (!rigTune?.id) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/teams/${teamId}/rig-tunes/${rigTune.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsTable: { ...tbl, schema: SETTINGS_SCHEMA }, settingsNotes: noteDraft.trim() || null }),
      }).then((x) => x.json())
      if (r?.error) setMsg(r.error)
      else {
        setDirty(false); setEditing(false); setMsg('Saved')
        setSavedAt(r?.savedAt || new Date().toISOString())
        setSavedNotes(noteDraft.trim())
        setNoteDraft('')
        setVersions(null)
        if (showHist) loadVersions()
      }
    } catch (e: any) { setMsg(String(e?.message || e)) }
    finally { setBusy(false) }
  }

  const cardTitle = `${boatName || 'JV76'} - Backstay Guide`
  // A version saved before the guide layout has no overlay we can map onto these
  // columns, so the card shows the guide itself — say so rather than let the
  // timestamp imply those were the numbers on the day.
  const staleVersion = !!viewing && !isGuideLayout(viewing.settings)

  // ── The card, printed ──────────────────────────────────────────────────────
  // Same 8-column ruler as the screen, drawn in mm so an A4 print comes out at
  // the size the rig team laminates.
  const downloadPdf = async () => {
    setPdfBusy(true)
    try {
      const JsPDF = await loadJsPdf()
      const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const M = 12
      const LABEL_W = 34, COL_W = 21.5
      const W = LABEL_W + COL_W * N_COLS
      const RH = 5.4          // grid row height
      const BASE = RH * 0.68  // text baseline inside a row
      const FS = 7.5
      const colX = (i: number) => M + LABEL_W + COL_W * i
      let y = 16
      const top = y

      doc.setDrawColor(0); doc.setLineWidth(0.2)
      const box = (x: number, yy: number, w: number, h: number, rgb?: [number, number, number]) => {
        if (rgb) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, yy, w, h, 'FD') }
        else doc.rect(x, yy, w, h, 'S')
      }
      // Centred text that shrinks rather than spilling out of its cell.
      const fit = (v: string, cx: number, cy: number, maxW: number, bold: boolean, rgb: [number, number, number]) => {
        if (!v) return
        doc.setFont('helvetica', bold ? 'bold' : 'normal')
        doc.setTextColor(rgb[0], rgb[1], rgb[2])
        doc.setFontSize(FS)
        const w = doc.getTextWidth(v)
        if (w > maxW) doc.setFontSize(Math.max(4, (FS * maxW) / w))
        doc.text(v, cx, cy, { align: 'center' })
        doc.setFontSize(FS)
      }
      // A value whose tail after the last slash is bold — "10 / 12", "80/100/3".
      const fitSplit = (v: string, cx: number, cy: number, maxW: number, rgb: [number, number, number], tailRgb = rgb) => {
        if (!v) return
        const [head, tail] = splitTail(v)
        if (!tail) return fit(v, cx, cy, maxW, false, rgb)
        doc.setFontSize(FS); doc.setTextColor(rgb[0], rgb[1], rgb[2])
        doc.setFont('helvetica', 'normal'); const wh = doc.getTextWidth(head)
        doc.setFont('helvetica', 'bold'); const wt = doc.getTextWidth(tail)
        const total = wh + wt
        if (total > maxW) doc.setFontSize(Math.max(4, (FS * maxW) / total))
        const x0 = cx - Math.min(total, maxW) / 2
        doc.setFont('helvetica', 'normal'); doc.text(head, x0, cy)
        doc.setTextColor(tailRgb[0], tailRgb[1], tailRgb[2])
        doc.setFont('helvetica', 'bold'); doc.text(tail, x0 + (total > maxW ? (wh * maxW) / total : wh), cy)
        doc.setFontSize(FS)
      }
      const labelCell = (text: string, bold: boolean) => {
        box(M, y, LABEL_W, RH)
        doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(FS); doc.setTextColor(0)
        const parts = text.split('/')
        if (text.startsWith('Forestay/')) { // the guide bolds "Total"
          doc.text('Forestay/', M + 1.2, y + BASE)
          const w = doc.getTextWidth('Forestay/')
          doc.setFont('helvetica', 'bold'); doc.text('Total', M + 1.2 + w, y + BASE)
          const w2 = doc.getTextWidth('Total')
          doc.setFont('helvetica', 'normal'); doc.text(' (T)', M + 1.2 + w + w2, y + BASE)
        } else doc.text(parts.join('/'), M + 1.2, y + BASE)
      }

      // Masthead — boat name, title, tuning-guide reference.
      doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(15); doc.setTextColor(0)
      doc.text(boatName || 'JV76', M + 3, y + 7)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
      doc.setTextColor(GUIDE_TITLE_RGB[0], GUIDE_TITLE_RGB[1], GUIDE_TITLE_RGB[2])
      doc.text(cardTitle, colX(2), y + 5)
      doc.setFontSize(9.5); doc.setTextColor(GUIDE_ORANGE_RGB[0], GUIDE_ORANGE_RGB[1], GUIDE_ORANGE_RGB[2])
      doc.text(`Tuning Guide Ref: ${refRevision} ${refDate}`, colX(2), y + 10)
      y += 13
      doc.line(M, y, M + W, y)
      // Baseline float line, full width, its own ruled row.
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0)
      doc.text(floatLine(refVal), M + W / 2, y + 4.2, { align: 'center' })
      y += 6.2
      doc.line(M, y, M + W, y)

      // TWS block.
      labelCell('TWS @ MH', true)
      TWS_COLS.forEach((c, i) => { box(colX(i), y, COL_W, RH, bandRgb(i)); fit(c, colX(i) + COL_W / 2, y + BASE, COL_W - 1.5, true, INK_RGB) })
      y += RH
      for (const r of TWS_ROWS) {
        labelCell(r.label, false)
        r.vals.forEach((gv, i) => {
          box(colX(i), y, COL_W, RH, bandRgb(i))
          const rgb: [number, number, number] = r.red?.includes(i) ? GUIDE_RED_RGB : INK_RGB
          const v = cellValue('upwind', r.key, i, gv)
          if (r.boldTail) fitSplit(v, colX(i) + COL_W / 2, y + BASE, COL_W - 1.5, rgb)
          else fit(v, colX(i) + COL_W / 2, y + BASE, COL_W - 1.5, false, rgb)
        })
        y += RH
      }
      // WIDE markers sit in the gap between the blocks — no rules.
      y += 1
      doc.setFont('helvetica', 'bold'); doc.setFontSize(FS)
      doc.setTextColor(GUIDE_GREEN_RGB[0], GUIDE_GREEN_RGB[1], GUIDE_GREEN_RGB[2])
      for (const i of TWS_WIDE) doc.text('WIDE', colX(i) + COL_W / 2, y + 3, { align: 'center' })
      y += 5.5
      doc.setTextColor(0)

      // Sails block, with the downwind crib filling the last two columns.
      const dwdX = colX(SAIL_COLS.length)
      const dwdW = COL_W * (N_COLS - SAIL_COLS.length)
      labelCell('Sails', true)
      SAIL_COLS.forEach((c, i) => { box(colX(i), y, COL_W, RH, bandRgb(i)); fit(c, colX(i) + COL_W / 2, y + BASE, COL_W - 1.2, true, INK_RGB) })
      box(dwdX, y, dwdW, RH, GUIDE_PEACH_RGB)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(FS); doc.setTextColor(0)
      doc.text('DWD', dwdX + 1.5, y + BASE)
      y += RH
      SAIL_ROWS.forEach((r, ri) => {
        labelCell(r.label, false)
        r.vals.forEach((gv, i) => {
          box(colX(i), y, COL_W, RH, bandRgb(i))
          fit(cellValue('reaching', r.key, i, gv), colX(i) + COL_W / 2, y + BASE, COL_W - 1.5, false, r.red?.includes(i) ? GUIDE_RED_RGB : INK_RGB)
        })
        // The crib: header on the first row, then the five bands; the rest is
        // plain peach so the panel reads as one block.
        box(dwdX, y, dwdW / 2, RH, GUIDE_PEACH_RGB)
        box(dwdX + dwdW / 2, y, dwdW / 2, RH, GUIDE_PEACH_RGB)
        if (ri === 0) {
          fit(DWD_HEAD[0], dwdX + dwdW / 4, y + BASE, dwdW / 2 - 1.5, false, INK_RGB)
          fitSplit(DWD_HEAD[1], dwdX + dwdW * 0.75, y + BASE, dwdW / 2 - 1.5, INK_RGB, GUIDE_RED_RGB)
        } else if (ri <= DWD_BANDS.length) {
          const bi = ri - 1
          fit(dwdValue(bi, 'tws'), dwdX + dwdW / 4, y + BASE, dwdW / 2 - 1.5, false, INK_RGB)
          fitSplit(dwdValue(bi, 'val'), dwdX + dwdW * 0.75, y + BASE, dwdW / 2 - 1.5, INK_RGB, GUIDE_RED_RGB)
        }
        y += RH
      })

      // NOTES strip and the card's footnote.
      doc.line(M, y, M + W, y)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(FS); doc.setTextColor(0)
      doc.text('NOTES', M + 1.2, y + BASE + 0.6)
      doc.setTextColor(GUIDE_GREEN_RGB[0], GUIDE_GREEN_RGB[1], GUIDE_GREEN_RGB[2])
      for (const i of SAIL_WIDE) doc.text('WIDE', colX(i) + COL_W / 2, y + BASE + 0.6, { align: 'center' })
      y += RH + 0.6
      doc.setFont('helvetica', 'normal'); doc.setTextColor(0)
      doc.text(GUIDE_NOTE, M + W / 2, y + BASE, { align: 'center' })
      y += RH
      box(M, top, W, y - top) // the outer frame, drawn last so it sits on top

      // Provenance, below the card — not part of it.
      const stampNotes = viewing ? viewing.notes : savedNotes
      y += 6
      doc.setFontSize(8); doc.setTextColor(110)
      doc.text(`Settings as saved ${fmtWhen(viewing ? viewing.saved_at : savedAt)}${viewing ? '  (historical version)' : ''}`, M, y); y += 4
      if (stampNotes) for (const ln of doc.splitTextToSize(`Notes: ${stampNotes}`, W).slice(0, 3)) { doc.text(ln, M, y); y += 3.6 }

      const name = `Backstay_Guide_${[boatName, refRevision].filter(Boolean).join('_').replace(/[^\w.-]+/g, '_') || 'sheet'}.pdf`
      doc.save(name)
    } catch (e: any) { setMsg('Could not build the PDF: ' + (e?.message || e)) }
    finally { setPdfBusy(false) }
  }

  // ── The card, on screen ────────────────────────────────────────────────────
  const LABEL_PX = 132, COL_PX = 86
  const cellBase: React.CSSProperties = { border: `1px solid ${INK}`, padding: 0, textAlign: 'center', fontSize: 12, color: INK, height: 23 }
  const labelBase: React.CSSProperties = { border: `1px solid ${INK}`, padding: '2px 6px', textAlign: 'left', fontSize: 12, color: INK, whiteSpace: 'nowrap', background: '#fff' }
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', textAlign: 'center', fontSize: 12, color: 'inherit', padding: '3px 2px', fontFamily: 'inherit', textOverflow: 'ellipsis' }
  const refInput: React.CSSProperties = { width: 60, background: '#f5f8fb', border: '1px solid #cdd9e6', borderRadius: 3, padding: '0 4px', fontSize: 11, color: '#0b1f33', fontFamily: 'inherit' }
  const bare: React.CSSProperties = { border: 'none', padding: '2px 6px', fontSize: 12, color: INK }

  // One data cell: shows the guide value (bold tail and red kept) until it is
  // being edited, when it becomes a plain input over the raw text.
  const DataCell = (sec: 'upwind' | 'reaching', row: GuideRow, i: number, gv: string) => {
    const red = !!row.red?.includes(i)
    const v = cellValue(sec, row.key, i, gv)
    const colour = red ? GUIDE_RED : INK
    const [head, tail] = row.boldTail ? splitTail(v) : [v, '']
    return (
      <td key={i} style={{ ...cellBase, background: bandBg(i), color: colour }}>
        {edit ? (
          <input style={inputStyle} value={v} onChange={(e) => setCell(sec, i, row.key, e.target.value)} />
        ) : (
          <span>{head}{tail ? <b>{tail}</b> : null}</span>
        )}
      </td>
    )
  }
  // A downwind-crib cell — same idea, always on the peach panel.
  const CribCell = (rowIdx: number, key: 'tws' | 'val', split: boolean, k: string) => {
    const v = dwdValue(rowIdx, key)
    const [head, tail] = split ? splitTail(v) : [v, '']
    return (
      <td key={k} style={{ ...cellBase, background: GUIDE_PEACH }}>
        {edit ? (
          <input style={inputStyle} value={v} onChange={(e) => setDwd(rowIdx, key, e.target.value)} />
        ) : (
          <span>{head}{tail ? <b style={{ color: GUIDE_RED }}>{tail}</b> : null}</span>
        )}
      </td>
    )
  }

  const Card = () => (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 4, padding: 12 }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: LABEL_PX + COL_PX * N_COLS, border: `2px solid ${INK}`, background: '#fff' }}>
        <colgroup>
          <col style={{ width: LABEL_PX }} />
          {TWS_COLS.map((_, i) => <col key={i} style={{ width: COL_PX }} />)}
        </colgroup>
        <tbody>
          {/* Masthead — boat name where the guide carries the loft wordmark. */}
          <tr>
            <td colSpan={2} style={{ ...bare, borderBottom: `1px solid ${INK}`, fontSize: 20, fontWeight: 700, fontStyle: 'italic', paddingTop: 6 }}>{boatName || 'JV76'}</td>
            <td colSpan={6} style={{ ...bare, borderBottom: `1px solid ${INK}`, paddingTop: 5, paddingBottom: 4 }}>
              <div style={{ color: GUIDE_TITLE, fontWeight: 700, fontSize: 13 }}>{cardTitle}</div>
              <div style={{ color: GUIDE_ORANGE, fontWeight: 700, fontSize: 11, marginTop: 2, display: 'flex', gap: 5, alignItems: 'center' }}>
                <span>Tuning Guide Ref:</span>
                {edit
                  ? <>
                      <input value={refRevision} onChange={(e) => setRef('revision', e.target.value)} placeholder={GUIDE_REV} style={{ ...refInput, width: 46 }} />
                      <input value={refDate} onChange={(e) => setRef('date', e.target.value)} placeholder={GUIDE_DATE} style={{ ...refInput, width: 76 }} />
                    </>
                  : <span>{refRevision} {refDate}</span>}
              </div>
            </td>
          </tr>
          {/* Baseline float line — one row across the card. */}
          <tr>
            <td colSpan={8} style={{ ...bare, borderBottom: `1px solid ${INK}`, textAlign: 'center', padding: '4px 6px' }}>
              {edit ? (
                <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', fontSize: 11 }}>
                  {REF_ITEMS.map(({ key, label, ph }) => (
                    <span key={key} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <b>{label}</b>
                      <input value={refVal(key)} onChange={(e) => setRef(key, e.target.value)} placeholder={ph} style={refInput} />
                    </span>
                  ))}
                </span>
              ) : floatLine(refVal)}
            </td>
          </tr>
          {/* TWS block. */}
          <tr>
            <td style={{ ...labelBase, fontWeight: 700 }}>TWS @ MH</td>
            {TWS_COLS.map((c, i) => <td key={i} style={{ ...cellBase, background: bandBg(i), fontWeight: 700 }}>{c}</td>)}
          </tr>
          {TWS_ROWS.map((r) => (
            <tr key={r.key}>
              <td style={labelBase}>
                {r.boldTail && r.label.startsWith('Forestay/') ? <>Forestay/<b>Total</b> (T)</> : r.label}
              </td>
              {r.vals.map((gv, i) => DataCell('upwind', r, i, gv))}
            </tr>
          ))}
          {/* WIDE markers in the gap between the blocks. */}
          <tr>
            <td style={bare} />
            {TWS_COLS.map((_, i) => (
              <td key={i} style={{ ...bare, textAlign: 'center', color: GUIDE_GREEN, fontWeight: 700, fontSize: 11 }}>
                {TWS_WIDE.includes(i) ? 'WIDE' : ''}
              </td>
            ))}
          </tr>
          {/* Sails block, downwind crib in the last two columns. */}
          <tr>
            <td style={{ ...labelBase, fontWeight: 700 }}>Sails</td>
            {SAIL_COLS.map((c, i) => <td key={i} style={{ ...cellBase, background: bandBg(i), fontWeight: 700, fontSize: 11 }}>{c}</td>)}
            <td colSpan={N_COLS - SAIL_COLS.length} style={{ ...cellBase, background: GUIDE_PEACH, fontWeight: 700, textAlign: 'left', paddingLeft: 6 }}>DWD</td>
          </tr>
          {SAIL_ROWS.map((r, ri) => (
            <tr key={r.key}>
              <td style={labelBase}>{r.label}</td>
              {r.vals.map((gv, i) => DataCell('reaching', r, i, gv))}
              {ri === 0 ? (
                <>
                  <td style={{ ...cellBase, background: GUIDE_PEACH }}>{DWD_HEAD[0]}</td>
                  <td style={{ ...cellBase, background: GUIDE_PEACH }}>Up/Low/<b style={{ color: GUIDE_RED }}>FS</b></td>
                </>
              ) : ri <= DWD_BANDS.length ? (
                <>
                  {CribCell(ri - 1, 'tws', false, 'tws')}
                  {CribCell(ri - 1, 'val', true, 'val')}
                </>
              ) : (
                <>
                  <td style={{ ...cellBase, background: GUIDE_PEACH }} />
                  <td style={{ ...cellBase, background: GUIDE_PEACH }} />
                </>
              )}
            </tr>
          ))}
          {/* NOTES strip. */}
          <tr>
            <td style={{ ...bare, borderTop: `2px solid ${INK}`, fontWeight: 700 }}>NOTES</td>
            {TWS_COLS.map((_, i) => (
              <td key={i} style={{ ...bare, borderTop: `2px solid ${INK}`, textAlign: 'center', color: GUIDE_GREEN, fontWeight: 700, fontSize: 11 }}>
                {SAIL_WIDE.includes(i) ? 'WIDE' : ''}
              </td>
            ))}
          </tr>
          <tr><td colSpan={8} style={{ ...bare, textAlign: 'center', paddingBottom: 5 }}>{GUIDE_NOTE}</td></tr>
        </tbody>
      </table>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: C.head }}>Backstay guide</span>
        <span style={{ fontSize: 10, color: C.dim }}>
          {viewing ? `history · saved ${fmtWhen(viewing.saved_at)}` : savedAt ? `saved ${fmtWhen(savedAt)}` : `guide ${GUIDE_REV} ${GUIDE_DATE} · not yet saved`}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowHist((v) => !v)} style={{ ...rbtn('#334155'), color: '#E2E8F0' }}>
          {showHist ? '▴ History' : `▾ History${versions?.length ? ` (${versions.length})` : ''}`}
        </button>
        <button onClick={downloadPdf} disabled={pdfBusy} style={{ ...rbtn('#8B5CF6'), color: '#fff', opacity: pdfBusy ? 0.6 : 1 }}>{pdfBusy ? 'Building…' : '⬇ PDF'}</button>
        {viewing && <button onClick={backToCurrent} style={{ ...rbtn('#06B6D4') }}>← Back to current</button>}
        {canEdit && !editing && !viewing && <button onClick={startEdit} style={{ ...rbtn('#06B6D4') }}>✎ Edit</button>}
        {edit && <button onClick={save} disabled={busy || !dirty} style={{ ...rbtn('#10B981'), opacity: busy || !dirty ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>}
        {edit && <button onClick={cancelEdit} style={{ ...rbtn('#334155'), color: '#E2E8F0' }}>Cancel</button>}
        {msg && <span style={{ fontSize: 11, color: msg === 'Saved' ? '#10B981' : '#F59E0B' }}>{msg}</span>}
      </div>
      {staleVersion ? (
        <div style={{ fontSize: 12, color: '#FCD34D', background: '#2A1F05', border: '1px solid #78530F', borderRadius: 8, padding: '7px 10px' }}>
          This version was saved against the old three-table layout, whose columns don’t map onto the guide’s. The card below shows guide {GUIDE_REV} {GUIDE_DATE} as issued, not that version’s numbers.
        </div>
      ) : null}
      {edit ? <div style={{ fontSize: 11, color: C.dim }}>Every cell is editable — each starts from guide {GUIDE_REV} {GUIDE_DATE} and keeps your value until you clear it. The row labels stay fixed.</div> : null}

      {edit ? (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Notes for this version</div>
          <textarea
            value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} rows={2}
            placeholder="What changed and why"
            style={{ width: '100%', boxSizing: 'border-box', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, color: '#E2E8F0', padding: '7px 9px', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </div>
      ) : ((viewing?.notes || savedNotes) ? (
        <div style={{ fontSize: 12, color: '#94A3B8', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 8, padding: '7px 10px' }}>
          <span style={{ color: '#7DD3FC', fontWeight: 700 }}>Notes: </span>
          {viewing ? viewing.notes : savedNotes}
        </div>
      ) : null)}

      {showHist ? (
        <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', marginBottom: 6 }}>Saved versions — newest first</div>
          {versions == null ? <div style={{ fontSize: 11, color: C.dim }}>loading…</div> : null}
          {versions?.length === 0 ? <div style={{ fontSize: 11, color: C.dim }}>No saved versions yet. The next Save starts the record.</div> : null}
          {versions?.map((v, i) => (
            <div key={v.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', borderTop: i ? '1px solid #12283E' : 'none' }}>
              <div style={{ minWidth: 155 }}>
                <div style={{ fontSize: 12, color: '#E2E8F0', fontWeight: 700 }}>{fmtWhen(v.saved_at)}</div>
                <div style={{ fontSize: 10, color: C.dim }}>{v.saved_by || '—'}{i === 0 ? ' · current' : ''}</div>
              </div>
              <div style={{ flex: 1, fontSize: 12, color: v.notes ? '#94A3B8' : '#475569', minWidth: 0 }}>{v.notes || 'no notes'}</div>
              <button onClick={() => viewVersion(v)} style={{ ...rbtn('#334155'), color: '#E2E8F0', fontSize: 11, padding: '4px 9px' }}>View</button>
              {canEdit && i > 0 ? (
                <button onClick={() => restoreVersion(v)} style={{ ...rbtn('#F59E0B'), fontSize: 11, padding: '4px 9px' }}>Restore</button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Called, not mounted as <Card/>: it is defined inside this component, so
          as a JSX element React remounts the subtree (and the focused <input>)
          on every keystroke — dropping focus and scrolling to the top. */}
      {Card()}
    </div>
  )
}

function RigSubTable({ cols, heading, fields }: { cols: any[]; heading: string; fields: RigField[] }) {
  if (!cols.length) return null
  const bands: { section: string; span: number }[] = []
  for (const c of cols) {
    const last = bands[bands.length - 1]
    if (last && last.section === c.section) last.span++
    else bands.push({ section: c.section, span: 1 })
  }
  const th: React.CSSProperties = { padding: '5px 8px', fontSize: 11, fontWeight: 700, color: '#0b1f33', borderBottom: '1px solid #1E3A5A', textAlign: 'center', whiteSpace: 'nowrap' }
  const rh: React.CSSProperties = { padding: '5px 10px', fontSize: 11, fontWeight: 700, color: '#0b1f33', textAlign: 'left', borderBottom: '1px solid #d7e2ee', background: '#eef3f8', position: 'sticky', left: 0 }
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12, color: '#0b1f33', textAlign: 'center', borderBottom: '1px solid #d7e2ee', whiteSpace: 'nowrap' }
  return (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#0b1f33', padding: '2px 4px 8px' }}>{heading}</div>
      <table style={{ borderCollapse: 'collapse', minWidth: 560 }}>
        <thead>
          <tr>
            <th style={{ ...th, background: '#eef3f8' }}></th>
            {bands.map((b, i) => (
              <th key={i} style={{ ...th, background: RIG_SEC_TINT[b.section] || '#eee' }} colSpan={b.span}>{b.section.toUpperCase()}</th>
            ))}
          </tr>
          <tr>
            <th style={{ ...rh, background: '#dde6ef' }}>Sail combo</th>
            {cols.map((c, i) => (
              <th key={i} style={{ ...th, background: RIG_SEC_TINT[c.section] || '#eee' }}>{c.headsail || '—'}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <td style={rh}>{f.label}</td>
              {cols.map((c, i) => (
                <td key={i} style={{ ...td, background: (RIG_SEC_TINT[c.section] || '#fff').replace('0.45', '0.16').replace('0.5', '0.16') }}>{f.render(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RigTuneTable({ data }: { data: any }) {
  const cols: any[] = Array.isArray(data?.columns) ? data.columns : []
  if (!cols.length) return <div style={{ color: C.dim, fontSize: 12 }}>No rig columns parsed.</div>
  const upwind = cols.filter((c) => c.section === 'upwind')
  const reachDown = cols.filter((c) => c.section !== 'upwind' && !isHiddenReachingCol(c))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <RigSubTable cols={upwind} heading="Upwind" fields={UPWIND_FIELDS} />
      <RigSubTable cols={reachDown} heading="Reaching / Downwind" fields={REACHING_FIELDS} />
    </div>
  )
}

// ── Polar upload + version history ───────────────────────────────────────────
interface PolarUploadVersion extends PolarVersion {
  include: boolean     // save this version
  stored: boolean      // a version with this name is already on file for the boat
  validFrom: string
}
interface PolarUpload {
  fileName: string
  versions: PolarUploadVersion[]
  source: string
  activeIdx: number | null   // null = keep the current active polar
}

// Where each version of an upload got to. The upload used to be silent about this:
// a save that never reached the cloud looked the same as one that did, and the only
// hint was a version quietly missing from the list below.
interface PolarSaveRow {
  name: string
  state: 'waiting' | 'saving' | 'saved' | 'failed'
  detail?: string
  id?: string
  at?: string
}
interface PolarSaveStatus {
  fileName: string
  rows: PolarSaveRow[]
  startedAt: number
  finishedAt: number | null
  verified: 'pending' | 'ok' | 'partial' | 'failed'
  activeName: string | null
}
interface PolarSync { at: number | null; error: string | null }   // last read of the cloud

const POLAR_SOURCES: [string, string][] = [
  ['design_vpp', 'Design VPP'], ['measured', 'Measured'], ['sailmaker', 'Sailmaker'], ['blend', 'Blend'], ['other', 'Other'],
]

function PolarUploadForm({ upload, setUpload, onPick, onSave, busy, msg, btn, input, save, cloud, onRecheck }: {
  upload: PolarUpload | null
  setUpload: (u: PolarUpload | null) => void
  onPick: (f: File) => void
  onSave: () => void
  busy: boolean
  msg: string
  btn: (bg: string) => React.CSSProperties
  input: React.CSSProperties
  save: PolarSaveStatus | null
  cloud: { count: number; activeName: string | null; at: number | null; error: string | null }
  onRecheck: () => void
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const setVersion = (i: number, patch: Partial<PolarUploadVersion>) =>
    upload && setUpload({ ...upload, versions: upload.versions.map((v, j) => (j === i ? { ...v, ...patch } : v)) })
  const range = (xs: number[]) => (xs.length ? `${Math.min(...xs)}–${Math.max(...xs)}` : '—')
  const nNew = upload?.versions.filter((v) => v.include).length || 0
  const canSave = !!upload && (nNew > 0 || upload.activeIdx != null)
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: C.dim }
  const cell: React.CSSProperties = { padding: '5px 6px', fontSize: 12, color: C.text, borderBottom: '1px solid #0d2236', verticalAlign: 'middle' }
  const head: React.CSSProperties = { ...cell, color: C.dim, fontSize: 10, fontWeight: 600, textAlign: 'left', borderBottom: `1px solid ${C.border}` }
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 14, background: C.card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.head }}>Upload polar</span>
        <span style={{ fontSize: 11, color: C.dim, flex: '1 1 240px' }}>
          A polar workbook (.xlsx, one TWS/TWA sheet per version) or a single polar (.txt, .csv, .pol).
          Every version is kept for this boat.
        </span>
        <input ref={fileRef} type="file" style={{ display: 'none' }}
          accept=".xlsx,.txt,.csv,.pol,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...btn(C.accent), opacity: busy ? 0.6 : 1 }}>
          Choose file…
        </button>
      </div>

      {/* What the cloud holds right now — so "did my upload land?" is answered on the page. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 11 }}>
        {cloud.error ? (
          <span style={{ color: C.warn }}>⚠ Could not read the cloud: {cloud.error} — what is listed below may be out of date.</span>
        ) : cloud.at ? (
          <span style={{ color: C.dim }}>
            <span style={{ color: C.ok }}>●</span> Cloud: {cloud.count} version{cloud.count === 1 ? '' : 's'} on file
            {cloud.activeName ? <> · active <b style={{ color: C.head }}>{cloud.activeName}</b></> : ' · none active'}
            {' · '}checked {fmtClock(cloud.at)}
          </span>
        ) : (
          <span style={{ color: C.dim }}>Reading the cloud…</span>
        )}
        <button onClick={onRecheck} disabled={busy} style={{ ...btn('#0F2A45'), color: C.head, padding: '2px 8px', fontSize: 10, opacity: busy ? 0.6 : 1 }}>
          Re-check
        </button>
      </div>

      {save && <PolarSaveReport save={save} />}

      {upload && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: C.text, marginBottom: 6 }}>
            <b style={{ color: C.head }}>{upload.fileName}</b> — {upload.versions.length} polar version{upload.versions.length === 1 ? '' : 's'}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 680 }}>
              <thead>
                <tr>
                  <th style={head}>Save</th><th style={head}>Version name</th><th style={head}>TWS (kn)</th>
                  <th style={head}>TWA (°)</th><th style={head}>Valid from</th><th style={head}>Notes</th>
                  <th style={{ ...head, textAlign: 'center' }}>Active</th>
                </tr>
              </thead>
              <tbody>
                {upload.versions.map((v, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={v.include} onChange={(e) => setVersion(i, { include: e.target.checked })} />
                      {v.stored && <span style={{ fontSize: 10, color: C.dim, marginLeft: 6 }}>on file</span>}
                    </td>
                    <td style={cell}>
                      <input value={v.name} disabled={!v.include} onChange={(e) => setVersion(i, { name: e.target.value })}
                        style={{ ...input, width: '100%', minWidth: 170, opacity: v.include ? 1 : 0.6 }} />
                    </td>
                    <td style={cell}>{range(v.entries.map((e) => e.tws))}</td>
                    <td style={cell}>{range(v.entries.flatMap((e) => e.points.map((p) => p.twa)))}</td>
                    <td style={cell}>
                      <input type="date" value={v.validFrom} disabled={!v.include} onChange={(e) => setVersion(i, { validFrom: e.target.value })}
                        style={{ ...input, opacity: v.include ? 1 : 0.6 }} />
                    </td>
                    <td style={{ ...cell, color: C.dim, maxWidth: 280 }}>
                      {v.notes || '—'}
                      {v.headline && <span style={{ color: C.accent }}> · targets sheet</span>}
                    </td>
                    <td style={{ ...cell, textAlign: 'center' }}>
                      <input type="radio" name="polar-active" checked={upload.activeIdx === i} disabled={!v.include && !v.stored}
                        onChange={() => setUpload({ ...upload, activeIdx: i })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
            <label style={label}>Source
              <select value={upload.source} onChange={(e) => setUpload({ ...upload, source: e.target.value })} style={input}>
                {POLAR_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.text }}>
              <input type="radio" name="polar-active" checked={upload.activeIdx == null} onChange={() => setUpload({ ...upload, activeIdx: null })} />
              Keep the current active polar
            </label>
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button onClick={() => setUpload(null)} disabled={busy} style={{ ...btn('#0F2A45'), color: C.head }}>Cancel</button>
              <button onClick={onSave} disabled={busy || !canSave} style={{ ...btn(C.ok), opacity: busy || !canSave ? 0.6 : 1 }}>
                {busy ? 'Saving…' : nNew ? `Save ${nNew} version${nNew === 1 ? '' : 's'}` : 'Set active'}
              </button>
            </div>
          </div>
        </div>
      )}
      {msg && <div style={{ color: C.warn, fontSize: 12, marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

// Per-version result of the last upload: what reached the cloud, what did not, and why.
function PolarSaveReport({ save }: { save: PolarSaveStatus }) {
  const tone = save.verified === 'ok' ? C.ok : save.verified === 'pending' ? C.accent : C.warn
  const saved = save.rows.filter((r) => r.state === 'saved').length
  const title = save.verified === 'pending'
    ? `Uploading ${save.fileName} to the cloud — ${saved}/${save.rows.length} done…`
    : save.verified === 'ok'
      ? `✓ ${saved} version${saved === 1 ? '' : 's'} of ${save.fileName} ${saved === 1 ? 'is' : 'are'} in the cloud · ${fmtClock(save.finishedAt)}`
      : save.verified === 'partial'
        ? `⚠ ${save.fileName}: ${saved} of ${save.rows.length} version${save.rows.length === 1 ? '' : 's'} confirmed in the cloud`
        : `✕ ${save.fileName} did not upload`
  const mark = (r: PolarSaveRow) =>
    r.state === 'saved' ? '✓' : r.state === 'failed' ? '✕' : r.state === 'saving' ? '…' : '·'
  const colour = (r: PolarSaveRow) =>
    r.state === 'saved' ? C.ok : r.state === 'failed' ? C.warn : C.dim
  return (
    <div data-polar-save={save.verified} style={{ marginTop: 10, border: `1px solid ${tone}55`, borderRadius: 8, padding: '8px 10px', background: '#05121f' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: tone, marginBottom: 4 }}>{title}</div>
      {save.rows.map((r) => (
        <div key={r.name} style={{ fontSize: 11, color: colour(r), display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ width: 10 }}>{mark(r)}</span>
          <span style={{ color: r.state === 'saved' ? C.text : colour(r) }}>{r.name}</span>
          {r.state === 'saved' && <span style={{ color: C.dim }}>· saved{r.at ? ` ${fmtDate(r.at)}` : ''}{r.id ? ` · id ${String(r.id).slice(0, 8)}` : ''}</span>}
          {r.detail && <span>· {r.detail}</span>}
        </div>
      ))}
      {save.activeName && (
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>
          Active polar after this upload: <b style={{ color: C.head }}>{save.activeName}</b>
        </div>
      )}
      {save.verified !== 'ok' && save.verified !== 'pending' && (
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>
          The file is still loaded above — fix what the line says and press Save again.
        </div>
      )}
    </div>
  )
}

function PolarVersions({ versions, canEdit, busy, onActivate, th, td, btn, sync }: {
  versions: any[]
  canEdit: boolean
  busy: boolean
  onActivate: (id: string) => void
  th: React.CSSProperties
  td: React.CSSProperties
  btn: (bg: string) => React.CSSProperties
  sync: PolarSync
}) {
  const sourceLabel = Object.fromEntries(POLAR_SOURCES)
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.head }}>Polar versions</span>
        <span style={{ fontSize: 11, color: sync.error ? C.warn : C.dim }}>
          {sync.error ? `⚠ cloud read failed: ${sync.error}` : `${versions.length} in the cloud · read ${fmtClock(sync.at)}`}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
          <thead>
            <tr>
              <th style={th}>Version</th><th style={th}>Source</th><th style={th}>Valid from</th>
              <th style={th}>Uploaded</th><th style={th}>File</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td style={{ ...td, fontWeight: 700, color: C.head }}>{v.name}</td>
                <td style={td}>{sourceLabel[v.source] || v.source || '—'}</td>
                <td style={td}>{fmtDate(v.valid_from)}</td>
                <td style={td}>{fmtDate(v.created_at)}</td>
                <td style={{ ...td, color: C.dim }}>{v.data?.file_name || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {v.is_active ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.ok }}>● Active</span>
                  ) : canEdit ? (
                    <button onClick={() => onActivate(v.id)} disabled={busy}
                      style={{ ...btn('#0F2A45'), color: C.head, padding: '3px 10px', opacity: busy ? 0.6 : 1 }}>
                      Set active
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Headline TARGETS sheet (upwind | TWS | downwind) ─────────────────────────
function TargetsTable({ targets, uploadedAt }: { targets: any; uploadedAt?: string | null }) {
  const rows = targets.headline || []
  const th: React.CSSProperties = { padding: '5px 8px', fontSize: 11, fontWeight: 700, color: '#0b1f33', borderBottom: '1px solid #1E3A5A', textAlign: 'center' }
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12, color: '#0b1f33', textAlign: 'center', borderBottom: '1px solid #d7e2ee' }
  const up = 'rgba(244,176,132,0.45)'   // orange tint (upwind)
  const dn = 'rgba(180,199,231,0.45)'   // blue tint (downwind)
  const tws = 'rgba(217,217,217,0.6)'
  return (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <table style={{ borderCollapse: 'collapse', margin: '0 auto', minWidth: 560 }}>
        <thead>
          <tr>
            <th style={{ ...th, background: up }} colSpan={5}>UPWIND</th>
            <th style={{ ...th, background: tws }}></th>
            <th style={{ ...th, background: dn }} colSpan={5}>DOWNWIND</th>
          </tr>
          <tr>
            {['RUDD', 'AWA', 'HEEL', 'TWA', 'BSP'].map((h) => <th key={'u' + h} style={{ ...th, background: up }}>{h}</th>)}
            <th style={{ ...th, background: tws }}>TWS</th>
            {['BSP', 'TWA', 'HEEL', 'AWA', 'RUDD'].map((h) => <th key={'d' + h} style={{ ...th, background: dn }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.tws}>
              <td style={{ ...td, background: up }}>{fmt(r.up.rudd)}</td>
              <td style={{ ...td, background: up, fontWeight: 700 }}>{fmt(r.up.awa, 0)}</td>
              <td style={{ ...td, background: up }}>{fmt(r.up.heel, 0)}</td>
              <td style={{ ...td, background: up, fontWeight: 700 }}>{fmt(r.up.twa, 0)}</td>
              <td style={{ ...td, background: up }}>{fmt(r.up.bsp)}</td>
              <td style={{ ...td, background: tws, fontWeight: 800 }}>{r.tws}</td>
              <td style={{ ...td, background: dn }}>{fmt(r.dn.bsp)}</td>
              <td style={{ ...td, background: dn, fontWeight: 700 }}>{fmt(r.dn.twa, 0)}</td>
              <td style={{ ...td, background: dn }}>{fmt(r.dn.heel, 0)}</td>
              <td style={{ ...td, background: dn, fontWeight: 700 }}>{fmt(r.dn.awa, 0)}</td>
              <td style={{ ...td, background: dn }}>{fmt(r.dn.rudd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <UploadedCaption uploadedAt={uploadedAt} />
    </div>
  )
}

// ── One TWS×TWA matrix (BSP / Heel / Rudder / AWA) with heat shading ─────────
function MatrixTable({ targets, mkey, uploadedAt }: { targets: any; mkey: string; uploadedAt?: string | null }) {
  const m: number[][] = targets.matrices?.[mkey] || []
  const twa: number[] = targets.twa || []
  const tws: number[] = targets.tws || []
  const dec = targets.matrix_meta?.[mkey]?.decimals ?? 1
  const flat = m.flat().filter((v) => typeof v === 'number' && !Number.isNaN(v))
  const lo = Math.min(...flat), hi = Math.max(...flat)
  const cell: React.CSSProperties = { padding: '3px 6px', fontSize: 11, textAlign: 'center', color: '#0b1f33', border: '1px solid #e2e8f0', minWidth: 30 }
  const hcell: React.CSSProperties = { ...cell, fontWeight: 700, color: C.dim, background: '#0a1c2e', borderColor: C.border }
  return (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...hcell, color: C.head }}>TWS\TWA</th>
            {twa.map((a) => <th key={a} style={{ ...cell, fontWeight: 700, background: '#eef2f7' }}>{a}</th>)}
          </tr>
        </thead>
        <tbody>
          {m.map((row, i) => (
            <tr key={tws[i]}>
              <td style={{ ...cell, fontWeight: 700, background: '#eef2f7' }}>{tws[i]}</td>
              {row.map((v, j) => (
                <td key={j} style={{ ...cell, background: heat(v, lo, hi) }}>{fmt(v, dec)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <UploadedCaption uploadedAt={uploadedAt} />
    </div>
  )
}

// ── Print the targets as a clean, laminate-ready sheet (new window) ──────────
function printTargets(targets: any, title: string) {
  const esc = (s: any) => String(s)
  const fmtN = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '' : Number(v).toFixed(d))
  const headline = targets.headline || []
  const twa: number[] = targets.twa || []
  const tws: number[] = targets.tws || []

  const headlineRows = headline.map((r: any) => `
    <tr>
      <td class="up">${fmtN(r.up.rudd)}</td><td class="up b">${fmtN(r.up.awa,0)}</td><td class="up">${fmtN(r.up.heel,0)}</td><td class="up b">${fmtN(r.up.twa,0)}</td><td class="up">${fmtN(r.up.bsp)}</td>
      <td class="tws">${r.tws}</td>
      <td class="dn">${fmtN(r.dn.bsp)}</td><td class="dn b">${fmtN(r.dn.twa,0)}</td><td class="dn">${fmtN(r.dn.heel,0)}</td><td class="dn b">${fmtN(r.dn.awa,0)}</td><td class="dn">${fmtN(r.dn.rudd)}</td>
    </tr>`).join('')

  const matrix = (mkey: string) => {
    const m: number[][] = targets.matrices?.[mkey] || []
    const dec = targets.matrix_meta?.[mkey]?.decimals ?? 1
    const label = targets.matrix_meta?.[mkey]?.label || mkey
    const head = `<tr><th>TWS\\TWA</th>${twa.map((a) => `<th>${a}</th>`).join('')}</tr>`
    const body = m.map((row, i) => `<tr><th>${tws[i]}</th>${row.map((v) => `<td>${fmtN(v, dec)}</td>`).join('')}</tr>`).join('')
    return `<h3>${esc(label)}</h3><table class="mx">${head}${body}</table>`
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page { size: landscape; margin: 10mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 12px; }
    h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 12px; font-weight: normal; color: #555; margin: 0 0 12px; }
    h3 { font-size: 13px; margin: 16px 0 4px; }
    table { border-collapse: collapse; }
    .hl td, .hl th { border: 1px solid #999; padding: 4px 8px; text-align: center; font-size: 12px; }
    .hl .grp { font-weight: 700; }
    .up { background: #f8d8bf; } .dn { background: #cdd9f0; } .tws { background: #dcdcdc; font-weight: 800; } .b { font-weight: 700; }
    .mx td, .mx th { border: 1px solid #ccc; padding: 2px 5px; text-align: center; font-size: 10px; }
    .mx th { background: #eef2f7; }
    .page-break { page-break-before: always; }
  </style></head><body>
    <h1>${esc(title)}</h1>
    <h2>${esc(targets.source_note || '')}${targets.wind_reference ? ' · ' + esc(targets.wind_reference) : ''}</h2>
    <table class="hl">
      <tr><td class="up grp" colspan="5">UPWIND</td><td class="tws"></td><td class="dn grp" colspan="5">DOWNWIND</td></tr>
      <tr><td class="up">RUDD</td><td class="up">AWA</td><td class="up">HEEL</td><td class="up">TWA</td><td class="up">BSP</td><td class="tws">TWS</td><td class="dn">BSP</td><td class="dn">TWA</td><td class="dn">HEEL</td><td class="dn">AWA</td><td class="dn">RUDD</td></tr>
      ${headlineRows}
    </table>
    <div class="page-break"></div>
    ${matrix('bsp')}
    ${matrix('heel')}
    ${matrix('rudder')}
    ${matrix('awa')}
    <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`

  const w = window.open('', '_blank')
  if (!w) return
  w.document.open(); w.document.write(html); w.document.close()
}

// ── Add-sail form ────────────────────────────────────────────────────────────
// ── Import the sail inventory from an Expedition event file's <saillist> ──────
function ImportSailListForm({ onImport, btn, input }: any) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const submit = async (file: File) => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await onImport(file)
      setMsg(`Imported ${r?.count ?? 0} sail${(r?.count ?? 0) === 1 ? '' : 's'} (${r?.inserted ?? 0} new, ${r?.updated ?? 0} updated, ${r?.retired ?? 0} retired)${r?.boatName ? ` · ${r.boatName}` : ''}.`)
    } catch (e: any) { setErr(e?.message || 'Import failed.') }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <span style={{ fontSize: 11, color: '#8A97A9', fontWeight: 700 }}>Import sail list</span>
      <span style={{ fontSize: 10, color: '#64748B' }}>Expedition event file (.ev.xml) — its &lt;saillist&gt;</span>
      <input ref={fileRef} type="file" accept=".xml,.ev.xml,text/xml,application/xml" disabled={busy} style={{ ...input, padding: 4 }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) submit(f) }} />
      <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...btn('#06B6D4'), opacity: busy ? 0.5 : 1 }}>{busy ? 'Importing…' : 'Choose file'}</button>
      {msg && <span style={{ fontSize: 11, color: '#10B981' }}>{msg}</span>}
      {err && <span style={{ fontSize: 11, color: '#F59E0B' }}>{err}</span>}
    </div>
  )
}

// Import the North "Target sail shapes" design CSV → store per-sail design shapes.
function ImportDesignShapesForm({ onImport, btn, input }: any) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const submit = async (file: File) => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await onImport(file)
      const un = (r?.unmatched || []).length ? ` · no inventory match for ${r.unmatched.join(', ')}` : ''
      setMsg(`Design shapes stored on ${r?.matched ?? 0} sail${(r?.matched ?? 0) === 1 ? '' : 's'}${un}.`)
    } catch (e: any) { setErr(e?.message || 'Import failed.') }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <span style={{ fontSize: 11, color: '#8A97A9', fontWeight: 700 }}>Import design shapes</span>
      <span style={{ fontSize: 10, color: '#64748B' }}>North target-shapes (.csv) — matched to sails by code (MN/J1/J1.5/J2/J3)</span>
      <input ref={fileRef} type="file" accept=".csv,text/csv" disabled={busy} style={{ ...input, padding: 4 }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) submit(f) }} />
      <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...btn('#06B6D4'), opacity: busy ? 0.5 : 1 }}>{busy ? 'Importing…' : 'Choose file'}</button>
      {msg && <span style={{ fontSize: 11, color: '#10B981' }}>{msg}</span>}
      {err && <span style={{ fontSize: 11, color: '#F59E0B' }}>{err}</span>}
    </div>
  )
}

// Descriptive sail types (matches the Expedition <saillist> sailtype values).
const SAIL_TYPES = [
  'Mainsail', 'Jib', 'Genoa', 'Genoa Staysail', 'Spinnaker Staysail',
  'Masthead Spinnaker', 'Fractional Spinnaker', 'Masthead Gennaker', 'Fractional Gennaker', 'Code', 'Other',
]
// The values sails.kind accepts — kept in step with the CHECK constraint in
// migration 0035. 'mainsail' is the one that carries weight elsewhere: the
// batten card hangs off it, so a boat whose inventory never sets it gets a
// Battens tab that says it has no mainsail.
const SAIL_KINDS = [
  'mainsail', 'jib', 'genoa', 'staysail', 'spinnaker', 'gennaker', 'code', 'other',
] as const

const SAIL_GROUPS = [
  { v: 'M', label: 'M · main' },
  { v: 'H', label: 'H · headsail' },
  { v: 'S', label: 'S · spinnaker' },
]
// "A1.5_2026" → "A1.5"; otherwise the name as-is.
const categoryFromName = (name: string): string => name.replace(/_\d{4}$/, '').trim() || name
const groupForKind = (kind: string): string => (kind === 'mainsail' ? 'M' : kind === 'spinnaker' ? 'S' : 'H')

// Manual add — same shape as the <saillist> import rows: name + sail type +
// group + weight, with `kind` derived and the rest stored under `specs`.
function AddSailForm({ onAdd, busy, input, btn }: any) {
  const [name, setName] = useState('')
  const [sailType, setSailType] = useState('Jib')
  const [group, setGroup] = useState('')
  const [weight, setWeight] = useState('')
  const [build, setBuild] = useState('')
  const submit = () => {
    if (!name.trim()) return
    const kind = sailKindFromType(sailType, group)
    const wt = weight.trim() ? parseFloat(weight.replace(',', '.')) : null
    onAdd({
      name: name.trim(),
      kind,
      category: categoryFromName(name.trim()),
      build_date: build || null,
      specs: {
        sail_type: sailType || null,
        sail_group: group || groupForKind(kind),
        weight_kg: wt != null && !Number.isNaN(wt) ? wt : null,
        source: 'manual',
      },
    })
    setName(''); setSailType('Jib'); setGroup(''); setWeight(''); setBuild('')
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <input style={{ ...input, width: 150 }} placeholder="Sail name *" value={name} onChange={(e) => setName(e.target.value)} />
      <label style={{ fontSize: 11, color: '#8A97A9' }}>Type
        <select style={{ ...input, marginLeft: 4 }} value={sailType} onChange={(e) => setSailType(e.target.value)}>
          {SAIL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label style={{ fontSize: 11, color: '#8A97A9' }}>Grp
        <select style={{ ...input, marginLeft: 4 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">auto</option>
          {SAIL_GROUPS.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}
        </select>
      </label>
      <input style={{ ...input, width: 80 }} type="number" step="0.1" placeholder="Wt (kg)" value={weight} onChange={(e) => setWeight(e.target.value)} />
      <label style={{ fontSize: 11, color: '#8A97A9' }}>Build <input type="date" style={input} value={build} onChange={(e) => setBuild(e.target.value)} /></label>
      <button onClick={submit} disabled={busy || !name.trim()} style={{ ...btn('#06B6D4'), opacity: busy || !name.trim() ? 0.5 : 1 }}>{busy ? '…' : '+ Add sail'}</button>
    </div>
  )
}

// ── Import-and-assign a North scan ───────────────────────────────────────────
// File-picker for a North SailScan PDF + a sail selector (existing inventory,
// "assign later", or inline-create a new sail tag). Posts to /sail-scans, which
// parses the report into a structured row linked to the chosen sail.
function ImportScanForm({ sails, onImport, onCreateSail, input, btn }: any) {
  const active = (sails || []).filter((s: any) => !s.retired)
  const [file, setFile] = useState<File | null>(null)
  const [sailId, setSailId] = useState<string>('')   // '' = assign later, '__new' = create
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const fileRef = React.useRef<HTMLInputElement>(null)

  const submit = async () => {
    if (!file) { setErr('Pick a North report PDF first.'); return }
    setBusy(true); setErr(''); setMsg('')
    try {
      let assignTo: string | null = sailId && sailId !== '__new' ? sailId : null
      if (sailId === '__new') {
        if (!newName.trim()) { setErr('Name the new sail, or choose “assign later”.'); setBusy(false); return }
        const created = await onCreateSail({ name: newName.trim() })
        assignTo = created?.id || null
      }
      const res = await onImport(file, assignTo, (m: string) => setMsg(m))
      const scans = res?.parsed || []
      const total = scans.reduce((a: number, s: any) => a + (s?.stripes?.length || 0), 0)
      const names = scans.map((s: any) => s?.sailName).filter(Boolean).join(', ')
      setMsg(`Imported ${res?.count ?? scans.length} scan${(res?.count ?? scans.length) === 1 ? '' : 's'}${names ? ` — ${names}` : ''}, ${total} stripe${total === 1 ? '' : 's'}.`)
      setFile(null); setNewName(''); setSailId('')
      if (fileRef.current) fileRef.current.value = ''
    } catch (e: any) {
      setErr(e?.message || 'Import failed.')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <span style={{ fontSize: 11, color: '#8A97A9', fontWeight: 700 }}>Import SailScan report</span>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" style={{ ...input, padding: 4 }}
        onChange={(e) => { setFile(e.target.files?.[0] || null); setErr(''); setMsg('') }} />
      <select style={input} value={sailId} onChange={(e) => setSailId(e.target.value)}>
        <option value="">— assign later —</option>
        {active.map((s: any) => (
          <option key={s.id} value={s.id}>{s.category ? `${s.category} · ${s.name}` : s.name}</option>
        ))}
        <option value="__new">+ New sail…</option>
      </select>
      {sailId === '__new' && (
        <input style={{ ...input, width: 150 }} placeholder="New sail name *" value={newName} onChange={(e) => setNewName(e.target.value)} />
      )}
      <button onClick={submit} disabled={busy || !file} style={{ ...btn('#06B6D4'), opacity: busy || !file ? 0.5 : 1 }}>{busy ? '…' : 'Import'}</button>
      {msg && <span style={{ fontSize: 11, color: '#10B981' }}>{msg}</span>}
      {err && <span style={{ fontSize: 11, color: '#F59E0B' }}>{err}</span>}
    </div>
  )
}

// ── One inventory row (view + inline edit) ───────────────────────────────────
export function SailRow({ sail, canEdit, busy, td, input, btn, onPatch, onCert, onDelete, onShowDesign }: any) {
  const spec = sail.specs || {}
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(sail.name)
  const [category, setCategory] = useState(sail.category || '')
  const [build, setBuild] = useState(sail.build_date || '')
  // Kind, sail type, group and weight used to be import-only: a boat whose
  // inventory was typed in by hand could never say a sail was the mainsail, and
  // the batten card and the weight-aboard total both depend on knowing.
  const [kind, setKind] = useState(sail.kind || 'other')
  const [sailType, setSailType] = useState(spec.sail_type || '')
  const [group, setGroup] = useState(spec.sail_group || '')
  const [weight, setWeight] = useState(spec.weight_kg != null ? String(spec.weight_kg) : '')
  const [retired, setRetired] = useState(!!sail.retired)
  const fileRef = React.useRef<HTMLInputElement>(null)

  // Reset the draft whenever the row is opened, so a Cancel followed by a second
  // Edit does not show what was abandoned the first time.
  const startEdit = () => {
    setName(sail.name); setCategory(sail.category || ''); setBuild(sail.build_date || '')
    setKind(sail.kind || 'other'); setSailType(spec.sail_type || '')
    setGroup(spec.sail_group || '')
    setWeight(spec.weight_kg != null ? String(spec.weight_kg) : '')
    setRetired(!!sail.retired)
    setEditing(true)
  }

  // The payload's decisions — an unparseable weight, the source marker, and
  // sending ONLY the keys this form edits — live in lib/sailEdit, where they are
  // under test. The route merges what arrives into the rest of specs.
  const save = () => {
    onPatch(sailPatchFrom(
      { name, category, buildDate: build, kind, sailType, group, weight, retired },
      spec
    ))
    setEditing(false)
  }

  const sailTypeText = spec.sail_type || '—'
  const sailGroupText = spec.sail_group || '—'
  const weightText = spec.weight_kg != null ? fmt(spec.weight_kg, 1) : '—'
  const nDesign = Array.isArray(spec.design_shapes?.conditions) ? spec.design_shapes.conditions.length : 0
  const aliases: string[] = Array.isArray(spec.aliases)
    ? spec.aliases.filter((a: unknown) => typeof a === 'string' && a.trim())
    : []

  if (editing) {
    return (
      <tr>
        <td style={td}><input style={{ ...input, width: 60 }} value={category} onChange={(e) => setCategory(e.target.value)} /></td>
        <td style={td}><input style={{ ...input, width: 150 }} value={name} onChange={(e) => setName(e.target.value)} /></td>
        <td style={td}>
          <select style={{ ...input, width: 104 }} value={kind} onChange={(e) => setKind(e.target.value)}>
            {SAIL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </td>
        <td style={td}>
          <select
            style={{ ...input, width: 150 }}
            value={SAIL_TYPES.includes(sailType) ? sailType : ''}
            onChange={(e) => {
              const t = e.target.value
              setSailType(t)
              // Type implies kind and group, so changing it moves them — but
              // both stay editable underneath, because a sail list can call
              // something a "Jib" that the crew treats as the genoa.
              if (t) {
                const k = sailKindFromType(t, group)
                setKind(k)
                if (!group) setGroup(groupForKind(k))
              }
            }}
          >
            {/* An imported type that is not one of ours must not be silently
                rewritten to "Mainsail" by a select that cannot represent it. */}
            {!SAIL_TYPES.includes(sailType) && <option value="">{sailType || '—'}</option>}
            {SAIL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </td>
        <td style={td}>
          <select style={{ ...input, width: 72 }} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">—</option>
            {SAIL_GROUPS.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}
          </select>
        </td>
        <td style={td}>
          <input
            style={{ ...input, width: 68 }} inputMode="decimal" placeholder="kg"
            value={weight} onChange={(e) => setWeight(e.target.value)}
          />
        </td>
        <td style={td}><input type="date" style={input} value={build || ''} onChange={(e) => setBuild(e.target.value)} /></td>
        <td style={td}>
          <select
            aria-label="Status"
            style={{ ...input, width: 92 }}
            value={retired ? 'retired' : 'active'}
            onChange={(e) => setRetired(e.target.value === 'retired')}
          >
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </select>
        </td>
        <td style={td} colSpan={2}>
          <button onClick={save} disabled={busy} style={btn('#10B981')}>Save</button>{' '}
          <button onClick={() => setEditing(false)} style={{ ...btn('#334155'), color: '#cbd5e1' }}>Cancel</button>
        </td>
        <td style={td}></td>
      </tr>
    )
  }
  return (
    // A retired sail is dimmed so the active fleet reads first — but not so far
    // that the row looks disabled, because its controls still work and one of
    // them is how a sail comes back.
    <tr style={{ opacity: sail.retired ? 0.75 : 1 }}>
      <td style={{ ...td, fontWeight: 700, color: '#06B6D4' }}>{sail.category || '—'}</td>
      <td style={td}>
        {sail.name}
        {/* Other names event files have used for this sail, set from the tagger
            when somebody linked a file's spelling here rather than adding a
            second sail. Shown because a link made in one place and undoable in
            none is a one-way door: "J4_A 2026" pointed at the wrong sail reads
            perfectly and is wrong everywhere. */}
        {aliases.length > 0 && (
          <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {aliases.map((a: string) => (
              <span
                key={a}
                title={`Event files calling this sail “${a}” mean this one`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: '#0F2A45', border: `1px solid ${C.border}`, borderRadius: 5,
                  fontSize: 10, color: '#8A97A9', padding: '1px 5px', fontFamily: 'ui-monospace, monospace',
                }}
              >
                {a}
                {canEdit && (
                  <button
                    onClick={() => onPatch({ specs: { aliases: aliases.filter((x: string) => x !== a) } })}
                    disabled={busy}
                    title={`Stop linking “${a}” to this sail`}
                    style={{ background: 'none', border: 'none', color: '#8A97A9', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0 }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </td>
      <td style={{ ...td, color: sail.kind === 'mainsail' ? '#2DD4BF' : undefined, fontWeight: sail.kind === 'mainsail' ? 700 : undefined }}>
        {sail.kind || '—'}
      </td>
      <td style={td}>{sailTypeText}</td>
      <td style={td}>{sailGroupText}</td>
      <td style={td}>{weightText}</td>
      <td style={td}>{sail.build_date ? new Date(sail.build_date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
      <td style={{ ...td, opacity: 1 }}>
        {canEdit ? (
          // A status that is ALSO the control for changing it. The old styling
          // was a flat grey pill on a dimmed row, which reads as a label — so
          // nobody found the one click that brings a sail back into service.
          // It now says what pressing it does, and looks pressable.
          <button
            onClick={() => onPatch({ retired: !sail.retired })}
            disabled={busy}
            title={sail.retired ? `Bring ${sail.name} back into service` : `Retire ${sail.name}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: sail.retired ? '#3A2A12' : '#10B98122',
              color: sail.retired ? '#F59E0B' : '#10B981',
              border: `1px solid ${sail.retired ? '#F59E0B66' : '#10B981'}`,
              borderRadius: 6, fontSize: 11, fontWeight: 700,
              padding: '4px 9px', cursor: busy ? 'progress' : 'pointer', minHeight: 26,
            }}
          >
            {sail.retired ? '↻ Retired' : '✓ Active'}
          </button>
        ) : (sail.retired ? 'Retired' : 'Active')}
      </td>
      <td style={td}>
        {sail.certificate_name ? <span title={sail.certificate_name}>📄 {sail.certificate_name.length > 16 ? sail.certificate_name.slice(0, 14) + '…' : sail.certificate_name}</span> : <span style={{ color: '#8A97A9' }}>—</span>}
        {canEdit && (
          <>
            {' '}
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ background: 'none', border: '1px solid #1E3A5A', color: '#06B6D4', borderRadius: 6, fontSize: 11, padding: '2px 7px', cursor: 'pointer' }}>{busy ? '…' : sail.certificate_name ? 'Replace' : 'Upload'}</button>
            <input ref={fileRef} type="file" accept=".pdf,image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onCert(f); e.target.value = '' }} />
          </>
        )}
      </td>
      <td style={td}>
        {nDesign > 0 ? (
          <button onClick={onShowDesign} style={{ background: '#0F2A45', border: `1px solid ${C.border}`, color: '#06B6D4', borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>Details ({nDesign})</button>
        ) : <span style={{ color: '#8A97A9' }}>—</span>}
      </td>
      {canEdit && (
        <td style={td}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={startEdit} disabled={busy}
              style={{ background: 'none', border: '1px solid #1E3A5A', color: '#06B6D4', borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>✎ Edit</button>
            <button onClick={onDelete} disabled={busy}
              style={{ background: '#3a1320', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>🗑</button>
          </div>
        </td>
      )}
    </tr>
  )
}
