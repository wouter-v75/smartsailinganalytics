-- 0053 — Public share links for a single clip (video + instrument overlay).
--
-- Lets a sailmaker / outside coach watch ONE clip with its data overlay, without an
-- account. The link is a random token, it expires, and it can be revoked.
--
-- Scope is deliberately narrow: a token grants access to exactly one video and the slice
-- of log data covering that clip's time window. Nothing about the boat, the session, the
-- team or any other clip is reachable from it.
--
-- The public read is served by the API using the SERVICE ROLE (RLS bypassed), because
-- the viewer has no Supabase identity at all. The token IS the authorisation, so the
-- route must check expiry + revoked itself — the policies below only govern who can
-- CREATE and MANAGE links, not who can read through one.

CREATE TABLE IF NOT EXISTS public.video_shares (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token              TEXT NOT NULL UNIQUE,          -- random, URL-safe; the capability
    video_id           UUID NOT NULL REFERENCES public.videos(id)  ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id)   ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id)   ON DELETE CASCADE,
    include_overlay    BOOLEAN NOT NULL DEFAULT TRUE, -- false ⇒ footage only, no numbers
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,                   -- non-null ⇒ dead, regardless of expiry
    view_count         INTEGER NOT NULL DEFAULT 0,
    last_viewed_at     TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_shares_token_idx ON public.video_shares(token);
CREATE INDEX IF NOT EXISTS video_shares_video_idx ON public.video_shares(video_id);

ALTER TABLE public.video_shares ENABLE ROW LEVEL SECURITY;

-- Who may see which links exist, and revoke them: the boat's people.
DROP POLICY IF EXISTS video_shares_select ON public.video_shares;
CREATE POLICY video_shares_select ON public.video_shares
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

-- Who may MINT a link. Deliberately NOT everyone with boat access: a share link hands a
-- clip and its instrument data to the open internet, so it sits with the senior roles —
-- the same TL3+ ladder that can rotate clips and edit Boat Config.
DROP POLICY IF EXISTS video_shares_insert ON public.video_shares;
CREATE POLICY video_shares_insert ON public.video_shares
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

-- Revoking is an UPDATE (revoked_at). Same set — plus the person who created it.
DROP POLICY IF EXISTS video_shares_update ON public.video_shares;
CREATE POLICY video_shares_update ON public.video_shares
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

DROP POLICY IF EXISTS video_shares_delete ON public.video_shares;
CREATE POLICY video_shares_delete ON public.video_shares
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

COMMENT ON TABLE public.video_shares IS
    'Public, expiring, revocable share links for a single clip + its overlay. The token is the capability; the public route validates expiry/revocation itself using the service role.';
