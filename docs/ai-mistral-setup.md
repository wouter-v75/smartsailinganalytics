# Sovereign AI (Scaleway + Mistral) — setup & security

Sandboxed, EU-hosted AI for the SSA webapp. Two target use cases:

1. **Numerical data analysis** — verbal questions + reasoning over a team's own
   performance data. Shipped: `POST /api/ai/analyze`.
2. **Invoices, expenses & team accounts** — document extraction into a new
   schema. Planned (see "Next: invoices & expenses").

## Why serverless Generative APIs (not a dedicated GPU)

We use Scaleway's **serverless Generative APIs**, not a dedicated Managed
Inference GPU. This was a deliberate cost/leakage trade-off:

| | Serverless Generative APIs (chosen) | Dedicated Managed Inference |
| --- | --- | --- |
| Cost | Pay-per-token (~€0–5/mo at our volume) | ~€679–2,482/mo always-on GPU |
| Region | Paris (EU) | Amsterdam (nl-ams) available |
| Tenancy | Multi-tenant compute | Single-tenant GPU + private VPC |
| Data policy | **Zero Data Retention by default** | Same or stronger |

The €679+/mo dedicated box was well over budget (target ~€100/mo) and buys
physical single-tenancy — which is **not** what prevents data leakage. The
leakage guarantees below hold on serverless too.

### Data policy (verified against Scaleway docs, Jul 2026)

Scaleway Generative APIs, **Zero Data Retention by default**:

- Inputs/outputs are **not stored** — except the **Batch API**, which holds input
  for ≤24h during processing. **We never use Batch** (`stream:false`, synchronous
  only in `src/lib/ai/mistral.ts`), so nothing is persisted.
- Data is **not used to train** the base models.
- Data is **not accessible** to Mistral (the model creator), other Scaleway
  tenants, or third parties.
- Processing stays **in the EU**.

