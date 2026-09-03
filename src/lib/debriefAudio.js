// Client-side debrief pipeline: an uploaded recording → 16 kHz mono MP3 chunks →
// Scaleway transcription (per chunk) → Scaleway Mistral summary → the section's
// fields. Pure-JS compression (lamejs) so it needs no ffmpeg.wasm / COOP-COEP and
// runs on any browser. Chunked so each upload stays under Vercel's ~4.5 MB body
// cap and each transcription is a short call. Desktop-gated by the caller.
//
// runAudioBrief(file, mode, { onStage }) → { fields, transcript }
//   onStage(stage, pct)  stage ∈ 'compress' | 'transcribe' | 'summarise' | 'done'

import { whisperPrompt, withOverride, clampWhisperPrompt } from './debriefGlossary'

const OUT_RATE = 16000
const FRAME = 1152

// ── WAV: parse RIFF, expose a mono int16-scaled sample reader (no full decode) ──
function parseWav(buf) {
  const dv = new DataView(buf)
  if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) throw new Error('not a WAV')
  let off = 12, fmt = null, dataOff = 0, dataLen = 0
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false), sz = dv.getUint32(off + 4, true)
    if (id === 0x666d7420) fmt = { format: dv.getUint16(off + 8, true), ch: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) }
    else if (id === 0x64617461) { dataOff = off + 8; dataLen = sz }
    off += 8 + sz + (sz & 1)
  }
  if (!fmt || !dataOff) throw new Error('WAV missing fmt/data')
  const ch = fmt.ch, bits = fmt.bits, isFloat = fmt.format === 3
  let read
  if (bits === 16) {
    const n = Math.floor(dataLen / 2)
    const s = (dataOff % 2 === 0) ? new Int16Array(buf, dataOff, n) : new Int16Array(buf.slice(dataOff, dataOff + n * 2))
    read = ch === 1 ? (f) => s[f] : (f) => { let a = 0; const k = f * ch; for (let c = 0; c < ch; c++) a += s[k + c]; return a / ch }
  } else if (bits === 32 && isFloat) {
    const n = Math.floor(dataLen / 4)
    const s = (dataOff % 4 === 0) ? new Float32Array(buf, dataOff, n) : new Float32Array(buf.slice(dataOff, dataOff + n * 4))
    read = ch === 1 ? (f) => s[f] * 32767 : (f) => { let a = 0; const k = f * ch; for (let c = 0; c < ch; c++) a += s[k + c]; return a / ch * 32767 }
  } else throw new Error(bits + '-bit WAV — using fallback')
  return { rate: fmt.rate, frameCount: Math.floor(dataLen / (ch * (bits / 8))), read }
}

// ── Fallback for compressed inputs (m4a/mp3/…): full Web Audio decode (heavier) ──
async function decodeAny(buf) {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) throw new Error('cannot decode this audio format in this browser')
  const ac = new AC()
  const audio = await ac.decodeAudioData(buf.slice(0))
  const ch0 = audio.getChannelData(0)
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null
  const out = { rate: audio.sampleRate, frameCount: audio.length, read: ch1 ? (f) => (ch0[f] + ch1[f]) * 0.5 * 32767 : (f) => ch0[f] * 32767 }
  try { ac.close() } catch { /* */ }
  return out
}

// lamejs (pure-JS MP3 encoder) loaded once from the CDN — no bundler/COOP concerns.
let _lamePromise = null
function loadLame() {
  if (typeof window !== 'undefined' && window.lamejs) return Promise.resolve(window.lamejs)
  if (_lamePromise) return _lamePromise
  _lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js'
    s.async = true
    s.onload = () => (window.lamejs ? resolve(window.lamejs) : reject(new Error('MP3 encoder failed to initialise')))
    s.onerror = () => reject(new Error('could not load the MP3 encoder (check the connection)'))
    document.head.appendChild(s)
  })
  return _lamePromise
}

