// Offline eval for the numeric data-analysis assistant (POST /api/ai/analyze).
//
// Runs every gold case in evals/ai-analyze/gold.jsonl through the LIVE Scaleway
// model, using the SAME prompt + few-shot the route uses (imported from
// src/lib/ai/analyzePrompt.js — that's why the prompt lives in a shared module),
// then grades each answer with an LLM-as-judge against the case's rubric.
//
// This is how you know a prompt/few-shot change actually helped, instead of
// guessing. Track the pass-rate over time; a persistent plateau is the only
// honest signal that fine-tuning might be worth its cost/retention trade-off.
//
//   npm run eval:ai
//
// Needs SCALEWAY_AI_API_KEY (read from .env.local or the environment). Costs a
// few tenths of a cent per run — it hits the paid API. LLM-judged, so treat the
// pass-rate as a regression signal, not gospel; read the printed reasons.
//
// Exit code: 0 if pass-rate ≥ THRESHOLD, 1 otherwise (so CI can gate on it).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ANALYZE_SYSTEM, ANALYZE_FEWSHOT, analyzeUserContent } from '../src/lib/ai/analyzePrompt.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..')
const THRESHOLD = Number(process.env.AI_EVAL_THRESHOLD || '0.8') // fraction that must pass

// ── Minimal .env.local loader (no dotenv dependency) ─────────────────────────
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env.local — rely on the real environment */ }
}
loadEnv(resolve(ROOT, '.env.local'))

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE_URL = process.env.SCALEWAY_AI_BASE_URL || 'https://api.scaleway.ai/v1'
const MODEL = process.env.SCALEWAY_AI_MODEL || 'mistral-small-3.2-24b-instruct-2506'
const JUDGE_MODEL = process.env.SCALEWAY_AI_JUDGE_MODEL || MODEL

if (!KEY) {
  console.error('✗ SCALEWAY_AI_API_KEY is not set (looked in env and .env.local). Cannot run evals.')
  process.exit(2)
}

let totalIn = 0
let totalOut = 0

async function chat(messages, { model = MODEL, maxTokens = 1200, temperature = 0.2 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
  })
  if (!res.ok) throw new Error(`scaleway ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  if (j?.usage) { totalIn += j.usage.prompt_tokens ?? 0; totalOut += j.usage.completion_tokens ?? 0 }
  return j?.choices?.[0]?.message?.content ?? ''
}

function parseJSON(text) {
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

// ── The judge: grades a candidate answer against the rubric. Same model by
// default; override with SCALEWAY_AI_JUDGE_MODEL for a stronger grader. ───────
const JUDGE_SYSTEM = `You are a strict grader for a sailing-performance data assistant. You are given the QUESTION, the exact DATA the assistant was allowed to use, its ANSWER (JSON), and a RUBRIC of requirements. Grade ONLY against the rubric and the data.

Fail the answer if it invents any number not present in the DATA, or if it violates any rubric item. Reward answers that are grounded, cite figures with units, and are honest about gaps/confounders.

Return ONLY JSON: { "pass": boolean, "score": integer 0-100, "reasons": string[] (one short reason per rubric item, noting pass/fail) }.`

async function judge(gold, answerObj) {
  const text = await chat([
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content:
        `QUESTION:\n${gold.question}\n\n` +
        `DATA:\n${JSON.stringify(gold.context)}\n\n` +
        `RUBRIC:\n${gold.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
        `ANSWER:\n${JSON.stringify(answerObj)}`,
    },
  ], { model: JUDGE_MODEL, temperature: 0 })
  return parseJSON(text)
}

async function runCase(gold) {
  const raw = await chat([
    { role: 'system', content: `${ANALYZE_SYSTEM}\n\nReturn ONLY valid JSON. No markdown, no prose outside the JSON.` },
    ...ANALYZE_FEWSHOT,
    { role: 'user', content: analyzeUserContent(gold.question, gold.context) },
  ], { maxTokens: 1200 })
  let answerObj
  try { answerObj = parseJSON(raw) } catch { return { id: gold.id, pass: false, score: 0, reasons: ['model returned non-JSON'] } }
  const verdict = await judge(gold, answerObj)
  return { id: gold.id, ...verdict, answer: answerObj.answer }
}

// ── Main ─────────────────────────────────────────────────────────────────────
const gold = readFileSync(resolve(ROOT, 'evals/ai-analyze/gold.jsonl'), 'utf8')
  .split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))

console.log(`\nAI analyze eval — model=${MODEL}, judge=${JUDGE_MODEL}, ${gold.length} cases\n`)

let passed = 0
for (const g of gold) {
  try {
    const r = await runCase(g)
    if (r.pass) passed++
    console.log(`${r.pass ? '✓' : '✗'} ${r.id.padEnd(20)} score=${String(r.score ?? 0).padStart(3)}  ${r.pass ? '' : '\n    ' + (r.reasons || []).join('\n    ')}`)
  } catch (e) {
    console.log(`✗ ${g.id.padEnd(20)} ERROR  ${e.message}`)
  }
}

const rate = passed / gold.length
// Rough cost at Mistral Small 3.2 list price (€0.15/€0.35 per 1M in/out).
const eur = (totalIn / 1e6) * 0.15 + (totalOut / 1e6) * 0.35
console.log(`\n${passed}/${gold.length} passed (${(rate * 100).toFixed(0)}%) — threshold ${(THRESHOLD * 100).toFixed(0)}%`)
console.log(`tokens: ${totalIn} in / ${totalOut} out  ≈ €${eur.toFixed(4)} this run\n`)
process.exit(rate >= THRESHOLD ? 0 : 1)
