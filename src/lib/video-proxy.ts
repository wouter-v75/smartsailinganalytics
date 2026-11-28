// Client-side proxy generation — two engines, picked at runtime.
//
// A "proxy" is a small, mobile-friendly preview: 1280×720, H.264, ~1.2 Mbps
// video, faststart so streaming begins before the file finishes. Full quality
// is carried by the separately-uploaded original.
//
// Engine 1 — WebCodecs (preferred). Uses the device's *hardware* H.264
//   encoder via the Mediabunny library. Typically 5–20× faster than software,
//   with the biggest gains on phones. No SharedArrayBuffer / COOP-COEP needed.
// Engine 2 — ffmpeg.wasm (fallback). Pure-software encode in WebAssembly.
//   Used automatically when WebCodecs is unavailable (old iOS Safari, etc.)
//   or when the WebCodecs path throws for any reason.
//
// `generateProxy()` tries engine 1, then transparently falls back to engine 2,
// so callers don't need to know which ran (the result carries `engine`).
//
// Types intentionally `any`-loose for the dynamically-imported modules: they
// are lazy-loaded and only exist at runtime in the browser.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProxyProgress {
  /** 0..1 transcoding progress within the current job. */
  progress: number
  /**
   * Which engine is producing this. Worth reporting: hardware is 5-20× faster
   * and needs no network, software needs a CDN download and turns a clip into
   * a coffee break — and nothing used to say which one a device had fallen to.
   */
  engine?: 'webcodecs' | 'ffmpeg'
  /** Status line, useful for diagnostics / the progress UI. */
  message?: string
  /**
   * Why the hardware engine was abandoned, reported once as the software
   * engine takes over.
   *
   * THE REASON THIS EXISTS. The fallback is silent by design — a clip that
   * encodes slowly is better than a clip that fails — but silence turned a
   * 5-20× slowdown into something nobody could see. On 28 Nov 2026 a 60 s
   * 1080p clip took 62 SECONDS to encode at 3 MB/s of source on a Mac whose
   * own probe reports a working hardware encoder, and the only record of why
   * was a console.warn in a browser console nobody had open. Every clip this
   * app has ever made may have gone this way.
   */
  fallbackReason?: string
}

export interface GenerateProxyArgs {
  /** Source file or blob (e.g. from IndexedDB or a freshly-imported File). */
  source: File | Blob
  /** Stem for tmp file names inside ffmpeg's virtual fs. Default: 'src'. */
  inputStem?: string
  /** Optional progress callback. */
  onProgress?: (p: ProxyProgress) => void
  /** Optional abort signal (honoured by the WebCodecs engine). */
  signal?: AbortSignal
}

export interface ProxyResult {
  blob: Blob
  bytes: number
  /** MIME of the produced proxy. */
  type: 'video/mp4'
  /** Which engine produced this proxy. */
  engine?: 'webcodecs' | 'ffmpeg'
}

// Proxy target spec — shared by both engines so output is consistent.
//
// 4.8 Mbps, not the 1.2 it was. Two measurements settled that:
//
//   • Cloudflare publish 4.8 Mbps as their recommended INGEST bitrate for 720p
//     (1080p 8, 480p 2.4, 360p 1). 1.2 was a quarter of that, on water, wake
//     and spray — the worst content for a low bitrate, not the best.
//   • The drone clips `clips:day` produces are 720p at a measured MEAN of
//     6.10 Mbps, four of fifteen pinned against its `--maxrate 8M` cap. A
//     1.2 Mbps proxy was a 5× cut of that; 4.8 is a modest one.
//
// It is also inside Mux's published "standard input" envelope (H.264, <= 1080p,
// average under 8 Mbps, closed GOP), which platforms use to skip a mezzanine
// transcode on ingest.
const PROXY_HEIGHT = 720
const PROXY_VIDEO_BITRATE = 4_800_000 // bits/sec — see above
const PROXY_FPS = 30

// ════════════════════════════════════════════════════════════════════════════
// Engine 1 — WebCodecs (via Mediabunny)
// ════════════════════════════════════════════════════════════════════════════

// One-shot capability probe: does this browser have a working H.264 video
// encoder? Cached — the probe is cheap but we only need it once per page.
let webCodecsProbe: Promise<boolean> | null = null
/**
 * Can this browser encode H.264 in hardware?
 *
 * Exported for the dock-side readiness check (uploadReadiness.ts): the answer
 * decides whether a device needs to download ffmpeg.wasm at all, which is the
 * one part of the pipeline that needs the network before a clip can be made.
 * Cached, so asking costs nothing after the first time.
 */
