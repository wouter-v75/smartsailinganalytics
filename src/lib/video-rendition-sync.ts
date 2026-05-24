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
import { uploadBlobToStorage, type UploadProgress } from './bunny-storage-upload'
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
    const uploadInfo = await createStreamUpload(proxyFile.name, proxyFile.size)
    if (!uploadInfo?.streamId) {
      throw new Error('Bunny Stream create failed')
    }
    const streamOk = await uploadFileToStream(
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
    if (!streamOk) throw new Error('Bunny Stream upload failed')

    // ── 3. Mark in Supabase ──────────────────────────────────────────
    emit({ phase: 'marking', pct: 0, message: 'Recording rendition…' })
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxyStream: { streamId: uploadInfo.streamId, bytes: proxyBlob.size },
      }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(`PATCH renditions: ${j?.error || res.status}`)
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
}: BaseArgs): Promise<{
  ok: boolean
  originalPath?: string
  error?: string
}> {
  const emit = (p: RenditionProgress) => onProgress?.(p)
  try {
    const originalPath = originalPathFor(sessionDate, videoId)
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