// ── Resample to 16 kHz mono + MP3-encode, split into ≤ chunkSeconds pieces ──
async function compressToMp3Chunks(file, { kbps = 48, chunkSeconds = 300, onProgress } = {}) {
  const lamejs = await loadLame()
  const Mp3Encoder = lamejs.Mp3Encoder
  if (!Mp3Encoder) throw new Error('MP3 encoder unavailable')

  const buf = await file.arrayBuffer()
  let src
  try { src = parseWav(buf) } catch { src = await decodeAny(buf) }

  const ratio = src.rate / OUT_RATE
  const outFrames = Math.floor(src.frameCount / ratio)
  const chunkFrames = Math.max(FRAME, Math.floor(chunkSeconds * OUT_RATE))
  const chunks = []
  const frame = new Int16Array(FRAME)
  let enc = new Mp3Encoder(1, OUT_RATE, kbps)
  let parts = []
  let bi = 0, inChunk = 0

  const closeChunk = () => {
    if (bi > 0) { const d = enc.encodeBuffer(frame.subarray(0, bi)); if (d.length) parts.push(new Uint8Array(d)); bi = 0 }
    const tail = enc.flush(); if (tail.length) parts.push(new Uint8Array(tail))
    if (parts.length) chunks.push(new Blob(parts, { type: 'audio/mpeg' }))
    parts = []; enc = new Mp3Encoder(1, OUT_RATE, kbps); inChunk = 0
  }

  const BLOCK = OUT_RATE * 3 // ~3 s of output per tick, so the UI stays alive
  for (let start = 0; start < outFrames; start += BLOCK) {
    const end = Math.min(start + BLOCK, outFrames)
    for (let o = start; o < end; o++) {
      const t = o * ratio, i0 = t | 0, frac = t - i0
      const a = src.read(i0), b = (i0 + 1 < src.frameCount) ? src.read(i0 + 1) : a
      let v = (a + (b - a) * frac) | 0
      frame[bi++] = v < -32768 ? -32768 : (v > 32767 ? 32767 : v)
      if (bi === FRAME) { const d = enc.encodeBuffer(frame); if (d.length) parts.push(new Uint8Array(d)); bi = 0 }
      if (++inChunk >= chunkFrames) closeChunk()
    }
    if (onProgress) onProgress(end / outFrames)
    await new Promise((r) => setTimeout(r, 0))
  }
  closeChunk()
  const durationSec = src.frameCount / src.rate
  return { chunks, durationSec }
}

async function transcribeChunks(chunks, onProgress, glossaryExtra) {
  const texts = []
  const bias = whisperPrompt(withOverride(glossaryExtra)) // team glossary (+ live sail inventory) → Whisper spells the jargon right
  let prevTail = ''
  for (let i = 0; i < chunks.length; i++) {
    const fd = new FormData()
    fd.append('file', chunks[i], `chunk-${i}.mp3`)
    // No language hint — let Whisper auto-detect (debriefs may be Dutch, English, …).
    // Forcing 'en' on a non-English recording makes it mis-hear the whole thing.
    // Prompt = a little context from the previous chunk + the glossary LAST. The
    // provider REJECTS an over-long prompt rather than truncating it, so clamp
    // rather than assume: clampWhisperPrompt keeps the end, sacrificing the tail
    // and keeping the terms.
    fd.append('prompt', clampWhisperPrompt(prevTail ? `${prevTail}\n${bias}` : bias))
    const res = await fetch('/api/ai/transcribe', { method: 'POST', body: fd })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `transcription failed (chunk ${i + 1})`)
    const text = (j.text || '').trim()
    texts.push(text)
    prevTail = text.slice(-100) // carry a little context across the chunk boundary
    if (onProgress) onProgress((i + 1) / chunks.length)
  }
  return texts.join('\n')
}

async function summarise(transcript, mode, glossaryExtra) {
  const res = await fetch('/api/ai/debrief-summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript, mode, glossary: glossaryExtra || undefined }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || 'summary failed')
  delete j._ms
  return j
}

export async function runAudioBrief(file, mode, { onStage, glossaryExtra } = {}) {
  const stage = (s, p) => { if (onStage) onStage(s, p) }
  stage('compress', 0)
  const { chunks } = await compressToMp3Chunks(file, { onProgress: (p) => stage('compress', p) })
  if (!chunks.length) throw new Error('no audio decoded from that file')
  stage('transcribe', 0)
  const transcript = await transcribeChunks(chunks, (p) => stage('transcribe', p), glossaryExtra)
  if (!transcript.trim()) throw new Error('transcript came back empty — was anything recorded?')
  stage('summarise', 0)
  const fields = await summarise(transcript, mode, glossaryExtra)
  stage('done', 1)
  return { fields, transcript }
}
