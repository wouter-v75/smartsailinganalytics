// Record a spoken note straight into ONE field. The mic button that sits on
// every note in the campaign day.
//
// Unlike AudioBrief (which takes an uploaded file, summarises a whole meeting
// into a section's fields, and is desktop-only because a 75-minute recording is
// heavy), this is for a short dictated note and deliberately runs on MOBILE —
// the dock and the coach boat are exactly where a note gets spoken, and a
// 40-second recording compresses in a moment.
//
// Props:
//   value      current text of the field, so a note can be appended to it
//   onCommit   (nextValue) => Promise — saves the field, same contract as onSave
//   canEdit    hides the button for read-only roles
//   label      the field's name, for the button title
//   teamId/boatId  feed the boat's sail wardrobe into the tidy-up
import React, { useEffect, useRef, useState } from 'react'
import { runAudioNote } from '../lib/debriefAudio'
import { startRecording, isRecordingSupported, MAX_MS } from '../lib/micRecord'
import { loadBoatVocab } from '../lib/boatVocab'

const STAGE = { compress: 'Processing', transcribe: 'Transcribing', summarise: 'Tidying up', done: 'Done' }

const mmss = (ms) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const btn = {
  background: 'transparent', border: '1px solid #1E3A5A', color: '#8a97a9',
  borderRadius: 8, padding: '3px 8px', fontSize: 11, cursor: 'pointer', lineHeight: 1.6,
}
const ta = {
  width: '100%', background: '#0A1929', border: '1px solid #1E3A5A', color: '#E2E8F0',
  borderRadius: 8, padding: 8, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
}

export default function NoteRecorder({ value, onCommit, canEdit, label, teamId, boatId }) {
  const recRef = useRef(null)
  const [rec, setRec] = useState(false)
  const [ms, setMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [pct, setPct] = useState(0)
  const [draft, setDraft] = useState(null)
  const [transcript, setTranscript] = useState('')
  const [showTx, setShowTx] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [vocab, setVocab] = useState(null)

  useEffect(() => { loadBoatVocab(teamId, boatId).then(setVocab) }, [teamId, boatId])

  // A recording left running when the note unmounts must not keep the mic open.
  useEffect(() => () => { if (recRef.current) { try { recRef.current.cancel() } catch { /* */ } } }, [])

  if (!canEdit) return null
  if (!isRecordingSupported()) return null

  async function begin() {
    setErr(null); setDraft(null); setTranscript(''); setShowTx(false)
    try {
      recRef.current = await startRecording({ onTick: (elapsed, lvl) => { setMs(elapsed); setLevel(lvl) } })
      setMs(0); setRec(true)
    } catch (e) { setErr((e && e.message) || 'could not start recording') }
  }

  async function finish() {
    const r = recRef.current
    if (!r) return
    recRef.current = null
    setRec(false)
    const blob = await r.stop()
    if (!blob || blob.size < 2000) { setErr('nothing was recorded'); return }
    setBusy(true); setStage('compress'); setPct(0)
    try {
      const { note, transcript: tx } = await runAudioNote(blob, {
        onStage: (s, p) => { setStage(s); setPct(p || 0) },
        glossaryExtra: vocab,
      })
      setDraft(note); setTranscript(tx)
    } catch (e) {
      setErr((e && e.message) || String(e))
    } finally { setBusy(false); setStage(null) }
  }

  function abandon() {
    const r = recRef.current
    recRef.current = null
    if (r) { try { r.cancel() } catch { /* */ } }
    setRec(false); setMs(0)
  }

  async function commit(mode) {
    if (!draft) return
    const cur = (value || '').trim()
    const next = mode === 'append' && cur ? `${cur}\n${draft.trim()}` : draft.trim()
    setSaving(true); setErr(null)
    try {
      await onCommit(next)
      setDraft(null); setTranscript(''); setShowTx(false)
    } catch (e) { setErr((e && e.message) || 'save failed') }
    finally { setSaving(false) }
  }

  // ── Idle: just the button ────────────────────────────────────────────────
  if (!rec && !busy && !draft) {
    return (
      <>
        <button onClick={begin} title={`Record a spoken note for ${label || 'this note'}`}
          style={{ ...btn, borderColor: '#1E3A5A' }}>🎙 Record</button>
        {err && <div style={{ color: '#EF4444', fontSize: 11, marginTop: 4 }}>✕ {err}</div>}
      </>
    )
  }

  // ── Recording: timer, a live level bar, stop / discard ───────────────────
  if (rec) {
    const near = ms > MAX_MS - 30_000
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8, border: '1px solid #EF4444', background: '#2a0f1544' }}>
          <i style={{ width: 8, height: 8, borderRadius: 4, background: '#EF4444', display: 'inline-block', opacity: 0.5 + 0.5 * level }} />
          <b style={{ fontSize: 11, color: near ? '#F59E0B' : '#EF4444', fontVariantNumeric: 'tabular-nums' }}>{mmss(ms)}</b>
          <i style={{ display: 'inline-block', width: 34, height: 4, borderRadius: 2, background: '#3a1420', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${Math.round(level * 100)}%`, background: '#EF4444', transition: 'width .12s' }} />
          </i>
        </span>
        <button onClick={finish} style={{ ...btn, borderColor: '#10B981', color: '#10B981', fontWeight: 700 }}>■ Stop</button>
        <button onClick={abandon} style={btn}>Discard</button>
      </span>
    )
  }

  // ── Working ──────────────────────────────────────────────────────────────
  if (busy) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#06B6D4' }}>{STAGE[stage] || 'Working'}… {Math.round(pct * 100)}%</span>
        <i style={{ display: 'inline-block', width: 60, height: 4, borderRadius: 2, background: '#0F2030', overflow: 'hidden', border: '1px solid #1E3A5A' }}>
          <i style={{ display: 'block', height: '100%', width: `${Math.round(pct * 100)}%`, background: '#06B6D4', transition: 'width .15s' }} />
        </i>
      </span>
    )
  }

  // ── Review before it is saved. Never write to the field behind the user. ──
  return (
    <div style={{ marginTop: 8, background: '#0A1929', border: '1px solid #06B6D4', borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: 11, color: '#8a97a9', marginBottom: 8 }}>
        From your recording — <b style={{ color: '#a6b2c4' }}>read it against what you said</b>. Edit it here first.
      </div>
      <textarea value={draft} rows={5} style={ta} onChange={(e) => setDraft(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <button onClick={() => commit('append')} disabled={saving}
          style={{ ...btn, background: '#10B981', border: 'none', color: '#03251a', fontWeight: 700, fontSize: 12, padding: '5px 10px' }}>
          {saving ? 'Saving…' : (value || '').trim() ? 'Add to note' : 'Save note'}
        </button>
        {(value || '').trim() && (
          <button onClick={() => commit('replace')} disabled={saving} style={btn}>Replace note</button>
        )}
        <button onClick={() => { setDraft(null); setTranscript(''); setShowTx(false) }} style={btn}>Discard</button>
        <button onClick={() => setShowTx((s) => !s)} style={btn}>{showTx ? 'Hide' : 'Show'} transcript</button>
      </div>
      {err && <div style={{ color: '#EF4444', fontSize: 11, marginTop: 6 }}>✕ {err}</div>}
      {showTx && <textarea readOnly value={transcript} rows={6} style={{ ...ta, marginTop: 8, fontFamily: 'monospace', fontSize: 11, color: '#8a97a9' }} />}
    </div>
  )
}
