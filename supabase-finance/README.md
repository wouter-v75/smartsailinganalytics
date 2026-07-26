# supabase-finance

Migrations and config for the **separate finance Supabase project** (not the SSA
project). See `src/finance/README.md` for the module boundary rules and full
setup steps.

## Environment variables (set in Vercel — server-only, never `NEXT_PUBLIC`)

```
# Tier 1 (now): service-role client to the finance project.
FINANCE_SUPABASE_URL=https://YOUR-FINANCE-PROJECT.supabase.co
FINANCE_SERVICE_ROLE_KEY=YOUR-FINANCE-SERVICE-ROLE-KEY

# Tier 2 (later): pooled Postgres connection for identity-injected finance RLS.
# Finance project → Settings → Database → Connection pooling (port 6543).
# FINANCE_DATABASE_URL=postgres://postgres.YOUR-REF:PASSWORD@aws-...pooler.supabase.com:6543/postgres
```

Copy these into your local `.env.local` too (gitignored) for local dev. The
remote file tools block writing `.env*` files, so create that file yourself.

## Applying migrations

This is a distinct project from SSA, so it has its own migration history. Run
`migrations/0001_finance_init.sql` in the finance project's SQL editor (or link a
second Supabase CLI project ref and push). Keep finance migrations here, separate
from the SSA `supabase/migrations/` history, so each database is reproducible on
its own.
