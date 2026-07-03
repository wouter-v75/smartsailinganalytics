'use client'
import * as React from 'react'
import { Play, Camera } from 'lucide-react'
import { Badge, Dialog, DialogContent } from '@/components/ui'

// Media for a day: photo + video thumbnails (with TWS/TWD/tags baked from the
// log/event file), fetched lazily from the cloud when a day expands in the
// timeline. Click a thumbnail to view (photo lightbox, or HLS/MP4 video player).
interface PhotoItem { id: string; thumb: string | null; tws?: number | null; twd?: number | null; twa?: number | null; sails: string[] }
interface VideoItem { id: string; thumb: string | null; title: string | null; tags: string[] }

const r = (v?: number | null, d = 0) => (v == null ? null : v.toFixed(d))

export default function DayMedia({ teamId, boatId, date }: { teamId: string; boatId: string; date: string }) {
  const [photos, setPhotos] = React.useState<PhotoItem[] | null>(null)
  const [videos, setVideos] = React.useState<VideoItem[] | null>(null)
  const [openPhoto, setOpenPhoto] = React.useState<PhotoItem | null>(null)
  const [openVideo, setOpenVideo] = React.useState<VideoItem | null>(null)

  React.useEffect(() => {
    let alive = true
    fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`)
      .then((res) => res.json())
      .then((j) => {
        if (!alive) return
        setPhotos((j?.photos || []).map((p: any) => {
          const a = p.analysis_data || {}, inst = a.inst || {}
          return { id: p.id, thumb: p.thumbnail_url, tws: inst.tws ?? null, twd: inst.twd ?? null, twa: inst.twa ?? null, sails: a.sails || [] }
        }))
      })
      .catch(() => { if (alive) setPhotos([]) })
    fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`)
      .then((res) => res.json())
      .then((j) => {
        if (!alive) return
        setVideos((j?.videos || []).map((v: any) => ({ id: v.id, thumb: v.thumbnail || v.thumbnail_url, title: v.title, tags: v.tags || [] })))
      })
      .catch(() => { if (alive) setVideos([]) })
    return () => { alive = false }
  }, [teamId, boatId, date])

  const nP = photos?.length ?? 0, nV = videos?.length ?? 0
  if (photos !== null && videos !== null && nP === 0 && nV === 0) return null

  return (
    <div className="py-1">
      {nV > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {videos!.map((v) => (
            <button key={v.id} onClick={() => setOpenVideo(v)}
              className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-lg border border-[color:var(--border)] bg-surface-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]">
              {v.thumb ? <img src={v.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Play size={18} aria-hidden /></div>}
              <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white"><Play size={15} aria-hidden /></span>
              {v.tags.length > 0 && <div className="absolute inset-x-0 bottom-0 truncate bg-black/45 px-1.5 py-0.5 text-[10px] text-white/90">{v.tags.slice(0, 3).join(' · ')}</div>}
            </button>
          ))}
        </div>
      )}
      {nP > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {photos!.map((p) => (
            <button key={p.id} onClick={() => setOpenPhoto(p)}
              className="relative aspect-[4/3] w-28 shrink-0 overflow-hidden rounded-lg border border-[color:var(--border)] bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]">
              {p.thumb ? <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Camera size={16} aria-hidden /></div>}
              {(p.tws != null || p.twd != null) && (
                <div className="absolute inset-x-0 bottom-0 bg-black/45 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
                  {p.tws != null ? `${r(p.tws)}kt` : ''}{p.twd != null ? ` ${r(p.twd)}°` : ''}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!openPhoto} onOpenChange={(o) => { if (!o) setOpenPhoto(null) }}>
        {openPhoto && (
          <DialogContent title="Photo">
            {openPhoto.thumb && <img src={openPhoto.thumb} alt="" className="max-h-[60vh] w-full rounded object-contain" />}
            <div className="mt-3 flex flex-wrap gap-2">
              {openPhoto.tws != null && <Badge tone="accent">TWS {r(openPhoto.tws)} kt</Badge>}
              {openPhoto.twd != null && <Badge>TWD {r(openPhoto.twd)}°</Badge>}
              {openPhoto.twa != null && <Badge>TWA {r(openPhoto.twa)}°</Badge>}
              {openPhoto.sails.map((s) => <Badge key={s}>{s}</Badge>)}
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!openVideo} onOpenChange={(o) => { if (!o) setOpenVideo(null) }}>
        {openVideo && (
          <DialogContent title={openVideo.title || 'Video'}>
            <VideoPlayer videoId={openVideo.id} />
            {openVideo.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{openVideo.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

function VideoPlayer({ videoId }: { videoId: string }) {
  const ref = React.useRef<HTMLVideoElement>(null)
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    let hls: any = null
    ;(async () => {
      try {
        const j = await fetch(`/api/videos/${videoId}/url`).then((res) => res.json())
        if (!alive) return
        const el = ref.current
        const url: string | undefined = j?.url
        if (!url || !el) { setErr('Not playable yet — the clip may still be processing.'); return }
        if (j?.kind === 'hls' && !el.canPlayType('application/vnd.apple.mpegurl')) {
          const w = window as any
          const attach = () => { hls = new w.Hls(); hls.loadSource(url); hls.attachMedia(el) }
          if (w.Hls?.isSupported()) attach()
          else {
            const s = document.createElement('script')
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.14/hls.min.js'
            s.onload = () => { if (w.Hls?.isSupported()) attach(); else el.src = url }
            document.head.appendChild(s)
          }
        } else { el.src = url }
      } catch { if (alive) setErr('Could not load the video.') }
    })()
    return () => { alive = false; if (hls) { try { hls.destroy() } catch { /* noop */ } } }
  }, [videoId])
  if (err) return <div className="py-8 text-center text-sm text-muted">{err}</div>
  return <video ref={ref} controls autoPlay playsInline className="w-full rounded bg-black" style={{ maxHeight: '60vh' }} />
}
