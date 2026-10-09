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
import { MODES, buildMessages } from '../src/lib/debriefPrompt'
import { collapseRepeats } from '../src/lib/transcriptClean'
import { summariseWithContinuation, type Ask } from '../src/lib/debriefSummarise'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const MODE = flag('--mode') || 'debrief'
const OUT = flag('--out')
const file = args.find((a) => !a.startsWith('--') && a !== MODE && a !== OUT)
if (!file) {
  console.error('usage: npx vite-node scripts/debrief-resummarise.ts -- <transcript.txt> [--mode debrief] [--out note.md]')
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

async function main() {
  const raw = readFileSync(file!, 'utf8')
  const cleaned = collapseRepeats(raw)
  console.log(`${MODE} · ${raw.length} chars`
    + (cleaned.removed ? ` (de-looped ${cleaned.removed}; worst ${cleaned.loops[0]?.count}× "${cleaned.loops[0]?.phrase?.slice(0, 40)}")` : '')
    + ` · ${MODEL}\n`)

  const out = await summariseWithContinuation({
    ask,
    // No boat glossary here: it is fetched per team/boat in the app, and the
    // point of this script is the SUMMARISE step. Sail names may come back less
    // tidy than in the app — that is the one way this run differs from a real one.
    baseMessages: buildMessages(MODE, cleaned.text, undefined),
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
  console.log(`\n${Date.now() - t0} ms · ${out.rounds} continuation(s) · `
    + (out.truncated ? 'STILL SHORT — see the last section' : 'complete'))
  for (const k of mode.keys) console.log(`  ${k}: ${(out.result[k] || '').length} chars`)

  if (OUT) { writeFileSync(OUT, `${text}\n`); console.log(`\n→ ${OUT}`) }
  else console.log(`\n${text}`)
}
main()
