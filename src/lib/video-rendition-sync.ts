// Orchestrates the per-video "proxy sync" pipeline that backs the manual
// "Sync proxy" button. End-to-end this does three things, in order:
//
//   1. Generate a 720p H.264 proxy from the source blob using ffmpeg.wasm
//      (see src/lib/video-proxy.ts). 30–60s per minute of input on phones,
//      faster on laptops.
//   2. PUT the proxy blob to Bunny Storage at
//      `sessions/<date>/proxies/<videoId>.mp4` via the browser-side
//      AccessKey path (see src/lib/bunny-storage-upload.ts).
//   3. PATCH the videos row in Supabase to flip `has_proxy = true` and
//      record bunny_proxy_path + proxy_bytes (see /api/videos/[id]/renditions).
//
// We intentionally do all three sequentially per video and don't try to
// parallelise ffmpeg jobs — the WASM core is single-instance per page,
// running two in parallel just queues them and burns more memory.
//
// The 'original' upload path is identical minus the ffmpeg step; that's
// `syncOriginalForVideo`. Phase B v1 wires only the proxy button; the
// original button comes later once the proxy flow is proven in the field.

import { generateProxy, type ProxyProgress } from './video-proxy'
import { uploadBlobToStorage, storageObjectSize, type UploadProgress } from './bunny-storage-upload'

/** Path layout — keep aligned with the design in the project memo. */
export function proxyPathFor(sessionDate: string, videoId: string): string {
  return `sessions/${sessionDate}/proxies/${videoId}.mp4`
}
export function originalPathFor(sessionDate: string, videoId: string): string {
  return `sessions/${sessionDate}/originals/${videoId}.mp4`
}

export type RenditionPhase =
  | 'idle'
  | 'transcoding'
  | 'uploading'
  | 'marking'
  | 'done'
  | 'error'

export interface RenditionProgress {
  phase: RenditionPhase
  /** 0..1 within the current phase. */
  pct: number
  message?: string
  bytesUploaded?: number
  bytesTotal?: number
  errorMessage?: string
}

interface BaseArgs {
  videoId: string
  sessionDate: string
  source: Blob
  onProgress?: (p: RenditionProgress) => void
  signal?: AbortSignal
}

/**
 * Generate (if needed) and upload the proxy rendition for one video,
 * then flip has_proxy=true via PATCH.
 *
 * @param proxyBlobIfAvailable — if you've already generated the proxy
 * once and cached it, pass it here to skip the (slow) ffmpeg step.
 */

/** Ceiling the proxy would target anyway. Anything at or under this is already
 *  a proxy in all but name. */
export const PROXY_MAX_HEIGHT = 720
/** A 720p file can still be absurdly fat (a 40 Mbps intra-frame export). Above
 *  this it is worth re-encoding even at 720p; our own trim script caps at 8. */
export const PROXY_MAX_MBPS = 12

/**
 * Is this source already proxy-sized, so transcoding would only cost time and a
 * generation of quality?
 *
 * The clips coming out of scripts/select-race-clips.mjs are ALREADY 720p at
 * about 6 Mbps — the encoder made them that way. Running them through
 * ffmpeg.wasm in the browser to produce another 720p file took minutes per clip,
 * lost a generation, and produced something nearly identical to its input.
 *
 * Unknown values return false: if we cannot measure the source we transcode, as
 * before. Guessing wrong in that direction costs time; guessing wrong the other
 * way uploads a 4K original to every phone on the boat.
 */
export function shouldSkipProxy(
  { height, durationSec, bytes }: { height?: number | null; durationSec?: number | null; bytes?: number | null }
): boolean {
  if (!height || !Number.isFinite(height) || height <= 0) return false
  if (height > PROXY_MAX_HEIGHT) return false
  if (!bytes || !durationSec || durationSec <= 0) return false
  const mbps = (bytes * 8) / durationSec / 1e6
  return mbps <= PROXY_MAX_MBPS
}

/** Height and duration of a blob, read from a detached <video>. Returns nulls
 *  rather than throwing — an unreadable source simply falls back to transcoding. */
