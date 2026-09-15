'use client'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  WIND_BANDS, TENSIONS, TENSION_SHORT, MAX_BATTEN_COUNT,
  defaultBattenCard, normaliseBattenCard, setBattenCount, formatSetting,
  type BattenCard, type BattenSetting, type Tension,
} from '../../lib/battens'

// Boat → Battens. The laminated card, in the app.
//
// A grid: one row per batten, one column per wind band. Battens are numbered
// FROM THE TOP, because that is how a crew counts them standing on deck looking
// up, and because the top batten is the one that gets touched.
//
// Edited as a whole and saved as a whole — it is a card, and a half-saved card
// is a card that is wrong in the boat. Which also means an explicit Save: this
// is reference data that a whole crew reads, not a personal note, and a grid
// that writes on every keystroke is a grid where a mis-tap becomes the team's
// tuning guide.
//
// Six columns do not fit across a phone, so on a narrow screen the grid becomes
// one card per batten with its bands stacked inside. Same data, same edits.

const C = {
  card: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  text: '#cbd5e1', dim: '#8A97A9', head: '#e2e8f0', warn: '#F59E0B', ok: '#10B981',
}

const TENSION_COLOR: Record<Tension, string> = {
  soft: '#38BDF8',
  medium: '#2DD4BF',
  stiff: '#F59E0B',
}

