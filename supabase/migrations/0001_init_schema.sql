-- ============================================================================
-- SSA L1.0 — initial schema
--
-- Tables: users, teams, boats, memberships, user_quota, events.
-- Run once in the Supabase SQL Editor on a fresh project. Idempotent (CREATE
-- IF NOT EXISTS) so re-running is safe during development.
--
-- See docs/auth/spec.md for design decisions; docs/auth/setup.md for the
-- step-by-step Supabase project provisioning guide.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- users — application-level profile linked 1:1 to Supabase's auth.users.
--
-- Supabase manages identity (email, hashed password, passkey credentials) in
-- the `auth` schema. We mirror id + add app-level fields here. A row is
-- inserted by the signup flow with status='pending'; the admin flips it to
-- 'active' after review. Login is rejected for non-active users.
--
-- global_role is set ONLY for the site admin (Wouter). All other roles
-- (coach, tl1, tl2, consultant) live on memberships and are scoped to
-- (team, boat).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
    id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email        TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'active', 'disabled')),
    global_role  TEXT
                 CHECK (global_role IS NULL OR global_role = 'admin'),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at  TIMESTAMPTZ,
    approved_by  UUID REFERENCES public.users(id) ON DELETE SET NULL,
    last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS users_status_idx ON public.users(status);
COMMENT ON COLUMN public.users.global_role IS
    'Only ''admin'' is valid here. All non-admin roles are membership-scoped.';

-- ────────────────────────────────────────────────────────────────────────────
-- teams — top-level tenant. A team owns boats; memberships scope users to
-- (team, boat) tuples.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.teams (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT NOT NULL UNIQUE,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- boats — owned by a team. Photos / videos / sessions belong to a boat.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boats (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sail_number TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, name)
);

CREATE INDEX IF NOT EXISTS boats_team_idx ON public.boats(team_id);

-- ────────────────────────────────────────────────────────────────────────────
-- memberships — many-to-many user × (team, boat) with a role.
--
-- Setting boat_id to NULL means "any boat in the team" (rarely used; mainly
-- for coaches who supervise the whole team's boats).
--
-- valid_from / valid_to bound the *active* window of the membership; outside
-- it the user can't see anything for that (team, boat). Used principally for
-- consultants — admin sets a date range when granting them access.
-- NULL on either column means unbounded in that direction.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    team_id     UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id     UUID REFERENCES public.boats(id) ON DELETE CASCADE,
    role        TEXT NOT NULL
                CHECK (role IN ('coach', 'tl1', 'tl2', 'consultant')),
    valid_from  TIMESTAMPTZ,
    valid_to    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, team_id, boat_id, role)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON public.memberships(user_id);
CREATE INDEX IF NOT EXISTS memberships_team_idx ON public.memberships(team_id);

-- ────────────────────────────────────────────────────────────────────────────
-- user_quota — per-user storage budget. Defaults are role-derived; admin can
-- override per user. NULL bytes_limit means unlimited (used for site admin).
--
-- bytes_used is incremented by upload triggers (or app code calling an RPC).
-- The two warning flags suppress duplicate emails on repeated near-limit
-- bumps; cleared by admin if quota is raised.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_quota (
    user_id      UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    bytes_used   BIGINT NOT NULL DEFAULT 0,
    bytes_limit  BIGINT,                                  -- NULL = unlimited
    warned_80    BOOLEAN NOT NULL DEFAULT FALSE,
    warned_100   BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- events — lightweight audit/activity log. JSON details column lets us evolve
-- per-event payloads without migrations.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.events (
    id        BIGSERIAL PRIMARY KEY,
    user_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action    TEXT NOT NULL,           -- 'signup', 'approve', 'login', 'upload', 'quota_warn_80', 'quota_block', etc.
    details   JSONB,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_user_ts_idx ON public.events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_action_ts_idx ON public.events(action, ts DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- handle_new_user — trigger that auto-creates the public.users row whenever
-- Supabase Auth creates an auth.users row. The signup flow on the client
-- only needs to call supabase.auth.signUp(); the rest is handled server-side
-- atomically. Status starts as 'pending'.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, email, name, status)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        'pending'
    );
    -- Insert default quota row (5 GB until admin sets role-based amount)
    INSERT INTO public.user_quota (user_id, bytes_limit)
    VALUES (NEW.id, 5 * 1024::BIGINT * 1024 * 1024);
    -- Audit
    INSERT INTO public.events (user_id, action, details)
    VALUES (NEW.id, 'signup', jsonb_build_object('email', NEW.email));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ────────────────────────────────────────────────────────────────────────────
-- set_quota_for_role — convenience function the admin UI calls when
-- assigning a primary role. Caps user_quota.bytes_limit to the role's
-- default. Returns the new limit (NULL = unlimited).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_quota_for_role(p_user_id UUID, p_role TEXT)
RETURNS BIGINT AS $$
DECLARE
    new_limit BIGINT;
BEGIN
    new_limit := CASE p_role
        WHEN 'admin'      THEN NULL
        WHEN 'coach'      THEN 50::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl2'        THEN 10::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl1'        THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'consultant' THEN  5::BIGINT * 1024 * 1024 * 1024
        ELSE 5::BIGINT * 1024 * 1024 * 1024
    END;
    UPDATE public.user_quota
       SET bytes_limit = new_limit,
           warned_80   = FALSE,
           warned_100  = FALSE,
           updated_at  = now()
     WHERE user_id = p_user_id;
    RETURN new_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
