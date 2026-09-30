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

import React, { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { FallbackVideoPlayer } from '@/components/timeline/DayMedia'
import PhotoLightbox, { type LightboxPhoto } from '@/components/timeline/PhotoLightbox'
import SailScanDetail from '@/components/SailScanDetail'
import { SAIL_MEDIA_KINDS, allTwsBands, twsBand, type SailMediaItem, type SailMediaKind } from '@/lib/sailMedia'

const C = {
  bg: '#04101c', card: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  text: '#cbd5e1', dim: '#8A97A9', head: '#e2e8f0', warn: '#F59E0B',
}
const PER_CELL = 4

type Item = SailMediaItem & { scan?: any; photo?: LightboxPhoto & { inst?: any } }
interface Payload { items: Item[]; events: string[]; taggedDays: number; days: number }
interface SailOpt { id: string; name: string; category?: string | null; retired?: boolean }

const sailLabel = (s: SailOpt) => (s.category ? `${s.category} · ${s.name}` : s.name)
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`
const shortDate = (d: string | null) =>
  d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : '—'

export default function SailMediaPanel({ teamId, sails, sailId, onSailChange, onBack, onOpenVideo, sessionTzOffset = 0, isMobile }: {
  teamId: string
  /** The app's own player — the one the timeline opens, with the instrument
   *  overlay. Absent only outside the app shell (the /dev preview), where the
   *  bare fallback player stands in. */
  onOpenVideo?: (date: string, videoId: string) => void
  sails: SailOpt[]
  sailId: string
  onSailChange: (id: string) => void
  onBack: () => void
  sessionTzOffset?: number
  isMobile?: boolean
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [event, setEvent] = useState<string>('')          // '' = every event
  const [showEmpty, setShowEmpty] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set()) // expanded cells
  const [photo, setPhoto] = useState<Item | null>(null)
  const [video, setVideo] = useState<Item | null>(null)
  const [scan, setScan] = useState<Item | null>(null)

  useEffect(() => {
    if (!sailId) return
    let alive = true
    setData(null); setErr(''); setOpen(new Set()); setEvent('')
    fetch(`/api/teams/${teamId}/sails/${sailId}/media`)
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j) })
      .catch((e) => alive && setErr(String(e)))
    return () => { alive = false }
  }, [teamId, sailId])

  const shown = useMemo(
    () => (data?.items || []).filter((i) => !event || (event === '(none)' ? !i.event : i.event === event)),
    [data, event]
  )

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
    for (const i of shown) t[i.kind] = (t[i.kind] || 0) + 1
    return t
  }, [shown])

  const openItem = (i: Item) => {
    if (i.kind === 'scan') setScan(i)
    else if (i.kind === 'photo' || i.kind === 'trim') setPhoto(i)
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
    return (
      <button
        key={`${i.kind}:${i.id}:${i.startSec ?? ''}`}
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
        <div style={{ fontSize: 9, color: C.dim, padding: '2px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{caption}</div>
      </button>
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
            {shown.length} item{shown.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {data && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: C.dim, marginRight: 2 }}>Event</span>
          <button onClick={() => setEvent('')} style={chip(event === '')}>All</button>
          {data.events.map((e) => <button key={e} onClick={() => setEvent(e)} style={chip(event === e)}>{e}</button>)}
          {data.items.some((i) => !i.event) && <button onClick={() => setEvent('(none)')} style={chip(event === '(none)')}>Training / no event</button>}
          <label style={{ marginLeft: 'auto', fontSize: 11, color: C.dim, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
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
          </p>
        </div>
      )}

      <PhotoLightbox photo={photo?.photo ? { ...photo.photo, id: photo.id } : null} onClose={() => setPhoto(null)} />

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
