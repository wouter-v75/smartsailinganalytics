// Microphone capture for a spoken note. MediaRecorder → a Blob that
// debriefAudio's compressToMp3Chunks can read, so the whole existing
// transcribe/summarise pipeline works unchanged from a live recording.
//
//   const rec = await startRecording({ onTick: (ms, level) => … })
//   const blob = await rec.stop()      // null if nothing was captured
//   rec.cancel()                       // drop it, release the mic
//
// Format is chosen by what the browser will actually produce AND decode:
// Chrome/Firefox give webm/opus, Safari gives mp4/AAC, and each decodes its
// own through Web Audio's decodeAudioData (debriefAudio's decodeAny fallback).
// Never force a type — asking Safari for webm yields a file it cannot read back.

// Ordered by preference; the first one the browser supports wins. The empty
// string is the browser's own default and the last resort.
const MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  '',
]

export function isRecordingSupported() {
  return typeof window !== 'undefined'
    && typeof MediaRecorder !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
}

function pickMime() {
  for (const m of MIMES) {
    if (!m) return ''
    try { if (MediaRecorder.isTypeSupported(m)) return m } catch { /* older browsers */ }
  }
  return ''
}

// A dock-side note, not a meeting. The cap exists so a button left running in a
// pocket cannot produce a 40-minute upload; runAudioBrief still chunks anything
// longer that arrives as a file.
export const MAX_MS = 10 * 60 * 1000

export async function startRecording({ onTick, maxMs = MAX_MS } = {}) {
  if (!isRecordingSupported()) throw new Error('this browser cannot record audio')

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (e) {
    // NotAllowedError is the common one and deserves a human sentence: the
    // browser will not ask again until the user changes it in site settings.
    const name = (e && e.name) || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('microphone blocked — allow it for this site in your browser settings')
    }
    if (name === 'NotFoundError') throw new Error('no microphone found')
    throw new Error((e && e.message) || 'could not open the microphone')
  }

  const mime = pickMime()
  let rec
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined) }
  catch { rec = new MediaRecorder(stream) }

  const parts = []
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data) }

  // Level meter — purely so the user can see the mic is live. Optional: if the
  // AudioContext cannot start (autoplay policy, older Safari), the timer still runs.
  let ac = null, analyser = null, buf = null
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (AC) {
      ac = new AC()
      analyser = ac.createAnalyser()
      analyser.fftSize = 512
      ac.createMediaStreamSource(stream).connect(analyser)
      buf = new Uint8Array(analyser.frequencyBinCount)
    }
  } catch { ac = null; analyser = null }

  const level = () => {
    if (!analyser || !buf) return 0
    analyser.getByteTimeDomainData(buf)
    let peak = 0
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128))
    return Math.min(1, peak / 96) // 96 ≈ speaking voice, not full scale
  }

  const t0 = Date.now()
  let stopped = false
  let timer = null
  const cleanup = () => {
    if (timer) { clearInterval(timer); timer = null }
    try { stream.getTracks().forEach((t) => t.stop()) } catch { /* */ }
    try { if (ac) ac.close() } catch { /* */ }
  }

  const stop = () => new Promise((resolve) => {
    if (stopped) return resolve(null)
    stopped = true
    rec.onstop = () => {
      cleanup()
      resolve(parts.length ? new Blob(parts, { type: rec.mimeType || mime || 'audio/webm' }) : null)
    }
    try { rec.stop() } catch { cleanup(); resolve(null) }
  })

  timer = setInterval(() => {
    const ms = Date.now() - t0
    if (onTick) onTick(ms, level())
    if (ms >= maxMs && !stopped) stop()
  }, 200)

  rec.start(1000) // a timeslice, so a crash still leaves usable parts

  return {
    stop,
    cancel: () => { stopped = true; try { rec.stop() } catch { /* */ } cleanup() },
    get elapsedMs() { return Date.now() - t0 },
    mimeType: rec.mimeType || mime || '',
  }
}
