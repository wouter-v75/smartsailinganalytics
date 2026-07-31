// Server-side proxy: audio chunk → Scaleway Whisper transcription. The Scaleway
// key stays on the server (never shipped to the browser). All AI stays inside the
// Scaleway (EU) account — nothing goes to a third party.
//
// Env (see .env.example):
//   SCALEWAY_AI_API_KEY   — Secret Key from the IAM key screen
//   SCALEWAY_AI_BASE_URL  — project-scoped, e.g. https://api.scaleway.ai/<project>/v1
//   SCALEWAY_TRANSCRIBE_MODEL (optional) — defaults to whisper-large-v3
//
// POST multipart/form-data { file: <audio>, language?: <ISO code>, prompt?: string } → { text }
// prompt biases Whisper toward domain vocabulary (sail names, manoeuvres, crew).
// language is OPTIONAL: omit it (or send "auto"/"") to let Whisper auto-detect the
// spoken language. Only forward an explicit code — forcing a wrong one (e.g. "en"
// on a Dutch recording) makes Whisper mis-transcribe the whole thing.
// The client sends ONE CHUNK per request (≤ ~4 MB — Vercel caps the request body
// at ~4.5 MB, and a single long transcription would also blow the function
// timeout). The client stitches the chunk texts back together in order.
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_TRANSCRIBE_MODEL || 'whisper-large-v3'

const log = (...a: unknown[]) => { try { console.info('[ai/transcribe]', ...a) } catch { /* */ } }

// Health check — confirms config WITHOUT exposing the key.
export async function GET() {
  return NextResponse.json({ configured: !!(KEY && BASE), model: MODEL })
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  if (!KEY || !BASE) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL not configured' }, { status: 503 })
  }

  let form: FormData
  try { form = await req.formData() }
  catch { return NextResponse.json({ error: 'expected multipart/form-data with a "file"' }, { status: 400 }) }

  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: '"file" (audio) is required' }, { status: 400 })
  }
  const language = (form.get('language') as string | null)?.trim() || ''
  const name = (file instanceof File && file.name) ? file.name : 'audio.mp3'
  // Optional vocabulary bias (glossary term string) — makes Whisper spell the
  // team's sail names / jargon / crew names correctly instead of guessing.
  const prompt = (form.get('prompt') as string | null)?.trim() || ''

  const out = new FormData()
  out.append('file', file, name)
  out.append('model', MODEL)
  // Only pin the language when the caller gave a real code (not empty / "auto").
  if (language && language.toLowerCase() !== 'auto') out.append('language', language)
  if (prompt) out.append('prompt', prompt)

  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), 55_000)
  try {
    log('transcribing', `${Math.round((file.size || 0) / 1024)}kb`, MODEL)
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
      body: out,
      signal: ctrl.signal,
    })
    const raw = await res.text()
    if (!res.ok) {
      log('scaleway error', res.status, raw.slice(0, 200))
      return NextResponse.json({ error: `scaleway ${res.status}: ${raw.slice(0, 200)}`, ms: Date.now() - t0 }, { status: 502 })
    }
    let text = ''
    try { text = (JSON.parse(raw) as { text?: string }).text || '' } catch { text = raw }
    log('ok', `${text.length} chars`)
    return NextResponse.json({ text, _ms: Date.now() - t0 })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    log('exception', aborted ? 'aborted (>55s)' : String(e))
    return NextResponse.json(
      { error: aborted ? 'transcription >55s (aborted) — send shorter chunks' : (e instanceof Error ? e.message : 'failed'), ms: Date.now() - t0 },
      { status: aborted ? 504 : 500 },
    )
  } finally { clearTimeout(killer) }
}