async function probeBlob(blob: Blob): Promise<{ height: number | null; durationSec: number | null }> {
  if (typeof document === 'undefined') return { height: null, durationSec: null }
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve) => {
      const v = document.createElement('video')
      v.preload = 'metadata'
      const done = (h: number | null, d: number | null) => {
        v.removeAttribute('src'); try { v.load() } catch { /* ignore */ }
        resolve({ height: h, durationSec: d })
      }
      const timer = setTimeout(() => done(null, null), 8000)
      v.onloadedmetadata = () => {
        clearTimeout(timer)
        done(v.videoHeight || null, Number.isFinite(v.duration) ? v.duration : null)
      }
      v.onerror = () => { clearTimeout(timer); done(null, null) }
      v.src = url
    })
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}


/**
 * THE one way a clip reaches the cloud.
 *
 * Storage first, then Bunny fetches it into Stream server-side. Storage first
 * because the clip is watchable the moment its bytes land — as a progressive
 * MP4 — instead of waiting on a transcode. Bunny fetching rather than us
 * uploading twice because the bytes then cross our uplink once.
 *
 * Both renditions go through here. They differ only in WHICH columns they
 * write, and that distinction is honest: `original` means we shipped the file
 * as it was, `proxy` means we shrank it first, so has_original never claims to
 * be a file we re-encoded.
 *
 * Anything failing after the row is marked returns ok with `streamError`: the
 * clip already plays, and only the adaptive ladder is missing. Telling the user
 * the upload failed would send them re-uploading footage the team can watch.
 */
async function putAndFetch({
  videoId, sessionDate, blob, title, kind, onProgress, signal,
}: {
  videoId: string; sessionDate: string; blob: Blob; title: string
  kind: 'original' | 'proxy'
  onProgress?: (p: RenditionProgress) => void
  signal?: AbortSignal
}): Promise<{ ok: boolean; path?: string; streamId?: string; streamError?: string; error?: string }> {
  const emit = (p: RenditionProgress) => onProgress?.(p)
  const path = kind === 'proxy' ? proxyPathFor(sessionDate, videoId) : originalPathFor(sessionDate, videoId)
  const mark = (body: unknown) =>
    fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    })

  try {
    // Bunny Storage cannot resume a PUT, so the next best thing is not to repeat
    // one that already finished. Only an EXACT size match skips: a truncated
    // object from a dropped upload has the wrong size and is sent again.
    let bytes = blob.size
    const have = await storageObjectSize(path)
    if (have === blob.size) {
      emit({ phase: 'uploading', pct: 1, message: 'Already uploaded — skipping' })
    } else {
      emit({ phase: 'uploading', pct: 0, message: 'Uploading…' })
      const up = await uploadBlobToStorage({
        key: path, blob, contentType: blob.type || 'video/mp4', signal,
        onProgress: (u: UploadProgress) => emit({
          phase: 'uploading', pct: u.fraction,
          message: `${(u.bytesUploaded / 1048576).toFixed(0)} / ${(u.bytesTotal / 1048576).toFixed(0)} MB`,
          bytesUploaded: u.bytesUploaded, bytesTotal: u.bytesTotal,
        }),
      })
      bytes = up.bytes
    }

    // Watchable from here.
    emit({ phase: 'marking', pct: 0, message: 'Recording rendition…' })
    const marked = await mark(kind === 'proxy' ? { proxy: { path, bytes } } : { original: { path, bytes } })
    if (!marked.ok) {
      const j = await marked.json().catch(() => null)
      throw new Error(`recording the rendition failed: ${j?.error || `HTTP ${marked.status}`}`)
    }

    // Everything below is the upgrade to the adaptive ladder.
    emit({ phase: 'marking', pct: 0.5, message: 'Queuing adaptive encode…' })
    const res = await fetch('/api/stream/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }), signal,
    })
    const j = (await res.json().catch(() => null)) as { streamId?: string; error?: string } | null
    if (!res.ok || !j?.streamId) {
      emit({ phase: 'done', pct: 1, message: 'Playable — adaptive encode not queued' })
      return { ok: true, path, streamError: j?.error || `HTTP ${res.status}` }
    }
    const marked2 = await mark(kind === 'proxy'
      ? { proxyStream: { streamId: j.streamId, bytes } }
      : { original: { streamId: j.streamId } })
    if (!marked2.ok) {
      const m = await marked2.json().catch(() => null)
      return { ok: true, path, streamId: j.streamId, streamError: `PATCH renditions: ${m?.error || marked2.status}` }
    }
    emit({ phase: 'done', pct: 1, message: 'Playable now · adaptive encode queued' })
    return { ok: true, path, streamId: j.streamId }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ phase: 'error', pct: 0, errorMessage: msg })
    return { ok: false, error: msg }
  }
}

