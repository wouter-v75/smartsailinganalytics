// Whisper repetition loops — strip them before anything tries to read the text.
//
// Greedy ASR decoding gets stuck: it emits the same phrase over and over, hundreds
// of times, usually over silence, wind noise or crosstalk. One real debrief carried
// "attacking high and slow" about 250 times and "if you go back a tiny bit" about
// 100. That is not a cosmetic blemish. A summariser handed a wall of one repeated
// sentence spends its attention there and returns a thin summary that misses whole
// topics discussed elsewhere in the session — which is exactly what it did.
//
// Repeats are collapsed rather than deleted so the model still sees that something
// was said there, and the marker tells it (and a human reading the transcript) that
// the repetition is a machine artefact, not emphasis.

export interface CleanResult {
  text: string
  removed: number          // characters dropped
  loops: { phrase: string; count: number }[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

// Split into phrases: sentence enders and newlines. ASR output that runs on without
// punctuation is handled by the word-level pass below.
function toPhrases(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Collapse a run of a repeating CYCLE of phrases (A A A…, or A B A B A B…).
function collapseCycles(phrases: string[], keep: number, minRun: number, loops: CleanResult['loops']): string[] {
  const out: string[] = []
  let i = 0
  while (i < phrases.length) {
    let best: { len: number; reps: number } | null = null
    // Longer cycles first: "A B A B" should be seen as a 2-cycle, not two 1-cycles.
    for (let len = 6; len >= 1; len--) {
      if (i + len * 2 > phrases.length) continue
      const cyc = phrases.slice(i, i + len).map(norm).join('|')
      if (!cyc.replace(/\|/g, '').trim()) continue
      let reps = 1
      while (
        i + len * (reps + 1) <= phrases.length &&
        phrases.slice(i + len * reps, i + len * (reps + 1)).map(norm).join('|') === cyc
      ) reps++
      // >= not >: cycle length is searched long-to-short, and 250 identical phrases
      // score the same whether read as a 1-cycle x250 or a 5-cycle x50. On a tie the
      // SHORTEST cycle is the true period — without this it kept five copies of the
      // loop and reported it as 50x.
      if (reps >= minRun && (!best || reps * len >= best.reps * best.len)) best = { len, reps }
    }
    if (best) {
      out.push(...phrases.slice(i, i + best.len * keep))
      loops.push({ phrase: phrases[i], count: best.reps })
      out.push(`[repeated ${best.reps}x — transcription loop]`)
      i += best.len * best.reps
    } else {
      out.push(phrases[i]); i++
    }
  }
  return out
}

// A run-on phrase with no punctuation can still loop internally. Collapse repeated
// word cycles inside any single phrase that is long enough to hide one.
function collapseWithinPhrase(p: string, keep: number, minRun: number): string {
  const w = p.split(/\s+/)
  if (w.length < 24) return p
  const out: string[] = []
  let i = 0
  while (i < w.length) {
    let best: { len: number; reps: number } | null = null
    for (let len = 8; len >= 2; len--) {
      if (i + len * 2 > w.length) continue
      const cyc = w.slice(i, i + len).map(norm).join(' ')
      if (!cyc.trim()) continue
      let reps = 1
      while (
        i + len * (reps + 1) <= w.length &&
        w.slice(i + len * reps, i + len * (reps + 1)).map(norm).join(' ') === cyc
      ) reps++
      if (reps >= minRun && (!best || reps * len >= best.reps * best.len)) best = { len, reps }
    }
    if (best) {
      out.push(...w.slice(i, i + best.len * keep), `[repeated ${best.reps}x]`)
      i += best.len * best.reps
    } else { out.push(w[i]); i++ }
  }
  return out.join(' ')
}

export function collapseRepeats(text: string, opts: { keep?: number; minRun?: number } = {}): CleanResult {
  const keep = opts.keep ?? 1
  const minRun = opts.minRun ?? 3
  if (!text) return { text: '', removed: 0, loops: [] }
  const loops: CleanResult['loops'] = []
  const phrases = toPhrases(text).map((p) => collapseWithinPhrase(p, keep, minRun))
  const out = collapseCycles(phrases, keep, minRun, loops).join(' ')
  return { text: out, removed: Math.max(0, text.length - out.length), loops: loops.sort((a, b) => b.count - a.count) }
}
