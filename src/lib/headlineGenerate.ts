// src/lib/headlineGenerate.ts
// ─────────────────────────────────────────────────────────────────────────────
// One call to Mistral on Scaleway (EU) for a day's sectioned headlines, validated against
// FACTS. Shared by the API route (…/phase-stats/:date/headlines) and
// scripts/headlines-backfill.ts, so both write exactly the same thing.
// ─────────────────────────────────────────────────────────────────────────────

import { buildHeadlineMessages, validateSections, SECTION_ORDER, type HeadlineFacts, type ValidatedSections } from './headlineFacts'

export const DEFAULT_HEADLINES_MODEL = 'mistral-medium-3.5-128b'

export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const tryParse = (s: string) => { try { return JSON.parse(s) as Record<string, unknown> } catch { return null } }
  const direct = tryParse(cleaned)
  if (direct) return direct
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}')
  return a >= 0 && b > a ? tryParse(cleaned.slice(a, b + 1)) : null
}

export type GenerateResult =
  | { ok: true; headlines: ValidatedSections; model: string; ms: number }
  | { ok: false; status: number; error: string; dropped?: string[]; ms: number }

export async function generateHeadlines(
  facts: HeadlineFacts,
  cfg: { key: string; base: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<GenerateResult> {
  const t0 = Date.now()
  const model = cfg.model || DEFAULT_HEADLINES_MODEL
  const doFetch = cfg.fetchImpl || fetch
  if (!SECTION_ORDER.some(k => facts.sections[k])) {
    return { ok: false, status: 409, error: 'no section has enough phases to write about', ms: 0 }
  }
  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 55_000)
  try {
    const res = await doFetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: buildHeadlineMessages(facts),
      }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    if (!res.ok) return { ok: false, status: 502, error: `scaleway ${res.status}: ${raw.slice(0, 200)}`, ms: Date.now() - t0 }
    let content = ''
    try { content = (JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content || '' } catch { /* */ }
    const parsed = extractJson(content)
    if (!parsed) return { ok: false, status: 502, error: 'could not parse model JSON', ms: Date.now() - t0 }
    const headlines = validateSections(parsed, facts)
    if (!Object.keys(headlines.sections).length) {
      return { ok: false, status: 502, error: 'the model wrote no headline that passed the number check', dropped: headlines.dropped, ms: Date.now() - t0 }
    }
    return { ok: true, headlines, model, ms: Date.now() - t0 }
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return { ok: false, status: aborted ? 504 : 500, error: aborted ? `headlines took longer than ${Math.round((cfg.timeoutMs ?? 55_000) / 1000)} s (aborted)` : e instanceof Error ? e.message : 'failed', ms: Date.now() - t0 }
  } finally {
    clearTimeout(killer)
  }
}
