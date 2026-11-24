// scripts/debrief-resummarise.ts
// ─────────────────────────────────────────────────────────────────────────────
// Summarise a transcript again, without re-recording or re-transcribing it.
//
//   npx vite-node scripts/debrief-resummarise.ts -- transcript.txt
//   npx vite-node scripts/debrief-resummarise.ts -- transcript.txt --mode debrief
//   …                                                             --out note.md
//
// READ-ONLY against SSA: it writes nothing to the database. It does call the
// model, so it costs what one summary costs.
//
// WHY. The app's flow is audio → transcribe → summarise, so testing a change to
// the SUMMARISE step through the UI means paying for the transcription again
// and waiting for it. The transcript is the expensive part and it was already
// complete — it was only the summary that stopped mid-sentence.
//
// It calls src/lib/debriefSummarise.ts, the same function the route calls, with
// the same prompts and the same continuation loop. Not a copy: a second
// implementation would agree with the route right up until it quietly didn't,
// which is how four stations once collapsed onto a flat −5700 in this codebase.
//
// Run OUTSIDE Claude Code's Bash sandbox — Scaleway is not reachable from it.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { MODES, buildMessages } from '../src/lib/debriefPrompt'
import { collapseRepeats } from '../src/lib/transcriptClean'
import { summariseWithContinuation, type Ask } from '../src/lib/debriefSummarise'
import { vocabForBoat, type Glossary } from '../src/lib/debriefGlossary'
import { normaliseDebriefVocab, isEmptyVocab } from '../src/lib/debriefVocab'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const MODE = flag('--mode') || 'debrief'
const BOAT = flag('--boat')
const OUT = flag('--out')
const file = args.find((a) => !a.startsWith('--') && a !== MODE && a !== OUT && a !== BOAT)
if (!file) {
  console.error('usage: npx vite-node scripts/debrief-resummarise.ts -- <transcript.txt> [--mode debrief] [--boat "Ryujin"] [--out note.md]')
  console.error(`modes: ${Object.keys(MODES).join(', ')}`)
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const KEY = env.SCALEWAY_AI_API_KEY
const BASE = env.SCALEWAY_AI_BASE_URL
const MODEL = env.SCALEWAY_AI_MODEL || 'mistral-medium-3.5-128b'
if (!KEY || !BASE) { console.error('SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL missing from .env.local'); process.exit(1) }

const mode = MODES[MODE]
if (!mode) { console.error(`no such mode "${MODE}" — try ${Object.keys(MODES).join(', ')}`); process.exit(1) }

// The same 280 s the route gets, so a run here tells you what a run there does.
const BUDGET_MS = 280_000
const t0 = Date.now()
const ctrl = new AbortController()
setTimeout(() => ctrl.abort(), BUDGET_MS)

const ask: Ask = async (messages) => {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, temperature: 0.2,
      response_format: { type: 'json_object' }, messages,
    }),
    signal: ctrl.signal,
  })
  const text = await r.text()
  if (!r.ok) return { ok: false, status: r.status, text }
  try {
    const body = JSON.parse(text) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
    return { ok: true, content: body.choices?.[0]?.message?.content || '', finishReason: body.choices?.[0]?.finish_reason }
  } catch { return { ok: true, content: '', finishReason: undefined } }
}

/**
 * The boat's live vocabulary, the way the APP assembles it.
 *
 * Without this the script could not reproduce the one thing that went wrong on
 * Ryujin's 7 Nov debrief: her wardrobe was in the prompt and the shared
 * glossary's MH0 beat it. A run with no glossary at all cannot see that, so the
 * script agreed with the route about everything except the part that mattered.
 *
 * Deliberately NOT a call to loadBoatVocab(): that one fetches the app's own
 * routes with a browser session. Same three sources, read with the service key.
 */
