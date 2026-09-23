'use client'
import React, { useCallback, useMemo, useState } from 'react'
import AskAnswerModal from './AskAnswerModal'

// ─── ASK THE DATA ─────────────────────────────────────────────────────────────
// The box at the top of the Analysis tab. Type the question the way you would say
// it; the answer opens over the tab with the chart and the photo beside it.
//
// Two deliberate choices in how it presents itself:
//
// • It is never an empty box. Long-form typing into a blank field is still not a
//   habit for most people, and the suggestions here are built from what THIS day
//   holds — its races, its sails — so every one of them is answerable. A
//   suggestion that also fails is worse than no suggestion.
//
// • The button says "Ask", and the label says what it reads. "Summarize with
//   copilot", not "Copilot, summarize": the person is the pilot, and every
//   question it answers can also be answered by opening the tables below by hand.

const C = {
  bg: '#0A1929', panel: '#071624', line: '#1E3A5A', text: '#E2E8F0',
  dim: '#94A3B8', faint: '#475569', cyan: '#06B6D4',
}

const STARTERS = ({ races, hasManoeuvres, hasPhotos, manyDays }) => [
  'Was VMG% better on port or starboard upwind today?',
  'Which sail combination was quickest upwind today?',
  ...(races >= 2 ? [`Compare VMG% upwind between race 1 and race ${races}.`] : []),
  ...(hasManoeuvres ? ['Which tacks cost the most distance today?'] : []),
  ...(hasPhotos ? ['Show me the photos from the strongest wind today.'] : []),
  ...(manyDays ? ['How does today compare with the rest of the season upwind?'] : []),
  'How did VMG% change across the wind range today?',
]

export default function AskPanel({
  boat, activeDate, canUseAI = false, races = 0, hasManoeuvres = false,
  hasPhotos = false, manyDays = false, onPlayClip = null, onStatsComputed = null,
}) {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [computing, setComputing] = useState(false)
  const [history, setHistory] = useState([])

  const starters = useMemo(
    () => STARTERS({ races, hasManoeuvres, hasPhotos, manyDays }).slice(0, 4),
    [races, hasManoeuvres, hasPhotos, manyDays])

  const ask = useCallback(async (q, opts = {}) => {
    const text = (q || '').trim()
    if (!text || !boat || !activeDate) return
    setAsked(text); setBusy(true); setError(''); setResult(null)
    try {
      const r = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          teamId: boat.teamId, boatId: boat.boatId, date: activeDate,
          question: text, force: !!opts.force,
          // Only what was actually answered carries forward — a blocked question
          // is not a turn, and feeding it back invites the same wrong reading.
          history: history.slice(-3),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) setError(j.error || `HTTP ${r.status}`)
      else {
        setResult(j)
        if (!j.blocked && j.answer?.lines?.length) {
          setHistory(h => [...h, { question: text, answer: j.answer.lines.join(' ') }].slice(-3))
        }
      }
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }, [boat, activeDate, history])

  // Editing a token re-runs that ONE tool, deterministically. No model, no new
  // opinion — the same arguments always give the same table.
  const editToken = useCallback(async (stepIndex, path, value) => {
    const step = result?.steps?.[stepIndex]
    if (!step || !boat || !activeDate) return
    setResult(r => ({ ...r, steps: r.steps.map((s, i) => (i === stepIndex ? { ...s, busy: true } : s)) }))
    try {
      const r = await fetch('/api/ai/ask/tool', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          teamId: boat.teamId, boatId: boat.boatId, date: activeDate,
          tool: step.tool, args: step.args, edit: { path, value },
        }),
      })
      const j = await r.json().catch(() => ({}))
      setResult(prev => ({
        ...prev,
        steps: prev.steps.map((s, i) => (i !== stepIndex ? s : (
          r.ok
            ? { ...s, ...j, busy: false, edited: true }
            : { ...s, busy: false, unavailable: j.error || `HTTP ${r.status}` }
        ))),
      }))
    } catch (e) {
      setResult(prev => ({
        ...prev,
        steps: prev.steps.map((s, i) => (i === stepIndex ? { ...s, busy: false, unavailable: String(e?.message || e) } : s)),
      }))
    }
  }, [result, boat, activeDate])

  const sendFeedback = useCallback(verdict => {
    if (!result?.logId) return
    fetch('/api/ai/ask/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logId: result.logId, verdict }),
    }).catch(() => { /* a lost thumb is not worth a message */ })
  }, [result])

  // The day has no stored numbers: compute them server-side from the cloud log,
  // the same POST the Performance charts use, then ask the question again.
  const computeStats = useCallback(async () => {
    if (!boat || !activeDate) return
    setComputing(true)
    try {
      const r = await fetch(`/api/teams/${boat.teamId}/boats/${boat.boatId}/phase-stats/${activeDate}`, { method: 'POST' })
      if (r.ok) {
        onStatsComputed?.()
        if (asked) await ask(asked, { force: true })
      } else {
        const j = await r.json().catch(() => ({}))
        setError(j.error || `could not compute this day (HTTP ${r.status})`)
      }
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setComputing(false)
    }
  }, [boat, activeDate, asked, ask, onStatsComputed])

  if (!canUseAI) return null

  const disabled = !boat || !activeDate

  return (
    <>
      <div style={{ background: C.bg, border: `1px solid ${C.cyan}33`, borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#7DD3FC', letterSpacing: 1, textTransform: 'uppercase' }}>
            ✦ Ask the data
          </span>
          <span style={{ fontSize: 10, color: C.faint }}>
            Your own numbers, photos and clips — read by Mistral on Scaleway (EU). It never calculates; it looks things up.
          </span>
        </div>

        <form onSubmit={e => { e.preventDefault(); ask(question) }} style={{ display: 'flex', gap: 8 }}>
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            disabled={disabled}
            placeholder={disabled ? 'Open a day first' : 'Were we quicker on port or starboard upwind in the breeze?'}
            aria-label="Ask a question about this data"
            style={{
              flex: 1, minWidth: 0, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 7,
              color: C.text, fontSize: 12.5, padding: '9px 11px',
            }} />
          <button type="submit" disabled={disabled || !question.trim() || busy}
            style={{
              fontSize: 12, fontWeight: 700, borderRadius: 7, padding: '9px 18px',
              cursor: disabled || !question.trim() ? 'default' : 'pointer',
              border: `1px solid ${C.cyan}`, background: question.trim() ? '#06B6D420' : C.panel,
              color: question.trim() ? C.cyan : C.faint, whiteSpace: 'nowrap',
            }}>
            {busy ? 'Reading…' : 'Ask'}
          </button>
        </form>

        {!question && !disabled && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
            {starters.map(s => (
              <button key={s} onClick={() => { setQuestion(s); ask(s) }}
                style={{
                  fontSize: 10.5, borderRadius: 999, padding: '4px 11px', cursor: 'pointer',
                  border: `1px solid ${C.line}`, background: C.panel, color: C.dim,
                }}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {(busy || result || error) && asked && (
        <AskAnswerModal
          question={asked}
          result={result}
          busy={busy}
          error={error}
          onClose={() => { setAsked(null); setResult(null); setError('') }}
          onAsk={ask}
          onEditToken={editToken}
          onFeedback={result?.logId ? sendFeedback : null}
          onPlayClip={onPlayClip}
          onComputeStats={computeStats}
          computing={computing}
          activeDate={activeDate}
        />
      )}
    </>
  )
}