export function webCodecsCanEncodeH264(): Promise<boolean> {
  if (webCodecsProbe) return webCodecsProbe
  webCodecsProbe = (async () => {
    // Reference the globals defensively so this compiles regardless of the
    // TS lib version, and is safe under SSR.
    const VE: any = (globalThis as any).VideoEncoder
    const VD: any = (globalThis as any).VideoDecoder
    if (!VE || !VD || typeof VE.isConfigSupported !== 'function') return false
    try {
      const support = await VE.isConfigSupported({
        codec: 'avc1.42E01F', // H.264 constrained-baseline, level 3.1 (720p)
        width: 1280,
        height: 720,
        bitrate: PROXY_VIDEO_BITRATE,
        framerate: PROXY_FPS,
      })
      return !!support?.supported
    } catch {
      return false
    }
  })()
  return webCodecsProbe
}

/**
 * Where the moov atom goes — the difference between a progressive MP4 and one
 * a player must download in full before it can start.
 *
 * IT WAS `'in-place'`, WHICH IS NOT A VALUE MEDIABUNNY ACCEPTS. It takes
 * `false | 'in-memory' | 'reserve' | 'fragmented'` and throws a TypeError on
 * anything else — from the Mp4OutputFormat CONSTRUCTOR, before a frame is
 * read. generateProxy catches that and falls back to ffmpeg.wasm, so the
 * hardware engine had never once run: every proxy this app has ever made was
 * software, 5-20× slower, and the only trace was a console.warn. Measured on
 * 28 Nov 2026: 62 s of CPU for a 60 s clip, at 3 MB/s of source.
 *
 * `'in-memory'` is the right one here and costs nothing extra, because the
 * target is a BufferTarget — the whole output is already held in memory.
 * `'reserve'` needs the size up front and `'fragmented'` produces fMP4, which
 * is a different file for no gain when the bytes are buffered anyway.
 *
 * Exported so a test can hand the real value to the real library. The bug
 * survived because `mb: any` meant tsc checked none of this.
 */
export const PROXY_FAST_START = 'in-memory' as const

/**
 * Bumped whenever a change could alter WHICH ENGINE runs or how fast it runs.
 *
 * uploadStats remembers the engine that last ran and trusts it over the
 * capability probe, which is right — the fallback is silent, so a probe saying
 * "hardware" on a device that always falls back would be optimistic by 5-20×
 * in the one direction that skips a proxy the link needed.
 *
 * But that memory outlives the code. On 28 Nov 2026 the hardware engine was
 * fixed after never once having run, and every existing device still
 * remembered `ffmpeg` at 3 MB/s — which on a 50 Mbit link says "send it as it
 * is" and so would never retry the engine that had just been repaired. The fix
 * would have shipped to nobody.
 *
 * So the remembered engine carries the version it was learned under and is
 * ignored when that does not match, falling back to the probe and letting the
 * next clip find out for itself. Same pattern as SAILTRIM_VERSION, for the
 * same reason: a stored measurement is only as good as the code that made it.
 *
 * 2 — fastStart fixed; the WebCodecs engine can run for the first time.
 */
export const PROXY_PIPELINE_VERSION = 2

async function generateProxyWebCodecs({
  source,
  onProgress,
  signal,
}: GenerateProxyArgs): Promise<ProxyResult> {
  // Mediabunny is a lazy import so it code-splits out of the main bundle. It
  // is TYPED, deliberately: the `any` that used to be here is what let an
  // invalid fastStart through every check this repo runs.
  const {
    Input,
    Output,
    Conversion,
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Mp4OutputFormat,
  } = await import('mediabunny')

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  })
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: PROXY_FAST_START }),
    target: new BufferTarget(),
  })

  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary', // keep only the primary video + audio track
    video: {
      height: PROXY_HEIGHT, // width auto-derived to preserve aspect ratio
      frameRate: PROXY_FPS,
      bitrate: PROXY_VIDEO_BITRATE,
      codec: 'avc', // H.264
    },
    // Audio is intentionally left unconfigured: Mediabunny copies the audio
    // track without re-encoding whenever possible. That keeps this path
    // working on iOS's partial WebCodecs (which has no AudioEncoder).
  })

  if (!conversion.isValid) {
    const reasons = (conversion.discardedTracks || [])
      .map((d: any) => d?.reason)
      .filter(Boolean)
      .join(', ')
    throw new Error(`mediabunny conversion not valid${reasons ? `: ${reasons}` : ''}`)
  }

  conversion.onProgress = (p: number) => {
    onProgress?.({
      progress: Math.min(0.999, Math.max(0, p || 0)),
      message: 'Hardware transcode',
      engine: 'webcodecs',
    })
  }

  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    signal.addEventListener(
      'abort',
      () => {
        // Best-effort — cancel() makes execute() reject.
        conversion.cancel?.().catch(() => {})
      },
      { once: true }
    )
  }

  await conversion.execute()

  const buf: ArrayBuffer | null = output.target?.buffer ?? null
  if (!buf || buf.byteLength === 0) {
    throw new Error('mediabunny produced an empty file')
  }
  const blob = new Blob([buf], { type: 'video/mp4' })
  return { blob, bytes: blob.size, type: 'video/mp4', engine: 'webcodecs' }
}

