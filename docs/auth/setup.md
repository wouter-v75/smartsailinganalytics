# SSA Supabase Setup Runbook

Step-by-step guide to provision the Supabase backend for SSA L1.0. Follow once per environment (dev / prod). Should take ~20 minutes.

Decisions and rationale live in [`spec.md`](./spec.md). The SQL itself is in [`../../supabase/migrations/`](../../supabase/migrations/).

---

## 1. Create the Supabase project

1. Sign in at <https://supabase.com> with the Anthropic / Wouter account.
2. **New Project** → fill in:
   - **Name**: `ssa-prod` (or `ssa-dev` for the dev project — make two if you want clean separation).
   - **Database Password**: generate a strong one and stash it in 1Password / Bitwarden under "SSA Supabase DB".
   - **Region**: **Frankfurt (eu-central-1)**. ⚠ This is the GDPR-relevant choice — do not change.
   - **Pricing Plan**: Free for now. Upgrade to Pro when we exceed 500 MB DB or want point-in-time backups.
3. Wait ~2 minutes for the project to provision.

## 2. Run the schema migrations

Two SQL files, run in order. Both are idempotent so you can re-run during development.

1. Open **SQL Editor** in the Supabase dashboard.
2. **New query** → paste the contents of `supabase/migrations/0001_init_schema.sql` → **Run**.
3. **New query** → paste the contents of `supabase/migrations/0002_rls_policies.sql` → **Run**.
4. Verify under **Table Editor** that you can see: `users`, `teams`, `boats`, `memberships`, `user_quota`, `events`.

> 💡 Once we're past L1.0 we should switch to the Supabase CLI and run migrations locally with `supabase db push`. For now, the dashboard SQL editor is fine.

## 3. Promote yourself to admin

The schema starts every user as `pending`. The admin must be flipped manually since there's no UI yet.

1. Sign yourself up via the app (L1.1) **OR** insert a row directly via SQL Editor:
   ```sql
   -- Only do this AFTER you've signed up so auth.users has your row.
   UPDATE public.users
      SET status      = 'active',
          global_role = 'admin',
          approved_at = now()
    WHERE email = 'wouterv@runbox.com';

   UPDATE public.user_quota
      SET bytes_limit = NULL  -- unlimited for admin
    WHERE user_id = (SELECT id FROM public.users WHERE email = 'wouterv@runbox.com');
   ```
2. From here on, all admin work goes through the app's admin UI (built in L2).

## 4. Configure Auth providers

**Authentication → Providers** in the dashboard.

### Email/password (fallback)

- **Enable Email provider**: ON.
- **Confirm email**: ON (recommended). New users must click the link before they can sign in. Combined with `status='pending'`, this gives us double-defence.
- **Secure email change**: ON.
- **Secure password change**: ON.

### Passkey / WebAuthn (primary)

Supabase ships passkey support via "Phone / WebAuthn" providers as of mid-2025. Toggling it on:

- **Enable Phone provider**: OFF (we don't use SMS).
- **Enable WebAuthn / Passkey**: ON.
- The actual passkey registration UI lives in our app (L1.2).

### Disable everything else

OAuth providers (Google, GitHub, etc.) — leave OFF. We're not federating identity for now.

### Magic link

Leave ON as another fallback for lost passkeys; the email template can be customised in the next step.

## 5. Customise email templates

**Authentication → Email Templates** in the dashboard. Tweak each template to use SSA branding and the right URL.

- **Confirm signup**: Subject "Confirm your SSA account". Body: short note, mention the admin will review the application after they confirm.
- **Magic link**: Subject "SSA sign-in link". Body: short note, link expires in 1 hour.
- **Reset password**: Default is fine.
- **Invite user**: Not used (we don't invite, admin approves).

The `{{ .SiteURL }}` template variable should resolve to the deployed URL. Set this under **Authentication → URL Configuration**:

- **Site URL**: `https://smart-sailing-analytics.vercel.app` (or your prod URL).
- **Redirect URLs**: add both prod and `http://localhost:3000` for dev.

## 6. Get the API keys

**Project Settings → API** in the dashboard.

You need two keys:

| Variable | Purpose | Exposure |
| -------- | ------- | -------- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project endpoint, e.g. `https://abcdefgh.supabase.co` | Public — safe in browser bundle. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon / public key. RLS-gated. | Public — safe in browser bundle. |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Used only by Vercel server functions for admin RPCs. | **SECRET. Never expose.** |

Copy them into the env files described next.

## 7. Local environment

Create `.env.local` in the repo root (already gitignored):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVICE-ROLE-KEY  # only on the server
```

The shipped `.env.example` lists every variable the app expects — copy it and fill in.

## 8. Vercel environment

For prod and preview:

1. Vercel project → **Settings → Environment Variables**.
2. Add the same three vars. Tick **Production** + **Preview** for `NEXT_PUBLIC_*`. Tick only **Production** for `SUPABASE_SERVICE_ROLE_KEY` (preview deploys don't need admin powers).
3. Trigger a redeploy.

## 9. Smoke test

Run from the SQL Editor as a sanity check:

```sql
-- Should return 1 row with your admin user once you've followed step 3.
SELECT id, email, status, global_role
  FROM public.users
 WHERE global_role = 'admin';

-- Should return 6 tables.
SELECT tablename
  FROM pg_tables
 WHERE schemaname = 'public'
 ORDER BY tablename;

-- Should return >0; verifies RLS is enabled on every table.
SELECT relname, relrowsecurity
  FROM pg_class
 WHERE relnamespace = 'public'::regnamespace
   AND relkind = 'r'
   AND relrowsecurity = true;
```

Once these all pass, L1.0 is done. Move on to L1.1 (app integration).

---

## Backups

Supabase Free tier gives 7-day automatic daily backups, no point-in-time recovery. For prod, upgrade to Pro ($25/mo) for 28-day daily + PITR. For dev, free is fine.

## Switching providers later

The schema is plain Postgres + standard `auth.users` shape. To migrate off Supabase:

1. `pg_dump` the `public.*` schema and the relevant `auth.users` rows.
2. Stand up Postgres on Aiven / Scaleway (Frankfurt).
3. Replace Supabase Auth with [Lucia](https://lucia-auth.com/) or [Better Auth](https://www.better-auth.com/) — both wire passkey + email/password into a session-cookie scheme that can talk to a vanilla Postgres user table.
4. Re-issue passkey credentials (they're scoped to the relying-party origin, which doesn't change, but the storage table does).

Estimated effort: 1–2 build sessions.
