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
  /** Status line, useful for diagnostics / the progress UI. */
  message?: string
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
const PROXY_HEIGHT = 720
const PROXY_VIDEO_BITRATE = 1_200_000 // bits/sec
const PROXY_FPS = 30

// ════════════════════════════════════════════════════════════════════════════
// Engine 1 — WebCodecs (via Mediabunny)
// ════════════════════════════════════════════════════════════════════════════

// One-shot capability probe: does this browser have a working H.264 video
// encoder? Cached — the probe is cheap but we only need it once per page.
let webCodecsProbe: Promise<boolean> | null = null
function webCodecsCanEncodeH264(): Promise<boolean> {
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

async function generateProxyWebCodecs({
  source,
  onProgress,
  signal,
}: GenerateProxyArgs): Promise<ProxyResult> {
  // Mediabunny is an optional/lazy dependency — bundled once installed via
  // `npm install`. The ts-ignore keeps the sandbox typecheck green before the
  // package lands; the bundler resolves the literal specifier at build time.
  // @ts-ignore — resolved at build time once `mediabunny` is installed
  const mb: any = await import('mediabunny')
  const {
    Input,
    Output,
    Conversion,
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Mp4OutputFormat,
  } = mb

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  })
  const output = new Output({
    // faststart 'in-place' → moov atom at the front → streamable.
    format: new Mp4OutputFormat({ fastStart: 'in-place' }),
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

async function ensureFFmpeg(onLog?: (msg: string) => void): Promise<any> {
  if (ffmpegInstance) return ffmpegInstance
  // Dynamic imports so the heavy WASM bundle stays out of the initial route
  // chunk; only paid for when a proxy actually needs the fallback engine.
  const ffMod = await import('@ffmpeg/ffmpeg')
  const utilMod = await import('@ffmpeg/util')
  const { FFmpeg } = ffMod
  const { toBlobURL } = utilMod
  const ff = new FFmpeg()
  if (onLog) {
    ff.on('log', ({ message }: { message: string }) => onLog(message))
  }
  // Load WASM core from the unpkg CDN as recommended by the ffmpeg.wasm docs.
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'
  await ff.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  })
  ffmpegInstance = ff
  return ff
}

async function generateProxyFFmpeg({
  source,
  inputStem = 'src',
  onProgress,
}: GenerateProxyArgs): Promise<ProxyResult> {
  const ff = await ensureFFmpeg((msg) =>
    onProgress?.({ progress: 0, message: msg })
  )

  // Wire progress event → caller. ffmpeg emits 0..1 floats.
  const onProgressEv = ({ progress }: { progress: number }) => {
    onProgress?.({
      progress: Math.min(0.999, Math.max(0, progress)),
      message: 'Software transcode',
    })
  }
  ff.on('progress', onProgressEv)

  const inputName = `${inputStem}.mp4`
  const outputName = `${inputStem}.proxy.mp4`

  try {
    const buf = new Uint8Array(await source.arrayBuffer())
    await ff.writeFile(inputName, buf)

    // Speed-tuned for field upload. -vf scale=-2:720,fps=30 caps height +
    // framerate; -preset ultrafast -tune zerolatency for a fast encode;
    // ~1.2 Mbps target; +faststart so the file is streamable.
    await ff.exec([
      '-i', inputName,
      '-vf', `scale=-2:${PROXY_HEIGHT},fps=${PROXY_FPS}`,
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '1200k',
      '-maxrate', '1500k',
      '-bufsize', '3000k',
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
    }
  }
  return generateProxyFFmpeg(args)
}

/** Estimate the resulting proxy size in bytes without doing a real transcode.
 *  Useful for showing "will upload ~N MB" before the user confirms. */
export function estimateProxySize(durationSec: number): number {
  // ~1.2 Mbps video + audio ≈ 1.3 Mbps total ≈ ~165 KB/s.
  return Math.round(durationSec * 165 * 1024)
}
