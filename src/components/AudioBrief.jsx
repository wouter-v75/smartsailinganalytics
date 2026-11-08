// One-button debrief-from-recording. Upload an audio file → compress + chunk in
// the browser → Scaleway transcribes → Mistral summarises into THIS section's
// fields → review/edit → save. Desktop-only (gated by the caller passing isMobile)
// so the heavy compression runs on a real CPU; and editors-only (canEdit).
//
// CONSENT GATE. A debrief recording captures everyone in the room, so it will
// not run until every coach/tl1/tl3 in the team has agreed in their profile,
// PLUS whoever is pressing this button — pressing it is what being in the room
// looks like from here (migration 0105; an owner, consultant or guest who is not
// recording still gates nobody). The button stays VISIBLE and explains itself
// when pressed: a control that silently vanishes teaches a coach nothing, and the
// fix is a sentence they can relay to the person who has not ticked the box.
//
// And when the person who has not ticked it is YOU, the panel does not send you
// to your profile to find it — it offers the box here. A one-person team used to
// be refused by a panel that could name nobody, with the profile box already
// ticked: a dead end with no next step in it.
//
// Props: { mode, fields:[{key,label}], onSaved:(values)=>Promise, canEdit, isMobile }
import React, { useEffect, useRef, useState } from 'react'
import { runAudioBrief } from '../lib/debriefAudio'
import { loadBoatVocab } from '../lib/boatVocab'
import { AutoTextarea } from './ui/auto-textarea'

const STAGE = { compress: 'Compressing audio', transcribe: 'Transcribing', summarise: 'Summarising', done: 'Done' }

