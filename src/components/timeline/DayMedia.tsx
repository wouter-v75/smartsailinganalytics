'use client'
import * as React from 'react'
import { Play, Camera } from 'lucide-react'
import { Badge, Dialog, DialogContent, Skeleton } from '@/components/ui'
import { renderOverlay } from '@/lib/photoOverlay'
import { racingTagsOf, RACE_RED } from '@/lib/racingTags'

// Media for a day: photo + video thumbnails (TWS/TWD/tags baked from the log /
// event file), fetched lazily from the cloud when a day becomes active in the
// timeline. Thumbnails enlarge on hover. Clicking a clip calls `onPlayVideo`
// (which opens the real Videos-tab player *with* the instrument data overlay);
// if no handler is supplied we fall back to an inline HLS/MP4 player. Clicking a
// photo opens a lightbox with its TWS/TWD/TWA/sail data.
interface PhotoItem { id: string; thumb: string | null; tws?: number | null; twd?: number | null; twa?: number | null; sails: string[]; inst: Record<string, any> }
interface VideoItem { id: string; thumb: string | null; title: string | null; tags: string[] }

const r = (v?: number | null, d = 0) => (v == null ? null : v.toFixed(d))

export default function DayMedia({ teamId, boatId, date, onPlayVideo, showEmpty = false }: {
  teamId: string; boatId: string; date: string
  onPlayVideo?: (videoId: string) => void
  showEmpty?: boolean
}) {
  const [photos, setPhotos] = React.useState<PhotoItem[] | null>(null)
  const [videos, setVideos] = React.useState<VideoItem[] | null>(null)
  const [openPhoto, setOpenPhoto] = React.useState<PhotoItem | null>(null)
  const [fallbackVideo, setFallbackVideo] = React.useState<VideoItem | null>(null)

  React.useEffect(() => {
    let alive = true
    setPhotos(null); setVideos(null)
    fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`)
      .then((res) => res.json())
      .then((j) => {
        if (!alive) return
        setPhotos((j?.photos || []).map((p: any) => {
          const a = p.analysis_data || {}, inst = a.inst || {}
          const sails = a.sails ?? inst.sails ?? []
          return { id: p.id, thumb: p.thumbnail_url, tws: inst.tws ?? null, twd: inst.twd ?? null, twa: inst.twa ?? null, sails, inst: { ...inst, sails } }
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

  const loading = photos === null || videos === null
  const nP = photos?.length ?? 0, nV = videos?.length ?? 0

  if (loading) {
    return (
      <div className="flex gap-2 py-1">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-40 shrink-0 rounded-lg" />)}
      </div>
    )
  }
  if (nP === 0 && nV === 0) {
    return showEmpty ? <div className="py-2 text-xs text-muted">No photos or videos for this day.</div> : null
  }

  const playVideo = (v: VideoItem) => { if (onPlayVideo) onPlayVideo(v.id); else setFallbackVideo(v) }

  return (
    <div className="py-1">
      {nV > 0 && (
        <>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Videos</div>
          <div className="mb-3 flex flex-wrap gap-2">
            {videos!.map((v) => (
              <button key={v.id} onClick={() => playVideo(v)} title={v.title || 'Play video'}
                className="group/med relative aspect-video w-44 shrink-0 overflow-hidden rounded-lg border border-[color:var(--border)] bg-surface-2 text-left shadow-sm transition-transform duration-150 hover:z-10 hover:scale-[1.06] hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]">
                {v.thumb ? <img src={v.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Play size={20} aria-hidden /></div>}
                <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-transform duration-150 group-hover/med:scale-110"><Play size={16} aria-hidden /></span>
                {racingTagsOf(v.tags).length > 0 && (
                  <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-0.5 bg-black/55 px-1 py-0.5">
                    {racingTagsOf(v.tags).slice(0, 2).map((t) => (
                      <span key={t} className="rounded px-1 py-px text-[8px] font-bold uppercase tracking-wide"
                        style={{ background: RACE_RED, color: '#fff' }}>{t}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      {nP > 0 && (
        <>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Photos</div>
          <div className="flex flex-wrap gap-2">
            {photos!.map((p) => (
              <button key={p.id} onClick={() => setOpenPhoto(p)}
                className="group/med relative aspect-[4/3] w-32 shrink-0 overflow-hidden rounded-lg border border-[color:var(--border)] bg-surface-2 shadow-sm transition-transform duration-150 hover:z-10 hover:scale-[1.08] hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]">
                {p.thumb ? <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Camera size={18} aria-hidden /></div>}
                {(p.tws != null || p.twd != null) && (
                  <div className="absolute inset-x-0 bottom-0 bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
                    {p.tws != null ? `${r(p.tws)}kt` : ''}{p.twd != null ? ` ${r(p.twd)}°` : ''}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      <Dialog open={!!openPhoto} onOpenChange={(o) => { if (!o) setOpenPhoto(null) }}>
        {openPhoto && (
          <DialogContent title="Photo">
            <PhotoOverlayImage src={openPhoto.thumb} inst={openPhoto.inst} />
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!fallbackVideo} onOpenChange={(o) => { if (!o) setFallbackVideo(null) }}>
        {fallbackVideo && (
          <DialogContent title={fallbackVideo.title || 'Video'}>
            <FallbackVideoPlayer videoId={fallbackVideo.id} />
            {racingTagsOf(fallbackVideo.tags).length > 0 && <div className="mt-3 flex flex-wrap gap-2">{racingTagsOf(fallbackVideo.tags).map((t) => <Badge key={t}>{t}</Badge>)}</div>}
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

// Photo with the same instrument data overlay as the Photos tab (shared
// renderer). Display-only, so we deliberately don't set crossOrigin — the
// canvas may become "tainted", which is fine since we never export it, and it
// avoids CORS load failures on the CDN thumbnail.
export function PhotoOverlayImage({ src, inst }: { src: string | null; inst: Record<string, any> }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => {
    setReady(false); setFailed(false)
    if (!src) return
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      try { renderOverlay(c, img, inst || {}); setReady(true) } catch { setFailed(true) }
    }
    img.onerror = () => setFailed(true)
    img.src = src
    return () => { img.onload = null; img.onerror = null }
  }, [src, inst])

  if (!src) return <div className="py-8 text-center text-sm text-muted">No image.</div>
  if (failed) return <img src={src} alt="" className="max-h-[80vh] w-full rounded object-contain" />
  return (
    <div className="relative">
      {!ready && <Skeleton className="h-56 w-full rounded" />}
      <canvas ref={canvasRef} className="max-h-[80vh] w-full rounded object-contain" style={{ display: ready ? 'block' : 'none' }} />
    </div>
  )
}

// Fallback only (standalone timeline page, no app player). The main app routes
// clicks to the Videos-tab player which carries the instrument data overlay.
export function FallbackVideoPlayer({ videoId }: { videoId: string }) {
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
  return <video ref={ref} controls autoPlay playsInline className="w-full rounded bg-black" style={{ maxHeight: '80vh' }} />
}
