'use client'
// src/components/boat/SailMediaPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// One sail's media, by wind band: TWS down the side, SailScans · SailTrim ·
// 360 video · Photos · Videos across. What belongs here is worked out server-side
// from when each was taken (lib/sailMedia), so nobody tags a photo with a sail.
//
// A season is thousands of frames, so a cell shows its newest few and says how
// many more there are. The count is the point; the whole pile is one click away.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { getPref, setPref } from '@/lib/prefsStore'
import { FavouriteHeart, FavouritesFilterButton } from '@/components/FavouriteHeart'
import { useFavourites } from '@/lib/favourites'
import { FallbackVideoPlayer } from '@/components/timeline/DayMedia'
import PhotoLightbox, { type LightboxPhoto } from '@/components/timeline/PhotoLightbox'
import SailScanDetail from '@/components/SailScanDetail'
import { isAnnotation, annotationHeadline } from '@/lib/sailTrimOverlay'
import { savePhotoSailTrim, type PhotoRow, type SailTrimPayload } from '@/lib/savePhotoSailTrim'
import { SAIL_MEDIA_KINDS, allTwsBands, twsBand, type SailMediaItem, type SailMediaKind } from '@/lib/sailMedia'

const C = {
  bg: '#04101c', card: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  text: '#cbd5e1', dim: '#8A97A9', head: '#e2e8f0', warn: '#F59E0B',
}
const PER_CELL = 4

/** This machine's "don't ask again" for the ✕ — a UI preference, so it lives in
 *  ssa-prefs (lib/prefsStore), never in ssa-db: see CLAUDE.md on DB_VER. */
const SKIP_HIDE_CONFIRM_PREF = 'sailMedia.skipHideConfirm'

