# Finance module

A **bounded** module that shares the SSA login but keeps its data in a **separate
database**. Built so it can be lifted into its own app later with minimal work.
Right now it's a framework only — business tables and routes arrive once
requirements are defined with Harry.

## The boundary rules (what keeps it splittable)

1. **One seam.** Finance code touches the rest of SSA through `identity.ts` and
   nothing else. Do **not** `import` SSA components, libs, or helpers from
   anywhere else in `src/finance/*` or `src/app/api/finance/*`. If finance needs
   something from SSA, it comes through `identity.ts` (or is fetched over an API).
2. **Separate database, always.** Finance data lives in the finance Supabase
   project via `db.ts`. Never add a finance table to the SSA database, and never
   query SSA business tables from finance code except the user/membership lookup
   inside `identity.ts`.
3. **Soft references only.** Finance rows reference SSA `user_id` / `team_id` /
   `boat_id` as plain UUID columns — no cross-database foreign keys. Name/label
   enrichment happens in the route by asking SSA, not by joining across DBs.
4. **Server-only.** Everything here runs server-side. No finance key or finance
   client ever reaches the browser.

Follow these four and the eventual split is a lift-and-shift, not a rewrite.

## Files

- `identity.ts` — the seam. Resolves the SSA-authenticated caller (`FinanceCaller`)
  and defines the claims the app injects into the finance DB. **The one file that
  gets reimplemented if finance becomes its own app** (verify the SSA JWT via
  SSA's public JWKS instead of the shared cookie).
- `db.ts` — the finance database client (Tier 1: service-role; Tier 2 upgrade
  path documented inline).
- `../app/api/finance/health/route.ts` — wiring health check.
- `../../supabase-finance/migrations/0001_finance_init.sql` — finance DB skeleton
  (identity helpers, `finance_members` access list, audit, default-deny RLS).

## Setup (once, to activate the framework)

1. **Create a second Supabase project** — e.g. `ssa-finance`. Turn on asymmetric
   JWT signing keys (consistency with SSA). This is the separate database.
2. **Run the init migration** `supabase-finance/migrations/0001_finance_init.sql`
   in the finance project's SQL editor.
3. **Set env vars** in Vercel from `supabase-finance/.env.finance.example`
   (`FINANCE_SUPABASE_URL`, `FINANCE_SERVICE_ROLE_KEY`), then redeploy.
4. **Check wiring:** signed in, hit `GET /api/finance/health` → `{ ok: true }`.
   Before step 3 it returns 503 (`finance-db-not-configured`) — harmless.
5. **Seed access** — get the SSA user UUIDs for Harry/Shane/Sam/you and the
   Northstar `team_id` (queries are in the migration's footer), then run the
   seed `INSERT` in the finance project.

## Authorization (today vs later)

- **Tier 1 (now):** routes authorize using `getFinanceCaller()` + the
  `finance_members` role, then read/write via the service-role finance client.
- **Tier 2 (later):** switch `db.ts` to a pooled Postgres connection that injects
  `financeClaims(caller)` as `request.jwt.claims` per transaction, so the finance
  DB's own RLS (already scaffolded) enforces access. Isolated to `db.ts`.

## When it's time to split into its own app

Because the seams are set now, the split is mechanical: move `src/finance/*` and
`src/app/(finance)/*` into a new Next.js/Vercel project; keep the finance Supabase
project as-is; reimplement `identity.ts` to verify the SSA JWT against SSA's JWKS
(`https://<ssa-ref>.supabase.co/auth/v1/.well-known/jwks.json`); host it on a
subdomain of the same root domain so the SSA login cookie is shared, or pass the
token. No data migration, no schema change.