const mmssOf = (sec) => {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

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
  // What the transcript IS, in numbers, so "it looks cut short" can be settled
  // by reading rather than by judging the bottom edge of a box.
  const [txMeta, setTxMeta] = useState(null) // { durationSec, parts, gap }
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  // The summary stopped because the model ran out of room, not because the
  // debrief ended. It reads as a finished summary — the route repairs the
  // unclosed JSON — so the only thing standing between that and a note saved
  // with its last point missing is saying so here.
  //
  // It now fires far more rarely, and means far more when it does: the route
  // asks the model for the rest up to three times before giving up, so reaching
  // here means a debrief that is long even by those standards.
  const [cutShort, setCutShort] = useState(false)
  // WHICH of the three tells fired. "it still ends mid-sentence" and "the
  // provider cut it off" need different next steps, and reading one as the
  // other is what sent three rounds of this bug to the wrong place.
  const [cutSignals, setCutSignals] = useState(null)
  const [glossaryExtra, setGlossaryExtra] = useState(null)
  // null = not yet known. Until it is known the button is allowed to be pressed;
  // the check runs again on press, so nothing slips through a slow fetch.
  const [consent, setConsent] = useState(null)
  const [blocked, setBlocked] = useState(false)
  const [agreeing, setAgreeing] = useState(false)
  const [agreeErr, setAgreeErr] = useState(null)
  const [agreed, setAgreed] = useState(false)

  // The boat's live sail wardrobe + class glossary, feeding the summariser so
  // sail names self-maintain from the Boat tab. Shared with NoteRecorder and
  // cached per boat — a day's page mounts many of these.
  useEffect(() => { loadBoatVocab(teamId, boatId).then(setGlossaryExtra) }, [teamId, boatId])

  useEffect(() => {
    if (!teamId) return
    let off = false
    fetch(`/api/teams/${teamId}/recording-consent`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!off && j) setConsent(j) })
      .catch(() => { /* leave null — press-time check will try again */ })
    return () => { off = true }
  }, [teamId])

  // Desktop + editors only. On mobile the button simply isn't shown.
  if (isMobile || !canEdit) return null

  // Re-checked on press rather than trusted from mount: someone may have
  // withdrawn consent while this page was open, and withdrawal has to bite
  // immediately to mean anything.
  async function guardedOpen() {
    setBlocked(false); setAgreed(false); setAgreeErr(null)
    let c = consent
    if (teamId) {
      try {
        const r = await fetch(`/api/teams/${teamId}/recording-consent`)
        if (r.ok) { c = await r.json(); setConsent(c) }
      } catch { /* fall back to what we already had */ }
    }
    if (c && !c.allConsented) { setBlocked(true); return }
    if (inputRef.current) inputRef.current.click()
  }

  // Ticking the box from inside the refusal panel. The route writes the caller's
  // own flag and hands back the recomputed gate, so one call both agrees and
  // re-checks — there is no window in which the UI believes a consent the
  // database has not got.
  async function agreeNow() {
    setAgreeing(true); setAgreeErr(null)
    try {
      const r = await fetch(`/api/teams/${teamId}/recording-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true }),
      })
      if (!r.ok) throw new Error('could not save your agreement — try your profile')
      const c = await r.json()
      setConsent(c)
      // Deliberately NOT auto-opening the file picker: the await has broken the
      // user-gesture chain, so a programmatic click on the input is blocked in
      // some browsers, and would be a surprise in the rest.
      if (c.allConsented) { setBlocked(false); setAgreed(true) }
    } catch (ex) {
      setAgreeErr((ex && ex.message) || 'could not save your agreement')
    } finally { setAgreeing(false) }
  }

  async function onPick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setErr(null); setResult(null); setCutShort(false); setCutSignals(null); setBusy(true); setStage('compress'); setPct(0)
    try {
      const { fields: out, transcript: tx, truncated, cutSignals: sig, durationSec, parts, gap } = await runAudioBrief(file, mode, {
        onStage: (s, p) => { setStage(s); setPct(p || 0) },
        glossaryExtra,
      })
      setResult(out); setTranscript(tx); setCutShort(!!truncated); setCutSignals(sig || null)
      setTxMeta({ durationSec, parts, gap })
    } catch (ex) {
      setErr((ex && ex.message) || String(ex))
    } finally { setBusy(false); setStage(null) }
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcript)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard permission, or an insecure origin. Open the box instead —
      // it is uncapped, so select-all gets the whole thing.
      setShowTx(true)
    }
  }

  async function save() {
    if (!result) return
    setSaving(true); setErr(null)
    try { await onSaved(result); setResult(null); setTranscript(''); setShowTx(false); setTxMeta(null) }
    catch (ex) { setErr((ex && ex.message) || 'save failed') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <input ref={inputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={onPick} />

      {!result && (
        <button onClick={guardedOpen} disabled={busy}
          style={{ ...btn, background: busy ? '#0F2030' : '#06253044', borderColor: '#06B6D4', color: busy ? '#8a97a9' : '#06B6D4', fontWeight: 700 }}>
          {busy
            ? (stage === 'summarise'
                ? 'Summarising… (a long debrief takes a few minutes)'
                : `${STAGE[stage] || 'Working'}… ${Math.round(pct * 100)}%`)
            : '🎙 Summarise from a recording'}
        </button>
      )}

      {busy && (
        <div style={{ height: 6, background: '#0F2030', borderRadius: 4, overflow: 'hidden', marginTop: 8, border: '1px solid #1E3A5A' }}>
          <i style={{ display: 'block', height: '100%', width: `${Math.round(pct * 100)}%`, background: '#06B6D4', transition: 'width .15s' }} />
        </div>
      )}

      {agreed && (
        <div style={{ color: '#10B981', fontSize: 12, marginTop: 8 }}>
          ✓ Agreed, and saved. Press the button again to pick the recording.
        </div>
      )}

      {blocked && (
        <div style={{ marginTop: 8, background: '#2A1A0A', border: '1px solid #B45309', borderRadius: 10, padding: 12, fontSize: 12, color: '#FCD34D', lineHeight: 1.6 }}>
          {consent && consent.youConsented === false ? (
            <>
              <b>You have not agreed to be recorded in team debriefs.</b> The recording
              captures everyone in the room, including you, so it will not run until you have.
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, cursor: agreeing ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={false} disabled={agreeing}
                  onChange={agreeNow} style={{ marginTop: 2, width: 15, height: 15, flexShrink: 0 }} />
                <span style={{ color: '#FDE68A' }}>
                  <b>I agree to be recorded in team debriefs.</b>{' '}
                  {agreeing ? 'Saving…' : 'Saved the moment you tick it — this covers debriefs already recorded as well as future ones, and you can withdraw it at any time in your profile.'}
                </span>
              </label>
              {agreeErr && <div style={{ color: '#EF4444', marginTop: 6 }}>✕ {agreeErr}</div>}
            </>
          ) : (
            <>
              <b>Not all of your team have agreed to team recording.</b> They can do so in their
              profile.
            </>
          )}
          {consent && consent.pending && consent.pending.length > 0 && (
            <div style={{ marginTop: 6, color: '#E8C98A' }}>
              Still to agree: {consent.pending.join(', ')}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <a href="/profile" style={{ color: '#FCD34D', textDecoration: 'underline' }}>Open your profile</a>
          </div>
        </div>
      )}

      {cutShort && (
        <div style={{ color: '#F59E0B', fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
          ⚠ <b>The summary is still unfinished</b>
          {cutSignals && cutSignals.midSentence && !cutSignals.repaired && !cutSignals.finishReason
            ? ' — it ends mid-sentence even though the model reported it as complete, '
            : ' — the model stopped early, '}
          and asking it for the rest did not finish the job either. The transcript is
          complete (check its size above); the LAST section is the one to read before
          saving. Copy the transcript and re-run if something is missing.
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
              <AutoTextarea value={result[f.key] || ''} minRows={5} maxHeight="none" style={ta}
                onChange={(e) => setResult((p) => ({ ...p, [f.key]: e.target.value }))} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving} style={{ ...btn, background: '#10B981', border: 'none', color: '#03251a', fontWeight: 700 }}>
              {saving ? 'Saving…' : 'Save to section'}
            </button>
            <button onClick={() => { setResult(null); setTranscript(''); setShowTx(false); setTxMeta(null) }} style={btn}>Discard</button>
            <button onClick={() => setShowTx((s) => !s)} style={{ ...btn, background: 'transparent' }}>{showTx ? 'Hide' : 'Show'} transcript</button>
            {/* The transcript is the expensive half of the run and it is thrown
                away the moment the draft is saved — so re-running a SUMMARY
                (scripts/debrief-resummarise.ts) means paying for the
                transcription again unless it can be got out of here first. */}
            <button onClick={copyTranscript} style={{ ...btn, background: 'transparent' }}>
              {copied ? '✓ Copied' : 'Copy transcript'}
            </button>
          </div>
          {txMeta && txMeta.gap && (
            <div style={{ color: '#F59E0B', fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>⚠ {txMeta.gap}</div>
          )}

          {showTx && (
            <>
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 8 }}>
                Raw transcript — {transcript.length.toLocaleString()} characters
                {txMeta && txMeta.parts ? `, ${txMeta.parts} part${txMeta.parts === 1 ? '' : 's'}` : ''}
                {txMeta && Number.isFinite(txMeta.durationSec) ? `, ${mmssOf(txMeta.durationSec)} of audio` : ''}.
                {' '}The whole of it is below; the box grows to fit it.
              </div>
              {/* maxHeight NONE. bd975f6 ("the debrief summary was never short — the
                  box was") gave every note box its full height and left THIS one at
                  the 60vh default — the one box whose content is forty minutes of
                  speech, so the one most likely to stop mid-sentence at a bottom
                  edge and read as a transcription that was cut. The cap bought
                  nothing here either: this box is the LAST thing in the panel, below
                  the Save button, so it cannot push the actions off the page. */}
              <AutoTextarea readOnly value={transcript} minRows={8} maxHeight="none"
                style={{ ...ta, marginTop: 4, fontFamily: 'monospace', fontSize: 11, color: '#8a97a9' }} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
