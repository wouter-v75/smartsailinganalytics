'use client'
import React, { useState } from 'react'
import AskChart from './AskChart'

// ─── ASK ANSWER ───────────────────────────────────────────────────────────────
// The popup: what the machine understood, what it found, the picture, the rows
// behind the picture, the photos and clips, and how it got there.
//
// The order is deliberate and is the research (docs/ai-query-analysis-2026-09.md):
//   1. The WARNING first, if there is one. A caveat under the answer is a caveat
//      nobody reads.
//   2. What it understood, as editable tokens. A crew member cannot audit a tool
//      call but can read "Upwind · TWS 14–18 kn · by tack" — and when it read
//      "in the breeze" as 14–18 and you meant over 20, you drag the number
//      rather than retyping the question and hoping.
//   3. The answer, then the chart, then the table it was drawn from. Citations
//      close to the claim, so checking costs one glance.
//   4. The evidence — the photo, the clip, the scan. The part general BI tools
//      cannot do and the part a sailor actually wants.
//   5. How it was answered, and 👍/👎.

const C = {
  bg: '#0A1929', panel: '#071624', line: '#1E3A5A', soft: '#0F2A45',
  text: '#E2E8F0', dim: '#94A3B8', faint: '#475569', cyan: '#06B6D4',
  warn: '#F59E0B', bad: '#EF4444', good: '#22C55E',
}

const btn = (on = false) => ({
  fontSize: 11, fontWeight: 600, borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
  border: `1px solid ${on ? C.cyan : C.line}`, background: on ? '#06B6D420' : C.panel,
  color: on ? C.cyan : C.dim,
})
const caption = { fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: 1, textTransform: 'uppercase' }

// ── One editable search token ────────────────────────────────────────────────

function TokenChip({ token, onEdit, busy }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(token.value)
  if (!token.editable || !onEdit) {
    return <span style={{ ...chip, cursor: 'default' }}>{token.text}</span>
  }

  const commit = v => { setOpen(false); onEdit(token.path, v) }
  const pair = Array.isArray(draft) ? draft : ['', '']
  const setPair = (i, v) => setDraft(p => { const n = [...(Array.isArray(p) ? p : ['', ''])]; n[i] = v; return n })

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => { setDraft(token.value); setOpen(o => !o) }} disabled={busy}
        title={`${token.label} — click to change`}
        style={{ ...chip, cursor: 'pointer', borderStyle: 'dashed', opacity: busy ? 0.5 : 1 }}>
        {token.text} <span style={{ color: C.faint }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 10,
          background: C.bg, border: `1px solid ${C.cyan}66`, borderRadius: 8, padding: 10,
          minWidth: 210, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          <div style={{ ...caption, marginBottom: 6 }}>{token.label}</div>

          {(token.kind === 'number' || token.kind === 'daterange' || token.kind === 'text') && Array.isArray(token.value) && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={pair[0] ?? ''} onChange={e => setPair(0, e.target.value)} placeholder="from"
                style={input} />
              <span style={{ color: C.faint }}>→</span>
              <input value={pair[1] ?? ''} onChange={e => setPair(1, e.target.value)} placeholder="to"
                style={input} />
            </div>
          )}

          {(token.kind === 'number' || token.kind === 'text') && !Array.isArray(token.value) && (
            <input value={draft ?? ''} onChange={e => setDraft(e.target.value)} style={{ ...input, width: '100%' }} />
          )}

          {token.kind === 'enum' && (
            <select value={draft ?? ''} onChange={e => setDraft(e.target.value)} style={{ ...input, width: '100%' }}>
              {(token.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}

          {(token.kind === 'multi' || token.kind === 'groups') && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
              {(token.options || []).map(o => {
                const list = Array.isArray(draft) ? draft : []
                const on = list.includes(o.value)
                return (
                  <button key={o.value} onClick={() => setDraft(on ? list.filter(x => x !== o.value) : [...list, o.value])}
                    style={btn(on)}>{o.label}</button>
                )
              })}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button onClick={() => commit(draft)} style={{ ...btn(true), flex: 1 }}>Apply</button>
            <button onClick={() => setOpen(false)} style={btn()}>Cancel</button>
          </div>
        </div>
      )}
    </span>
  )
}

