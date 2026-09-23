// src/lib/ai/scaleway.ts
// ─────────────────────────────────────────────────────────────────────────────
// One thin OpenAI-compatible client for Scaleway Generative APIs (Paris, EU,
// zero data retention). Synchronous chat completions only — never Batch, so
// nothing of ours is persisted on their side.
//
// It exists because /api/ai/ask needs what lib/headlineGenerate.ts does not:
// TOOL CALLING. mistral-medium-3.5-128b supports OpenAI-style `tools` +
// `tool_calls` on Scaleway, including several calls in one turn (verified live
// against the ssa-ai project on 2026-09-23).
//
// Pure transport: no prompt, no SSA vocabulary, no Supabase. The caller owns the
// messages and the tool catalogue.
//
// Env (server only, never NEXT_PUBLIC): SCALEWAY_AI_API_KEY, SCALEWAY_AI_BASE_URL.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ASK_MODEL = 'mistral-medium-3.5-128b'

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as the model wrote it — parsed and validated by the caller. */
  argumentsRaw: string
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: unknown[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

export type ChatResult =
  | { ok: true; content: string; toolCalls: ToolCall[]; raw: unknown; ms: number }
  | { ok: false; status: number; error: string; ms: number }

export interface ChatConfig {
  key: string
  base: string
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolSpec[]
  /** 'auto' lets it answer without a tool; 'none' forces prose (the last turn). */
  toolChoice?: 'auto' | 'none'
  /** Ask for a JSON object back. Only on a turn with no tools — Mistral rejects both. */
  json?: boolean
}

interface RawChoice {
  message?: {
    content?: string | null
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
  }
  finish_reason?: string
}

/** `assistant` message to echo back into the next turn, tool_calls and all. */
export function assistantTurn(raw: unknown): ChatMessage {
  const msg = (raw as { choices?: RawChoice[] } | null)?.choices?.[0]?.message
  return { role: 'assistant', content: msg?.content ?? null, tool_calls: msg?.tool_calls }
}

export async function chat(req: ChatRequest, cfg: ChatConfig): Promise<ChatResult> {
  const t0 = Date.now()
  const doFetch = cfg.fetchImpl || fetch
  const timeoutMs = cfg.timeoutMs ?? 45_000
  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const body: Record<string, unknown> = {
      model: cfg.model || DEFAULT_ASK_MODEL,
      temperature: cfg.temperature ?? 0,
      max_tokens: cfg.maxTokens ?? 2000,
      messages: req.messages,
    }
    if (req.tools?.length) {
      body.tools = req.tools
      body.tool_choice = req.toolChoice || 'auto'
    } else if (req.json) {
      // Only without tools: asking for both at once is refused.
      body.response_format = { type: 'json_object' }
    }
    const res = await doFetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, status: 502, error: `scaleway ${res.status}: ${text.slice(0, 300)}`, ms: Date.now() - t0 }
    }
    let raw: unknown
    try { raw = JSON.parse(text) } catch {
      return { ok: false, status: 502, error: 'scaleway returned non-JSON', ms: Date.now() - t0 }
    }
    const choice = (raw as { choices?: RawChoice[] }).choices?.[0]
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls || [])
      .map((t, i) => ({
        id: t.id || `call_${i}`,
        name: t.function?.name || '',
        argumentsRaw: t.function?.arguments || '{}',
      }))
      .filter(t => t.name)
    return { ok: true, content: choice?.message?.content || '', toolCalls, raw, ms: Date.now() - t0 }
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      status: aborted ? 504 : 500,
      error: aborted ? `the model took longer than ${Math.round(timeoutMs / 1000)} s (aborted)` : e instanceof Error ? e.message : 'failed',
      ms: Date.now() - t0,
    }
  } finally {
    clearTimeout(killer)
  }
}
