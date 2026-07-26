-- ============================================================================
-- SSA Finance — 0001 init (FRAMEWORK ONLY)
--
-- Runs in the SEPARATE finance Supabase project — NOT the SSA project. This is
-- the skeleton: identity plumbing, the access list, audit, and locked-down RLS.
-- Business tables (invoices, suppliers, expenses, …) are deliberately NOT here —
-- they arrive once you and Harry define requirements, on top of this frame.
--
-- Identity model: this database has NO users of its own. The SSA project is the
-- only identity provider. The SSA app injects the caller as request.jwt.claims:
--   { "sub": <ssa user uuid>, "role": "authenticated",
--     "ssa_roles": ["admin", ...], "ssa_teams": ["<team uuid>", ...] }
-- The helpers below read that injected context; finance RLS is built on them.
-- (Today the app connects with the service-role key and authorizes in-app —
--  Tier 1. These helpers make the DB ready for Tier-2 RLS with zero rework.)
-- ============================================================================

-- ── Identity helpers (read the injected claims) ─────────────────────────────
create or replace function public.fin_claims()
returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function public.fin_uid()
returns uuid language sql stable as $$
  select nullif(public.fin_claims() ->> 'sub', '')::uuid
$$;

create or replace function public.fin_is_ssa_admin()
returns boolean language sql stable as $$
  select coalesce(public.fin_claims() -> 'ssa_roles' ? 'admin', false)
$$;

-- ── Access list: who has finance access, and their finance role ─────────────
-- finance_role is intentionally open for now (values set with Harry); the CHECK
-- enumerates the four we agreed. team_id / ssa_user_id are SSA UUIDs — soft
-- references (no cross-database foreign keys).
create table if not exists public.finance_members (
  ssa_user_id  uuid not null,
  team_id      uuid not null,
  finance_role text not null check (finance_role in
                 ('admin','project_manager','boat_captain','first_mate')),
  email        text,
  added_by     uuid,
  created_at   timestamptz not null default now(),
  primary key (ssa_user_id, team_id)
);
create index if not exists finance_members_team_idx on public.finance_members (team_id);

create or replace function public.fin_member_role(p_team uuid)
returns text language sql stable security definer set search_path = public as $$
  select finance_role from public.finance_members
   where ssa_user_id = public.fin_uid() and team_id = p_team
$$;

-- Any finance access to a team? (admin always yes.)
create or replace function public.fin_has_access(p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.fin_is_ssa_admin()
      or exists (select 1 from public.finance_members
                  where ssa_user_id = public.fin_uid() and team_id = p_team)
$$;

-- ── Audit: every finance change recorded — the evidence for the trust story ──
create table if not exists public.finance_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  action     text not null,
  table_name text,
  row_pk     text,
  detail     jsonb
);

-- ── RLS: default-deny everywhere. Policies wrap helper calls in (select …) so
--    Postgres caches them once per query (the perf lesson from Phase 0). ──────
alter table public.finance_members enable row level security;
alter table public.finance_audit   enable row level security;

create policy finance_members_read on public.finance_members
  for select to authenticated
  using ((select public.fin_has_access(team_id)));

create policy finance_members_admin_all on public.finance_members
  for all to authenticated
  using ((select public.fin_is_ssa_admin()))
  with check ((select public.fin_is_ssa_admin()));

create policy finance_audit_admin_read on public.finance_audit
  for select to authenticated
  using ((select public.fin_is_ssa_admin()));

-- ── Seed the Northstar access list (fill in real UUIDs, then uncomment) ─────
-- Get the SSA user UUIDs by running, in the SSA project's SQL editor:
--   select id, email from auth.users where email in
--     ('harry@…','shane@…','sam@…','wouter@…');
-- and the Northstar team_id from the SSA project:
--   select id, name from public.teams where name ilike '%northstar%';
--
-- insert into public.finance_members (ssa_user_id, team_id, finance_role, email) values
--   ('<harry-uuid>',  '<northstar-team-uuid>', 'project_manager', 'harry@…'),
--   ('<shane-uuid>',  '<northstar-team-uuid>', 'boat_captain',    'shane@…'),
--   ('<sam-uuid>',    '<northstar-team-uuid>', 'first_mate',      'sam@…'),
--   ('<wouter-uuid>', '<northstar-team-uuid>', 'admin',           'wouter@…')
-- on conflict (ssa_user_id, team_id) do update set finance_role = excluded.finance_role;
