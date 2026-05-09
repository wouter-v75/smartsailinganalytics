-- ============================================================================
-- SSA — invitations + requested_team_id.
--
-- Two invitation flavours share one table:
--   1. Targeted (email = X, max_uses = 1, auto_approve = TRUE)
--      Team manager invites a specific person; on signup they're already
--      vetted, so we auto-flip status='active' and create the membership.
--   2. Open (email NULL, max_uses = N, auto_approve = FALSE)
--      Team manager generates a QR / URL to drop in WhatsApp. Recipients
--      sign up and land status='pending' with requested_team_id set; team
--      manager sees them in their team's pending queue and approves.
--
-- The redemption logic lives in API code, not the database, because we need
-- to coordinate auth.users creation (signup) + public.users update + new
-- membership in the same request.
--
-- Run after 0004. Idempotent.
-- ============================================================================

-- ── invitations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invitations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id             UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    email               TEXT,                                 -- NULL = open link
    role                TEXT NOT NULL
                        CHECK (role IN ('team_manager','coach','tl1','tl2','consultant')),
    boat_id             UUID REFERENCES public.boats(id) ON DELETE CASCADE,
    valid_from          TIMESTAMPTZ,
    valid_to            TIMESTAMPTZ,
    token               TEXT UNIQUE NOT NULL,                 -- random opaque, ~24 chars
    auto_approve        BOOLEAN NOT NULL,
    max_uses            INTEGER NOT NULL DEFAULT 1
                        CHECK (max_uses >= 1),
    used_count          INTEGER NOT NULL DEFAULT 0
                        CHECK (used_count >= 0),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    created_by_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invitations_team_idx ON public.invitations(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_idx ON public.invitations(token);

COMMENT ON COLUMN public.invitations.email IS
    'NULL for open team links (anyone with URL/QR can use up to max_uses times).';
COMMENT ON COLUMN public.invitations.auto_approve IS
    'TRUE for email invites (team_manager has vouched). FALSE for open links.';

-- ── requested_team_id on public.users ──────────────────────────────────────
-- Set when an open-link invite is redeemed by a brand-new user, so the
-- team_manager pending queue can filter to "users requesting MY team".
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS requested_team_id UUID
        REFERENCES public.teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_requested_team_idx
    ON public.users(requested_team_id)
    WHERE requested_team_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_select ON public.invitations;
DROP POLICY IF EXISTS invitations_insert ON public.invitations;
DROP POLICY IF EXISTS invitations_update ON public.invitations;
DROP POLICY IF EXISTS invitations_delete ON public.invitations;

-- SELECT: admin or team_manager of the target team.
-- Anonymous redemption goes through a server-side service-role API path,
-- so we don't need a public select here.
CREATE POLICY invitations_select ON public.invitations
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY invitations_insert ON public.invitations
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY invitations_update ON public.invitations
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY invitations_delete ON public.invitations
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO authenticated;
REVOKE ALL ON public.invitations FROM anon;
