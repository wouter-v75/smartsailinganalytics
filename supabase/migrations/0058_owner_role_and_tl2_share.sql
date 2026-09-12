-- ============================================================================
-- SSA — 0058  "Owner" membership role + sharing from TL2 up
--
-- 1. OWNER. A boat owner should see and do what a TL1 does — and additionally
--    share a clip with someone outside the team. Rather than DROP/CREATE the
--    ~30 write policies that name 'tl1', extend the single shared gate
--    has_team_role(): an owner passes ANY check whose role list includes 'tl1'.
--    That is exactly TL1's access and nothing more (it does NOT pass tl2-,
--    coach- or manager-only checks) — the same trick 0040 used for tl3.
--
-- 2. SHARING. Minting a public link sat with TL3+. It moves to TL2 and up, and
--    to owner. Everything that made it safe is unchanged: the link is a random
--    token for ONE clip, it expires, it can be revoked, and a link minted from
--    the player carries no instrument data at all (include_overlay = false).
--
-- Idempotent. Run after 0057.
-- ============================================================================

-- ── 1. role CHECK: add 'owner' ───────────────────────────────────────────────
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl3', 'tl2', 'tl1', 'owner', 'consultant', 'guest'));

ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl3', 'tl2', 'tl1', 'owner', 'consultant', 'guest'));

-- ── 2. the shared gate: owner ≡ tl1 (plus sharing, granted below) ────────────
CREATE OR REPLACE FUNCTION public.has_team_role(p_team_id UUID, p_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships m
         WHERE m.user_id = auth.uid()
           AND m.team_id = p_team_id
           AND (
                 m.role = ANY (p_roles)
                 -- tl3 ≥ tl2 ≥ tl1: a tl3 passes any gate that admits tl1/tl2.
                 OR (m.role = 'tl3'   AND (p_roles && ARRAY['tl1', 'tl2']))
                 -- owner ≡ tl1 everywhere; its one extra right is video sharing,
                 -- which the video_shares policies below name explicitly.
                 OR (m.role = 'owner' AND (p_roles && ARRAY['tl1']))
               )
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    );
$$;

-- ── 3. quota: an owner uploads like a tl1 ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_quota_for_role(p_user_id UUID, p_role TEXT)
RETURNS BIGINT AS $$
DECLARE
    new_limit BIGINT;
BEGIN
    new_limit := CASE p_role
        WHEN 'admin'      THEN NULL
        WHEN 'coach'      THEN 50::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl3'        THEN 10::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl2'        THEN 10::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl1'        THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'owner'      THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'consultant' THEN  5::BIGINT * 1024 * 1024 * 1024
        ELSE 5::BIGINT * 1024 * 1024 * 1024
    END;
    UPDATE public.user_quota
       SET bytes_limit = new_limit, warned_80 = FALSE, warned_100 = FALSE, updated_at = now()
     WHERE user_id = p_user_id;
    RETURN new_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 4. who may mint / revoke a share link: TL2 and up, plus owner ────────────
DROP POLICY IF EXISTS video_shares_insert ON public.video_shares;
CREATE POLICY video_shares_insert ON public.video_shares
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl2', 'owner', 'team_manager'])
    );

DROP POLICY IF EXISTS video_shares_update ON public.video_shares;
CREATE POLICY video_shares_update ON public.video_shares
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl2', 'owner', 'team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl2', 'owner', 'team_manager'])
    );

DROP POLICY IF EXISTS video_shares_delete ON public.video_shares;
CREATE POLICY video_shares_delete ON public.video_shares
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl2', 'owner', 'team_manager'])
    );