const chip = {
  display: 'inline-block', fontSize: 10, color: '#7DD3FC', background: '#06B6D414',
  border: `1px solid ${C.cyan}44`, borderRadius: 999, padding: '2px 9px', margin: '0 4px 4px 0',
  fontFamily: 'inherit',
}
const input = {
  background: C.panel, border: `1px solid ${C.line}`, borderRadius: 5, color: C.text,
  fontSize: 11, padding: '4px 6px', width: 76,
}

// ── Table behind a chart ─────────────────────────────────────────────────────

function ResultTable({ table, highlight = null }) {
  const [open, setOpen] = useState(false)
  // A row is "yours" when one of its grouping cells IS the day on screen. Only
  // ever fires for a table grouped by day, which is exactly where it is wanted.
  const isMine = row => highlight != null && table.columns.some((c, j) => c.group && String(row[j]) === String(highlight))
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)} style={{ ...btn(), fontSize: 10 }}>
        {open ? '▾' : '▸'} {open ? 'Hide' : 'Show'} the {table.rows.length} row{table.rows.length === 1 ? '' : 's'} behind this
      </button>
      {open && (
        <div style={{ overflowX: 'auto', marginTop: 6 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 10, width: '100%' }}>
            <thead>
              <tr>
                {table.columns.map(c => (
                  <th key={c.key} style={{ textAlign: c.group ? 'left' : 'right', padding: '4px 8px', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {c.label}{c.unit ? <span style={{ color: C.faint }}> {c.unit}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => {
                const mine = isMine(r)
                return (
                  <tr key={i} style={mine ? { background: '#FBBF2412' } : undefined}>
                    {r.map((v, j) => (
                      <td key={j} style={{
                        textAlign: table.columns[j]?.group ? 'left' : 'right', padding: '3px 8px',
                        color: v == null ? C.faint : mine ? '#FBBF24' : C.text,
                        fontWeight: mine ? 700 : 400,
                        borderBottom: `1px solid ${C.soft}`, whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}>{v == null ? '—' : String(v)}</td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {table.droppedThin > 0 && (
            <div style={{ fontSize: 9, color: C.faint, marginTop: 4 }}>
              {table.droppedThin} group{table.droppedThin === 1 ? '' : 's'} left out for having too few phases to say anything about.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Evidence ─────────────────────────────────────────────────────────────────

const KIND_ICON = { photo: '📷', video: '🎬', sailscan: '⛵', tag: '🏷' }

function MediaStrip({ items, onPlayClip, onOpenPhoto }) {
  if (!items?.length) return null
  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
      {items.map(m => {
        const clickable = (m.kind === 'photo' && (m.fullUrl || m.thumbUrl)) || (m.kind === 'video' && onPlayClip)
        const open = () => {
          if (m.kind === 'photo') onOpenPhoto?.(m)
          else if (m.kind === 'video') onPlayClip?.(m)
        }
        return (
          <div key={`${m.kind}-${m.id}`} onClick={clickable ? open : undefined}
            style={{
              flex: '0 0 auto', width: 132, background: C.panel, border: `1px solid ${C.line}`,
              borderRadius: 8, overflow: 'hidden', cursor: clickable ? 'pointer' : 'default',
            }}>
            {m.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.thumbUrl} alt={m.title} loading="lazy"
                style={{ width: '100%', height: 78, objectFit: 'cover', display: 'block', background: C.soft }} />
            ) : (
              <div style={{ height: 78, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, background: C.soft }}>
                {KIND_ICON[m.kind]}
              </div>
            )}
            <div style={{ padding: '5px 7px' }}>
              <div style={{ fontSize: 10, color: C.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {KIND_ICON[m.kind]} {m.title}
              </div>
              <div style={{ fontSize: 9, color: C.dim }}>{[m.date, m.atLocal].filter(Boolean).join(' · ')}</div>
              {m.conditions && <div style={{ fontSize: 9, color: '#7DD3FC', marginTop: 2 }}>{m.conditions}</div>}
              {m.note && <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>{m.note.slice(0, 70)}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── The modal ────────────────────────────────────────────────────────────────

export default function AskAnswerModal({
  question, result, busy, error, onClose, onAsk, onEditToken, onFeedback,
  onPlayClip, onComputeStats, computing, activeDate = null,
}) {
  const [followUp, setFollowUp] = useState('')
  const [verdict, setVerdict] = useState(null)
  const [photo, setPhoto] = useState(null)

  const risk = result?.risk
  const blocked = !!result?.blocked
  const steps = result?.steps || []
  const lines = result?.answer?.lines || []
  const bottom = result?.answer?.bottomLine || []
  const suggestions = blocked ? (risk?.narrower || []) : (result?.suggestions?.length ? result.suggestions : risk?.narrower || [])
  const edited = steps.some(s => s.edited)

  const sendFeedback = v => {
    setVerdict(v)
    onFeedback?.(v)
  }

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Answer"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.68)', zIndex: 1300, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '28px 12px' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(760px, 100%)', background: C.bg, border: `1px solid ${C.cyan}44`, borderRadius: 12, padding: 18, color: C.text }}>

        {/* Question, always visible above its answer — input and output together */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={caption}>You asked</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{question}</div>
          </div>
          <button onClick={onClose} style={{ ...btn(), padding: '6px 11px' }}>Close</button>
        </div>

        {busy && (
          <div style={{ padding: '22px 0', textAlign: 'center', color: C.dim, fontSize: 12 }}>
            Reading the boat&rsquo;s data…
          </div>
        )}

        {error && (
          <div style={{ background: '#2a1f0a', border: `1px solid ${C.warn}55`, borderRadius: 8, padding: '10px 12px', fontSize: 12, color: C.warn }}>
            {error}
          </div>
        )}

        {/* 1 · The warning, before the answer */}
        {!busy && risk && risk.level !== 'ok' && (risk.before?.length || risk.after?.length) && (
          <div style={{
            background: risk.level === 'high' ? '#2a0f0f' : '#2a1f0a',
            border: `1px solid ${risk.level === 'high' ? C.bad : C.warn}55`,
            borderRadius: 8, padding: '10px 12px', marginBottom: 12,
          }}>
            <div style={{ ...caption, color: risk.level === 'high' ? C.bad : C.warn, marginBottom: 4 }}>
              {risk.level === 'high' ? 'This is the kind of question that gets made up' : 'Read this with care'}
            </div>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, lineHeight: 1.55, color: C.text }}>
              {[...(risk.before || []), ...(risk.after || [])].map(f => <li key={f.code}>{f.text}</li>)}
            </ul>
          </div>
        )}

        {/* The day has no stored numbers — offer to compute them rather than shrug */}
        {!busy && result?.needsStats && (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: C.dim, flex: 1, minWidth: 200 }}>
              This day has no stored performance numbers yet, so there is nothing to read from it.
            </span>
            {onComputeStats && (
              <button onClick={onComputeStats} disabled={computing} style={{ ...btn(true), opacity: computing ? 0.6 : 1 }}>
                {computing ? 'Working it out…' : 'Compute this day, then ask again'}
              </button>
            )}
          </div>
        )}

        {/* Better questions — the ones this data can actually answer */}
        {!busy && suggestions.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ ...caption, marginBottom: 5 }}>
              {blocked ? 'Ask one of these instead' : 'Or ask'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {suggestions.map(s => (
                <button key={s} onClick={() => onAsk?.(s)}
                  style={{ ...btn(), textAlign: 'left', fontWeight: 500, fontSize: 11.5, padding: '7px 10px', color: C.text }}>
                  {s}
                </button>
              ))}
            </div>
            {blocked && (
              <button onClick={() => onAsk?.(question, { force: true })}
                style={{ ...btn(), marginTop: 8, fontSize: 10, color: C.faint }}>
                Answer my question anyway
              </button>
            )}
          </div>
        )}

        {/* 3 · The answer */}
        {!busy && lines.length > 0 && (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, lineHeight: 1.65 }}>
              {lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
            {bottom.length > 0 && (
              <>
                <div style={{ ...caption, marginTop: 10, marginBottom: 3, color: '#7DD3FC' }}>Bottom line</div>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, lineHeight: 1.65 }}>
                  {bottom.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </>
            )}
            {edited && (
              <div style={{ fontSize: 10, color: C.warn, marginTop: 8 }}>
                You have changed a filter since this was written — the words below still describe the original query. Ask again to have them rewritten.
              </div>
            )}
          </div>
        )}

        {!busy && !blocked && !lines.length && !error && (
          <div style={{ fontSize: 12, color: C.dim, marginBottom: 12 }}>
            Nothing came back that could be checked against the data.
          </div>
        )}

        {/* 2 + 4 · What it understood, what it found, what it looks like */}
        {steps.map((s, i) => (
          <div key={i} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: '11px 13px', marginBottom: 10 }}>
            <div style={{ ...caption, marginBottom: 5 }}>
              {i + 1}. {TOOL_TITLE[s.tool] || s.tool}
            </div>
            {/* The tokens read as decoration unless you are told they are not.
                Somebody who edited one on the first live test still did not
                register them as the feature — so the line above them says it. */}
            {onEditToken && (s.tokens || []).some(t => t.editable) && (
              <div style={{ fontSize: 9.5, color: C.faint, marginBottom: 4 }}>
                What it understood — <span style={{ color: '#7DD3FC' }}>tap any of these to change it</span> and the numbers redraw.
              </div>
            )}
            <div style={{ marginBottom: s.charts?.length || s.media?.length ? 8 : 0 }}>
              {(s.tokens || []).map(t => (
                <TokenChip key={`${t.path}-${t.text}`} token={t} busy={s.busy}
                  onEdit={onEditToken ? (path, value) => onEditToken(i, path, value) : null} />
              ))}
            </div>

            {s.unavailable && (
              <div style={{ fontSize: 11.5, color: C.warn, background: '#2a1f0a', border: `1px solid ${C.warn}44`, borderRadius: 6, padding: '7px 9px' }}>
                {s.unavailable}
              </div>
            )}

            {s.charts?.map((c, ci) => (
              <div key={ci} style={{ marginTop: 8 }}><AskChart spec={c} highlight={activeDate} /></div>
            ))}
            {s.tables?.map((t, ti) => <ResultTable key={ti} table={t} highlight={activeDate} />)}
            {s.media?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <MediaStrip items={s.media} onPlayClip={onPlayClip} onOpenPhoto={setPhoto} />
              </div>
            )}
            {s.summary && <div style={{ fontSize: 9.5, color: C.faint, marginTop: 6 }}>{s.summary}</div>}
          </div>
        ))}

        {/* 5 · Provenance and the thumbs */}
        {!busy && result && !blocked && (
          <div style={{ borderTop: `1px solid ${C.soft}`, paddingTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9.5, color: C.faint, flex: 1, minWidth: 200 }}>
              {result.model} on Scaleway (EU) · {result.ms ? `${(result.ms / 1000).toFixed(1)} s` : ''}
              {' · '}
              {steps.length
                ? `${steps.length} tool call${steps.length === 1 ? '' : 's'} against the boat's stored numbers`
                : 'no tool was called'}
              {result.answer?.dropped?.length
                ? ` · ${result.answer.dropped.length} sentence${result.answer.dropped.length === 1 ? '' : 's'} dropped by the number check`
                : ''}
              . Check it before you act on it.
            </span>
            {onFeedback && (
              <span style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => sendFeedback(1)} style={btn(verdict === 1)} title="Useful">👍</button>
                <button onClick={() => sendFeedback(-1)} style={btn(verdict === -1)} title="Not useful">👎</button>
              </span>
            )}
          </div>
        )}

        {/* Follow-up — the conversation continues where the answer is */}
        {!busy && onAsk && (
          <form onSubmit={e => { e.preventDefault(); if (followUp.trim()) { onAsk(followUp.trim()); setFollowUp('') } }}
            style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input value={followUp} onChange={e => setFollowUp(e.target.value)}
              placeholder="Ask a follow-up…"
              style={{ ...input, flex: 1, width: 'auto', fontSize: 12, padding: '8px 10px' }} />
            <button type="submit" disabled={!followUp.trim()} style={{ ...btn(!!followUp.trim()), padding: '8px 14px' }}>Ask</button>
          </form>
        )}
      </div>

      {photo && (
        <div onClick={e => { e.stopPropagation(); setPhoto(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.fullUrl || photo.thumbUrl} alt={photo.title}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 12, color: C.text }}>
            {[photo.title, photo.date, photo.atLocal, photo.conditions].filter(Boolean).join(' · ')}
          </div>
        </div>
      )}
    </div>
  )
}

const TOOL_TITLE = {
  compare_phases: 'Compared the boat’s steady-state phases',
  scatter_phases: 'Plotted every phase, one dot each',
  rank_drivers: 'Ranked what moves the number most',
  day_timeseries: 'Read the instruments through the day',
  list_manoeuvres: 'Looked at the tacks and gybes',
  find_media: 'Looked for photos, clips and scans',
  search_notes: 'Searched what people wrote down',
}
