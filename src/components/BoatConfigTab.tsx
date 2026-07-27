'use client'
// src/components/BoatConfigTab.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Boat Config — sub-tabs:
//   • Sail inventory  — SSA-owned master list of sail tags (name, build date,
//                       status, certificate). Editable by TL3+. Scans + daily
//                       configs link to these sails.
//   • Sail shapes     — structured trim-stripe scans (ingested from North).
//   • Polar           — target speed reference (design VPP, via lib/polarCalc).
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
import { useUiNext } from '../lib/ui-flags'
import BoatConfigNext from './boat/BoatConfigNext'

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
  const [view, setView] = useState<'inventory' | 'shapes' | 'rig' | 'polar' | 'log'>('inventory')
  const uiNext = useUiNext() // ?ui=next → redesigned reference screen (Phase 1)
  const [sails, setSails] = useState<Sail[]>(() => (pf?.sails as Sail[]) || [])
  const [scans, setScans] = useState<Scan[]>(() => (pf?.scans as Scan[]) || [])
  const [loading, setLoading] = useState(!pf?.sails)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string>('') // sail id being mutated
  const [polar, setPolar] = useState<any>(() => pf?.polar ?? null)          // active polar row (DB)
  const [matrixKey, setMatrixKey] = useState<'bsp' | 'heel' | 'rudder' | 'awa'>('bsp')
  const [importing, setImporting] = useState(false)
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

  const loadPolar = useCallback(() => {
    if (!teamId || !boatId) return
    fetch(`/api/teams/${teamId}/polars?boat_id=${boatId}&active=1`)
      .then((r) => (r.ok ? r.json() : { polars: [] }))
      .then((j) => setPolar((j.polars || [])[0] || null))
      .catch(() => {})
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
        {canSeeTuning && subBtn('log', 'Log profile')}
      </div>

      {err && <div style={{ color: C.warn, fontSize: 12, marginBottom: 12 }}>Error: {err}</div>}
      {loading && <div style={{ color: C.dim, fontSize: 12 }}>Loading…</div>}

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
              {(['bsp', 'heel', 'rudder', 'awa'] as const).map((k) => (
                <button key={k} onClick={() => setMatrixKey(k)} style={{
                  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', border: 'none',
                  background: matrixKey === k ? C.accent : '#0F2A45', color: matrixKey === k ? '#001018' : '#94A3B8',
                }}>{targets.matrix_meta?.[k]?.label || k}</button>
              ))}
            </div>
            <MatrixTable targets={targets} mkey={matrixKey} uploadedAt={polar?.created_at} />
          </div>
        )
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
const RIG_FIELDS: RigField[] = [
  { key: 'twsAtMh', label: 'TWS @ MH (kt)', render: (c) => (c.twsAtMh ?? '—') },
  { key: 'rakeDeg', label: 'Rake (°)', render: (c) => (c.rakeDeg != null ? fmt(c.rakeDeg, 2) : '—') },
  { key: 'mastbasePosition', label: 'Mastbase Position', render: (c) => (c.mastbasePosition ?? '—') },
  { key: 'shimStack', label: 'Shim Stack (mm)', render: (c) => (c.shimStack ?? '—') },
  { key: 'mastbaseLoadT', label: 'Mastbase (t)', render: (c) => (c.mastbaseLoadT != null ? fmt(c.mastbaseLoadT, 1) : '—') },
  { key: 'headstayT', label: 'Headstay (t)', render: (c) => (c.headstayT != null ? fmt(c.headstayT, 1) : '—') },
  { key: 'jibTackT', label: 'Jib Tack (t)', render: (c) => (c.jibTackT != null ? fmt(c.jibTackT, 1) : '—') },
  { key: 'mainCunninghamT', label: 'Main Cunningham (t)', render: (c) => (c.mainCunninghamT != null ? fmt(c.mainCunninghamT, 1) : '—') },
  { key: 'bowspritTackT', label: 'Bowsprit Tack (t)', render: (c) => (c.bowspritTackT != null ? fmt(c.bowspritTackT, 1) : '—'), reachingOnly: true },
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
const RED = '#C00000'
const RED_RGB: [number, number, number] = [192, 0, 0]

const combHSof = (c: any): string => {
  if (!c) return ''
  const a = c.headstayT; const b = c.jibTackT
  if (a == null && b == null) return ''
  return fmt((a || 0) + (b || 0), 1)
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
const twsLabel = (c: any): string => {
  const n = twsNum(c)
  if (n != null) return String(n)
  const s = String(c?.twsAtMh ?? '').trim()
  return s || '—'
}
// Mainsail 50%-height design camber (%) nearest a column's TWS, from the mainsail's
// SailScan design_shapes (conditions by TWS, sections by height %).
function main50Camber(conds: any[], twsKn: number | null): string {
  if (!Array.isArray(conds) || !conds.length || twsKn == null) return ''
  let best: any = null; let bd = Infinity
  for (const cnd of conds) {
    const tv = Number(cnd?.tws)
    if (!Number.isFinite(tv)) continue
    const d = Math.abs(tv - twsKn)
    if (d < bd) { bd = d; best = cnd }
  }
  const secs = best?.sections || best?.stripes || []
  const st = secs.find((s: any) => Math.abs(Number(s?.posPct) - 50) < 1)
  const cam = st?.camber
  return cam != null && Number.isFinite(Number(cam)) ? fmt(Number(cam) * 100, 1) : ''
}

// Rows. source: 'sheet' → read-only via get(); 'manual' → typed + saved; 'camber'
// → auto from the mainsail design. Order matches the boat's whiteboard.
type RigRow = { key: string; label: string; red?: boolean; source: 'sheet' | 'manual' | 'camber'; get?: (c: any) => string }
const UPWIND_ROWS: RigRow[] = [
  { key: 'hs', label: 'HS', source: 'sheet', get: (c) => (c?.headstayT != null ? fmt(c.headstayT, 1) : '') },
  { key: 'combHS', label: 'HS + Tack', red: true, source: 'sheet', get: (c) => combHSof(c) },
  { key: 'shims', label: 'Shim', source: 'sheet', get: (c) => (c?.shimStack ?? '') },
  { key: 'buttPos', label: 'Butt position', source: 'sheet', get: (c) => (c?.mastbasePosition ?? '') },
  { key: 'mainCun', label: 'Main Cun', source: 'manual' },
  { key: 'main50', label: 'Main 50% camber', source: 'camber' },
  { key: 'upDefl', label: 'Up Def %', source: 'sheet', get: (c) => (c?.upperDeflectorCylStroke ?? '') },
  { key: 'lowDefl', label: 'Low Def %', source: 'sheet', get: (c) => (c?.lowerDeflectorCylStroke ?? '') },
  { key: 'vang', label: 'Vang', source: 'manual' },
]
const REACHING_ROWS: RigRow[] = [
  { key: 'hs', label: 'HS', red: true, source: 'sheet', get: (c) => (c?.headstayT != null ? fmt(c.headstayT, 1) : '') },
  { key: 'bobstay', label: 'Bobstay', source: 'manual' },
  { key: 'spritTack', label: 'Sprit tack', source: 'sheet', get: (c) => (c?.bowspritTackT != null ? fmt(c.bowspritTackT, 1) : '') },
  { key: 'gsTack', label: 'GS tack', source: 'sheet', get: (c) => (c?.gsTackT != null ? fmt(c.gsTackT, 1) : '') },
  { key: 'shims', label: 'Shim', source: 'sheet', get: (c) => (c?.shimStack ?? '') },
  { key: 'buttPos', label: 'Butt position', source: 'sheet', get: (c) => (c?.mastbasePosition ?? '') },
  { key: 'upDefl', label: 'Up Def %', source: 'sheet', get: (c) => (c?.upperDeflectorCylStroke ?? '') },
  { key: 'lowDefl', label: 'Low Def %', source: 'sheet', get: (c) => (c?.lowerDeflectorCylStroke ?? '') },
]
const MANUAL_KEYS = ['mainCun', 'vang', 'bobstay']

// Saved overlay: per section, per display-column index, the hand-entered rows.
type ManualCell = Record<string, string>
type RigSettings = { upwind: Record<string, ManualCell>; reaching: Record<string, ManualCell>; downwind: Record<string, ManualCell> }
const emptySettings = (): RigSettings => ({ upwind: {}, reaching: {}, downwind: {} })
function normSettings(raw: any): RigSettings {
  const out = emptySettings()
  for (const sec of ['upwind', 'reaching'] as const) {
    const s = raw?.[sec]
    if (!s || typeof s !== 'object') continue
    for (const [k, v] of Object.entries(s)) {
      if (!v || typeof v !== 'object') continue
      const cell: ManualCell = {}
      for (const mk of MANUAL_KEYS) { const val = (v as any)[mk]; if (typeof val === 'string' && val) cell[mk] = val }
      if (Object.keys(cell).length) out[sec][k] = cell
    }
  }
  const dw = raw?.downwind
  if (dw && typeof dw === 'object') {
    for (const [k, v] of Object.entries(dw)) if (v && typeof v === 'object') out.downwind[k] = { ...(v as any) }
  }
  return out
}

const COL_BLUE = '#BDD7EE'
const COL_BLUE_RGB: [number, number, number] = [189, 215, 238]
const DWD_BG = '#DDF0E4'
const DWD_RGB: [number, number, number] = [221, 240, 228]
// Downwind is its OWN small crib — TWS rows x (Up/Low deflector + HS), seeded
// from the boat's whiteboard, editable + saved like the rest.
const DWD_TWS = ['8', '10', '12', '15', '20']
const DWD_ROWS: { key: string; label: string }[] = [
  { key: 'upDefl', label: 'Up Defl' },
  { key: 'lowDefl', label: 'Low Defl' },
  { key: 'hs', label: 'HS' },
]
const DWD_DEFAULTS: Record<string, Record<string, string>> = {
  '8': { upDefl: '70', lowDefl: '90', hs: '3' },
  '10': { upDefl: '50', lowDefl: '70', hs: '3.5' },
  '12': { upDefl: '40', lowDefl: '65', hs: '4' },
  '15': { upDefl: '30', lowDefl: '60', hs: '5' },
  '20': { upDefl: '5', lowDefl: '15', hs: '6.5' },
}
const colBg = (c: any, i: number) => (c?.section === 'downwind' ? DWD_BG : (i % 2 === 0 ? COL_BLUE : '#FFFFFF'))
const colRgb = (c: any, i: number): [number, number, number] => (c?.section === 'downwind' ? DWD_RGB : (i % 2 === 0 ? COL_BLUE_RGB : [255, 255, 255]))

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

function RigSettingsTables({ rigTune, teamId, canEdit, boatName, sails }: {
  rigTune: any; teamId: string; canEdit: boolean; boatName?: string | null; sails?: any[]
}) {
  const cols: any[] = Array.isArray(rigTune?.data?.columns) ? rigTune.data.columns : []
  const upCols = sectionCols(cols, 'upwind')
  const reachCols = sectionCols(cols, 'reaching')
  const colsFor = (sec: 'upwind' | 'reaching') => (sec === 'upwind' ? upCols : reachCols)

  const mainConds: any[] = React.useMemo(() => {
    const main = (sails || []).find((s: any) => s?.kind === 'mainsail' || /^(MAIN|MN)\b/i.test(s?.category || s?.name || ''))
    return Array.isArray(main?.specs?.design_shapes?.conditions) ? main.specs.design_shapes.conditions : []
  }, [sails])

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
  const cellValue = (sec: 'upwind' | 'reaching', row: RigRow, col: any, colIdx: number): string => {
    if (row.source === 'manual') return tbl[sec]?.[String(colIdx)]?.[row.key] ?? ''
    if (row.source === 'camber') return main50Camber(mainConds, twsNum(col))
    return row.get ? row.get(col) : ''
  }

  const dwdVal = (tws: string, key: string): string => (tbl.downwind?.[tws]?.[key] ?? (DWD_DEFAULTS[tws]?.[key] ?? ''))
  const setDwd = (tws: string, key: string, val: string) => {
    setTbl((p) => ({ ...p, downwind: { ...p.downwind, [tws]: { ...(p.downwind?.[tws] || {}), [key]: val } } }))
    setDirty(true); setMsg('')
  }

  const save = async () => {
    if (!rigTune?.id) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/teams/${teamId}/rig-tunes/${rigTune.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsTable: tbl, settingsNotes: noteDraft.trim() || null }),
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

  const downloadPdf = async () => {
    setPdfBusy(true)
    try {
      const JsPDF = await loadJsPdf()
      const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const M = 12; let y = 16
      doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.setTextColor(20)
      doc.text([boatName, 'Rig settings'].filter(Boolean).join(' — '), M, y); y += 6
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90)
      doc.text([rigTune?.name, rigTune?.revision ? `Rev ${rigTune.revision}` : '', rigTune?.effective_date ? `effective ${rigTune.effective_date}` : ''].filter(Boolean).join('   ·   '), M, y); y += 4.5
      const stampNotes = viewing ? viewing.notes : savedNotes
      doc.text(`Settings as saved ${fmtWhen(viewing ? viewing.saved_at : savedAt)}${viewing ? '  (historical version)' : ''}`, M, y); y += 4.5
      if (stampNotes) {
        doc.setFontSize(8)
        for (const ln of doc.splitTextToSize(`Notes: ${stampNotes}`, 180).slice(0, 3)) { doc.text(ln, M, y); y += 3.6 }
        doc.setFontSize(9)
      }
      y += 3
      const LABEL_W = 22
      const TABLE_W = 130 // 13 cm — the laminated-card print width
      const block = (title: string, sec: 'upwind' | 'reaching', rows: RigRow[], tableW = TABLE_W) => {
        const dcols = colsFor(sec)
        const nCols = Math.max(dcols.length, 1)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20)
        doc.text(title, M, y); y += 4
        const rowH = 50 / (rows.length + 1) // table ~5 cm tall
        const colW = (tableW - LABEL_W) / nCols
        const baseline = rowH * 0.68
        const FS = 6.5
        doc.setDrawColor(90); doc.setLineWidth(0.15)
        const fitText = (v: string, cx: number, cy: number, maxW: number) => {
          doc.setFontSize(FS)
          const w = doc.getTextWidth(v)
          if (w > maxW) doc.setFontSize(Math.max(3.2, (FS * maxW) / w))
          doc.text(v, cx, cy, { align: 'center' })
          doc.setFontSize(FS)
        }
        const line = (label: string, vals: string[], bold: boolean, red = false) => {
          doc.setFont('helvetica', 'bold')
          doc.setFillColor(238, 243, 248); doc.rect(M, y, LABEL_W, rowH, 'FD')
          doc.setTextColor(...(red ? RED_RGB : ([20, 20, 20] as [number, number, number])))
          doc.setFontSize(FS); doc.text(label, M + 1, y + baseline)
          doc.setFont('helvetica', bold || red ? 'bold' : 'normal')
          let x = M + LABEL_W
          vals.forEach((v, i) => {
            const rgb = colRgb(dcols[i], i)
            doc.setFillColor(rgb[0], rgb[1], rgb[2])
            doc.rect(x, y, colW, rowH, 'FD')
            fitText(v || '—', x + colW / 2, y + baseline, colW - 1.2)
            x += colW
          })
          doc.setTextColor(20)
          y += rowH
        }
        line('TWS', dcols.map((c) => twsLabel(c)), true)
        for (const r of rows) line(r.label, dcols.map((c, i) => cellValue(sec, r, c, i)), false, !!r.red)
        y += 6
      }
      block('Upwind', 'upwind', UPWIND_ROWS)
      y += 12 // triple the vertical gap before the reaching + downwind row
      // Reaching + Downwind share ONE 13 cm row: reaching left, downwind right,
      // together (incl. the gap) exactly TABLE_W wide.
      const DW_GAP = 5, DW_COLW = 10, DW_W = DW_COLW * 4, REACH_W = TABLE_W - DW_GAP - DW_W
      const yReachTop = y
      block('Reaching', 'reaching', REACHING_ROWS, REACH_W)
      // Downwind — printed to the RIGHT of Reaching, on the same top axis (uses its
      // own local dy so it doesn't push the page cursor down).
      {
        const dwX = M + REACH_W + DW_GAP
        let dy = yReachTop
        const dwColW = DW_COLW, dwRowH = 50 / (DWD_TWS.length + 1), dwBase = dwRowH * 0.68
        const dwLabels = ['TWS', 'Up', 'Low', 'HS']
        const dwKeys = ['upDefl', 'lowDefl', 'hs']
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20)
        doc.text('Downwind', dwX, dy); dy += 4
        doc.setFontSize(6.5); doc.setDrawColor(90); doc.setLineWidth(0.15)
        let hx = dwX
        for (const lab of dwLabels) {
          doc.setFillColor(DWD_RGB[0], DWD_RGB[1], DWD_RGB[2]); doc.rect(hx, dy, dwColW, dwRowH, 'FD')
          doc.setFont('helvetica', 'bold'); doc.setTextColor(...(lab === 'HS' ? RED_RGB : ([20, 20, 20] as [number, number, number]))); doc.text(lab, hx + dwColW / 2, dy + dwBase, { align: 'center' }); hx += dwColW
        }
        dy += dwRowH
        for (const tws of DWD_TWS) {
          let cx = dwX
          const vals = [tws, ...dwKeys.map((k) => dwdVal(tws, k))]
          vals.forEach((v, ci) => {
            doc.setFillColor(DWD_RGB[0], DWD_RGB[1], DWD_RGB[2]); doc.rect(cx, dy, dwColW, dwRowH, 'FD')
            doc.setFont('helvetica', (ci === 0 || ci === 3) ? 'bold' : 'normal'); doc.setTextColor(...(ci === 3 ? RED_RGB : ([20, 20, 20] as [number, number, number])))
            doc.text(String(v || '-'), cx + dwColW / 2, dy + dwBase, { align: 'center' }); cx += dwColW
          })
          dy += dwRowH
        }
      }
      const name = `Rig_settings_${[boatName, rigTune?.revision].filter(Boolean).join('_').replace(/[^\w.-]+/g, '_') || 'sheet'}.pdf`
      doc.save(name)
    } catch (e: any) { setMsg('Could not build the PDF: ' + (e?.message || e)) }
    finally { setPdfBusy(false) }
  }

  const th: React.CSSProperties = { padding: '5px 6px', fontSize: 11, fontWeight: 700, color: '#0b1f33', border: '1px solid #d7e2ee', textAlign: 'center', whiteSpace: 'nowrap' }
  const rh: React.CSSProperties = { padding: '5px 10px', fontSize: 11, fontWeight: 700, color: '#0b1f33', textAlign: 'left', border: '1px solid #d7e2ee', background: '#eef3f8', whiteSpace: 'nowrap', position: 'sticky', left: 0 }
  const cellStyle: React.CSSProperties = { border: '1px solid #d7e2ee', padding: 0 }
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', textAlign: 'center', fontSize: 12, color: '#0b1f33', padding: '5px 3px', fontFamily: 'inherit', textOverflow: 'ellipsis' }
  const LABEL_PX = 120, COL_PX = 78

  const Table = ({ title, sec, rows }: { title: string; sec: 'upwind' | 'reaching'; rows: RigRow[] }) => {
    const dcols = colsFor(sec)
    if (!dcols.length) return (
      <div style={{ background: '#fff', borderRadius: 8, padding: 8, color: '#64748b', fontSize: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#0b1f33', paddingBottom: 6 }}>{title}</div>
        No {sec} columns on the parsed sheet.
      </div>
    )
    return (
      <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#0b1f33', padding: '2px 4px 8px' }}>{title}</div>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: LABEL_PX + COL_PX * dcols.length }}>
          <colgroup>
            <col style={{ width: LABEL_PX }} />
            {dcols.map((c, i) => <col key={i} style={{ width: COL_PX }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...rh, background: '#dde6ef' }}>TWS</th>
              {dcols.map((c, i) => (
                <th key={i} style={{ ...th, background: colBg(c, i) }}>
                  <div>{twsLabel(c)}</div>
                  {c?.headsail ? <div style={{ fontSize: 9, fontWeight: 400, color: '#4b5c6b' }}>{c.headsail}</div> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={{ ...rh, ...(r.red ? { color: RED } : null) }}>{r.label}</td>
                {dcols.map((c, i) => {
                  const editable = edit && r.source === 'manual'
                  return (
                    <td key={i} style={{ ...cellStyle, background: colBg(c, i) }}>
                      <input
                        style={{ ...inputStyle, ...(r.red ? { color: RED, fontWeight: 700 } : null) }}
                        value={cellValue(sec, r, c, i)} readOnly={!editable}
                        placeholder={r.source === 'manual' ? '—' : ''}
                        onChange={(e) => setCell(sec, i, r.key, e.target.value)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const DownwindTable = () => (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#0b1f33', padding: '2px 4px 8px' }}>Downwind</div>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: LABEL_PX + COL_PX * DWD_ROWS.length }}>
        <colgroup>
          <col style={{ width: LABEL_PX }} />
          {DWD_ROWS.map((r) => <col key={r.key} style={{ width: COL_PX }} />)}
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...rh, background: DWD_BG }}>TWS</th>
            {DWD_ROWS.map((r) => <th key={r.key} style={{ ...th, background: DWD_BG, ...(r.key === 'hs' ? { color: RED } : null) }}>{r.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {DWD_TWS.map((tws) => (
            <tr key={tws}>
              <td style={{ ...rh, background: DWD_BG }}>{tws}</td>
              {DWD_ROWS.map((r) => (
                <td key={r.key} style={{ ...cellStyle, background: DWD_BG }}>
                  <input style={{ ...inputStyle, ...(r.key === 'hs' ? { color: RED, fontWeight: 700 } : null) }} value={dwdVal(tws, r.key)} readOnly={!edit} onChange={(e) => setDwd(tws, r.key, e.target.value)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: C.head }}>Rig settings by TWS</span>
        <span style={{ fontSize: 10, color: C.dim }}>
          {viewing ? `history · saved ${fmtWhen(viewing.saved_at)}` : savedAt ? `manual rows saved ${fmtWhen(savedAt)}` : 'sheet rows live · manual rows not saved'}
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
      {edit ? <div style={{ fontSize: 11, color: C.dim }}>Sheet rows (HS, Shim, Butt, deflectors, Sprit tack) are read-only from the rig sheet. Editable: Main Cun, Vang, Bobstay, GS tack. Main 50% camber auto-fills from the mainsail design.</div> : null}

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

      <Table title="Upwind" sec="upwind" rows={UPWIND_ROWS} />
      <Table title="Reaching" sec="reaching" rows={REACHING_ROWS} />
      <DownwindTable />
    </div>
  )
}

function RigSubTable({ cols, heading }: { cols: any[]; heading: string }) {
  if (!cols.length) return null
  // Drop reaching-only fields when the block is upwind.
  const isUpwindOnly = cols.every((c) => c.section === 'upwind')
  const fields = RIG_FIELDS.filter((f) => !(f.reachingOnly && isUpwindOnly))
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
  const reachDown = cols.filter((c) => c.section !== 'upwind')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <RigSubTable cols={upwind} heading="Upwind" />
      <RigSubTable cols={reachDown} heading="Reaching / Downwind" />
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
function SailRow({ sail, canEdit, busy, td, input, btn, onPatch, onCert, onDelete, onShowDesign }: any) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(sail.name)
  const [category, setCategory] = useState(sail.category || '')
  const [build, setBuild] = useState(sail.build_date || '')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const save = () => { onPatch({ name: name.trim(), category: category.trim() || null, build_date: build || null }); setEditing(false) }

  const spec = sail.specs || {}
  const sailType = spec.sail_type || '—'
  const sailGroup = spec.sail_group || '—'
  const weight = spec.weight_kg != null ? fmt(spec.weight_kg, 1) : '—'
  const nDesign = Array.isArray(spec.design_shapes?.conditions) ? spec.design_shapes.conditions.length : 0

  if (editing) {
    return (
      <tr>
        <td style={td}><input style={{ ...input, width: 60 }} value={category} onChange={(e) => setCategory(e.target.value)} /></td>
        <td style={td}><input style={{ ...input, width: 150 }} value={name} onChange={(e) => setName(e.target.value)} /></td>
        <td style={td}>{sail.kind || '—'}</td>
        <td style={td}>{sailType}</td>
        <td style={td}>{sailGroup}</td>
        <td style={td}>{weight}</td>
        <td style={td}><input type="date" style={input} value={build || ''} onChange={(e) => setBuild(e.target.value)} /></td>
        <td style={td} colSpan={2}>
          <button onClick={save} disabled={busy} style={btn('#10B981')}>Save</button>{' '}
          <button onClick={() => setEditing(false)} style={{ ...btn('#334155'), color: '#cbd5e1' }}>Cancel</button>
        </td>
        <td style={td}></td>
        <td style={td}></td>
      </tr>
    )
  }
  return (
    <tr style={{ opacity: sail.retired ? 0.55 : 1 }}>
      <td style={{ ...td, fontWeight: 700, color: '#06B6D4' }}>{sail.category || '—'}</td>
      <td style={td}>{sail.name}</td>
      <td style={td}>{sail.kind || '—'}</td>
      <td style={td}>{sailType}</td>
      <td style={td}>{sailGroup}</td>
      <td style={td}>{weight}</td>
      <td style={td}>{sail.build_date ? new Date(sail.build_date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
      <td style={td}>
        {canEdit ? (
          <button onClick={() => onPatch({ retired: !sail.retired })} disabled={busy}
            style={{ background: sail.retired ? '#334155' : '#10B98122', color: sail.retired ? '#94A3B8' : '#10B981', border: `1px solid ${sail.retired ? '#334155' : '#10B981'}`, borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>
            {sail.retired ? 'Retired' : 'Active'}
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
            <button onClick={() => setEditing(true)} disabled={busy}
              style={{ background: 'none', border: '1px solid #1E3A5A', color: '#06B6D4', borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>✎ Edit</button>
            <button onClick={onDelete} disabled={busy}
              style={{ background: '#3a1320', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>🗑</button>
          </div>
        </td>
      )}
    </tr>
  )
}
