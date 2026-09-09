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
// @ts-ignore — bunny.js is plain JS without type declarations
import { createStreamUpload, uploadFileToStream } from './bunny'

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

    // ── 2. Upload proxy to Bunny Stream ──────────────────────────────
    // Bunny Stream encodes the proxy into an adaptive-bitrate HLS ladder
    // (240p–720p) so playback adapts to the viewer's connection. TUS is
    // resumable — survives dropped connections on weak field wifi.
    emit({ phase: 'uploading', pct: 0, message: 'Uploading to Bunny Stream…' })
    const proxyFile = new File([proxyBlob], `${videoId}.mp4`, {
      type: 'video/mp4',
    })
    // Each network step names itself. A bare `TypeError: Failed to fetch` (blocked or
    // dropped request) is otherwise anonymous — the user is told the upload failed but
    // not WHICH of the five round-trips died, which is what left us guessing.
    let uploadInfo: any
    try {
      uploadInfo = await createStreamUpload(proxyFile.name, proxyFile.size)
    } catch (e: any) {
      throw new Error(`could not reach the app server to start the upload (${e?.message || 'network error'})`)
    }
    if (!uploadInfo?.streamId) {
      throw new Error('Bunny Stream create failed (no stream id returned)')
    }
    let streamOk = false
    try {
      streamOk = await uploadFileToStream(
        uploadInfo,
        proxyFile,
        (pct: number) => {
          emit({
            phase: 'uploading',
            pct: (pct || 0) / 100,
            message: `Uploading to Bunny Stream… ${pct || 0}%`,
          })
        }
      )
    } catch (e: any) {
      throw new Error(`upload to Bunny Stream failed (${e?.message || 'network error'})`)
    }
    if (!streamOk) throw new Error('upload to Bunny Stream failed (rejected)')

    // ── 3. Mark in Supabase ──────────────────────────────────────────
    emit({ phase: 'marking', pct: 0, message: 'Recording rendition…' })
    let res: Response
    try {
      res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proxyStream: { streamId: uploadInfo.streamId, bytes: proxyBlob.size },
        }),
      })
    } catch (e: any) {
      throw new Error(`uploaded, but could not record it (${e?.message || 'network error'})`)
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(`recording the rendition failed: ${j?.error || `HTTP ${res.status}`}`)
    }

    emit({ phase: 'done', pct: 1, message: 'Proxy ready' })
    return {
      ok: true,
      proxyStreamId: uploadInfo.streamId,
      proxyBytes: proxyBlob.size,
      proxyBlob,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ phase: 'error', pct: 0, errorMessage: msg })
    return { ok: false, error: msg }
  }
}

/**
 * Upload the original (full-resolution) source blob and flip has_original.
 * No transcode step — we ship the bytes as-is. Used by the (future) "Full
 * sync" button.
 */
export async function syncOriginalForVideo({
  videoId,
  sessionDate,
  source,
  onProgress,
  signal,
  skipIfPresent = false,
}: BaseArgs & { skipIfPresent?: boolean }): Promise<{
  ok: boolean
  originalPath?: string
  skipped?: boolean
  error?: string
}> {
  const emit = (p: RenditionProgress) => onProgress?.(p)
  try {
    const originalPath = originalPathFor(sessionDate, videoId)

    // Bunny Storage cannot resume a PUT, so the next best thing is not to
    // repeat one that already finished. An interrupted batch re-run then picks
    // up where it stopped instead of sending the whole card again.
    //
    // Only an EXACT size match counts. storageObjectSize returns null on any
    // doubt, and a truncated object from a dropped upload has the wrong size,
    // so both fall through to a re-upload. Re-uploading costs minutes; wrongly
    // skipping loses footage from a day that cannot be sailed again.
    if (skipIfPresent) {
      const have = await storageObjectSize(originalPath)
      if (have != null && have === source.size) {
        emit({ phase: 'marking', pct: 1, message: 'Already uploaded — skipping' })
        const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ original: { path: originalPath, bytes: have } }),
        })
        if (res.ok) {
          emit({ phase: 'done', pct: 1, message: 'Already uploaded' })
          return { ok: true, originalPath, skipped: true }
        }
        // Marking failed — fall through and upload properly rather than
        // returning ok for a row that does not point at the file.
      }
    }

    emit({ phase: 'uploading', pct: 0, message: 'Uploading original…' })
    const up = await uploadBlobToStorage({
      key: originalPath,
      blob: source,
      contentType: source.type || 'video/mp4',
      signal,
      onProgress: (u: UploadProgress) => {
        emit({
          phase: 'uploading',
          pct: u.fraction,
          message: `${(u.bytesUploaded / 1024 / 1024).toFixed(0)} / ${(
            u.bytesTotal /
            1024 /
            1024
          ).toFixed(0)} MB`,
          bytesUploaded: u.bytesUploaded,
          bytesTotal: u.bytesTotal,
        })
      },
    })

    emit({ phase: 'marking', pct: 0, message: 'Recording rendition…' })
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: { path: up.key, bytes: up.bytes } }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(`PATCH renditions: ${j?.error || res.status}`)
    }
    emit({ phase: 'done', pct: 1, message: 'Original ready' })
    return { ok: true, originalPath: up.key }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ phase: 'error', pct: 0, errorMessage: msg })
    return { ok: false, error: msg }
  }
}

