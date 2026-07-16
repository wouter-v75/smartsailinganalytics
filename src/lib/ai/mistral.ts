// Scaleway Generative APIs client — sovereign, EU-hosted Mistral inference.
//
// This talks to Scaleway's serverless Generative APIs, which are OpenAI-API
// compatible (POST /v1/chat/completions, Bearer auth). We deliberately use the
// SERVERLESS product (not a dedicated GPU deployment) because it is pay-per-token
// and, per Scaleway's Zero Data Retention policy, stores nothing by default:
//   - inputs/outputs are NOT persisted (except the Batch API, which we never use)
//   - data is NOT used to train the base models
//   - data is NOT accessible to Mistral, other Scaleway tenants, or third parties
//   - processing stays in the EU
// See docs/ai-mistral-setup.md for the provisioning + security rationale.
//
// The API key stays on the server (never NEXT_PUBLIC_, never shipped to the
// browser). Set SCALEWAY_AI_API_KEY in the environment.

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE_URL = process.env.SCALEWAY_AI_BASE_URL || 'https://api.scaleway.ai/v1'
// Mistral Small 3.2 (24B, vision-capable) — the cost/quality sweet spot for
// numeric reasoning and invoice extraction. Override per env if needed.
export const AI_MODEL = process.env.SCALEWAY_AI_MODEL || 'mistral-small-3.2-24b-instruct-2506'

export function aiConfigured(): boolean {
  return !!KEY
}

export function aiConfig() {
  return { configured: !!KEY, model: AI_MODEL, baseUrl: BASE_URL }
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  // string, or OpenAI-style content parts (used for vision — image_url parts).
  content: string | Array<Record<string, unknown>>
}

export type ChatResult = {
  text: string
  usage: { input: number; output: number } | null
  stopReason: string | null
}

export class AiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AiError'
    this.status = status
  }
}

// Low-level chat call. SYNCHRONOUS only — we never touch the Batch API, so
// Scaleway persists nothing. Aborts before the typical 60s function timeout so
// callers get a clean 504 instead of an opaque platform kill.
export async function mistralChat(opts: {
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<ChatResult> {
  if (!KEY) throw new AiError('SCALEWAY_AI_API_KEY not configured', 503)

  const ctrl = new AbortController()
  const timeout = opts.timeoutMs ?? 55000
  const killer = setTimeout(() => ctrl.abort(), timeout)
  // Chain any caller-supplied signal into ours.
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true })

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 1500,
        temperature: opts.temperature ?? 0.2,
        stream: false,
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new AiError(`scaleway ${res.status}: ${detail.slice(0, 300)}`, 502)
    }

    const j = await res.json()
    const text: string = j?.choices?.[0]?.message?.content ?? ''
    const usage = j?.usage
      ? { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 }
      : null
    return { text, usage, stopReason: j?.choices?.[0]?.finish_reason ?? null }
  } catch (e) {
    if (e instanceof AiError) throw e
    const aborted = e instanceof Error && e.name === 'AbortError'
    throw new AiError(aborted ? `scaleway call >${Math.round(timeout / 1000)}s (aborted)` : (e instanceof Error ? e.message : 'ai call failed'), aborted ? 504 : 500)
  } finally {
    clearTimeout(killer)
  }
}

// Convenience wrapper that parses a JSON object out of the reply. Instructs the
// model to emit pure JSON and strips accidental ```json fences (some models add
// them). Throws AiError(502) if the reply isn't parseable JSON.
export async function mistralJSON<T = unknown>(opts: {
  system: string
  user: string | Array<Record<string, unknown>>
  // Optional few-shot turns inserted between the system prompt and the user
  // question — e.g. ANALYZE_FEWSHOT. Teaches format + house style at ~no risk.
  examples?: ChatMessage[]
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ data: T; usage: ChatResult['usage'] }> {
  const { text, usage, stopReason } = await mistralChat({
    messages: [
      { role: 'system', content: `${opts.system}\n\nReturn ONLY valid JSON. No markdown, no prose outside the JSON.` },
      ...(opts.examples ?? []),
      { role: 'user', content: opts.user },
    ],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  })
  try {
    const cleaned = text.replace(/```json|```/g, '').trim()
    return { data: JSON.parse(cleaned) as T, usage }
  } catch {
    throw new AiError(`ai returned non-JSON (stop: ${stopReason ?? '?'})`, 502)
  }
}
