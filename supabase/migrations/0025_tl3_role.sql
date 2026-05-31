-- ============================================================================
-- SSA — 0025 add TL3 membership role + campaign edit tier
--
-- TL3 sits above TL2, below coach. TL3 and above (coach / team_manager / admin)
-- may EDIT the campaign features (plan, backlog, day, debrief + speed-team
-- notes, weather); TL1/TL2 view only.
--
-- This migration:
--   1. Extends memberships.role + invitations.role CHECK with 'tl3'.
--   2. Gives tl3 a storage quota (same as tl2).
--   3. Re-points campaign write policies to coach/tl3/team_manager, and lets
--      tl3 update sessions (objective / conditions / timings).
--
-- Idempotent. Run after 0024.
-- ============================================================================

-- ── 1. role CHECK ─────────────────────────────────────────────────────────────
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl3', 'tl1', 'tl2', 'consultant', 'guest'));

ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl3', 'tl1', 'tl2', 'consultant', 'guest'));

-- ── 2. quota ──────────────────────────────────────────────────────────────────
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
        WHEN 'consultant' THEN  5::BIGINT * 1024 * 1024 * 1024
        ELSE 5::BIGINT * 1024 * 1024 * 1024
    END;
    UPDATE public.user_quota
       SET bytes_limit = new_limit, warned_80 = FALSE, warned_100 = FALSE, updated_at = now()
     WHERE user_id = p_user_id;
    RETURN new_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 3. campaign write policies → coach / tl3 / team_manager ───────────────────
-- Helper note: EDIT = is_admin() OR has_team_role(team_id, ['coach','tl3','team_manager']).

-- backlog_items
DROP POLICY IF EXISTS backlog_items_insert ON public.backlog_items;
DROP POLICY IF EXISTS backlog_items_update ON public.backlog_items;
DROP POLICY IF EXISTS backlog_items_delete ON public.backlog_items;
CREATE POLICY backlog_items_insert ON public.backlog_items FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY backlog_items_update ON public.backlog_items FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY backlog_items_delete ON public.backlog_items FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- backlog_subtasks
DROP POLICY IF EXISTS backlog_subtasks_insert ON public.backlog_subtasks;
DROP POLICY IF EXISTS backlog_subtasks_update ON public.backlog_subtasks;
DROP POLICY IF EXISTS backlog_subtasks_delete ON public.backlog_subtasks;
CREATE POLICY backlog_subtasks_insert ON public.backlog_subtasks FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY backlog_subtasks_update ON public.backlog_subtasks FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY backlog_subtasks_delete ON public.backlog_subtasks FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- session_blocks
DROP POLICY IF EXISTS session_blocks_insert ON public.session_blocks;
DROP POLICY IF EXISTS session_blocks_update ON public.session_blocks;
DROP POLICY IF EXISTS session_blocks_delete ON public.session_blocks;
CREATE POLICY session_blocks_insert ON public.session_blocks FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY session_blocks_update ON public.session_blocks FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY session_blocks_delete ON public.session_blocks FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- session_plan_items
DROP POLICY IF EXISTS plan_items_insert ON public.session_plan_items;
DROP POLICY IF EXISTS plan_items_update ON public.session_plan_items;
DROP POLICY IF EXISTS plan_items_delete ON public.session_plan_items;
CREATE POLICY plan_items_insert ON public.session_plan_items FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY plan_items_update ON public.session_plan_items FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY plan_items_delete ON public.session_plan_items FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- runs
DROP POLICY IF EXISTS runs_insert ON public.runs;
DROP POLICY IF EXISTS runs_update ON public.runs;
DROP POLICY IF EXISTS runs_delete ON public.runs;
CREATE POLICY runs_insert ON public.runs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY runs_update ON public.runs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY runs_delete ON public.runs FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- configs
DROP POLICY IF EXISTS configs_insert ON public.configs;
DROP POLICY IF EXISTS configs_update ON public.configs;
DROP POLICY IF EXISTS configs_delete ON public.configs;
CREATE POLICY configs_insert ON public.configs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY configs_update ON public.configs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY configs_delete ON public.configs FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- datasets
DROP POLICY IF EXISTS datasets_insert ON public.datasets;
DROP POLICY IF EXISTS datasets_update ON public.datasets;
DROP POLICY IF EXISTS datasets_delete ON public.datasets;
CREATE POLICY datasets_insert ON public.datasets FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY datasets_update ON public.datasets FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY datasets_delete ON public.datasets FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- clip_notes
DROP POLICY IF EXISTS clip_notes_insert ON public.clip_notes;
DROP POLICY IF EXISTS clip_notes_update ON public.clip_notes;
DROP POLICY IF EXISTS clip_notes_delete ON public.clip_notes;
CREATE POLICY clip_notes_insert ON public.clip_notes FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY clip_notes_update ON public.clip_notes FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY clip_notes_delete ON public.clip_notes FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- manoeuvre_events
DROP POLICY IF EXISTS manoeuvre_events_insert ON public.manoeuvre_events;
DROP POLICY IF EXISTS manoeuvre_events_update ON public.manoeuvre_events;
DROP POLICY IF EXISTS manoeuvre_events_delete ON public.manoeuvre_events;
CREATE POLICY manoeuvre_events_insert ON public.manoeuvre_events FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY manoeuvre_events_update ON public.manoeuvre_events FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY manoeuvre_events_delete ON public.manoeuvre_events FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- debriefs (notes + speed-team notes)
DROP POLICY IF EXISTS debriefs_insert ON public.debriefs;
DROP POLICY IF EXISTS debriefs_update ON public.debriefs;
DROP POLICY IF EXISTS debriefs_delete ON public.debriefs;
CREATE POLICY debriefs_insert ON public.debriefs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY debriefs_update ON public.debriefs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY debriefs_delete ON public.debriefs FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- session_attachments (weather decks)
DROP POLICY IF EXISTS session_attachments_insert ON public.session_attachments;
DROP POLICY IF EXISTS session_attachments_delete ON public.session_attachments;
CREATE POLICY session_attachments_insert ON public.session_attachments FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));
CREATE POLICY session_attachments_delete ON public.session_attachments FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl3','team_manager']));

-- sessions UPDATE — allow tl3 (objective / conditions / timings). INSERT stays
-- coach/tl1/tl2 so video/photo sync can still create a session.
DROP POLICY IF EXISTS sessions_update ON public.sessions;
CREATE POLICY sessions_update ON public.sessions FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id) OR public.has_team_role(team_id, ARRAY['tl3','team_manager']))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id) OR public.has_team_role(team_id, ARRAY['tl3','team_manager']));