async function boatGlossary(name: string): Promise<Partial<Glossary> | undefined> {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: boats } = await sb.from('boats').select('id, name, specs')
  const boat = (boats ?? []).find((b) => String(b.name).toLowerCase() === name.toLowerCase())
  if (!boat) {
    console.error(`no boat called "${name}" — boats: ${(boats ?? []).map((b) => b.name).join(', ')}`)
    process.exit(1)
  }
  const { data: sails } = await sb.from('sails').select('name, retired').eq('boat_id', boat.id)
  // The same normalisation boatVocab.js does, so the two lists agree.
  const names = Array.from(new Set((sails ?? []).filter((s) => !s.retired)
    .map((s) => String(s.name || '').replace(/[_-]\d{2,4}$/, '').replace(/_/g, ' ').trim())
    .filter(Boolean)))
  const code = vocabForBoat(boat.name) || {}
  const own = normaliseDebriefVocab((boat.specs as Record<string, unknown> | null)?.debrief_vocab)
  const add = isEmptyVocab(own) ? {} : own
  const merge = (k: keyof Glossary, base?: unknown[]) => {
    const mine = (add as Record<string, unknown[]>)[k] || []
    return mine.length ? [...(base || []), ...mine] : base
  }
  const extra: Record<string, unknown> = {
    ...code,
    ...(names.length ? { sails: [...(code.sails || []), ...names] } : {}),
    crew: merge('crew', code.crew), boats: merge('boats', code.boats),
    roles: merge('roles', code.roles), manoeuvres: merge('manoeuvres', code.manoeuvres),
    aliases: merge('aliases', code.aliases), fixups: merge('fixups', code.fixups),
  }
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k]
  console.log(`  boat ${boat.name}: ${names.length} sails in the wardrobe`
    + `${isEmptyVocab(own) ? '' : ', plus its own Debrief words'}`
    + `${Object.keys(code).length ? ', plus TEAM_VOCAB' : ''}`)
  return Object.keys(extra).length ? (extra as Partial<Glossary>) : undefined
}

async function main() {
  const raw = readFileSync(file!, 'utf8')
  const cleaned = collapseRepeats(raw)
  console.log(`${MODE} · ${raw.length} chars`
    + (cleaned.removed ? ` (de-looped ${cleaned.removed}; worst ${cleaned.loops[0]?.count}× "${cleaned.loops[0]?.phrase?.slice(0, 40)}")` : '')
    + ` · ${MODEL}\n`)

  // --boat makes this run the app's run. Without it the glossary is the shared
  // default, which is a DIFFERENT prompt from the one the app sent.
  const glossary = BOAT ? await boatGlossary(BOAT) : undefined
  if (!BOAT) console.log('  (no --boat: shared glossary only — not what the app sends)')

  const out = await summariseWithContinuation({
    ask,
    baseMessages: buildMessages(MODE, cleaned.text, glossary),
    keys: mode.keys,
    budgetMs: BUDGET_MS,
    startedAt: t0,
    log: (...a) => console.log(' ', ...a),
  })

  if (out.error) {
    console.error(`\nfailed (${out.error.kind})`, out.error.status ?? '', (out.error.detail || '').slice(0, 300))
    process.exit(1)
  }

  const text = mode.keys.map((k) => `## ${k}\n\n${out.result[k] || '(empty)'}`).join('\n\n')
  // WHICH signal, not just whether. The three have different next steps: a
  // provider cut means ask again, a mid-sentence end that the provider called
  // 'stop' means the metadata is lying and only the text can be trusted.
  const fired = Object.entries(out.signals).filter(([, v]) => v).map(([k]) => k)
  console.log(`\n${Date.now() - t0} ms · ${out.rounds} continuation(s) · `
    + (out.truncated ? `STILL SHORT (${fired.join(' + ')}) — see the last section` : 'complete'))
  for (const k of mode.keys) console.log(`  ${k}: ${(out.result[k] || '').length} chars`)

  if (OUT) { writeFileSync(OUT, `${text}\n`); console.log(`\n→ ${OUT}`) }
  else console.log(`\n${text}`)
}
main()
