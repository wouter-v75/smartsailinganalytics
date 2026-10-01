'use client'
import * as React from 'react'
import {
  fileAt, nextFileFrom, pairFootage, playableName, proxyCount,
  type FootageFile,
} from '@/lib/droneProxy'
import { canWatchFolders, ensureFolderPermission } from '@/lib/watchFolder'
import { FOOTAGE_FOLDER_PREF, getPref, setPref } from '@/lib/prefsStore'
import { sessionClock } from '@/lib/tagging/clock'

// Review the day's drone footage off the SSD, without moving a byte of it.
//
// The bargain Njord's player strikes — hold a PATH, not a file — with the
// card's own proxies doing the playing. DJI writes a 720p LRF beside every 4K
// clip at record time; it is about a thirtieth of the bytes and it is already on
// the disk, so review costs no transcode and no upload. The cutter still cuts
// the original.
//
// Chrome and Edge only: Safari and Firefox ship no directory picker. That is a
// deliberate accepted limit — the review happens on the one laptop the card is
// plugged into anyway.
//
// WHAT IT IS FOR: watch, and press G where something is worth keeping. The
// playhead becomes the tagger's "now", so Grab video lands on the frame being
// watched rather than on the wall clock. Every tagging tool worth copying works
// this way — one key, no dialog, no pause.

const C = {
  card: '#0A1929', border: '#13293D', head: '#E2E8F0',
  text: '#CBD5E1', dim: '#64748B', accent: '#06B6D4', warn: '#F59E0B', bad: '#EF4444',
}

const btn: React.CSSProperties = {
  background: '#0F2A45', border: 'none', borderRadius: 7, color: '#CBD5E1',
  fontSize: 12, fontWeight: 600, padding: '7px 12px', cursor: 'pointer', minHeight: 36,
}

type Dir = FileSystemDirectoryHandle

export interface FootageReviewProps {
  /** The day being reviewed, for the picker's title and the empty state. */
  date?: string | null
  /** Venue offset: a DJI filename is local wall time and the track is UTC. */
  tzOffsetMin?: number
  /** A moment picked on the track — seek here. */
  seekToUtc?: number | null
  /** The playhead, so the tagger can tag the frame being watched. */
  onPlayhead?: (utc: number | null) => void
  /** Pressing G. The parent owns what a tag IS; this only says when. */
  onGrab?: (utc: number) => void
}

