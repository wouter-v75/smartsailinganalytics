// The BYTES half of Flow A: one clip's proxy, from a local blob to a playable
// rendition. src/lib/uploadFlows.ts is the layer above it — the architecture,
// and the one entry point every caller in the app uses. Nothing in the app
// calls this file directly; it is called through uploadClipProxy().
//
// End to end, in order:
//
//   1. Generate a 720p H.264 proxy from the source blob with ffmpeg.wasm (see
//      src/lib/video-proxy.ts). 30–60 s per minute of input on phones, faster
//      on laptops — and SKIPPED entirely when the source is already
//      proxy-sized (shouldSkipProxy), which clips:day output always is.
//   2. PUT the blob to Bunny Storage, direct from the browser on the
//      AccessKey path (src/lib/bunny-storage-upload.ts).
//   3. PATCH the videos row (/api/videos/[id]/renditions) to flip has_proxy and
//      record the path + bytes. The clip is WATCHABLE from here, as a
//      progressive MP4.
//   4. Ask Bunny to fetch it into Stream (/api/stream/fetch) and record the
//      guid, which upgrades it to the adaptive ladder. Everything from here on
//      returns ok with `streamError` if it fails: the clip already plays.
//
// Sequential per video on purpose — the WASM core is single-instance per page,
// so two ffmpeg jobs in parallel only queue and burn more memory.
//
// There is no `syncOriginalForVideo`. The header used to promise one; Flow B
// went a different way in the end (resumable TUS straight to Stream, where the
// `EnabledResolutions` header can ask for the full ladder) and lives in
// useCloudSync's originals queue. putAndFetch below still has an 'original'
// branch, for the one case this file can produce: a source small enough to
// upload untouched, registered as the original because that is what it is.

import { generateProxy, type ProxyProgress } from './video-proxy'
import { uploadBlobToStorage, storageObjectSize, type UploadProgress } from './bunny-storage-upload'
import { awaitUplink, uplinkBusy } from './uplinkPriority'
import { transcodeLock, uploadLock } from './phaseLocks'
import { chooseStrategy } from './uploadStrategy'
import { measuredThroughput, recordEncode, recordUpload } from './uploadStats'
import { webCodecsCanEncodeH264 } from './video-proxy'
// The RESUMABLE path, borrowed from Flow B. See the fallback in putAndFetch.
import { createStreamUpload, uploadFileToStream, FAST_LADDER } from './bunny'
import { writeKey, proxyLeaf, originalLeaf, type StorageScope } from './storageKeys'

/**
 * Where a clip's renditions go. Scoped by team+boat now (src/lib/storageKeys.ts);
 * a clip id is unique, so these never overwrote each other the way the session
 * JSON did — but a flat layout meant a day-wipe on one boat's prefix could reach
 * another's bytes, and nothing in the zone said who owned what.
 *
 * Existing rows are unaffected: the path is WRITTEN to bunny_proxy_path /
 * bunny_original_path and read back verbatim to sign a URL, never rebuilt from a
 * date. Old clips keep their flat path and keep playing.
 */
export function proxyPathFor(
  sessionDate: string, videoId: string, scope?: StorageScope | null
): string {
  return writeKey(scope, sessionDate, proxyLeaf(videoId)) ?? `sessions/${sessionDate}/proxies/${videoId}.mp4`
}
export function originalPathFor(
  sessionDate: string, videoId: string, scope?: StorageScope | null
): string {
  return writeKey(scope, sessionDate, originalLeaf(videoId)) ?? `sessions/${sessionDate}/originals/${videoId}.mp4`
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
  /** Which transcode engine ran — hardware or the software fallback. */
  engine?: 'webcodecs' | 'ffmpeg'
  /**
   * Which route this clip is taking, announced once before any work starts.
   * 'direct' means the file is going up as it is because the link is faster
   * than the encoder; 'transcode' means shrinking it first is the quicker way.
   */
  strategy?: 'direct' | 'transcode'
  bytesUploaded?: number
  bytesTotal?: number
  errorMessage?: string
}

