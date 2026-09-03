// One-button debrief-from-recording. Upload an audio file → compress + chunk in
// the browser → Scaleway transcribes → Mistral summarises into THIS section's
// fields → review/edit → save. Desktop-only (gated by the caller passing isMobile)
// so the heavy compression runs on a real CPU; and editors-only (canEdit).
//
// Props: { mode, fields:[{key,label}], onSaved:(values)=>Promise, canEdit, isMobile }
import React, { useEffect, useRef, useState } from 'react'
import { runAudioBrief } from '../lib/debriefAudio'
import { vocabForBoat } from '../lib/debriefGlossary'

const STAGE = { compress: 'Compressing audio', transcribe: 'Transcribing', summarise: 'Summarising', done: 'Done' }

const btn = { background: '#0F2030', border: '1px solid #1E3A5A', color: '#CBD5E1', borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer' }
const ta = { width: '100%', background: '#0A1929', border: '1px solid #1E3A5A', color: '#E2E8F0', borderRadius: 8, padding: 8, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }

export default function AudioBrief({ mode, fields, onSaved, canEdit, isMobile, teamId, boatId }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [pct, setPct] = useState(0)
  const [result, setResult] = useState(null)
  const [transcript, setTranscript] = useState('')
  const [showTx, setShowTx] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [glossaryExtra, setGlossaryExtra] = useState(null)

  // Pull the boat's live sail inventory → feeds the actual wardrobe into the
  // Whisper bias + summary glossary, so sail names self-maintain from the Boat tab.
  // The boat's NAME is fetched alongside it, because crew and rival-boat names are
  // per-team: priming Whisper with another team's crew makes it place those people
  // in a session they were never at.
  useEffect(() => {
    if (!teamId || !boatId) return
    let live = true
    Promise.all([
      fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`).then((r) => (r.ok ? r.json() : { sails: [] })).catch(() => ({ sails: [] })),
      fetch(`/api/teams/${teamId}/boats`).then((r) => (r.ok ? r.json() : { boats: [] })).catch(() => ({ boats: [] })),
    ]).then(([sj, bj]) => {
      if (!live) return
      const names = Array.from(new Set((sj.sails || [])
        .filter((s) => !s.retired)
        .map((s) => String(s.name || '').replace(/[_-]\d{2,4}$/, '').replace(/_/g, ' ').trim())
        .filter(Boolean)))
      const boat = (bj.boats || []).find((b) => b.id === boatId)
      const vocab = vocabForBoat(boat?.name) || {}
      const extra = {
        ...vocab,
        ...(names.length ? { sails: [...(vocab.sails || []), ...names] } : {}),
      }
      setGlossaryExtra(Object.keys(extra).length ? extra : null)
    })
    return () => { live = false }
  }, [teamId, boatId])

  // Desktop + editors only. On mobile the button simply isn't shown.
  if (isMobile || !canEdit) return null

  async function onPick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setErr(null); setResult(null); setBusy(true); setStage('compress'); setPct(0)
    try {
      const { fields: out, transcript: tx } = await runAudioBrief(file, mode, {
        onStage: (s, p) => { setStage(s); setPct(p || 0) },
        glossaryExtra,
      })
      setResult(out); setTranscript(tx)
    } catch (ex) {
      setErr((ex && ex.message) || String(ex))
    } finally { setBusy(false); setStage(null) }
  }

  async function save() {
    if (!result) return
    setSaving(true); setErr(null)
    try { await onSaved(result); setResult(null); setTranscript(''); setShowTx(false) }
    catch (ex) { setErr((ex && ex.message) || 'save failed') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <input ref={inputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={onPick} />

      {!result && (
        <button onClick={() => inputRef.current && inputRef.current.click()} disabled={busy}
          style={{ ...btn, background: busy ? '#0F2030' : '#06253044', borderColor: '#06B6D4', color: busy ? '#8a97a9' : '#06B6D4', fontWeight: 700 }}>
          {busy ? `${STAGE[stage] || 'Working'}… ${Math.round(pct * 100)}%` : '🎙 Summarise from a recording'}
        </button>
      )}

      {busy && (
        <div style={{ height: 6, background: '#0F2030', borderRadius: 4, overflow: 'hidden', marginTop: 8, border: '1px solid #1E3A5A' }}>
          <i style={{ display: 'block', height: '100%', width: `${Math.round(pct * 100)}%`, background: '#06B6D4', transition: 'width .15s' }} />
        </div>
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 12, marginTop: 8 }}>✕ {err}</div>}

      {result && (
        <div style={{ marginTop: 8, background: '#0A1929', border: '1px solid #06B6D4', borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 11, color: '#8a97a9', marginBottom: 10 }}>
            AI draft from the recording — <b style={{ color: '#a6b2c4' }}>read it against what was said</b> before saving. Edit anything below.
          </div>
          {fields.map((f) => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{f.label}</div>
              <textarea value={result[f.key] || ''} rows={5} style={ta}
                onChange={(e) => setResult((p) => ({ ...p, [f.key]: e.target.value }))} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving} style={{ ...btn, background: '#10B981', border: 'none', color: '#03251a', fontWeight: 700 }}>
              {saving ? 'Saving…' : 'Save to section'}
            </button>
            <button onClick={() => { setResult(null); setTranscript(''); setShowTx(false) }} style={btn}>Discard</button>
            <button onClick={() => setShowTx((s) => !s)} style={{ ...btn, background: 'transparent' }}>{showTx ? 'Hide' : 'Show'} transcript</button>
          </div>
          {showTx && <textarea readOnly value={transcript} rows={8} style={{ ...ta, marginTop: 8, fontFamily: 'monospace', fontSize: 11, color: '#8a97a9' }} />}
        </div>
      )}
    </div>
  )
}