// ════════════════════════════════════════════════════════════════════════════
// Engine 2 — ffmpeg.wasm (fallback)
// ════════════════════════════════════════════════════════════════════════════

let ffmpegInstance: any = null

// WHOSE transcode the log line belongs to.
//
// The instance is a singleton and `ensureFFmpeg` returns early once it exists,
// so an `onLog` passed on any later call used to be dropped on the floor — the
// listener stayed bound to the FIRST caller's closure for the life of the page.
// Every subsequent clip's ffmpeg output was therefore delivered to the first
// clip's progress handler, which is how an upload log came to read:
//
//   ✓ 20261127120000 … — 720p is up, the team can watch it now
//   ⟳ 20261127121500 … — encoding to 720p…
//   ⟳ 20261127120000 … — encoding to 720p…     ← finished clip, second's output
//
// and why the second clip got no messages of its own at all. The sink is set
// per RUN and cleared in the same finally that removes the progress listener,
// so the log stream belongs to whichever transcode is actually running.
let logSink: ((msg: string) => void) | null = null

async function ensureFFmpeg(onLog?: (msg: string) => void): Promise<any> {
  logSink = onLog || null
  if (ffmpegInstance) return ffmpegInstance
  // Dynamic imports so the heavy WASM bundle stays out of the initial route
  // chunk; only paid for when a proxy actually needs the fallback engine.
  const ffMod = await import('@ffmpeg/ffmpeg')
  const utilMod = await import('@ffmpeg/util')
  const { FFmpeg } = ffMod
  const { toBlobURL } = utilMod
  const ff = new FFmpeg()
  ff.on('log', ({ message }: { message: string }) => logSink?.(message))
  // Load WASM core from the unpkg CDN as recommended by the ffmpeg.wasm docs.
  //
  // This is a RUNTIME fetch to a third party from the user's device. When it fails —
  // captive portal, flaky field wifi, DNS, an ad/tracker blocker — `toBlobURL` throws a
  // bare `TypeError: Failed to fetch` with no hint of what it was fetching, which is
  // exactly what a phone user was left staring at. Name the step.
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'
  let coreURL: string, wasmURL: string
  try {
    coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')
    wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
  } catch (e: any) {
    throw new Error(
      `could not download the video encoder from unpkg.com (${e?.message || 'network error'}) — check the connection, or a blocker may be stopping it`
    )
  }
  try {
    await ff.load({ coreURL, wasmURL })
  } catch (e: any) {
    throw new Error(`video encoder failed to start: ${e?.message || 'unknown error'}`)
  }
  ffmpegInstance = ff
  return ff
}