export async function syncProxyForVideo({
  videoId,
  sessionDate,
  source,
  proxyBlobIfAvailable,
  onProgress,
  signal,
}: BaseArgs & { proxyBlobIfAvailable?: Blob | null }): Promise<{
  ok: boolean
  proxyStreamId?: string
  proxyBytes?: number
  proxyBlob?: Blob
  error?: string
}> {
  const emit = (p: RenditionProgress) => onProgress?.(p)
  try {
    // ── 1. Transcode (or reuse cached blob) ──────────────────────────
    let proxyBlob = proxyBlobIfAvailable || null

    // Already proxy-sized? Then the transcode is pure waste — see shouldSkipProxy.
    if (!proxyBlob) {
      const { height, durationSec } = await probeBlob(source)
      if (shouldSkipProxy({ height, durationSec, bytes: source.size })) {
        // eslint-disable-next-line no-console
        console.log(`[rendition] ${videoId}: source is already ${height}p at ` +
          `${((source.size * 8) / (durationSec || 1) / 1e6).toFixed(1)} Mbps — skipping transcode`)
        emit({ phase: 'transcoding', pct: 1, message: `Already ${height}p — no transcode needed` })
        proxyBlob = source
      }
    }

    if (!proxyBlob) {
      emit({ phase: 'transcoding', pct: 0, message: 'Starting transcode…' })
      const t0 = Date.now()
      const result = await generateProxy({
        source,
        inputStem: `v_${videoId}`,
        signal,
        onProgress: (pp: ProxyProgress) => {
          emit({
            phase: 'transcoding',
            pct: pp.progress,
            message: pp.message,
          })
        },
      })
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      proxyBlob = result.blob
      // eslint-disable-next-line no-console
      console.log(
        `[rendition] proxy generated for ${videoId} via ${
          result.engine || 'unknown'
        }: ${(proxyBlob.size / 1024 / 1024).toFixed(1)} MB in ${(
          (Date.now() - t0) /
          1000
        ).toFixed(0)}s`
      )
    }

    // ── 2. Storage first, then Bunny fetches it into Stream ─────────
    // This used to TUS straight to Stream, which left the clip unwatchable
    // until the transcode finished and made it the one path that never got the
    // storage-first change. Both paths share putAndFetch now.
    //
    // WHICH columns: if step 1 skipped the transcode, the blob IS the source,
    // so it is recorded as the ORIGINAL. Calling an untouched file a "proxy"
    // would make has_original mean nothing.
    const asIs = proxyBlob === source
    const r = await putAndFetch({
      videoId, sessionDate, blob: proxyBlob, title: `v_${videoId}`,
      kind: asIs ? 'original' : 'proxy', onProgress, signal,
    })
    if (!r.ok) throw new Error(r.error || 'upload failed')
    return {
      ok: true,
      proxyStreamId: r.streamId,
      proxyBytes: proxyBlob.size,
      proxyBlob,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ phase: 'error', pct: 0, errorMessage: msg })
    return { ok: false, error: msg }
  }
}

export async function uploadOriginalStorageFirst({
  videoId,
  sessionDate,
  source,
  title,
  onProgress,
  signal,
}: BaseArgs & { title: string }): Promise<{
  ok: boolean
  originalPath?: string
  streamId?: string
  streamError?: string
  error?: string
}> {
  const r = await putAndFetch({ videoId, sessionDate, blob: source, title, kind: 'original', onProgress, signal })
  return r.ok
    ? { ok: true, originalPath: r.path, streamId: r.streamId, streamError: r.streamError }
    : { ok: false, error: r.error }
}
