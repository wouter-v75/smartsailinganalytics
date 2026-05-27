// Lossless in-browser video trim using ffmpeg.wasm.
//
// Cuts a video to the [startSec, endSec] range and returns the new blob.
// We use `-c copy` so ffmpeg only remuxes — no re-encode, ~10× faster
// than the proxy transcode. Trade-off: cuts snap to the nearest keyframe
// (usually 1–2 s precision on consumer cameras like GoPro/DJI). For
// sailing — chopping off pre-race dock time or post-finish chatter —
// keyframe precision is plenty.
//
// If you need frame-accurate cuts in future, swap `-c copy` for
// `-c:v libx264 -c:a aac` and accept the slowdown.
//
// Reuses the same ffmpeg core lazy-loaded by video-proxy.ts; the first
// crop you run after a proxy already has the WASM in memory.

/* eslint-disable @typescript-eslint/no-explicit-any */

let ffmpegInstance: any = null

async function ensureFFmpeg(): Promise<any> {
  if (ffmpegInstance) return ffmpegInstance
  const ffMod = await import('@ffmpeg/ffmpeg')
  const utilMod = await import('@ffmpeg/util')
  const { FFmpeg } = ffMod
  const { toBlobURL } = utilMod
  const ff = new FFmpeg()
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'
  await ff.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(
      `${baseURL}/ffmpeg-core.wasm`,
      'application/wasm'
    ),
  })
  ffmpegInstance = ff
  return ff
}

export interface CropProgress {
  /** 0..1 within the current ffmpeg job. */
  progress: number
  message?: string
}

export interface CropArgs {
  source: File | Blob
  /** Inclusive start time in seconds. */
  startSec: number
  /** Exclusive end time in seconds. */
  endSec: number
  /** Stem for internal tmp file names. Default 'src'. */
  inputStem?: string
  onProgress?: (p: CropProgress) => void
  signal?: AbortSignal
}

export interface CropResult {
  blob: Blob
  bytes: number
  durationSec: number
  type: 'video/mp4'
}

/**
 * Trim a video to `[startSec, endSec]` (lossless, keyframe-snapped).
 * Throws on invalid range or ffmpeg failure.
 */
export async function cropVideo({
  source,
  startSec,
  endSec,
  inputStem = 'src',
  onProgress,
  signal,
}: CropArgs): Promise<CropResult> {
  if (!isFinite(startSec) || !isFinite(endSec)) {
    throw new Error('startSec and endSec must be finite numbers')
  }
  if (endSec <= startSec) {
    throw new Error('endSec must be greater than startSec')
  }
  const dur = endSec - startSec
  const ff = await ensureFFmpeg()

  const onProgressEv = ({ progress }: { progress: number }) => {
    onProgress?.({ progress: Math.min(0.999, Math.max(0, progress)) })
  }
  ff.on('progress', onProgressEv)

  const inputName = `${inputStem}.mp4`
  const outputName = `${inputStem}.crop.mp4`
  // Mount the source Blob into WORKERFS rather than reading the whole file
  // into a Uint8Array via `arrayBuffer()`. The single-buffer path hits the
  // browser's ~2 GiB typed-array ceiling on HD camera originals (multi-GB
  // .mp4/.mov), throwing NotReadableError. WORKERFS lets ffmpeg read the
  // Blob lazily via slice(), with no whole-file allocation.
  const mountPoint = `/in_${Math.random().toString(36).slice(2, 8)}`

  let mounted = false
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    await ff.createDir(mountPoint)
    await ff.mount(
      'WORKERFS' as any,
      { blobs: [{ name: inputName, data: source }] } as any,
      mountPoint,
    )
    mounted = true

    // -ss before -i is "fast seek": jumps to nearest keyframe without
    // decoding earlier frames. Combined with -c copy, this is the
    // fastest cut path ffmpeg offers.
    //  -ss <start>     seek to start (keyframe-snapped)
    //  -t <duration>   keep this many seconds
    //  -c copy         no re-encode
    //  -avoid_negative_ts make_zero
    //                  rebase timestamps so the output starts at 0
    //  -movflags +faststart  moov at start (mobile streaming)
    await ff.exec([
      '-ss', String(startSec),
      '-i', `${mountPoint}/${inputName}`,
      '-t', String(dur),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ])

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const data = await ff.readFile(outputName)
    const bytes = new Uint8Array(data as ArrayBufferLike).slice().buffer
    const blob = new Blob([bytes], { type: 'video/mp4' })

    // Clean up the virtual FS so memory doesn't accumulate.
    try { await ff.deleteFile(outputName) } catch {}

    return { blob, bytes: blob.size, durationSec: dur, type: 'video/mp4' }
  } finally {
    ff.off('progress', onProgressEv)
    if (mounted) {
      try { await ff.unmount(mountPoint) } catch {}
      try { await ff.deleteDir(mountPoint) } catch {}
    }
  }
}
