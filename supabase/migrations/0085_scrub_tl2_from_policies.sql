-- Scrub the last mentions of tl2 from live policy bodies.
--
-- 0083 rewrote the 13 policies that granted tl2 WITHOUT tl3, because those would
-- have taken rights away from promoted users. These 12 grant both, so they kept
-- working the moment every tl2 became a tl3 — functionally there was nothing to
-- fix.
--
-- They are cleaned up anyway. A live policy naming a role that cannot exist is
-- dead text that reads as fact: the next person to copy one of these lists as a
-- template propagates a role the CHECK constraint rejects, and the one after that
-- wonders whether tl2 means something. That is the same drift that let tl3 ship
-- in 0025 and stay out of the upload policies until 0080.
--
-- No behaviour change: every role that could reach these tables before still can.
-- (0084 was this migration with its body lost to a shell mishap; it applied as
-- comments only. This is the one that does the work.)

-- public.session_phase_stats.session_phase_stats_insert  (was last set in 0060_session_phase_stats.sql)
DROP POLICY IF EXISTS session_phase_stats_insert ON public.session_phase_stats;
CREATE POLICY session_phase_stats_insert ON public.session_phase_stats
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl3', 'team_manager', 'consultant'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    );;

-- public.session_phase_stats.session_phase_stats_update  (was last set in 0060_session_phase_stats.sql)
DROP POLICY IF EXISTS session_phase_stats_update ON public.session_phase_stats;
CREATE POLICY session_phase_stats_update ON public.session_phase_stats
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl3', 'team_manager', 'consultant'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    )
    WITH CHECK (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl3', 'team_manager', 'consultant'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    );;

-- public.squad_comments.squad_comments_insert  (was last set in 0074_squad_categories.sql)
DROP POLICY IF EXISTS squad_comments_insert ON public.squad_comments;
CREATE POLICY squad_comments_insert ON public.squad_comments
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_team_role(author_team_id,
          ARRAY['coach','tl1','tl3','team_manager','owner'])
        AND (
            public.has_team_role(owner_team_id, ARRAY['coach','tl1','tl3','team_manager','owner'])
            OR public.squad_shares(owner_team_id, 'comments')
        )
    );;

-- public.squad_comments.squad_comments_select  (was last set in 0074_squad_categories.sql)
DROP POLICY IF EXISTS squad_comments_select ON public.squad_comments;
CREATE POLICY squad_comments_select ON public.squad_comments
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(owner_team_id,
             ARRAY['coach','tl1','tl3','team_manager','owner','consultant'])
        OR public.squad_shares(owner_team_id, 'comments')
    );;

-- public.ssa_tag_events.ssa_tag_events_delete  (was last set in 0062_ssa_tagger.sql)
DROP POLICY IF EXISTS ssa_tag_events_delete ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_delete ON public.ssa_tag_events
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal'
            AND (created_by_user_id = auth.uid()
                 OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                 OR (scope = 'section'
                     AND public.has_team_role(team_id, ARRAY['coach', 'tl1', 'consultant'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );;

-- public.ssa_tag_events.ssa_tag_events_insert  (was last set in 0062_ssa_tagger.sql)
DROP POLICY IF EXISTS ssa_tag_events_insert ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_insert ON public.ssa_tag_events
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (scope = 'personal'
            AND owner_user_id = auth.uid()
            AND public.has_boat_access(team_id, boat_id))
        OR (scope = 'general'
            AND public.has_team_role(team_id, ARRAY['coach', 'tl1', 'consultant']))
        OR (scope = 'section'
            AND (public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                 OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'consultant'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );;

-- public.ssa_tag_events.ssa_tag_events_update  (was last set in 0062_ssa_tagger.sql)
DROP POLICY IF EXISTS ssa_tag_events_update ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_update ON public.ssa_tag_events
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal'
            AND (created_by_user_id = auth.uid()
                 OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                 OR (scope = 'section'
                     AND public.has_team_role(team_id, ARRAY['coach', 'tl1', 'consultant'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );;

-- public.trackers.trackers_select  (was last set in 0070_trackers_and_training_days.sql)
DROP POLICY IF EXISTS trackers_select ON public.trackers;
CREATE POLICY trackers_select ON public.trackers
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager','owner','consultant']));;

-- public.training_days.training_days_select  (was last set in 0070_trackers_and_training_days.sql)
DROP POLICY IF EXISTS training_days_select ON public.training_days;
CREATE POLICY training_days_select ON public.training_days
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl3','team_manager','owner','consultant']));;

-- public.video_shares.video_shares_delete  (was last set in 0058_owner_role_and_tl2_share.sql)
DROP POLICY IF EXISTS video_shares_delete ON public.video_shares;
CREATE POLICY video_shares_delete ON public.video_shares
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'owner', 'team_manager'])
    );;

-- public.video_shares.video_shares_insert  (was last set in 0058_owner_role_and_tl2_share.sql)
DROP POLICY IF EXISTS video_shares_insert ON public.video_shares;
CREATE POLICY video_shares_insert ON public.video_shares
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'owner', 'team_manager'])
    );;

-- public.video_shares.video_shares_update  (was last set in 0058_owner_role_and_tl2_share.sql)
DROP POLICY IF EXISTS video_shares_update ON public.video_shares;
CREATE POLICY video_shares_update ON public.video_shares
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'owner', 'team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR auth.uid() = created_by_user_id
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'owner', 'team_manager'])
    );;
