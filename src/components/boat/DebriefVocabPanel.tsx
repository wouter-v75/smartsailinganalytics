'use client'
import * as React from 'react'
import {
  EMPTY_VOCAB, MAX_ENTRY_CHARS, VOCAB_LABELS, VOCAB_LISTS,
  countVocab, isPairList, normaliseDebriefVocab,
  type DebriefVocab, type VocabList, type VocabPair,
} from '@/lib/debriefVocab'

// Boat → Debrief words. The glossary is what makes the debrief summaries usable,
// and half of it used to be hard-coded: a name, a rival or a mishearing cost a
// deploy, which meant it cost a day, which meant it usually did not happen. The
// moment to add a word is while the transcript is open.
//
// It ADDS to the shared glossary rather than replacing it, so an empty box is
// "I have nothing to add here", never "this boat has no crew" — see the merge
// in lib/boatVocab.js. That is why there is no delete-everything button and why
// the counts below say "extra".
//
// Editing state is a draft held here and saved whole. A per-row autosave would
// be worse than it sounds: half a pair is not a thing the model can use, and
// somebody typing a name has not yet typed the role.

const C = {
  bg: '#071624', card: '#0A1929', border: '#13293D', head: '#E2E8F0',
  text: '#CBD5E1', dim: '#64748B', accent: '#06B6D4', warn: '#F59E0B', bad: '#EF4444',
}

const inputStyle: React.CSSProperties = {
  background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6,
  color: C.head, padding: '6px 8px', fontSize: 12, width: '100%', boxSizing: 'border-box',
}

type Draft = { [K in VocabList]: K extends 'roles' | 'aliases' | 'fixups' ? VocabPair[] : string[] }

/** Rows on screen, finished or not — what the person believes they typed. */
const rawCount = (d: Draft): number =>
  VOCAB_LISTS.reduce((n, k) => n + (d[k] as unknown[]).length, 0)

const toDraft = (v: DebriefVocab): Draft => ({
  crew: [...v.crew], boats: [...v.boats], manoeuvres: [...v.manoeuvres],
  roles: v.roles.map((p) => [...p] as VocabPair),
  aliases: v.aliases.map((p) => [...p] as VocabPair),
  fixups: v.fixups.map((p) => [...p] as VocabPair),
})

export default function DebriefVocabPanel({
  teamId, boatId, canEdit, isMobile,
}: { teamId: string; boatId: string; canEdit: boolean; isMobile?: boolean }) {
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [saved, setSaved] = React.useState<DebriefVocab>(EMPTY_VOCAB)
  const [err, setErr] = React.useState<string | null>(null)
  const [msg, setMsg] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    setErr(null)
    fetch(`/api/teams/${teamId}/boats/${boatId}/debrief-vocab`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        const v = normaliseDebriefVocab(j?.vocab)
        setSaved(v); setDraft(toDraft(v)); setUpdatedAt(j?.updatedAt ?? null)
      })
      .catch(() => setErr("Couldn't load this boat's debrief words."))
  }, [teamId, boatId])
  React.useEffect(() => { load() }, [load])

  const dirty = !!draft && JSON.stringify(normaliseDebriefVocab(draft)) !== JSON.stringify(saved)

  const save = async () => {
    if (!draft) return
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await fetch(`/api/teams/${teamId}/boats/${boatId}/debrief-vocab`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vocab: normaliseDebriefVocab(draft) }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      const v = normaliseDebriefVocab(j?.vocab)
      setSaved(v); setDraft(toDraft(v)); setUpdatedAt(j?.updatedAt ?? null)
      // Half-typed rows are dropped on the way in. Count against what was TYPED,
      // not against the normalised body we sent — those are equal by
      // construction, so comparing them reports nothing and the row just
      // disappears from the editor as though the typing had never happened.
      const lost = rawCount(draft) - countVocab(v)
      setMsg(lost > 0
        ? `Saved. ${lost} unfinished ${lost === 1 ? 'row was' : 'rows were'} dropped — both halves are needed.`
        : 'Saved. The next recording uses these.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const setList = (k: VocabList, next: string[] | VocabPair[]) =>
    setDraft((d) => (d ? ({ ...d, [k]: next } as Draft) : d))

  if (err && !draft) {
    return <div style={{ color: C.bad, fontSize: 12 }}>{err} <button onClick={load} style={linkBtn}>Try again</button></div>
  }
  if (!draft) return <div style={{ color: C.dim, fontSize: 12 }}>Loading…</div>

  return (
    <div>
      <div style={{ marginBottom: 14, maxWidth: 760 }}>
        <div style={{ color: C.text, fontSize: 12, lineHeight: 1.5 }}>
          Words the debrief recorder should know. These are <b>added to</b> the built-in
          sailing glossary, not instead of it — leaving a box empty changes nothing.
          Sails are not here: those come from the inventory already.
        </div>
        <div style={{ color: C.dim, fontSize: 11, marginTop: 6 }}>
          {countVocab(saved)} extra {countVocab(saved) === 1 ? 'entry' : 'entries'} saved
          {updatedAt ? ` · last changed ${new Date(updatedAt).toLocaleDateString()}` : ''}
          {canEdit ? '' : ' · read-only'}
        </div>
      </div>

      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(340px, 1fr))',
      }}>
        {VOCAB_LISTS.map((k) => (
          <ListCard
            key={k} listKey={k} canEdit={canEdit}
            values={draft[k] as string[] | VocabPair[]}
            onChange={(next) => setList(k, next)}
          />
        ))}
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={save} disabled={busy || !dirty} style={{
            background: dirty ? C.accent : '#0F2A45', border: 'none', borderRadius: 6,
            color: dirty ? '#001018' : C.dim, fontWeight: 700, fontSize: 12,
            padding: '7px 14px', cursor: dirty && !busy ? 'pointer' : 'default',
          }}>{busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
          {dirty && <button onClick={() => setDraft(toDraft(saved))} style={linkBtn}>Discard changes</button>}
          {msg && <span style={{ color: C.dim, fontSize: 11 }}>{msg}</span>}
          {err && <span style={{ color: C.bad, fontSize: 11 }}>{err}</span>}
        </div>
      )}
    </div>
  )
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: C.accent, fontSize: 11,
  textDecoration: 'underline', cursor: 'pointer', padding: 0,
}