Because Mistral Small 3.2 is an open-weights (Apache 2.0) model that Scaleway
hosts itself, **Mistral SAS never receives our traffic** — only Scaleway's policy
governs our data. Sources: Scaleway [Generative APIs data-privacy](https://www.scaleway.com/en/docs/generative-apis/reference-content/data-privacy/).

> These are Scaleway's binding contractual/GDPR commitments, not an independent
> audit. The real between-teams leakage control is our own app-layer RLS (below).

## The real sandbox: app-layer RLS, not the hosting tier

`POST /api/ai/analyze` is safe against cross-team leakage because:

1. The model **never touches the database** and **never writes SQL**.
2. Context is fetched via `getServerSupabase()` (the caller's session cookie), so
   **Row-Level Security applies** — a user only pulls rows their `has_boat_access`
   allows. The model is strictly **downstream of RLS**.
3. Only that already-authorised, **bounded** slice (≤40 datasets + ≤40 configs +
   active polars metadata) is sent to Scaleway.

Never give the model a service-role client, write access, or a free-form SQL tool.

## Provisioning (one-time, Scaleway console)

1. **Console → Identity & Access (IAM) → Projects** — create a dedicated project,
   e.g. `ssa-ai`, so this key is isolated from the rest of the org.
2. **Generative APIs** — confirm it's enabled for that project. No deployment to
   create (serverless).
3. **IAM → API keys → Generate API key** — scope it to the `ssa-ai` project with
   the Generative APIs permission set. Copy the **secret key** (shown once).
4. (Optional hardening) Restrict the key's permissions to only what's needed and
   rotate periodically.

## App configuration

Set in **Vercel → Project → Settings → Environment Variables (Production)**, then
**redeploy** (env changes only apply to new builds):

```
SCALEWAY_AI_API_KEY=<secret key>
# optional overrides (defaults shown):
# SCALEWAY_AI_BASE_URL=https://api.scaleway.ai/v1
# SCALEWAY_AI_MODEL=mistral-small-3.2-24b-instruct-2506
```

For local dev, add the same to `.env.local` (see `.env.example`).

Never prefix with `NEXT_PUBLIC_` — the key must stay server-side.

## Verify

```
# Health (no auth): reports whether the key is set + which model/URL.
curl https://<your-app>/api/ai/analyze
# → {"configured":true,"model":"mistral-small-3.2-24b-instruct-2506","baseUrl":"https://api.scaleway.ai/v1"}

# Analysis (must be called from the app with a logged-in session cookie):
POST /api/ai/analyze  { "teamId": "<uuid>", "question": "...", "boatId": "<uuid>?" }
# → { answer, figuresUsed[], caveats[], _usage, _ms }
```

## Cost

Mistral Small 3.2: **€0.15 / €0.35** per 1M input/output tokens; first 1M free. A
data-analysis question (~6k in / 1k out) costs ~€0.0012 → **€100 buys ~80,000
questions**. Real usage is a few euros/month. The 24-bn model is vision-capable,
so the same key serves invoice OCR later.

## Feedback + eval loop (getting better over time, without fine-tuning)

The cheapest, safest way to make the assistant better at our niche is **not**
fine-tuning — it's a tight loop of prompt + few-shot + retrieval, *measured* by an
eval set. Fine-tuning a 24B model needs hundreds of vetted examples to beat good
few-shot, and it breaks zero-retention (you must store a training set). So we
build the loop first; it also produces the dataset a future fine-tune would need.

**The pieces:**

1. **Shared prompt** — `src/lib/ai/analyzePrompt.js` holds `ANALYZE_SYSTEM` and
   `ANALYZE_FEWSHOT`. Both the route and the eval runner import it, so a prompt
   change is tested by the exact thing that ships.
2. **Query log** — every `/api/ai/analyze` answer is written to `ai_query_log`
   (migration `0055`), in **our own Supabase under RLS**. We store the question +
   answer + a lean `context_summary` (row counts + ids), **not** the raw team
   rows — minimum data at rest. The route returns `logId`.
3. **Feedback** — `POST /api/ai/feedback { logId, rating: 1|-1|0, correction? }`.
   Authors rate their own answers; coaches/team_managers rate or write the ideal
   answer for any team row (enforced by RLS, not app code).
4. **Curation** — periodically promote the best 👍 rows (and coach corrections)
   into `ANALYZE_FEWSHOT`, and add hard cases to the eval gold set.
5. **Eval** — `npm run eval:ai` runs `evals/ai-analyze/gold.jsonl` through the
   live model with the shipping prompt, grades each with an LLM-judge against a
   rubric, and prints a pass-rate + rough cost. Exit code gates on
   `AI_EVAL_THRESHOLD` (default 0.8) so it can run in CI.

**The workflow:** change the prompt/few-shot → `npm run eval:ai` → keep it only
if the pass-rate holds or rises. Watch the log for 👎 rows; turn the good fixes
into new few-shot + new gold cases. Revisit fine-tuning **only** when the eval
plateaus with a real gap and you have a few hundred vetted examples — see the
three-path table in the chat history for the cost/retention trade-off.

```bash
# add SCALEWAY_AI_API_KEY to .env.local first (see App configuration above)
npm run eval:ai
# ✓ trend-vmg-rising     score= 95
# ✗ insufficient-data    score= 40
#     1. Failed: recommended a forestay value despite no 20+ kn runs
# 4/5 passed (80%) — threshold 80%
```

> The eval hits the paid API (a few tenths of a cent per run) and is LLM-judged,
> so read it as a **regression signal**, not a certificate. For a stronger grade,
> set `SCALEWAY_AI_JUDGE_MODEL` to a larger model.

## Next: invoices & expenses

There is **no invoice/expense schema yet** — it's greenfield. Plan:

- New migration: `invoices`, `expenses`, `expense_lines`, linked to `teams` /
  `memberships`, with RLS mirroring the campaign tables
  (`is_admin() OR has_team_role(...)`).
- `POST /api/ai/extract-invoice` — accepts an uploaded invoice image (Bunny.net),
  sends it as an OpenAI-style `image_url` content part to Mistral (vision), and
  validates the returned JSON against the schema **before** any DB write. The
  `mistralJSON()` helper already accepts array content for this.
- Keep the same sandbox rules: schema-validated output, RLS-scoped writes, no
  free-form DB access.
