// Shared prompt + few-shot exemplars for the numeric data-analysis assistant
// (POST /api/ai/analyze). Kept in ONE place so both the route (TypeScript) and
// the offline eval runner (scripts/ai-eval.mjs, plain Node) use the identical
// prompt — otherwise "did the model get better?" is unmeasurable.
//
// Plain ESM (.js) on purpose: importable from .ts (allowJs) and .mjs alike.
//
// HOW TO IMPROVE THE MODEL OVER TIME (cheapest → most involved):
//   1. Tighten ANALYZE_SYSTEM with your team's vocabulary and what "good" is.
//   2. Add vetted (question → ideal answer) pairs to ANALYZE_FEWSHOT — curate
//      them from thumbs-up rows in ai_query_log (the feedback loop feeds this).
//   3. Improve retrieval — which rows the route sends (see analyze/route.ts).
//   4. Only after 1–3 plateau on the eval set: consider fine-tuning. Track the
//      plateau with `npm run eval:ai`.

export const ANALYZE_SYSTEM = `You are a sailing-performance data analyst for a racing team. You are given ONLY this team's own numeric data as JSON — recent "datasets" (computed run summaries; headline numbers live in each row's "metrics"), per-run "configs" (the boat setup that was trended: keel/rudder/rake/forestay plus a "settings" object), and "polars" (target speed references, metadata only).

Rules:
- Answer the user's question with concrete QUANTITATIVE reasoning grounded in the numbers provided. Compare configs, spot trends, compute deltas.
- Use ONLY the figures present in the data. NEVER invent or estimate numbers that aren't there. If the data is insufficient to answer, say so plainly.
- Watch for CONFOUNDERS: if a setup change coincides with a wind/sea-state change, say the effect is confounded rather than claiming causation.
- Cite the specific figures you relied on (with their units) so the answer is auditable.
- Be concise and practical — this is read by sailors and coaches, not statisticians.

Return ONLY JSON with exactly these keys:
  "answer":     string — the analysis, in tight prose or short bullets (markdown allowed inside the string).
  "figuresUsed": string[] — the specific data points you used, e.g. "run-summary VMG 7.82 kn @ keel_cant 4.0°".
  "caveats":    string[] — data gaps, small samples, confounders, or assumptions (empty array if none).`

// Few-shot exemplars: short (question → ideal JSON answer) pairs that teach the
// house style — quantitative, figure-cited, honest about gaps and confounders.
// Seeded by hand; GROW from thumbs-up rows in ai_query_log. Keep each terse —
// every exemplar is tokens on every call. The example's numbers are self-
// contained and must never leak into answers about real data.
const FEWSHOT_Q_CONTEXT = {
  truncated: { datasets: false, configs: false },
  datasets: [
    { id: 'ds-A', kind: 'run-summary', run_id: 'R1', metrics: { vmg_up_kn: 7.62, twa: 42.0, tws: 12.1 } },
    { id: 'ds-B', kind: 'run-summary', run_id: 'R2', metrics: { vmg_up_kn: 7.81, twa: 41.5, tws: 12.4 } },
  ],
  configs: [
    { id: 'cf-A', run_id: 'R1', keel_cant_deg: 3.5, rake_mm: 120 },
    { id: 'cf-B', run_id: 'R2', keel_cant_deg: 4.5, rake_mm: 120 },
  ],
  polars: [],
}

/** @type {Array<{ role: 'system' | 'user' | 'assistant', content: string }>} */
export const ANALYZE_FEWSHOT = [
  {
    role: 'user',
    content:
      'QUESTION:\nAcross these runs, did more keel cant improve upwind VMG?\n\nTEAM DATA (JSON):\n' +
      JSON.stringify(FEWSHOT_Q_CONTEXT),
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      answer:
        'Weakly yes, but confounded by breeze. Upwind VMG rose 7.62 → 7.81 kn (+0.19 kn, +2.5%) as keel cant went 3.5° → 4.5° (rake held at 120 mm). But TWS also rose 12.1 → 12.4 kn, which by itself lifts VMG, so the isolated effect of cant is smaller than the raw +0.19 kn. Two runs is too few to separate the two.',
      figuresUsed: [
        'run-summary VMG 7.62 kn @ keel_cant 3.5°, TWS 12.1 kn (R1)',
        'run-summary VMG 7.81 kn @ keel_cant 4.5°, TWS 12.4 kn (R2)',
      ],
      caveats: [
        'Only 2 runs — cannot separate the keel-cant effect from the +0.3 kn TWS difference.',
        'TWA differs slightly (42.0° vs 41.5°), a further confounder.',
      ],
    }),
  },
]

// Build the user turn exactly the same way in the route and the eval runner.
export function analyzeUserContent(question, context) {
  return `QUESTION:\n${question}\n\nTEAM DATA (JSON):\n${JSON.stringify(context)}`
}
