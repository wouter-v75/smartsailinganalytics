// ─────────────────────────────────────────────────────────────────────────────
// THE TWO WAYS A CLIP REACHES THE CLOUD
//
// There are two, they are deliberately different, and every button in the app
// that uploads a clip is one of them. If you are reading this to find out what a
// third one does: there isn't a third one any more, and the note at the bottom
// says what the one that used to exist cost.
//
// ── FLOW A · "the team can watch it now" ───────────────────────────────────
//   what   whichever of these gets the clip up SOONER, decided per clip from
//          measurements this device has taken (uploadStrategy.ts):
//            • a 720p review copy at ~5 Mbps, transcoded in the browser —
//              WebCodecs on the device's hardware encoder, ffmpeg.wasm if it
//              has none; or
//            • the file exactly as it is, when the link is faster than the
//              encoder, or the source is already a review copy
//              (shouldSkipProxy — clips:day output always is).
//          Shrinking first pays when BYTES are the bottleneck, which on dock
//          wifi with a 2 GB card file is the difference between arriving and
//          not. It is pure cost when they are not: on a laptop on good wifi it
//          spends minutes of CPU and produces a worse copy than Bunny would
//          make from the full-quality source. Measured 27 Nov 2026, the "proxy"
//          for a 35 s clip came out the same size as its original.
//   how    Bunny STORAGE first, by direct browser PUT, then `videos/fetch` asks
//          Bunny to pull it into Stream server-side. Storage first because the
//          clip is watchable the moment its bytes land, as a progressive MP4 —
//          which matters more here than anywhere, because Bunny's own free
//          encoding "may take anywhere from several hours to multiple days"
//          under load. Bunny pulling rather than us uploading twice because the
//          bytes then cross the boat's uplink once. When the PUT cannot finish
//          — Storage has no resume, so each retry restarts from zero — it falls
//          back to resumable TUS, the same protocol Flow B uses.
//   ladder the LIBRARY DEFAULT (360p + 720p). `videos/fetch` takes no encoding
//          options at all, so this is not settable from code — see FAST_LADDER
//          in bunny.js, which is the written-down form of that dashboard value.
//   lands  bunny_proxy_path + has_proxy when it was shrunk; bunny_original_path
//          + has_original when it went up as it is, because that is what it is.
//          Either way a bunny_*_stream_id once the ladder exists.
//   entry  uploadClipProxy() below. EVERY such upload goes through it.
//
// ── FLOW B · the original — "the archive copy, this evening" ────────────────
//   what   the source file, untouched.
//   how    resumable TUS straight to Bunny Stream. No Storage copy: Stream
//          holds the original itself.
//   ladder FULL_LADDER, set per upload via the TUS `EnabledResolutions` header
//          — the one place Bunny documents it as settable.
//   lands  bunny_original_stream_id, has_original
//   entry  processOriginalsQueue() in components/ssa/useCloudSync.js, behind
//          the "Upload originals" button. One caller, so it is not extracted
//          here; it is deliberately manual because originals are multi-GB.
//
// Why A is automatic and B is a button: A is minutes and megabytes and is what
// the crew want before dinner. B is hours and gigabytes and wants a hotel wifi.
//
// WHY THERE IS A BROWSER TRANSCODE HERE AT ALL, when Mux, Cloudflare Stream,
// Vimeo, Frame.io and Wistia all take the original and transcode server-side:
// because their users are not on a boat. Browser transcoding is the minority
// choice everywhere, and it is taken for exactly one reason — when the uplink
// is the constraint. What the industry invests in instead is the TRANSFER
// (chunked, resumable, adapting to the network), and that argument is taken
// here too: hence the TUS fallback above, and hence the decision being measured
// rather than fixed. The local difference is Bunny's encoding queue, which is
// why uploading the original and waiting for the ladder to make a 720p rung is
// right for quality and wrong for getting the day watched.
//
// ── and the flow that used to exist ─────────────────────────────────────────
// `syncSessionToCloud` also uploaded videos: create a Stream video, TUS the
// whole file with NO ladder, record the guid in `bunny_stream_id`. Three
// buttons reached it. It produced a full-resolution copy in the column
// `resolveLegacy()` tries LAST — so for any clip that also had a proxy or an
// original, nothing ever played it. Migration 0107 cleared 69.7 GB of those.
// It is gone; `bunny_stream_id` is now read-only to the app, and only the admin
// backfill (which reads historical meta.json) still writes it.
// ─────────────────────────────────────────────────────────────────────────────

