'use client'
import * as React from 'react'
import { Mic, Square, Loader2 } from 'lucide-react'
import { cn } from '@/lib/ui'
import {
  foldResults, liveText, appendSpoken, speechLang, MAX_DICTATION_MS,
  type DictationMode, type Heard,
} from '@/lib/tagging/dictation'

// The mic beside the note box.
//
// A comment typed on a phone, on a boat, in gloves, is a comment that does not
// get typed. Speaking one takes three seconds. This is the whole feature, and
// almost all of its code is about the two things that decide whether people
// trust it: seeing the words appear, and never losing what was already there.
//
// It prefers the phone's OWN recogniser — the words land as they are said, so a
// crew member watches it mis-hear "J2" and fixes it before saving, and nothing
// is uploaded. Where that API is missing (Firefox; older iOS) it records and
// sends the audio to the transcriber SSA already runs, which is slower but
// works, and is better at sailing words than any phone recogniser.
//
// The provisional words are shown but never saved: a recogniser revises them,
// and a tag that saved them would record something nobody said.

export interface DictateButtonProps {
  /** Current text of the field, so dictation APPENDS rather than replaces. */
  value: string
  /** Called with the whole new value, live while speaking and again at the end. */
  onChange: (next: string) => void
  /** Called ONCE when a dictation finishes, with the committed text. For a
   *  field that saves on blur: the mic is where the thumb already is, so the
   *  field may never be focused and its onBlur may never fire. */
  onCommit?: (text: string) => void
  /** Kept for the composer's own disabled state. */
  disabled?: boolean
  className?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const speechCtor = (): any =>
  typeof window === 'undefined'
    ? null
    : (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null

const canRecord = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as any).MediaRecorder !== 'undefined' &&
  !!navigator?.mediaDevices?.getUserMedia

/** Which path this browser can offer. Resolved on the client only: both checks
 *  read `window`, and guessing on the server renders the wrong button first. */
export function detectMode(): DictationMode {
  if (speechCtor()) return 'live'
  if (canRecord()) return 'record'
  return 'unavailable'
}

export default function DictateButton({ value, onChange, onCommit, disabled, className }: DictateButtonProps) {
  const [mode, setMode] = React.useState<DictationMode>('unavailable')
  const [state, setState] = React.useState<'idle' | 'listening' | 'working'>('idle')
  const [err, setErr] = React.useState<string | null>(null)

  // The text as it was when the mic opened. Everything dictated is appended to
  // THIS, so a revision of the provisional words rewrites only them.
  const baseRef = React.useRef('')
  const committedRef = React.useRef('')
  const recRef = React.useRef<any>(null)
  const mediaRef = React.useRef<{ rec: any; chunks: Blob[]; stream: MediaStream } | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const valueRef = React.useRef(value)
  valueRef.current = value

  React.useEffect(() => { setMode(detectMode()) }, [])

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }

  const stopAll = React.useCallback(() => {
    clearTimer()
    try { recRef.current?.stop() } catch { /* already stopped */ }
    recRef.current = null
    const m = mediaRef.current
    if (m) {
      try { m.rec.stop() } catch { /* already stopped */ }
      // Releasing the tracks is what turns the phone's recording indicator off.
      // Leaving them open is the single most alarming thing this could do.
      try { m.stream.getTracks().forEach((t) => t.stop()) } catch { /* gone */ }
    }
  }, [])

  // Unmounting mid-sentence — the sheet dismissed, the tag saved — must not
  // leave the microphone open.
  React.useEffect(() => stopAll, [stopAll])

