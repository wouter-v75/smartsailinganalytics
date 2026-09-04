// Opt-in bake-off: run the SHIPPED summariser prompt against several Scaleway
// models on a real transcript, and write each note out for side-by-side reading.
// Not a pass/fail test — a measuring instrument. Summary quality was being judged
// by eye in production, which is how it went unnoticed that the model was running
// out of output tokens mid-note.
//
//   SSA_TRANSCRIPT_FIXTURE=/path/to/transcript.txt \
//   SSA_BENCH_MODELS=mistral-small-3.2-24b-instruct-2506,mistral-medium-3.5-128b \
//   SSA_BENCH_OUT=/tmp/bench SSA_BENCH_MAXTOK=4000 SSA_BENCH_MODE=speedteam \
//   npx vitest run src/lib/__tests__/summaryBench.test.ts
//
// Reads SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL from the environment.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { collapseRepeats } from '../transcriptClean'
import { buildMessages } from '../debriefPrompt'

const FIXTURE = process.env.SSA_TRANSCRIPT_FIXTURE || ''
const MODELS = (process.env.SSA_BENCH_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)
const KEY = process.env.SCALEWAY_AI_API_KEY || ''
const BASE = process.env.SCALEWAY_AI_BASE_URL || ''
const OUT = process.env.SSA_BENCH_OUT || ''
const MAXTOK = Number(process.env.SSA_BENCH_MAXTOK || 4000)
const MODE = process.env.SSA_BENCH_MODE || 'speedteam'
const RUNS = Number(process.env.SSA_BENCH_RUNS || 1)
// Optional gold facts: one JS regex per line, blank lines and #-comments ignored.
// A line starting "!" is an ANTI-fact — something the note must NOT say (a known
// hallucination, a sign flip, a unit error). Both count toward the same score.
// Each is something the meeting actually established; the score is how many the
// note carries. Eyeballing one sample is how a prompt "improvement" that made the
// output worse got shipped — this is the cheap guard against that.
const FACTS = process.env.SSA_BENCH_FACTS || ''
const factList: { src: string; re: RegExp; bad: boolean }[] = FACTS && existsSync(FACTS)
  ? readFileSync(FACTS, 'utf8').split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((src) => ({ src, re: new RegExp(src.replace(/^!/, ''), 'i'), bad: src.startsWith('!') }))
  : []

const ready = FIXTURE && existsSync(FIXTURE) && MODELS.length && KEY && BASE
const run = ready ? describe : describe.skip

run('summary bake-off', () => {
  it('runs every model and reports what actually limits the note', async () => {
    const raw = readFileSync(FIXTURE, 'utf8')
    const transcript = collapseRepeats(raw).text || raw
    const messages = buildMessages(MODE, transcript)
    if (OUT) mkdirSync(OUT, { recursive: true })

    const rows: string[] = []
    for (const model of MODELS) {
     for (let runIdx = 0; runIdx < RUNS; runIdx++) {
      const t0 = Date.now()
      let line = ''
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
          body: JSON.stringify({ model, max_tokens: MAXTOK, temperature: 0.2, response_format: { type: 'json_object' }, messages }),
        })
        const body = await res.text()
        if (!res.ok) { rows.push(`${model}\tHTTP ${res.status}\t${body.slice(0, 120)}`); continue }
        const j = JSON.parse(body) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const content = j.choices?.[0]?.message?.content || ''
        // finish_reason "length" is the whole story when it appears: the note was
        // cut off by max_tokens, and no prompt tuning fixes that.
        const finish = j.choices?.[0]?.finish_reason || '?'
        let note = ''
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>
          note = String(Object.values(parsed)[0] ?? '')
        } catch { note = `[UNPARSEABLE JSON]\n\n${content}` }
        const bullets = (note.match(/^\s*[-*]/gm) || []).length
        // A plain fact scores when present; an anti-fact scores when ABSENT.
        const ok = (f: { re: RegExp; bad: boolean }) => f.bad ? !f.re.test(note) : f.re.test(note)
        const hits = factList.filter(ok)
        const misses = factList.filter((f) => !ok(f)).map((f) => f.src)
        line = [`${model}${RUNS > 1 ? `#${runIdx + 1}` : ''}`, `${Date.now() - t0}ms`, `finish=${finish}`,
                `in=${j.usage?.prompt_tokens ?? '?'}`, `out=${j.usage?.completion_tokens ?? '?'}`,
                `note=${note.length}ch`, `bullets=${bullets}`,
                ...(factList.length ? [`facts=${hits.length}/${factList.length}`, `missed: ${misses.join(' | ') || '-'}`] : [])].join('\t')
        if (OUT) writeFileSync(join(OUT, `${model}${RUNS > 1 ? `.${runIdx + 1}` : ''}.md`), note)
      } catch (e) {
        line = `${model}\tEXCEPTION\t${String(e).slice(0, 120)}`
      }
      rows.push(line)
     }
    }
    // eslint-disable-next-line no-console
    console.log(`\ntranscript ${raw.length}ch → ${transcript.length}ch cleaned, max_tokens=${MAXTOK}, mode=${MODE}\n` + rows.join('\n') + '\n')
    expect(rows.length).toBe(MODELS.length * RUNS)
  }, 900_000)
})
