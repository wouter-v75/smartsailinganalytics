-- ============================================================================
-- SSA Campaign Engine — 0024 speed-team-meeting notes + TL2 write gate
--
--   • debriefs gains three more text sections for the morning speed-team
--     meeting: speed_learnings, speed_focus_today, speed_long_term.
--   • Write access to debriefs (notes + documents) tightened to TL2 and above
--     (coach / tl2 / team_manager); admin bypasses. TL1 can read but not write.
--
-- Idempotent. Run after 0023.
-- ============================================================================

ALTER TABLE public.debriefs
    ADD COLUMN IF NOT EXISTS speed_learnings   TEXT,
    ADD COLUMN IF NOT EXISTS speed_focus_today TEXT,
    ADD COLUMN IF NOT EXISTS speed_long_term   TEXT;

-- Tighten write policies to TL2 and above.
DROP POLICY IF EXISTS debriefs_insert ON public.debriefs;
DROP POLICY IF EXISTS debriefs_update ON public.debriefs;
CREATE POLICY debriefs_insert ON public.debriefs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl2','team_manager']));
CREATE POLICY debriefs_update ON public.debriefs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl2','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl2','team_manager']));
