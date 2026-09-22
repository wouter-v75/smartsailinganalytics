-- 0075_membership_roles.sql
-- ---------------------------------------------------------------------------
-- One person, several roles in the same team — and the duplicate rows that
-- were quietly possible all along.
--
-- THE REQUEST: a user should be able to be a team_manager AND something else,
-- typically coach. On a small campaign that is the normal case, not an edge
-- one: the person who runs the team is usually also the person coaching it.
--
-- THE SCHEMA ALREADY ALLOWED IT. `role` is part of
-- UNIQUE (user_id, team_id, boat_id, role), so two rows differing only in role
-- are legal, and has_team_role() is an EXISTS over all of a user's rows, so it
-- answers yes for either. Nothing in the database needed changing. What was
-- missing was a UI that offered it and a switcher that did not look broken
-- when it happened — both in this migration's commit, not in the SQL.
--
-- WHAT WAS ACTUALLY BROKEN: that same unique constraint does nothing when
-- boat_id IS NULL, because in Postgres NULL <> NULL, so no two rows with a
-- null boat are ever "equal" for uniqueness. An "all boats" membership could
-- therefore be inserted any number of times. Six user+team pairs had picked up
-- exact duplicates — tl1/all twice, tl2/all twice — and the workspace switcher
-- dutifully listed the same team twice, which is what made it visible.
--
-- Deduplicating keeps the OLDEST row of each identical group: it is the one
-- whose id may be referenced elsewhere, and its created_at is the date the
-- access was actually granted.
-- ---------------------------------------------------------------------------

-- ── 1. remove exact duplicates, keeping the earliest of each group ──────────
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, team_id, role, COALESCE(boat_id::text, ''),
                            COALESCE(valid_from::text, ''), COALESCE(valid_to::text, '')
               ORDER BY created_at, id
           ) AS rn
      FROM public.memberships
)
DELETE FROM public.memberships m
 USING ranked r
 WHERE m.id = r.id AND r.rn > 1;

-- ── 2. make it impossible again ─────────────────────────────────────────────
-- The table's own UNIQUE covers the boat-scoped case; this covers the null one.
-- Partial, so it does not fight the existing constraint.
CREATE UNIQUE INDEX IF NOT EXISTS memberships_user_team_role_allboats_idx
    ON public.memberships (user_id, team_id, role)
 WHERE boat_id IS NULL;

-- ── 3. a note for whoever reads this next ───────────────────────────────────
COMMENT ON CONSTRAINT memberships_user_id_team_id_boat_id_role_key ON public.memberships IS
    'Role is part of the key ON PURPOSE: one user may hold several roles in one '
    'team (team_manager AND coach is the normal case on a small campaign). '
    'This constraint does NOT cover boat_id IS NULL — see '
    'memberships_user_team_role_allboats_idx, which does.';
