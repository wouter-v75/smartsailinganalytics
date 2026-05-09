-- ============================================================================
-- SSA — extend public.users with requested_role + requested_boat_id.
--
-- When a user redeems an open-link invitation we already set
-- users.requested_team_id (added in 0005). To make the approval form
-- one-click, also persist the role and boat the inviting team_manager
-- specified — so when they review the pending user, the dropdowns are
-- already pre-filled with what they intended.
--
-- Run after 0005. Idempotent.
-- ============================================================================

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS requested_role TEXT
        CHECK (requested_role IS NULL OR
               requested_role IN ('team_manager','coach','tl1','tl2','consultant'));

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS requested_boat_id UUID
        REFERENCES public.boats(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.users.requested_role IS
    'Role from the invitation the user redeemed. Used to pre-fill the admin approval form.';
COMMENT ON COLUMN public.users.requested_boat_id IS
    'Boat from the invitation the user redeemed. Pre-fills the approval form; NULL means team-wide.';