export default function FootageReview({
  date, tzOffsetMin = 0, seekToUtc, onPlayhead, onGrab,
}: FootageReviewProps) {
  const [dir, setDir] = React.useState<Dir | null>(null)
  const [files, setFiles] = React.useState<FootageFile[]>([])
  const [playing, setPlaying] = React.useState<FootageFile | null>(null)
  const [url, setUrl] = React.useState<string | null>(null)
  const [msg, setMsg] = React.useState<string | null>(null)
  const [stale, setStale] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  // The seek a click asked for, held until the file it needs has loaded.
  const pendingSeek = React.useRef<number | null>(null)

  const supported = canWatchFolders()

  // The folder we were pointed at last time. Read on mount but never USED here:
  // re-granting its permission must happen inside a click, so the button does
  // it — the same rule the Upload tab's watcher follows.
  const [savedDir, setSavedDir] = React.useState<Dir | null>(null)
  React.useEffect(() => {
    let alive = true
    getPref(FOOTAGE_FOLDER_PREF).then((h: unknown) => {
      if (alive && h) setSavedDir(h as Dir)
    })
    return () => { alive = false }
  }, [])

  /** Read the folder: pair every clip with its proxy, then measure durations. */
  const scan = React.useCallback(async (handle: Dir) => {
    setBusy(true); setMsg(null); setStale(false)
    try {
      const names: string[] = []
      // @ts-expect-error — values() is part of the API, not yet in the lib types
      for await (const entry of handle.values()) if (entry.kind === 'file') names.push(entry.name)
      const paired = pairFootage(names, tzOffsetMin)
      setFiles(paired)
      if (!paired.length) {
        setMsg('No DJI clips in that folder — is it the Drone folder for this day?')
        return
      }
      // A filename says when a clip STARTED, never how long it ran, and without
      // the duration a click on the track cannot know which clip holds it. The
      // browser will tell us, one metadata read per file, off a local disk.
      const measured = await Promise.all(paired.map(async (f) => {
        try {
          const file = await (await handle.getFileHandle(playableName(f))).getFile()
          const u = URL.createObjectURL(file)
          const sec = await new Promise<number>((res) => {
            const v = document.createElement('video')
            v.preload = 'metadata'
            v.onloadedmetadata = () => res(Number.isFinite(v.duration) ? v.duration : 0)
            v.onerror = () => res(0)
            v.src = u
          })
          URL.revokeObjectURL(u)
          return { ...f, durationSec: sec }
        } catch { return f }
      }))
      setFiles(measured)
    } catch {
      // The drive was unplugged, or the folder is gone. Njord shows those clips
      // in red and offers "Locate Files…"; this is the same idea — say so, and
      // make re-pointing one press.
      setStale(true)
      setMsg('That folder is not readable any more — is the drive connected?')
    } finally { setBusy(false) }
  }, [tzOffsetMin])

  const pick = React.useCallback(async () => {
    if (!supported) return
    try {
      let handle: Dir | null = null
      if (savedDir && await ensureFolderPermission(savedDir as never)) handle = savedDir
      if (!handle) {
        handle = await (window as unknown as {
          showDirectoryPicker: (o: unknown) => Promise<Dir>
        }).showDirectoryPicker({
          id: 'ssa-drone-footage',
          mode: 'read',
          ...(savedDir ? { startIn: savedDir } : {}),
        })
        setSavedDir(handle)
        setPref(FOOTAGE_FOLDER_PREF, handle)
      }
      setDir(handle)
      await scan(handle)
    } catch {
      // Picker dismissed. Not an error worth saying anything about.
    }
  }, [savedDir, scan, supported])

  /** Open a file and seek into it. */
  const open = React.useCallback(async (f: FootageFile, offsetSec: number) => {
    if (!dir) return
    try {
      const file = await (await dir.getFileHandle(playableName(f))).getFile()
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file) })
      setPlaying(f)
      pendingSeek.current = offsetSec
      setStale(false)
    } catch {
      setStale(true)
      setMsg(`${playableName(f)} is not readable — is the drive still connected?`)
    }
  }, [dir])

  // A press on the track. If footage covers it, open that file there; if it
  // falls in a gap — the drone on the deck, which on 30 September was fourteen
  // minutes of the day — say so rather than doing nothing.
  React.useEffect(() => {
    if (seekToUtc == null || !files.length) return
    const hit = fileAt(files, seekToUtc)
    if (hit) {
      if (playing?.stem === hit.file.stem && videoRef.current) {
        videoRef.current.currentTime = hit.offsetSec
        setMsg(null)
      } else {
        void open(hit.file, hit.offsetSec)
        setMsg(null)
      }
      return
    }
    const next = nextFileFrom(files, seekToUtc)
    setMsg(next
      ? `No footage at ${sessionClock(seekToUtc, tzOffsetMin)} — the drone was not recording. Next is ${sessionClock(next.startUtc, tzOffsetMin)}.`
      : `No footage at ${sessionClock(seekToUtc, tzOffsetMin)} — nothing was filmed after this.`)
  }, [seekToUtc, files, playing, open, tzOffsetMin])

  // Apply a seek once the file it was meant for has loaded.
  const onLoaded = () => {
    const v = videoRef.current
    if (v && pendingSeek.current != null) { v.currentTime = pendingSeek.current; void v.play().catch(() => {}) }
    pendingSeek.current = null
  }

  const playheadUtc = React.useCallback((): number | null => {
    const v = videoRef.current
    if (!v || !playing) return null
    return playing.startUtc + v.currentTime * 1000
  }, [playing])

  const onTime = () => onPlayhead?.(playheadUtc())

  // One key, no dialog, no pause — how every tagging tool worth copying works.
  React.useEffect(() => {
    if (!playing) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') {
        e.preventDefault()
        const v = videoRef.current
        if (v) { if (v.paused) void v.play().catch(() => {}) ; else v.pause() }
      }
      if (e.key === 'g' || e.key === 'G') {
        const at = playheadUtc()
        if (at != null) { e.preventDefault(); onGrab?.(at) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing, onGrab, playheadUtc])

  React.useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  if (!supported) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, color: C.dim, fontSize: 12 }}>
        Reviewing from the card needs Chrome, Edge or Vivaldi — Safari and Firefox
        have no folder picker. The clips themselves play anywhere once uploaded.
      </div>
    )
  }

  const withProxy = proxyCount(files)

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <button onClick={pick} style={{ ...btn, background: dir ? '#0F2A45' : C.accent, color: dir ? '#CBD5E1' : '#001018' }}>
          {busy ? 'Reading the card…' : dir ? 'Change folder' : 'Review footage'}
        </button>
        {dir && (
          <span style={{ fontSize: 11, color: C.dim }}>
            {dir.name} · {files.length} clip{files.length === 1 ? '' : 's'}
            {files.length > 0 && (
              withProxy === files.length
                ? ' · playing the camera’s 720p proxies'
                : withProxy === 0
                  ? ' · no .LRF proxies on this card — playing the 4K originals, which will be slow'
                  : ` · ${withProxy} of ${files.length} have a proxy`
            )}
          </span>
        )}
        {!dir && <span style={{ fontSize: 11, color: C.dim }}>Point it at {date ? `${date.replace(/-/g, '')}/Drone` : 'the day’s Drone folder'} on the SSD — it is remembered.</span>}
      </div>

      {msg && (
        <div style={{ fontSize: 11, color: stale ? C.bad : C.warn, marginBottom: 8 }}>
          {msg}
          {stale && dir && <button onClick={pick} style={{ ...btn, marginLeft: 8, padding: '3px 8px', minHeight: 0 }}>Locate files…</button>}
        </div>
      )}

      {url && (
        <>
          <video
            ref={videoRef}
            src={url}
            controls
            onLoadedMetadata={onLoaded}
            onTimeUpdate={onTime}
            onSeeked={onTime}
            style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: '46vh' }}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: C.text }}>
              {playing?.proxyName ? 'proxy' : '4K original'} · {playing?.videoName}
            </span>
            <button
              onClick={() => { const at = playheadUtc(); if (at != null) onGrab?.(at) }}
              style={{ ...btn, background: '#15803D', color: '#EAFBF0' }}
            >
              Grab video here <span style={{ opacity: 0.7 }}>(G)</span>
            </button>
            <span style={{ fontSize: 10, color: C.dim }}>space plays and pauses</span>
          </div>
        </>
      )}

      {dir && !url && files.length > 0 && (
        <div style={{ fontSize: 11, color: C.dim }}>
          Press a green band on the track to play from that moment, or
          <button onClick={() => void open(files[0], 0)} style={{ ...btn, marginLeft: 6, padding: '3px 8px', minHeight: 0 }}>
            start at {sessionClock(files[0].startUtc, tzOffsetMin)}
          </button>
        </div>
      )}
    </div>
  )
}