interface BaseArgs {
  videoId: string
  sessionDate: string
  /** Team + boat the clip belongs to; omitted falls back to the flat layout. */
  scope?: StorageScope | null
  source: Blob
  onProgress?: (p: RenditionProgress) => void
  signal?: AbortSignal
  /** Base backoff for retrying the row PATCH (ms). Tests lower it. */
  retryBaseMs?: number
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
 *  this it is worth re-encoding even at 720p; our own trim script caps at 8.
 *
 *  Left at 12 after the proxy target moved from 1.2 to 4.8 Mbps (Nov 2026).
 *  It is deliberately ABOVE clips:day's 8 Mbps cap, so the drone clips — mean
 *  6.10 Mbps measured, four of fifteen pinned at the cap — pass through
 *  untouched rather than being re-encoded to something a fifth smaller and a
 *  generation worse. */
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
 * Storage first, then Bunny fetches it into Stream server-side. Storage first
 * because the clip is watchable the moment its bytes land — as a progressive
 * MP4 — instead of waiting on a transcode. Bunny fetching rather than us
 * uploading twice because the bytes then cross the boat's uplink once.
 *
 * Both KINDS come through here, and they differ only in which columns they
 * write. The distinction is honest: `original` means the file was shipped as it
 * was, `proxy` means it was shrunk first, so has_original never claims to be a
 * file we re-encoded. (Flow B's archive copy does NOT come through here — it
 * TUSes straight to Stream, because that is the only place Bunny lets an upload
 * name its own encoding ladder. See src/lib/uploadFlows.ts.)
 *
 * Anything failing after the row is marked returns ok with `streamError`: the
 * clip already plays, and only the adaptive ladder is missing. Telling the user
 * the upload failed would send them re-uploading footage the team can watch.
 */
async function putAndFetch({
  videoId, sessionDate, scope, blob, title, kind, onProgress, signal, retryBaseMs = 400,
}: {
  videoId: string; sessionDate: string; scope?: StorageScope | null; blob: Blob; title: string
  kind: 'original' | 'proxy'
  onProgress?: (p: RenditionProgress) => void
  signal?: AbortSignal
  retryBaseMs?: number
}): Promise<{ ok: boolean; path?: string; streamId?: string; streamError?: string; error?: string }> {
  const emit = (p: RenditionProgress) => onProgress?.(p)
  const path = kind === 'proxy' ? proxyPathFor(sessionDate, videoId, scope) : originalPathFor(sessionDate, videoId, scope)
  // The row PATCH is a small metadata write to our own API, and a blip there must
  // not cost a clip. Retry the PATCH — NOT the upload: re-sending bytes that are
  // already in Storage fixes nothing about a failed PATCH. (Before the upload
  // paths were consolidated, a failed mark fell through to a re-upload, which was
  // really a roundabout second attempt at the PATCH. putAndFetch dropped that
  // without replacing it, so a single transient failure failed the whole clip.)
  //
  // Only transient failures are retried — network errors, 429 and 5xx. A 4xx is a
  // bug or a permissions problem and will not improve by asking again.
  const mark = async (body: unknown): Promise<Response> => {
    let last: Response | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryBaseMs * 3 ** (attempt - 1)))
      try {
        last = await fetch(`/api/videos/${encodeURIComponent(videoId)}/renditions`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal,
        })
        if (last.ok || !(last.status === 429 || last.status >= 500)) return last
      } catch (e) {
        if (signal?.aborted || attempt === 2) throw e
      }
    }
    return last as Response
  }

  try {
    // Bunny Storage cannot resume a PUT, so the next best thing is not to repeat
    // one that already finished. Only an EXACT size match skips: a truncated
    // object from a dropped upload has the wrong size and is sent again.
    let bytes = blob.size
    const have = await storageObjectSize(path)
    if (have === blob.size) {
      emit({ phase: 'uploading', pct: 1, message: 'Already uploaded — skipping' })
    } else {
      // Yield to a log upload before taking the uplink. Between FILES, not
      // mid-file: Bunny Storage cannot resume a PUT, so stopping one already in
      // flight would throw away everything it had sent. On a queue of twenty
      // clips this is the difference between the log landing after one and
      // after twenty — see uplinkPriority.ts.
      if (uplinkBusy()) {
        emit({ phase: 'uploading', pct: 0, message: 'Waiting — the day\'s log goes first' })
        await awaitUplink()
      }
      // ONE clip's bytes at a time. Not for correctness — the uplink is shared,
      // so parallel uploads finish no sooner in total and each is slower, while
      // a clip is watchable the moment ITS bytes land. Holding it only around
      // the transfer is what lets the next clip ENCODE meanwhile.
      // ONE clip's bytes at a time. Not for correctness — the uplink is shared,
      // so parallel uploads finish no sooner in total and each is slower, while
      // a clip is watchable the moment ITS bytes land. Holding the lock only
      // around the TRANSFER is what lets the next clip encode meanwhile.
      const sentVia = await uploadLock.run(async (): Promise<
        { kind: 'storage'; bytes: number } | { kind: 'tus'; streamId: string }
      > => {
        emit({ phase: 'uploading', pct: 0, message: 'Uploading…' })
        const upT0 = Date.now()
        try {
          const up = await uploadBlobToStorage({
            key: path, blob, contentType: blob.type || 'video/mp4', signal,
            onProgress: (u: UploadProgress) => emit({
              phase: 'uploading', pct: u.fraction,
              message: `${(u.bytesUploaded / 1048576).toFixed(0)} / ${(u.bytesTotal / 1048576).toFixed(0)} MB`,
              bytesUploaded: u.bytesUploaded, bytesTotal: u.bytesTotal,
            }),
          })
          void recordUpload(up.bytes, (Date.now() - upT0) / 1000).catch(() => {})
          return { kind: 'storage', bytes: up.bytes }
        } catch (e: unknown) {
          // ── RESUMABLE FALLBACK ────────────────────────────────────────────
          // Bunny STORAGE cannot resume a PUT. uploadBlobToStorage already
          // retries the whole file three times with backoff and every attempt
          // starts from byte zero, so a connection that drops every few MB never
          // finishes a large clip however often it tries. Measured 27 Nov 2026
          // on field wifi: a 23.6 MB proxy failed twice, "network error during
          // upload", restarting from scratch each time.
          //
          // TUS resumes from the server's own offset, and Flow B already uses
          // it. So when the PUT has given up, send the same bytes that way
          // rather than lose the clip.
          //
          // NOT the primary path, deliberately. The Storage copy is what makes a
          // clip watchable the moment its bytes land, before any ladder exists,
          // and uploading both ways would double the uplink on every good
          // connection to help a bad one. This costs nothing until the normal
          // path has already failed.
          if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e
          const reason = e instanceof Error ? e.message : String(e)
          emit({ phase: 'uploading', pct: 0, message: `Storage upload failed — resuming over TUS (${reason})` })

          const info = await createStreamUpload(`${title}.mp4`, blob.size)
          if (!info?.streamId) throw e
          const file = new File([blob], `${title}.mp4`, { type: blob.type || 'video/mp4' })
          const sent = await uploadFileToStream(info, file, (pct: number) => emit({
            phase: 'uploading',
            pct: Math.max(0, Math.min(1, (pct || 0) / 100)),
            message: `resumable upload ${pct}%`,
          }), { resolutions: FAST_LADDER })
          if (!sent?.ok) throw e
          return { kind: 'tus', streamId: info.streamId }
        }
      }, () => emit({ phase: 'uploading', pct: 0, message: 'Queued — another clip is uploading' }))

      if (sentVia.kind === 'tus') {
        // In Stream, so there is no storage path to record — only the guid.
        // renditionOrder's `proxy` step takes either.
        emit({ phase: 'marking', pct: 0, message: 'Recording rendition…' })
        const markedTus = await mark(kind === 'proxy'
          ? { proxyStream: { streamId: sentVia.streamId, bytes: blob.size } }
          : { original: { streamId: sentVia.streamId } })
        if (!markedTus.ok) {
          const j = await markedTus.json().catch(() => null)
          throw new Error(`recording the rendition failed: ${j?.error || `HTTP ${markedTus.status}`}`)
        }
        emit({ phase: 'done', pct: 1, message: 'Uploaded resumably · adaptive encode queued' })
        return { ok: true, streamId: sentVia.streamId }
      }
      bytes = sentVia.bytes
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
  scope,
  source,
  proxyBlobIfAvailable,
  registerAs = 'auto',
  onProgress,
  signal,
  retryBaseMs,
}: BaseArgs & {
  proxyBlobIfAvailable?: Blob | null
  /**
   * Which column this upload belongs in when NO transcode was needed.
   *
   * 'auto' (the default, and what every existing caller gets) keeps the old
   * rule: an untouched file is the source, so it is recorded as the ORIGINAL.
   *
   * 'proxy' overrides that, and the watch folder passes it. The rule is right
   * for a clip imported raw, and wrong for the one workflow that matters most:
   * clips:day has ALREADY cut and encoded the day's racing to 720p, so the file
   * the watcher uploads is a review copy by construction — the full-resolution
   * original is the 4K still sitting on the card. Recording it as an "original"
   * made has_original claim something untrue AND left has_proxy false, which is
   * why 154 clips:day rows carry an original and not one carries a proxy.
   *
   * Whether a transcode happened is a fact about the ENCODE. What column the
   * file belongs in is a fact about the WORKFLOW, and only the caller knows it.
   */
  registerAs?: 'auto' | 'proxy'
}): Promise<{
  ok: boolean
  proxyStreamId?: string
  proxyBytes?: number
  proxyBlob?: Blob
  /** Storage key the rendition landed on — the caller records it locally. */
  proxyPath?: string
  /** Uploaded and playable, but the adaptive encode could not be queued. */
  streamError?: string
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
        emit({ phase: 'transcoding', pct: 1, strategy: 'direct',
          message: `already ${height}p — nothing to re-encode` })
        proxyBlob = source
      } else {
        // ── IS THE ENCODE WORTH IT ON THIS CONNECTION? ───────────────────
        // shouldSkipProxy above is a question about the FILE: a clip that is
        // already a review copy gains nothing from being re-encoded. This is a
        // question about the LINK, and it has a different answer on a dock and
        // in a flat. Shrinking a clip before sending it pays when bytes are the
        // bottleneck and costs minutes of CPU when they are not — and on the
        // 27 Nov test the "proxy" came out the same size as its source, so the
        // encode bought precisely nothing.
        //
        // Both strategies leave a progressive MP4 in Storage, so either way the
        // clip is watchable the moment its bytes land — which is the part that
        // matters locally, because Bunny's free encoding ladder can take hours.
        // That makes this purely a question of which finishes sooner, and
        // uploadStrategy.ts does that arithmetic from measurements this device
        // has taken. With no measurements it chooses the transcode, which is
        // what the app has always done.
        const engine = (await webCodecsCanEncodeH264().catch(() => false)) ? 'webcodecs' : 'ffmpeg'
        const { uplinkBps, encodeBps } = await measuredThroughput(engine).catch(
          () => ({ uplinkBps: null, encodeBps: null })
        )
        const decision = chooseStrategy({
          sourceBytes: source.size, durationSec, height, uplinkBps, encodeBps,
        })
        // eslint-disable-next-line no-console
        console.log(`[rendition] ${videoId}: ${decision.strategy} — ${decision.why}`)
        emit({ phase: 'transcoding', pct: decision.strategy === 'direct' ? 1 : 0,
          strategy: decision.strategy, message: decision.why })
        if (decision.strategy === 'direct') proxyBlob = source
      }
    }

    if (!proxyBlob) {
      emit({ phase: 'transcoding', pct: 0, message: 'Starting transcode…' })
      const t0 = Date.now()
      // ONE transcode at a time: ffmpeg.wasm is a single instance with one
      // virtual filesystem, so two at once would overwrite each other's files.
      // Holding the lock here (rather than around the whole clip) is what lets
      // the NEXT clip encode while this one uploads — see phaseLocks.ts.
      const result = await transcodeLock.run(() => generateProxy({
        source,
        inputStem: `v_${videoId}`,
        signal,
        onProgress: (pp: ProxyProgress) => {
          emit({
            phase: 'transcoding',
            pct: pp.progress,
            message: pp.message,
            engine: pp.engine,
          })
        },
      }), () => emit({ phase: 'transcoding', pct: 0,
        message: 'Queued — another clip is encoding' }))
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      proxyBlob = result.blob
      // What it cost, in bytes of SOURCE per second, so the next clip can be
      // decided on this device's real speed rather than on a default.
      void recordEncode(source.size, (Date.now() - t0) / 1000, result.engine).catch(() => {})
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
    // WHICH COLUMN. If a transcode produced the blob it is unambiguously a
    // proxy. If it did not, the blob IS the source — and then only the caller
    // knows whether that source is the clip's full resolution (register it as
    // the original) or a review copy something upstream already made (register
    // it as the proxy). See `registerAs` above.
    const asIs = proxyBlob === source
    const kind: 'original' | 'proxy' =
      !asIs || registerAs === 'proxy' ? 'proxy' : 'original'
    const r = await putAndFetch({
      videoId, sessionDate, scope, blob: proxyBlob, title: `v_${videoId}`,
      kind, onProgress, signal, retryBaseMs,
    })
    if (!r.ok) throw new Error(r.error || 'upload failed')
    return {
      ok: true,
      proxyStreamId: r.streamId,
      proxyBytes: proxyBlob.size,
      proxyBlob,
      proxyPath: r.path,
      streamError: r.streamError,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ phase: 'error', pct: 0, errorMessage: msg })
    return { ok: false, error: msg }
  }
}