/**
 * Upload an original STORAGE-FIRST, then hand it to Bunny Stream to fetch.
 *
 * The ordering is the whole point. Uploading straight to Stream leaves a clip
 * unwatchable until transcoding finishes — 60 to 120 minutes on this library,
 * which is far longer than the trim (~6 min) and the upload (~20 min) combined,
 * and was the real reason footage reached the team late. Landing it in Storage
 * first makes it playable as a progressive 720p MP4 the moment the bytes are
 * there, per clip: the first clip is watchable minutes in, not after the card.
 *
 * Stream still gets built, because the crew watches on poor 3G and needs the
 * lower rungs of the adaptive ladder. But Bunny FETCHES it from Storage
 * server-side (see /api/stream/fetch), so the bytes cross our uplink once. The
 * URL route already prefers the ladder and falls back to the MP4, so playback
 * upgrades on its own with nothing to do at the call site.
 *
 * A failure after the Storage step is NOT a failure of the upload. The clip is
 * already watchable; all that is lost is the ladder. We report it and return ok,
 * because telling the user their upload failed when the team can watch it would
 * be worse than the missing renditions.
 */
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
  const stored = await syncOriginalForVideo({
    videoId, sessionDate, source, onProgress, signal, skipIfPresent: true,
  })
  if (!stored.ok || !stored.originalPath) return stored

  // From here the clip is already playable. Everything below is the upgrade.
  onProgress?.({ phase: 'marking', pct: 0, message: 'Queuing adaptive encode…' })
  try {
    const res = await fetch('/api/stream/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: stored.originalPath, title }),
      signal,
    })
    const j = (await res.json().catch(() => null)) as { streamId?: string; error?: string } | null
    if (!res.ok || !j?.streamId) {
      const streamError = j?.error || `HTTP ${res.status}`
      onProgress?.({ phase: 'done', pct: 1, message: 'Playable — adaptive encode not queued' })
      return { ok: true, originalPath: stored.originalPath, streamError }
    }

    // Record the stream id so the URL route starts preferring the ladder as soon
    // as Bunny finishes with it.
    const mark = await fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: { streamId: j.streamId } }),
      signal,
    })
    if (!mark.ok) {
      const m = await mark.json().catch(() => null)
      onProgress?.({ phase: 'done', pct: 1, message: 'Playable — stream id not recorded' })
      return {
        ok: true,
        originalPath: stored.originalPath,
        streamId: j.streamId,
        streamError: `PATCH renditions: ${m?.error || mark.status}`,
      }
    }

    onProgress?.({ phase: 'done', pct: 1, message: 'Playable now · adaptive encode queued' })
    return { ok: true, originalPath: stored.originalPath, streamId: j.streamId }
  } catch (e: unknown) {
    const streamError = e instanceof Error ? e.message : String(e)
    return { ok: true, originalPath: stored.originalPath, streamError }
  }
}
