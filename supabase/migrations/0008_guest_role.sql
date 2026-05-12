-- ============================================================================
-- SSA — add `guest` role.
--
-- Guest is a minimal-access role for occasional viewers:
--   - Sees only the latest session day (UI-side filter).
--   - No SailScan, SquashShots, or AI features.
--   - Analytics tab shows the GPS map only — no charts / data tables.
--   - Cannot see photos that have SailScan analysis attached.
--
-- This migration:
--   1. Extends memberships.role CHECK to allow 'guest'.
--   2. Updates set_quota_for_role with a small (1 GB) default for guest.
--   3. Allows guest in invitations.role CHECK.
--
-- Run after 0007. Idempotent.
-- ============================================================================

ALTER TABLE public.memberships
    DROP CONSTRAINT IF EXISTS memberships_role_check;

ALTER TABLE public.memberships
    ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('team_manager','coach','tl1','tl2','consultant','guest'));

ALTER TABLE public.invitations
    DROP CONSTRAINT IF EXISTS invitations_role_check;

ALTER TABLE public.invitations
    ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('team_manager','coach','tl1','tl2','consultant','guest'));

-- ── set_quota_for_role — add guest case ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_quota_for_role(p_user_id UUID, p_role TEXT)
RETURNS BIGINT AS $$
DECLARE
    new_limit BIGINT;
BEGIN
    new_limit := CASE p_role
        WHEN 'admin'        THEN NULL
        WHEN 'team_manager' THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'coach'        THEN 50::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl2'          THEN 10::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl1'          THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'consultant'   THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'guest'        THEN  1::BIGINT * 1024 * 1024 * 1024
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