function ListCard({
  listKey, values, canEdit, onChange,
}: {
  listKey: VocabList
  values: string[] | VocabPair[]
  canEdit: boolean
  onChange: (next: string[] | VocabPair[]) => void
}) {
  const meta = VOCAB_LABELS[listKey]
  const pair = isPairList(listKey)
  const rows = values as (string | VocabPair)[]

  const set = (i: number, v: string | VocabPair) => {
    const next = [...rows]; next[i] = v; onChange(next as string[] | VocabPair[])
  }
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i) as string[] | VocabPair[])
  const add = () => onChange([...rows, (pair ? ['', ''] : '')] as unknown as string[] | VocabPair[])

  return (
    <div data-testid={`vocab-${listKey}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ color: C.head, fontSize: 12, fontWeight: 700 }}>{meta.title}</div>
      <div style={{ color: C.dim, fontSize: 10.5, lineHeight: 1.45, margin: '4px 0 10px' }}>{meta.hint}</div>

      {rows.length === 0 && (
        <div style={{ color: C.dim, fontSize: 11, marginBottom: 8 }}>Nothing added — the built-in list applies.</div>
      )}

      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          {pair ? (
            <>
              <input
                value={(row as VocabPair)[0]} disabled={!canEdit} maxLength={MAX_ENTRY_CHARS}
                placeholder={meta.a} aria-label={`${meta.title} — ${meta.a}`} style={inputStyle}
                onChange={(e) => set(i, [e.target.value, (row as VocabPair)[1]])}
              />
              <span style={{ color: C.dim, fontSize: 12 }}>→</span>
              <input
                value={(row as VocabPair)[1]} disabled={!canEdit} maxLength={MAX_ENTRY_CHARS}
                placeholder={meta.b} aria-label={`${meta.title} — ${meta.b}`} style={inputStyle}
                onChange={(e) => set(i, [(row as VocabPair)[0], e.target.value])}
              />
            </>
          ) : (
            <input
              value={row as string} disabled={!canEdit} maxLength={MAX_ENTRY_CHARS}
              placeholder={meta.title} aria-label={meta.title} style={inputStyle}
              onChange={(e) => set(i, e.target.value)}
            />
          )}
          {canEdit && (
            <button onClick={() => remove(i)} aria-label="Remove" style={{
              background: 'none', border: 'none', color: C.dim, cursor: 'pointer',
              fontSize: 14, lineHeight: 1, padding: '0 4px',
            }}>×</button>
          )}
        </div>
      ))}

      {canEdit && <button onClick={add} style={linkBtn}>+ Add</button>}
    </div>
  )
}
