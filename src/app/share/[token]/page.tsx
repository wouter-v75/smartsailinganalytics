'use client'
// PUBLIC watch page — /share/<token>. No login, no app shell, no navigation into SSA.
//
// Renders the clip with its instrument overlay drawn LIVE over the video (nothing is
// re-encoded, which is why a link is instant to create). The overlay follows playback:
// at video time t we show the log sample nearest startUtc + t.

import * as React from 'react'

interface Row { utc: number; bsp?: number; tws?: number; twa?: number; twd?: number; aws?: number; awa?: number; heel?: number; trim?: number; vmg?: number; sog?: number; cog?: number; vsPerfPct?: number }
interface Share {
  title: string
  startUtc: number | null
  durationMs: number | null
  rotation: number
  includeOverlay: boolean
  expiresAt: string
  playback: { url: string; kind: 'hls' | 'mp4' }
  rows: Row[]
}

const C = { bg: '#030F1A', panel: 'rgba(3,15,26,0.72)', border: '#1E3A5A', head: '#E2E8F0', dim: '#64748B', accent: '#06B6D4' }
const fmt = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d))

// Nearest sample to an instant — binary search, the rows are time-ordered.
function nearest(rows: Row[], utc: number): Row | null {
  if (!rows.length) return null
  let lo = 0, hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].utc < utc) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(rows[lo - 1].utc - utc) < Math.abs(rows[lo].utc - utc)) lo--
  return Math.abs(rows[lo].utc - utc) < 5000 ? rows[lo] : null
}

export default function SharePage({ params }: { params: { token: string } }) {
  const [data, setData] = React.useState<Share | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [row, setRow] = React.useState<Row | null>(null)
  const vidRef = React.useRef<HTMLVideoElement | null>(null)

  React.useEffect(() => {
    fetch(`/api/share/${params.token}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error('This link is no longer valid — it may have expired or been withdrawn.')
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load this clip.')
        return r.json()
      })
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [params.token])

  // HLS needs hls.js everywhere except Safari, which plays .m3u8 natively. The app loads
  // it from a CDN at runtime rather than bundling it — do the same here so the public
  // page adds no dependency and stays a light, standalone route.
  React.useEffect(() => {
    const v = vidRef.current
    if (!v || !data?.playback) return
    const { url, kind } = data.playback
    if (kind === 'mp4' || v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url
      return
    }
    let hls: any = null
    const attach = () => {
      const H = (window as any).Hls
      if (H?.isSupported()) {
        hls = new H({ capLevelToPlayerSize: true })
        hls.loadSource(url)
        hls.attachMedia(v)
      } else {
        v.src = url // last resort — some browsers will manage
      }
    }
    if ((window as any).Hls) attach()
    else {
      const s = document.createElement('script')
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.14/hls.min.js'
      s.onload = attach
      s.onerror = () => { v.src = url }
      document.head.appendChild(s)
    }
    return () => { try { hls?.destroy() } catch { /* */ } }
  }, [data])

  const onTime = React.useCallback(() => {
    const v = vidRef.current
    if (!v || !data?.startUtc || !data.rows?.length) return
    setRow(nearest(data.rows, data.startUtc + v.currentTime * 1000))
  }, [data])

  if (err) {
    return (
      <main style={{ minHeight: '100vh', background: C.bg, color: C.head, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Clip unavailable</div>
          <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.5 }}>{err}</div>
        </div>
      </main>
    )
  }

  if (!data) {
    return (
      <main style={{ minHeight: '100vh', background: C.bg, color: C.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
        Loading…
      </main>
    )
  }

  const rot = data.rotation % 360
  const quarter = rot === 90 || rot === 270
  const kv = (k: string, v: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 62 }}>
      <span style={{ fontSize: 9, color: C.dim, letterSpacing: 1, textTransform: 'uppercase' }}>{k}</span>
      <span style={{ fontSize: 15, fontWeight: 700, color: C.head, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  )

  return (
    <main style={{ minHeight: '100vh', background: C.bg, color: C.head, fontFamily: 'system-ui, sans-serif', padding: '20px 16px' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{data.title}</h1>
          <span style={{ fontSize: 11, color: C.dim }}>
            shared clip · link expires {new Date(data.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        </div>

        <div style={{ position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
          <video
            ref={vidRef}
            controls
            playsInline
            onTimeUpdate={onTime}
            onLoadedMetadata={onTime}
            style={{
              width: '100%', display: 'block', aspectRatio: '16 / 9', objectFit: 'contain', background: '#000',
              ...(rot ? { transform: `rotate(${rot}deg)${quarter ? ' scale(0.5625)' : ''}` } : {}),
            }}
          />
          {data.includeOverlay && row && (
            <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 14, flexWrap: 'wrap', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', backdropFilter: 'blur(6px)', pointerEvents: 'none' }}>
              {kv('TWS', `${fmt(row.tws)} kt`)}
              {kv('TWA', `${fmt(row.twa, 0)}°`)}
              {kv('BSP', `${fmt(row.bsp)} kt`)}
              {row.heel != null && kv('Heel', `${fmt(row.heel, 0)}°`)}
              {row.vsPerfPct != null && kv('Polar', `${fmt(row.vsPerfPct, 0)}%`)}
            </div>
          )}
        </div>

        {data.includeOverlay && !data.rows?.length && (
          <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>
            No instrument data was recorded for this clip.
          </div>
        )}

        <div style={{ fontSize: 10, color: C.dim, marginTop: 14 }}>
          Shared from Smart Sailing Analytics. This link shows one clip only.
        </div>
      </div>
    </main>
  )
}