// The same digitiser the timeline opens, on demand — it is big and brings its
// own CDN libraries, and most people looking at a sail never measure one.
const SailGeometryDialog = dynamic(() => import('@/components/photos/SailGeometryDialog'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-[#7DD3FC]">Loading the digitiser…</div>,
})

/**
 * A photo as the timeline's lightbox and digitiser take it — built from the
 * FULL row, exactly as DayTimeline builds its MediaItem. The grid only carries
 * a few keys of each photo; measuring has to write the whole row back
 * (lib/savePhotoSailTrim), so the row is fetched when a photo is opened.
 */
interface OpenPhoto extends LightboxPhoto {
  date: string | null
  twa: number | null
  raw: PhotoRow | null
}

function fromRow(p: any, date: string | null): OpenPhoto {
  const a = p.analysis_data || {}, inst = a.inst || {}
  const sails = a.sails ?? inst.sails ?? []
  const st = a.sailTrim && isAnnotation(a.sailTrim.annotation) ? a.sailTrim : null
  return {
    id: p.id, thumb: p.thumbnail_url, original: p.original_url || null, inst: { ...inst, sails },
    sailTrim: st, subjectBoatIds: p.subject_boat_ids ?? [], twa: inst.twa ?? null, date, raw: p,
  }
}

type Item = SailMediaItem & { scan?: any; photo?: LightboxPhoto & { inst?: any } }
interface Payload { items: Item[]; events: string[]; taggedDays: number; days: number }
interface SailOpt { id: string; name: string; category?: string | null; retired?: boolean }

const sailLabel = (s: SailOpt) => (s.category ? `${s.category} · ${s.name}` : s.name)
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`
const shortDate = (d: string | null) =>
  d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : '—'

export default function SailMediaPanel({ teamId, boatId, sails, sailId, onSailChange, onBack, onOpenVideo, canEdit = false, onMediaChanged, sessionTzOffset = 0, isMobile }: {
  teamId: string
  /** The boat the photo rows belong to — needed to read and save them. */
  boatId: string
  /** The app's own player — the one the timeline opens, with the instrument
   *  overlay. Absent only outside the app shell (the /dev preview), where the
   *  bare fallback player stands in. */
  onOpenVideo?: (date: string, videoId: string) => void
  sails: SailOpt[]
  sailId: string
  onSailChange: (id: string) => void
  onBack: () => void
  /** May mark photos and videos not relevant to the sail (the sails RLS: TL3+). */
  canEdit?: boolean
  /** A mark changed the sail's counts — the inventory's Media button re-counts. */
  onMediaChanged?: () => void
  sessionTzOffset?: number
  isMobile?: boolean
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [event, setEvent] = useState<string>('')          // '' = every event
  const [showEmpty, setShowEmpty] = useState(false)
  const [showHidden, setShowHidden] = useState(false)       // bring back what was marked not relevant
  const [favOnly, setFavOnly] = useState(false)             // ♥ — only my favourites
  const favs = useFavourites()
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [confirmFor, setConfirmFor] = useState<Item | null>(null) // the ✕ waiting on "are you sure?"
  const [dontAsk, setDontAsk] = useState(false)                   // the dialog's tick box
  const [skipConfirm, setSkipConfirm] = useState(false)           // ticked once, remembered here
  useEffect(() => {
    let alive = true
    getPref(SKIP_HIDE_CONFIRM_PREF).then((v: unknown) => { if (alive && v === true) setSkipConfirm(true) })
    return () => { alive = false }
  }, [])

  // ✕ asks first, unless this machine said not to. ↺ (bringing one back) never asks.
  const askHide = (i: Item) => {
    if (skipConfirm) { setHidden(i, true); return }
    setDontAsk(false)
    setConfirmFor(i)
  }
  const confirmHide = () => {
    const i = confirmFor
    setConfirmFor(null)
    if (!i) return
    if (dontAsk) { setSkipConfirm(true); setPref(SKIP_HIDE_CONFIRM_PREF, true) }
    setHidden(i, true)
  }
  const [open, setOpen] = useState<Set<string>>(new Set()) // expanded cells
  const [photo, setPhoto] = useState<OpenPhoto | null>(null)
  const [geomFor, setGeomFor] = useState<OpenPhoto | null>(null)
  // date → that day's full photo rows, as the photos route returns them.
  const dayRows = useRef(new Map<string, Promise<any[]>>())
  const [video, setVideo] = useState<Item | null>(null)
  const [scan, setScan] = useState<Item | null>(null)

  useEffect(() => {
    if (!sailId) return
    let alive = true
    setData(null); setErr(''); setOpen(new Set()); setEvent(''); setShowHidden(false)
    fetch(`/api/teams/${teamId}/sails/${sailId}/media`)
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j) })
      .catch((e) => alive && setErr(String(e)))
    return () => { alive = false }
  }, [teamId, sailId])

  const inEvent = useMemo(
    () => (data?.items || []).filter((i) => !event || (event === '(none)' ? !i.event : i.event === event)),
    [data, event]
  )
  const favKind = (i: Item) => (i.kind === 'photo' || i.kind === 'trim' ? 'photo' : i.kind === 'scan' ? null : 'video')
  const shown = useMemo(
    () => inEvent.filter((i) => (showHidden || !i.hidden) && (!favOnly || (favKind(i) != null && favs.has(favKind(i)!, i.id)))),
    [inEvent, showHidden, favOnly, favs] // eslint-disable-line react-hooks/exhaustive-deps
  )
  // Distinct photos/clips marked not relevant — a clip spans several bands but is one mark.
  const hiddenCount = useMemo(() => new Set(inEvent.filter((i) => i.hidden).map((i) => i.id)).size, [inEvent])

  // Mark one photo or clip not relevant to this sail, or bring it back. Every
  // entry of a clip goes together: the mark is on the clip, not on one band.
  const setHidden = async (i: Item, hidden: boolean) => {
    const flip = (h: boolean) => setData((d) => d && ({ ...d, items: d.items.map((it) => (it.id === i.id && it.kind !== 'scan' ? { ...it, hidden: h } : it)) }))
    setBusyIds((b) => new Set(b).add(i.id))
    flip(hidden)
    try {
      const r = await fetch(`/api/teams/${teamId}/sails/${sailId}/media/hidden`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id, hidden }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onMediaChanged?.()
    } catch (e) {
      flip(!hidden)
      setErr(`Could not ${hidden ? 'hide' : 'restore'} that — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyIds((b) => { const n = new Set(b); n.delete(i.id); return n })
    }
  }

  // band key → kind → items (newest first, as the server sends them)
  const grid = useMemo(() => {
    const g = new Map<string, Map<SailMediaKind, Item[]>>()
    for (const i of shown) {
      const b = twsBand(i.tws).key
      if (!g.has(b)) g.set(b, new Map())
      const row = g.get(b)!
      if (!row.has(i.kind)) row.set(i.kind, [])
      row.get(i.kind)!.push(i)
    }
    return g
  }, [shown])

  const bands = useMemo(() => {
    const all = [...allTwsBands(), twsBand(null)]
    if (showEmpty) return all
    return all.filter((b) => grid.has(b.key))
  }, [grid, showEmpty])

  const totals = useMemo(() => {
    const t: Record<string, number> = {}
    // Relevant ones only, whether or not the hidden are on show — the same
    // number the inventory's Media button gives.
    for (const i of shown) if (!i.hidden) t[i.kind] = (t[i.kind] || 0) + 1
    return t
  }, [shown])

  // Open at once on what the grid has, then swap in the full row: the original,
  // the whole instrument overlay and the measurement, as the timeline shows it.
  const openPhoto = (i: Item) => {
    const lite: OpenPhoto = { ...(i.photo || {}), id: i.id, date: i.date, twa: null, raw: null }
    setPhoto(lite)
    if (!i.date || !boatId) return
    const date = i.date
    let rows = dayRows.current.get(date)
    if (!rows) {
      rows = fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`)
        .then((r) => r.json()).then((j) => (Array.isArray(j?.photos) ? j.photos : []))
        .catch(() => { dayRows.current.delete(date); return [] })
      dayRows.current.set(date, rows)
    }
    rows.then((list) => {
      const row = list.find((p: any) => p.id === i.id)
      if (row) setPhoto((cur) => (cur && cur.id === i.id ? fromRow(row, date) : cur))
    })
  }

  // Measuring writes to the SAME shared row the timeline and the Photos tab
  // write to. A photo measured here moves to the SailTrim column.
  const applyGeometry = useCallback(async (m: OpenPhoto, payload: SailTrimPayload) => {
    if (!m.raw) throw new Error('This photo is still loading — try again in a moment.')
    await savePhotoSailTrim({ teamId, boatId, row: m.raw, payload, sessionDate: m.date })
    const raw = { ...m.raw, analysis_data: { ...(m.raw.analysis_data || {}), sailTrim: payload } }
    const next: OpenPhoto = { ...m, sailTrim: payload, raw }
    setPhoto((p) => (p && p.id === m.id ? next : p))
    setGeomFor((g) => (g && g.id === m.id ? next : g))
    const r = dayRows.current.get(m.date || '')
    if (r) dayRows.current.set(m.date || '', r.then((list) => list.map((p: any) => (p.id === m.id ? raw : p))))
    setData((d) => d && ({
      ...d,
      items: d.items.map((it) => (it.id === m.id && (it.kind === 'photo' || it.kind === 'trim')
        ? { ...it, kind: 'trim' as const, photo: { ...(it.photo || {}), sailTrim: payload } as Item['photo'] }
        : it)),
    }))
  }, [teamId, boatId])

  const toggleGeometryOverlay = useCallback((m: OpenPhoto) => {
    if (!m.sailTrim) return
    applyGeometry(m, { ...m.sailTrim, overlay: !m.sailTrim.overlay } as SailTrimPayload).catch(() => { /* the row keeps what it had */ })
  }, [applyGeometry])

  const openItem = (i: Item) => {
    if (i.kind === 'scan') setScan(i)
    else if (i.kind === 'photo' || i.kind === 'trim') openPhoto(i)
    else if (onOpenVideo && i.date) onOpenVideo(i.date, i.id)
    else setVideo(i)
  }

  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: C.dim, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: 6, verticalAlign: 'top', borderBottom: `1px solid #0d2236` }
  const input: React.CSSProperties = { background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '4px 6px', fontSize: 12 }
  const chip = (on: boolean): React.CSSProperties => ({
    fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', border: 'none',
    background: on ? C.accent : '#0F2A45', color: on ? '#001018' : '#94A3B8',
  })
  const thumbW = isMobile ? 64 : 88

  // A render function, not a component: defined in here, a component would be a
  // new type every render and every thumbnail would remount (and refetch).
  const thumb = (i: Item) => {
    const isVideo = i.kind === 'video' || i.kind === 'video360'
    const caption = [shortDate(i.date), i.tws != null ? `${i.tws.toFixed(1)} kn` : null].filter(Boolean).join(' · ')
    // Scans are filed to a sail and refiled in their detail view — not hidden.
    const canHide = canEdit && i.kind !== 'scan'
    const busy = busyIds.has(i.id)
    return (
      <div key={`${i.kind}:${i.id}:${i.startSec ?? ''}`} style={{ position: 'relative', opacity: i.hidden ? 0.45 : 1 }}>
      <button
        onClick={() => openItem(i)}
        title={[i.title, i.event, caption, isVideo && i.durSec ? `${mmss(i.durSec)} on this sail in this band` : null].filter(Boolean).join(' — ')}
        style={{ width: thumbW, boxSizing: 'border-box', padding: 0, border: `1px solid ${C.border}`, borderRadius: 6, background: '#0a1c2e', cursor: 'pointer', overflow: 'hidden', textAlign: 'left' }}
      >
        <div style={{ position: 'relative', width: '100%', aspectRatio: isVideo && i.kind === 'video360' ? '2 / 1' : '4 / 3', background: '#000' }}>
          {i.thumb
            ? <img src={i.thumb} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: C.dim, fontSize: 10 }}>no image</div>}
          {isVideo && (
            <span style={{ position: 'absolute', left: 3, bottom: 3, fontSize: 9, fontWeight: 700, color: '#fff', background: 'rgba(0,0,0,0.65)', borderRadius: 3, padding: '0 4px' }}>
              ▶{i.durSec ? ` ${mmss(i.durSec)}` : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 9, color: C.dim, padding: '2px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.hidden ? 'not relevant' : caption}</div>
      </button>
      {/* My favourite, top left over the picture. Not on scans. */}
      {favKind(i) && <FavouriteHeart kind={favKind(i)!} id={i.id} size={10} style={{ position: 'absolute', top: 2, left: 2 }} />}
      {/* A sibling of the thumbnail, not inside it: a button in a button is
          invalid, and the click would open the photo as well. */}
      {canHide && (
        <button
          onClick={() => (i.hidden ? setHidden(i, false) : askHide(i))}
          disabled={busy}
          title={i.hidden ? `Show this ${isVideo ? 'clip' : 'photo'} for ${sail ? sailLabel(sail) : 'this sail'} again` : `Not relevant to ${sail ? sailLabel(sail) : 'this sail'} — hide it here`}
          aria-label={i.hidden ? 'Restore' : 'Not relevant'}
          style={{
            position: 'absolute', top: 2, right: 2, width: 20, height: 20, padding: 0, lineHeight: '18px',
            borderRadius: 10, border: `1px solid ${i.hidden ? C.accent : 'rgba(255,255,255,0.35)'}`,
            background: 'rgba(3,15,26,0.8)', color: i.hidden ? C.accent : '#e2e8f0',
            fontSize: 11, fontWeight: 700, cursor: busy ? 'progress' : 'pointer', opacity: 1,
          }}
        >{i.hidden ? '↺' : '✕'}</button>
      )}
      </div>
    )
  }

  const sail = sails.find((s) => s.id === sailId)

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <button onClick={onBack} style={{ ...chip(false), background: 'none', border: `1px solid ${C.border}`, color: C.accent }}>← Sail inventory</button>
        <select value={sailId} onChange={(e) => onSailChange(e.target.value)} style={{ ...input, fontWeight: 700, minWidth: 180 }}>
          {sails.map((s) => <option key={s.id} value={s.id}>{sailLabel(s)}{s.retired ? ' (retired)' : ''}</option>)}
        </select>
        {data && (
          <span style={{ fontSize: 11, color: C.dim }}>
            {shown.filter((i) => !i.hidden).length} item{shown.filter((i) => !i.hidden).length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {data && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: C.dim, marginRight: 2 }}>Event</span>
          <button onClick={() => setEvent('')} style={chip(event === '')}>All</button>
          {data.events.map((e) => <button key={e} onClick={() => setEvent(e)} style={chip(event === e)}>{e}</button>)}
          {data.items.some((i) => !i.event) && <button onClick={() => setEvent('(none)')} style={chip(event === '(none)')}>Training / no event</button>}
          <FavouritesFilterButton on={favOnly} onToggle={() => setFavOnly((v) => !v)} style={{ marginLeft: 'auto' }} />
          {hiddenCount > 0 && (
            <button onClick={() => setShowHidden((v) => !v)} style={chip(showHidden)}
              title="Photos and clips marked not relevant to this sail — shown dimmed, with ↺ to bring them back">
              {showHidden ? 'Hide' : 'Show'} not relevant ({hiddenCount})
            </button>
          )}
          <label style={{ marginLeft: 8, fontSize: 11, color: C.dim, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> show empty bands
          </label>
        </div>
      )}

      {err && <div style={{ color: C.warn, fontSize: 12 }}>Error: {err}</div>}
      {!data && !err && <div style={{ color: C.dim, fontSize: 12 }}>Loading {sail ? sailLabel(sail) : 'sail'} media…</div>}
      {data && shown.length === 0 && (
        <div style={{ color: C.dim, fontSize: 12 }}>
          Nothing found for {sail ? sailLabel(sail) : 'this sail'}{event ? ' at this event' : ''}. Media is matched to a sail by the time it was taken,
          so it needs a sail-change tag, an event file with sails, or a scan filed to the sail.
        </div>
      )}

      {data && shown.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...th, position: 'sticky', left: 0, background: C.bg, zIndex: 1 }}>TWS</th>
                {SAIL_MEDIA_KINDS.map((k) => (
                  <th key={k.kind} style={th}>{k.label} <span style={{ fontWeight: 400 }}>({totals[k.kind] || 0})</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => {
                const row = grid.get(b.key)
                return (
                  <tr key={b.key}>
                    <td style={{ ...td, position: 'sticky', left: 0, background: C.bg, zIndex: 1, color: b.key === 'unknown' ? C.dim : C.head, fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
                      {b.label}
                    </td>
                    {SAIL_MEDIA_KINDS.map((k) => {
                      const list = row?.get(k.kind) || []
                      const cellKey = `${b.key}|${k.kind}`
                      const expanded = open.has(cellKey)
                      const visible = expanded ? list : list.slice(0, PER_CELL)
                      return (
                        <td key={k.kind} style={td}>
                          {list.length === 0 ? <span style={{ color: '#334155', fontSize: 11 }}>—</span> : (
                            // A fixed width, not min-width on the cell: table cells ignore min-width,
                            // and a squeezed column stacks the thumbnails one per line.
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, width: expanded ? thumbW * 4 + 12 : thumbW * 2 + 4 }}>
                              {visible.map(thumb)}
                              {list.length > PER_CELL && (
                                <button
                                  onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(cellKey)) n.delete(cellKey); else n.add(cellKey); return n })}
                                  style={{ ...chip(false), width: '100%', padding: '3px 6px' }}
                                >
                                  {expanded ? 'show fewer' : `+${list.length - PER_CELL} more`}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
            Matched by time: the crew’s sail-change tags where the day has them ({data.taggedDays} of {data.days} days), otherwise the event file’s sails.
            A video appears once per wind band it spends on this sail. 360 = a clip tagged “360”, or an Insta360 file name.
            {canEdit && ' ✕ on a photo or clip marks it not relevant to this sail only; it can be brought back.'}
          </p>
        </div>
      )}

      <Dialog open={!!confirmFor} onOpenChange={(o) => { if (!o) setConfirmFor(null) }}>
        {confirmFor && (
          <DialogContent title={`Remove from ${sail ? sailLabel(sail) : 'this sail'}?`}>
            <p className="text-sm">This will remove this media from this selection. Are you sure?</p>
            <p className="mt-1 text-xs text-muted">
              Only from {sail ? sailLabel(sail) : 'this sail'}{confirmFor.kind === 'video' || confirmFor.kind === 'video360' ? ', in every wind band the clip appears in' : ''}.
              Nothing is deleted — “Show not relevant” brings it back.
            </p>
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
              Don’t show this message in the future
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmFor(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={confirmHide} autoFocus>Yes</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <SailGeometryDialog
        open={!!geomFor}
        onClose={() => { setPhoto(geomFor); setGeomFor(null) }}
        boatId={boatId || null}
        fileUrl={geomFor?.original || ''}
        fileName={geomFor ? `photo-${geomFor.id.slice(0, 8)}.jpg` : 'photo.jpg'}
        caption={geomFor?.date || ''}
        twaDeg={geomFor?.twa ?? null}
        initialResult={(geomFor?.raw?.analysis_data as any)?.sailTrim?.result ?? null}
        onSaveToPhoto={async (save: any) => {
          if (!geomFor) return
          await applyGeometry(geomFor, {
            annotation: save.annotation, overlay: !!save.showOverlay,
            headline: annotationHeadline(save.annotation), result: save.result,
          })
        }} />

      <PhotoLightbox
        photo={photo}
        onClose={() => setPhoto(null)}
        onToggleOverlay={photo?.raw && photo.sailTrim ? () => toggleGeometryOverlay(photo) : null}
        onMeasure={photo?.raw ? () => { setGeomFor(photo); setPhoto(null) } : null} />

      <Dialog open={!!video} onOpenChange={(o) => { if (!o) setVideo(null) }}>
        {video && (
          <DialogContent
            title={`${video.title || 'Video'} · ${shortDate(video.date)}${video.tws != null ? ` · ${video.tws.toFixed(1)} kn` : ''}`}
            wide
          >
            <FallbackVideoPlayer videoId={video.id} />
          </DialogContent>
        )}
      </Dialog>

      {scan?.scan && (
        <SailScanDetail
          scan={scan.scan}
          teamId={teamId}
          sails={sails}
          canEdit={false}
          sailName={sail ? sailLabel(sail) : null}
          sessionTzOffset={sessionTzOffset}
          onClose={() => setScan(null)}
        />
      )}
    </div>
  )
}