async function generateProxyFFmpeg({
  source,
  inputStem = 'src',
  onProgress,
}: GenerateProxyArgs): Promise<ProxyResult> {
  // A LOG LINE IS NOT PROGRESS. ffmpeg emits many log lines between progress
  // events, and sending them as `progress: 0` rewound the bar to zero after
  // every one — so the messages changed constantly while the bar never moved,
  // which reads as "the encoder is stuck" when it is working perfectly. The
  // last real figure is carried on the message instead.
  let lastProgress = 0
  const ff = await ensureFFmpeg((msg) =>
    onProgress?.({ progress: lastProgress, message: msg })
  )

  // Wire progress event → caller. ffmpeg emits 0..1 floats.
  const onProgressEv = ({ progress }: { progress: number }) => {
    lastProgress = Math.min(0.999, Math.max(0, progress))
    onProgress?.({ progress: lastProgress, message: 'Software transcode', engine: 'ffmpeg' })
  }
  ff.on('progress', onProgressEv)

  const inputName = `${inputStem}.mp4`
  const outputName = `${inputStem}.proxy.mp4`

  try {
    const buf = new Uint8Array(await source.arrayBuffer())
    await ff.writeFile(inputName, buf)

    // Speed-tuned for field upload. -vf scale=-2:720,fps=30 caps height +
    // framerate; -preset ultrafast -tune zerolatency for a fast encode;
    // +faststart so the file is streamable.
    //
    // The bitrate args are derived from PROXY_VIDEO_BITRATE rather than written
    // out, so the two engines cannot drift — they used to be '1200k' here and a
    // constant there, and only one of them would have been changed.
    //
    // `-g` pins a 2-second keyframe interval and `-x264-params scenecut=0`
    // keeps the GOP closed: both are part of Mux's published "standard input"
    // envelope, which lets a platform skip its own mezzanine pass on ingest.
    const kbps = Math.round(PROXY_VIDEO_BITRATE / 1000)
    await ff.exec([
      '-i', inputName,
      '-vf', `scale=-2:${PROXY_HEIGHT},fps=${PROXY_FPS}`,
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', `${kbps}k`,
      '-maxrate', `${Math.round(kbps * 1.25)}k`,
      '-bufsize', `${Math.round(kbps * 2.5)}k`,
      '-g', String(PROXY_FPS * 2),
      '-x264-params', 'scenecut=0',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ])

    const data = await ff.readFile(outputName)
    // ffmpeg returns a Uint8Array; copy into a fresh ArrayBuffer so the Blob
    // constructor types are happy (avoids SharedArrayBuffer inference).
    const bytes = new Uint8Array(data as ArrayBufferLike).slice().buffer
    const blob = new Blob([bytes], { type: 'video/mp4' })

    try { await ff.deleteFile(inputName) } catch {}
    try { await ff.deleteFile(outputName) } catch {}

    return { blob, bytes: blob.size, type: 'video/mp4', engine: 'ffmpeg' }
  } finally {
    ff.off('progress', onProgressEv)
    logSink = null
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a 720p / ~1.2 Mbps H.264 proxy from the given source blob.
 *
 * Tries the hardware-accelerated WebCodecs engine first and transparently
 * falls back to ffmpeg.wasm if WebCodecs is unavailable or the conversion
 * fails. A genuine user abort is NOT retried with ffmpeg.
 *
 * @throws if both engines fail (e.g. unsupported / corrupt source).
 */
export async function generateProxy(
  args: GenerateProxyArgs
): Promise<ProxyResult> {
  let webCodecsReason: string | null = null
  if (await webCodecsCanEncodeH264()) {
    try {
      const t0 = Date.now()
      const result = await generateProxyWebCodecs(args)
      // eslint-disable-next-line no-console
      console.log(
        `[proxy] WebCodecs transcode OK — ${(result.bytes / 1024 / 1024).toFixed(
          1
        )} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`
      )
      return result
    } catch (e: any) {
      // A real cancel should propagate, not silently fall back.
      if (args.signal?.aborted || e?.name === 'AbortError') throw e
      // eslint-disable-next-line no-console
      console.warn(
        '[proxy] WebCodecs engine failed, falling back to ffmpeg.wasm:',
        e?.message || e
      )
      webCodecsReason = e?.message || String(e)
      // Say it where someone will see it. console.warn above is for a
      // developer with the console open; this reaches the upload log.
      args.onProgress?.({
        progress: 0,
        engine: 'ffmpeg',
        message: 'falling back to the software encoder',
        fallbackReason: webCodecsReason || 'unknown',
      })
    }
  }
  // If the fallback ALSO fails, surface both reasons — otherwise the ffmpeg error
  // (typically "could not download the video encoder") hides the fact that the fast,
  // dependency-free engine failed first, which is the thing actually worth fixing.
  try {
    return await generateProxyFFmpeg(args)
  } catch (e: any) {
    if (args.signal?.aborted || e?.name === 'AbortError') throw e
    throw new Error(
      webCodecsReason
        ? `${e?.message || 'transcode failed'} (the built-in encoder failed first: ${webCodecsReason})`
        : (e?.message || 'transcode failed')
    )
  }
}

// There was an `estimateProxySize(durationSec)` here, for showing "will upload
// ~N MB" before the user confirms. Nothing ever called it — not a component,
// not a script, not a test — and no upload path in the app asks the user to
// confirm a size. It had already been corrected once (it restated 1.2 Mbps and
// under-reported by four times after the target moved), which is the cost of
// keeping a function nothing exercises: it goes stale silently and the next
// reader believes it.
