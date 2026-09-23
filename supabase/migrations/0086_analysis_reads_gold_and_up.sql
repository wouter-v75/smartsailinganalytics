-- Analysis reads are Sailor Gold and up, in the database and not only the UI.
--
-- The app has always hidden charts, polars and SailScan from Sailor Silver
-- (`canSeeAnalyticsData`, `canSeeSailScanTab` in src/lib/rolePermissions.js).
-- The DATABASE did not: every one of these tables answered `has_boat_access`,
-- which asks whether you hold a live membership covering the boat and nothing
-- about your role. So the rule existed only in the client, and anyone with a
-- session token could read the lot straight from PostgREST.
--
-- This closes that. Nobody's experience changes — the UI already behaved this
-- way — which is exactly why it was worth doing quietly rather than as a
-- feature.
--
-- WHAT IS GATED: the day's analysis. Phase stats, runs, datasets, manoeuvre
-- events, polars, sail scans.
--
-- WHAT IS NOT: the day itself. Sessions, video, photos, the GPS track, the
-- debrief and the sail inventory stay on `has_boat_access`, so a Sailor Silver
-- still sees their own sailing, their own clips and what the team said about
-- them. Gating those would make Silver a login that sees nothing, which is not a
-- role, it is a lockout.
--
-- WHO READS ANALYSIS: admin, team_manager, coach, tl3 (Sailor Gold) and
-- consultant. Consultant is included because they are brought in to look at
-- exactly this, and their access already ends by itself on a date.
-- Excluded: tl1 (Sailor Silver), owner, guest — the same three the UI hides it
-- from, so the two agree.

-- ── the gate, in one place ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_analysis_access(p_team_id UUID, p_boat_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT public.has_boat_access(p_team_id, p_boat_id)
       AND public.has_team_role(
               p_team_id,
               ARRAY['team_manager', 'coach', 'tl3', 'consultant']
           );
$$;

COMMENT ON FUNCTION public.has_analysis_access(UUID, UUID) IS
    'Boat access AND a role that may see the analysis: team_manager, coach, tl3 (Sailor Gold), consultant. Mirrors canSeeAnalyticsData / canSeeSailScanTab in the app.';

-- ── phase stats (the charts) ────────────────────────────────────────────────
-- Keeps the DATED variant: a consultant's window still bounds which days they
-- see, and that is a different question from which role may see analysis at all.
DROP POLICY IF EXISTS session_phase_stats_select ON public.session_phase_stats;
CREATE POLICY session_phase_stats_select ON public.session_phase_stats
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.has_boat_access_dated(team_id, boat_id, date)
            AND public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl3', 'consultant'])
        )
    );

-- ── runs, datasets, manoeuvre events ────────────────────────────────────────
DROP POLICY IF EXISTS runs_select ON public.runs;
CREATE POLICY runs_select ON public.runs
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_analysis_access(team_id, boat_id));

DROP POLICY IF EXISTS datasets_select ON public.datasets;
CREATE POLICY datasets_select ON public.datasets
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_analysis_access(team_id, boat_id));

DROP POLICY IF EXISTS manoeuvre_events_select ON public.manoeuvre_events;
CREATE POLICY manoeuvre_events_select ON public.manoeuvre_events
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_analysis_access(team_id, boat_id));

-- ── polars and sail scans ───────────────────────────────────────────────────
-- These two were created by a DO loop in 0035, not as literal CREATE POLICY
-- statements, which is why a text search of the migrations does not find them.
-- Replaced explicitly here so they can be read.
DROP POLICY IF EXISTS polars_select ON public.polars;
CREATE POLICY polars_select ON public.polars
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_analysis_access(team_id, boat_id));

DROP POLICY IF EXISTS sail_scans_select ON public.sail_scans;
CREATE POLICY sail_scans_select ON public.sail_scans
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_analysis_access(team_id, boat_id));

-- The squad route into sail scans needs the same gate, or a Sailor Silver could
-- see a squad partner's scans while being refused their own team's. Policies OR
-- together, so leaving this one open would have left the whole gate open.
DROP POLICY IF EXISTS sail_scans_squad_select ON public.sail_scans;
CREATE POLICY sail_scans_squad_select ON public.sail_scans
    FOR SELECT TO authenticated
    USING (
        session_id IS NOT NULL
        AND public.squad_shares(team_id, 'sailscans')
        AND public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl3', 'consultant'])
        AND EXISTS (
            SELECT 1 FROM public.sessions s
             WHERE s.id = sail_scans.session_id AND s.shared_with_squad
        )
    );

-- `sails` (the inventory) is deliberately left on has_boat_access. Knowing which
-- sails are aboard is not analysis, and a consultant sailmaker needs it.