export default function BattenCardPanel({
  teamId, boatId, canEdit, isMobile,
}: {
  teamId: string
  boatId: string
  canEdit: boolean
  isMobile?: boolean
}) {
  const [saved, setSaved] = useState<BattenCard>(() => defaultBattenCard())
  const [draft, setDraft] = useState<BattenCard>(() => defaultBattenCard())
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    fetch(`/api/teams/${teamId}/boats/${boatId}/battens`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const card = normaliseBattenCard(j.card)
        setSaved(card); setDraft(card); setUpdatedAt(j.updatedAt ?? null)
      })
      .catch(() => setErr('Could not load the batten card.'))
      .finally(() => setLoading(false))
  }, [teamId, boatId])
  useEffect(() => { load() }, [load])

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  )

  const cell = (battenIdx: number, bandKey: string): BattenSetting =>
    draft.rows[battenIdx]?.[bandKey] || { tension: null, turns: 0 }

  const patch = (battenIdx: number, bandKey: string, next: Partial<BattenSetting>) =>
    setDraft((d) => {
      const rows = d.rows.map((r, i) => (i === battenIdx ? { ...r } : r))
      const cur = rows[battenIdx]?.[bandKey] || { tension: null, turns: 0 }
      rows[battenIdx] = { ...rows[battenIdx], [bandKey]: { ...cur, ...next } }
      return { ...d, rows }
    })

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      const r = await fetch(`/api/teams/${teamId}/boats/${boatId}/battens`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: draft }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const card = normaliseBattenCard(j.card)
      setSaved(card); setDraft(card); setUpdatedAt(j.updatedAt ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the batten card.')
    } finally { setSaving(false) }
  }

  if (loading) return <div style={{ color: C.dim, fontSize: 12 }}>Loading…</div>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.head }}>Batten card</span>
        <span style={{ fontSize: 11, color: C.dim }}>
          numbered from the top · turns may be negative
        </span>
        {updatedAt && (
          <span style={{ fontSize: 10, color: C.dim }}>
            saved {new Date(updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: C.text }} htmlFor="batten-count">Battens</label>
          <input
            id="batten-count"
            type="number"
            min={1}
            max={MAX_BATTEN_COUNT}
            value={draft.count}
            onChange={(e) => setDraft((d) => setBattenCount(d, Number(e.target.value)))}
            style={{
              width: 64, background: '#04101c', border: `1px solid ${C.border}`,
              borderRadius: 6, padding: '7px 8px', color: C.head, fontSize: 16,
            }}
          />
          <button
            onClick={save}
            disabled={!dirty || saving}
            style={{
              marginLeft: 'auto', minHeight: 40, padding: '0 16px', borderRadius: 8,
              border: 'none', cursor: dirty && !saving ? 'pointer' : 'default',
              background: dirty ? C.accent : '#0F2A45',
              color: dirty ? '#001018' : '#64748B', fontWeight: 800, fontSize: 13,
            }}
          >
            {saving ? 'Saving…' : dirty ? 'Save card' : 'Saved'}
          </button>
          {dirty && !saving && (
            <button
              onClick={() => setDraft(saved)}
              style={{
                minHeight: 40, padding: '0 12px', borderRadius: 8, fontSize: 12,
                border: `1px solid ${C.border}`, background: 'transparent',
                color: C.dim, cursor: 'pointer',
              }}
            >
              Discard
            </button>
          )}
        </div>
      )}

      {err && <div style={{ color: C.warn, fontSize: 12, marginBottom: 10 }}>{err}</div>}

      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.rows.map((_, i) => (
            <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.head, marginBottom: 8 }}>
                Batten {i + 1}{i === 0 ? ' · top' : ''}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {WIND_BANDS.map((b) => (
                  <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 52, flexShrink: 0, fontSize: 11, color: C.dim, fontWeight: 700 }}>
                      {b.label}
                    </span>
                    <Cell
                      value={cell(i, b.key)}
                      canEdit={canEdit}
                      onChange={(next) => patch(i, b.key, next)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: 1180 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left', minWidth: 96 }}>Batten</th>
                {WIND_BANDS.map((b) => (
                  <th key={b.key} style={{ ...th, minWidth: 186 }}>{b.label}<span style={{ color: C.dim, fontWeight: 500 }}> kn</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((_, i) => (
                <tr key={i}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 800, color: C.head }}>
                    {i + 1}
                    {i === 0 && <span style={{ color: C.dim, fontWeight: 500, fontSize: 10 }}> · top</span>}
                  </td>
                  {WIND_BANDS.map((b) => (
                    <td key={b.key} style={td}>
                      <Cell
                        value={cell(i, b.key)}
                        canEdit={canEdit}
                        onChange={(next) => patch(i, b.key, next)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!canEdit && (
        <p style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
          Read-only. The batten card is boat setup — a coach, team manager or TL3 can change it.
        </p>
      )}
    </div>
  )
}

/** One cell: a stiffness and a turn count. Read-only renders it the way a crew says it. */
function Cell({
  value, canEdit, onChange,
}: {
  value: BattenSetting
  canEdit: boolean
  onChange: (next: Partial<BattenSetting>) => void
}) {
  if (!canEdit) {
    return (
      <span style={{ fontSize: 12, color: value.tension ? TENSION_COLOR[value.tension] : C.dim, fontWeight: 700 }}>
        {formatSetting(value)}
      </span>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ display: 'flex', gap: 2 }}>
        {TENSIONS.map((t) => {
          const on = value.tension === t
          return (
            <button
              key={t}
              // Tapping the stiffness that is already set clears it — otherwise
              // a cell filled in by mistake can never be made blank again.
              onClick={() => onChange({ tension: on ? null : t })}
              title={t}
              aria-pressed={on}
              style={{
                minWidth: 38, minHeight: 32, padding: '0 4px', borderRadius: 5, cursor: 'pointer',
                fontSize: 10, fontWeight: 800,
                border: `1px solid ${on ? TENSION_COLOR[t] : C.border}`,
                background: on ? TENSION_COLOR[t] : 'transparent',
                color: on ? '#001018' : C.dim,
              }}
            >
              {TENSION_SHORT[t]}
            </button>
          )
        })}
      </div>
      <input
        type="number"
        inputMode="numeric"
        step={1}
        value={value.turns === 0 ? '' : value.turns}
        placeholder="0"
        onChange={(e) => {
          const raw = e.target.value
          // "-" alone is a number half-typed, not a zero. Leaving it as 0 would
          // fight the keyboard on every negative entry.
          if (raw === '' || raw === '-') { onChange({ turns: 0 }); return }
          const n = Number(raw)
          if (Number.isFinite(n)) onChange({ turns: Math.round(n) })
        }}
        aria-label="turns"
        style={{
          width: 46, minHeight: 30, background: '#04101c', border: `1px solid ${C.border}`,
          borderRadius: 5, padding: '0 6px', color: C.head, fontSize: 16, textAlign: 'center',
        }}
      />
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '6px 8px', fontSize: 11, color: C.dim, fontWeight: 700,
  textAlign: 'center', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'center', borderBottom: `1px solid #0F2030`,
}