  // ── Live: the phone's own recogniser ──────────────────────────────────────
  const startLive = () => {
    const Ctor = speechCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = speechLang(typeof navigator === 'undefined' ? undefined : navigator)

    baseRef.current = valueRef.current
    committedRef.current = ''

    rec.onresult = (e: any) => {
      const heard: Heard = foldResults(e.results, e.resultIndex)
      if (heard.final) committedRef.current = appendSpoken(committedRef.current, heard.final)
      onChange(liveText(appendSpoken(baseRef.current, committedRef.current), { final: '', interim: heard.interim }))
    }
    rec.onerror = (e: any) => {
      const code = String(e?.error || '')
      // "no-speech" and "aborted" are how a normal stop arrives on some
      // engines. Calling those errors trains people to ignore the message.
      if (code && code !== 'no-speech' && code !== 'aborted') {
        setErr(code === 'not-allowed' ? 'Microphone blocked — allow it in the browser.' : `Dictation failed (${code}).`)
      }
      setState('idle')
    }
    rec.onend = () => {
      // Commit: the provisional words are dropped, which is the point.
      const final = appendSpoken(baseRef.current, committedRef.current)
      onChange(final)
      if (committedRef.current) onCommit?.(final)
      setState('idle')
      recRef.current = null
      clearTimer()
    }

    recRef.current = rec
    setErr(null)
    setState('listening')
    try { rec.start() } catch { setState('idle'); setErr('Could not start dictation.') }
    timerRef.current = setTimeout(stopAll, MAX_DICTATION_MS)
  }

  // ── Record, then transcribe on the server ─────────────────────────────────
  const startRecord = async () => {
    setErr(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setErr('Microphone blocked — allow it in the browser.')
      return
    }
    const MR = (window as any).MediaRecorder
    const rec = new MR(stream)
    const chunks: Blob[] = []
    baseRef.current = valueRef.current

    rec.ondataavailable = (e: any) => { if (e.data?.size) chunks.push(e.data) }
    rec.onstop = async () => {
      try { stream.getTracks().forEach((t) => t.stop()) } catch { /* gone */ }
      mediaRef.current = null
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
      if (!blob.size) { setState('idle'); return }
      setState('working')
      try {
        const form = new FormData()
        form.append('file', blob, 'comment.webm')
        const res = await fetch('/api/ai/transcribe', { method: 'POST', body: form })
        const j = await res.json().catch(() => null)
        if (!res.ok) throw new Error(j?.error || 'Transcription failed')
        const text = String(j?.text || '').trim()
        if (text) {
          const final = appendSpoken(baseRef.current, text)
          onChange(final)
          onCommit?.(final)
        } else setErr('Nothing was heard.')
      } catch (e) {
        setErr((e as Error)?.message || 'Transcription failed')
      } finally {
        setState('idle')
      }
    }

    mediaRef.current = { rec, chunks, stream }
    setState('listening')
    rec.start()
    timerRef.current = setTimeout(stopAll, MAX_DICTATION_MS)
  }

  if (mode === 'unavailable') return null

  const listening = state === 'listening'
  const working = state === 'working'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        onClick={() => (listening ? stopAll() : mode === 'live' ? startLive() : startRecord())}
        disabled={disabled || working}
        aria-label={listening ? 'Stop dictating' : 'Dictate a comment'}
        aria-pressed={listening}
        className={cn(
          'flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-xs font-semibold',
          listening
            ? 'bg-danger text-white'
            : 'border border-[color:var(--border-strong)] bg-surface-2 text-secondary',
          (disabled || working) && 'opacity-60'
        )}
      >
        {working ? <Loader2 size={15} className="animate-spin" aria-hidden />
          : listening ? <Square size={14} aria-hidden />
            : <Mic size={15} aria-hidden />}
        {working ? 'Transcribing…' : listening ? 'Stop' : 'Speak'}
      </button>

      {listening && (
        <span className="flex items-center gap-1.5 text-[11px] text-secondary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
          {mode === 'live' ? 'Listening — the words appear as you speak' : 'Recording — press stop when done'}
        </span>
      )}
      {!listening && !working && err && (
        <span className="text-[11px] text-danger">{err}</span>
      )}
    </div>
  )
}