import { ensureCloudVideoId } from './cloud-videos'
import { getVideoBlob, markVideoProxyUploaded } from './localStore'
import { currentStorageScope } from './storageScope'
import { getBrowserSupabase } from './supabase/browser'
import { syncProxyForVideo, type RenditionProgress } from './video-rendition-sync'

/** The local clip record, as IndexedDB and the library's merged shape hold it. */
export interface ClipRecord {
  id: string
  title?: string | null
  name?: string | null
  sessionDate?: string | null
  startUtc?: number | string | null
  duration?: number | null
  tags?: string[]
  size?: number | null
  streamId?: string | null
}

export interface ProxyUploadResult {
  ok: boolean
  /** The Supabase row the rendition was recorded against. */
  cloudId?: string
  proxyPath?: string | null
  proxyStreamId?: string | null
  proxyBytes?: number
  /** Uploaded and playable, but the adaptive encode could not be queued. */
  streamError?: string
  /** User-facing, and meant to be shown rather than logged. */
  error?: string
}

/**
 * FLOW A, end to end, for one clip.
 *
 * This existed four times — the watch folder, the auto-sync queue, the
 * per-clip panel, and Push to Cloud — in four slightly different orders, and
 * only one of the four recorded the upload on this device. That mattered: the
 * local mark is what `alreadyInCloud()` reads, so the three that skipped it
 * left the next Push to Cloud believing the clip had never been sent.
 *
 * The blob is checked BEFORE the cloud row is created: a clip with no bytes on
 * this device cannot be uploaded from here whatever we do, and creating a row
 * for it only puts an unplayable entry in everyone's library.
 */
export async function uploadClipProxy({
  video,
  sessionDate,
  registerAs = 'auto',
  syncOffsets,
  onProgress,
  signal,
}: {
  video: ClipRecord
  /** Fallback when the clip carries no session date of its own. */
  sessionDate: string
  /**
   * 'proxy' when the CALLER knows the file is already a review copy — the watch
   * folder passes it, because clips:day has already cut and encoded the day's
   * racing to 720p and the real original is the 4K still on the card. See
   * syncProxyForVideo for why only the caller can know this.
   */
  registerAs?: 'auto' | 'proxy'
  syncOffsets?: Record<string, number>
  onProgress?: (p: RenditionProgress) => void
  signal?: AbortSignal
}): Promise<ProxyUploadResult> {
  const date = video.sessionDate || sessionDate
  if (!date) return { ok: false, error: 'no session date for this clip' }

  const blob = await getVideoBlob(video.id)
  if (!blob) {
    return { ok: false, error: 'no video data on this device — re-import the clip' }
  }

  let userId: string | null = null
  try {
    const { data: { user } } = await getBrowserSupabase().auth.getUser()
    userId = user?.id || null
  } catch { /* treated as signed out */ }
  if (!userId) return { ok: false, error: 'not signed in — sign in and try again' }

  let cloudId: string | null
  try {
    cloudId = await ensureCloudVideoId({ userId, video, sessionDate: date, syncOffsets })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!cloudId) {
    return { ok: false, error: "no active boat workspace — can't create the cloud entry" }
  }

  const res = await syncProxyForVideo({
    videoId: cloudId,
    sessionDate: date,
    scope: await currentStorageScope(),
    source: blob,
    registerAs,
    onProgress,
    signal,
  })
  if (!res.ok) return { ok: false, cloudId, error: res.error || 'upload failed' }

  // Record it HERE, for every caller. cloudId is load-bearing and not
  // bookkeeping: the timeline, the campaign notes and the debrief reel all hand
  // the player a Supabase id while the library is keyed by this device's IDB id,
  // so without the link the lookup misses and the player falls back to the day's
  // first clip — every card in the timeline opening the race start, with
  // thumbnails that look right because they come from the cloud rows.
  await markVideoProxyUploaded(video.id, {
    cloudId,
    proxyPath: res.proxyPath || null,
    proxyStreamId: res.proxyStreamId || null,
  })

  return {
    ok: true,
    cloudId,
    proxyPath: res.proxyPath || null,
    proxyStreamId: res.proxyStreamId || null,
    proxyBytes: res.proxyBytes,
    streamError: res.streamError,
  }
}
