// src/lib/ai/askVerify.ts
// ─────────────────────────────────────────────────────────────────────────────
// Every number in the written answer must have come out of a tool. A sentence
// carrying one that did not is dropped before the crew ever sees it.
//
// This is the same guard lib/headlineFacts.ts validateSections() puts on the
// day's headlines, and it reuses that file's numbersIn()/factNumbers() so the two
// surfaces agree on what "a number" is (times, sail names like "J4 2026" and
// band labels are not values). The rule is looser in one place only: a sentence
// with no numbers at all is kept, because "we have no sail scans in that wind
// band" is a true and useful answer, where a headline without a number is not.
//
// It catches the arithmetic an LLM does when nobody asked it to: averaging two
// rows, subtracting one percentage from another, converting knots to m/s. Each
// produces a number that is nowhere in the tables, and each is dropped.
// ─────────────────────────────────────────────────────────────────────────────

import { numbersIn, factNumbers } from '../headlineFacts'
import type { ToolResult } from './askTypes'

export interface VerifiedAnswer {
  lines: string[]
  bottomLine: string[]
  dropped: string[]
}

const MAX_LINES = 8
const MAX_BOTTOM = 3

const inSet = (set: Set<string>, n: string) => set.has(String(Number(n))) || set.has(n)

/** Every number the tools produced — table cells, headers, media captions, summaries. */
export function allowedNumbers(results: ToolResult[], extra: unknown[] = []): Set<string> {
  const source: unknown[] = [...extra]
  for (const r of results) {
    source.push(r.summary)
    for (const t of r.tables) {
      source.push(t.title)
      source.push(t.columns.map(c => c.label))
      source.push(t.rows)
    }
    for (const m of r.media) {
      source.push(m.title, m.conditions, m.note, m.atLocal, m.date)
    }
  }
  return factNumbers(source)
}

const sentences = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(Boolean)

/**
 * Keep the sentences whose numbers are all accounted for.
 * `raw` is whatever the model returned as its final JSON.
 */
export function verifyAnswer(
  raw: Record<string, unknown> | null | undefined,
  results: ToolResult[],
  extraNumbers: unknown[] = [],
): VerifiedAnswer {
  const known = allowedNumbers(results, extraNumbers)
  const dropped: string[] = []
  const keep = (list: string[], max: number) => {
    const out: string[] = []
    for (const s of list) {
      if (out.length >= max) break
      const nums = numbersIn(s)
      if (nums.every(n => inSet(known, n))) out.push(s)
      else dropped.push(s)
    }
    return out
  }
  return {
    lines: keep(sentences(raw?.answer ?? raw?.lines), MAX_LINES),
    bottomLine: keep(sentences(raw?.bottomLine), MAX_BOTTOM),
    dropped,
  }
}
