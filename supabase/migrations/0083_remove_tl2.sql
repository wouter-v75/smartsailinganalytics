-- Remove tl2. Its permissions become tl3's.
--
-- The sailing ladder is tl1 → tl2 → tl3. Three tiers turned out to be one more
-- than anyone uses, so tl2 goes and tl3 inherits everything it had. In the
-- interface these are now SAILOR SILVER (tl1) and SAILOR GOLD (tl3); the stored
-- values stay `tl1` and `tl3` on purpose — see the note at the bottom.
--
-- The work is in three parts, and the order matters:
--
--   1. POLICIES FIRST. 13 live policies grant tl2 without granting tl3, so a
--      straight data migration would silently take those rights away from every
--      promoted user: tag lists, timeline nodes, trackers, training days,
--      windweight samples, squad membership, tag requests, session attachments.
--      Each is rewritten with tl2's slot handed to tl3. They are reproduced from
--      their live definitions rather than retyped, so nothing else in them moved.
--
--   2. THEN THE DATA, once the destination role already has the rights.
--
--   3. THEN THE CONSTRAINT, so nothing can create a tl2 again.
--
-- The other 71 policies that name tl1 or tl3 are untouched: those values are
-- unchanged, so they keep meaning exactly what they meant.

-- ── 1. policies: tl2's grants become tl3's ──────────────────────────────────

-- public.session_attachments.session_attachments_select  (was last set in 0023_session_attachments.sql)
DROP POLICY IF EXISTS session_attachments_select ON public.session_attachments;
CREATE POLICY session_attachments_select ON public.session_attachments FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.has_boat_access(team_id, boat_id)
            AND public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager','consultant'])
        )
    );;

-- public.squad_members.squad_members_write  (was last set in 0071_squads.sql)
DROP POLICY IF EXISTS squad_members_write ON public.squad_members;
CREATE POLICY squad_members_write ON public.squad_members
    FOR ALL TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager'])
    );;

-- public.ssa_tag_requests.ssa_tag_requests_insert  (was last set in 0063_ssa_tag_requests.sql)
DROP POLICY IF EXISTS ssa_tag_requests_insert ON public.ssa_tag_requests;
CREATE POLICY ssa_tag_requests_insert ON public.ssa_tag_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        requested_by_user_id = auth.uid()
        AND (public.is_admin()
             OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl3', 'consultant']))
    );;

-- public.tag_lists.tag_lists_insert  (was last set in 0004_team_manager_role.sql)
DROP POLICY IF EXISTS tag_lists_insert ON public.tag_lists;
CREATE POLICY tag_lists_insert ON public.tag_lists
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl3'])
    );;

-- public.tag_lists.tag_lists_update  (was last set in 0004_team_manager_role.sql)
DROP POLICY IF EXISTS tag_lists_update ON public.tag_lists;
CREATE POLICY tag_lists_update ON public.tag_lists
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl3'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl3'])
    );;

-- public.timeline_nodes.timeline_nodes_delete  (was last set in 0046_timeline_nodes.sql)
DROP POLICY IF EXISTS timeline_nodes_delete ON public.timeline_nodes;
CREATE POLICY timeline_nodes_delete ON public.timeline_nodes
  FOR DELETE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl3']));;

-- public.timeline_nodes.timeline_nodes_insert  (was last set in 0046_timeline_nodes.sql)
DROP POLICY IF EXISTS timeline_nodes_insert ON public.timeline_nodes;
CREATE POLICY timeline_nodes_insert ON public.timeline_nodes
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl3']));;

-- public.timeline_nodes.timeline_nodes_update  (was last set in 0046_timeline_nodes.sql)
DROP POLICY IF EXISTS timeline_nodes_update ON public.timeline_nodes;
CREATE POLICY timeline_nodes_update ON public.timeline_nodes
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl3']));;

-- public.tracker_assignments.tracker_assignments_write  (was last set in 0070_trackers_and_training_days.sql)
DROP POLICY IF EXISTS tracker_assignments_write ON public.tracker_assignments;
CREATE POLICY tracker_assignments_write ON public.tracker_assignments
    FOR ALL TO authenticated
    USING (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.trackers t
            WHERE t.id = tracker_assignments.tracker_id
              AND public.has_team_role(t.team_id, ARRAY['coach','tl1','tl3','team_manager'])
        )
    )
    WITH CHECK (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.trackers t
            WHERE t.id = tracker_assignments.tracker_id
              AND public.has_team_role(t.team_id, ARRAY['coach','tl1','tl3','team_manager'])
        )
    );;

-- public.trackers.trackers_write  (was last set in 0070_trackers_and_training_days.sql)
DROP POLICY IF EXISTS trackers_write ON public.trackers;
CREATE POLICY trackers_write ON public.trackers
    FOR ALL TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager']));;

-- public.training_days.training_days_insert  (was last set in 0070_trackers_and_training_days.sql)
DROP POLICY IF EXISTS training_days_insert ON public.training_days;
CREATE POLICY training_days_insert ON public.training_days
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager']));;

-- public.windweight_samples.windweight_samples_update  (was last set in 0045_windweight_samples.sql)
DROP POLICY IF EXISTS windweight_samples_update ON public.windweight_samples;
CREATE POLICY windweight_samples_update ON public.windweight_samples
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl3']));;

-- public.windweight_samples.windweight_samples_write  (was last set in 0045_windweight_samples.sql)
DROP POLICY IF EXISTS windweight_samples_write ON public.windweight_samples;
CREATE POLICY windweight_samples_write ON public.windweight_samples
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl3']));;

-- ── 2. data: promote every tl2 to tl3 ───────────────────────────────────────
-- Promotion, not demotion: nobody loses access on the way through, and tl3 is
-- where a squad's senior sailors belong anyway.

UPDATE public.memberships SET role = 'tl3' WHERE role = 'tl2';
UPDATE public.invitations SET role = 'tl3' WHERE role = 'tl2';

-- ── 3. constraint: tl2 can no longer be created ─────────────────────────────

ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl3', 'tl1', 'owner', 'consultant', 'guest'));

ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl3', 'tl1', 'owner', 'consultant', 'guest'));

-- ── why the stored values are still tl1 / tl3 ───────────────────────────────
-- Renaming the VALUES to sailor_silver / sailor_gold would mean rewriting all 84
-- live policies that name them, on a production database, where missing one
-- silently removes someone's access — which is exactly the class of bug that let
-- tl3 exist for 55 migrations without being able to upload. The names people see
-- live in one map in the app (src/lib/roleLabels.ts) and every human-facing
-- surface reads from it. If the DB values should follow later, that is a
-- mechanical change to make deliberately and verify role by role, not a side
-- effect of removing a tier.
