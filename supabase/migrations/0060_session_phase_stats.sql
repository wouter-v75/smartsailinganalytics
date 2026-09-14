-- ============================================================================
-- SSA — 0060  session_phase_stats: stored 30 s phase averages per session
--
-- Analytics → "Performance charts" averages every event-file phase (30 s) of a
-- session (src/lib/phaseStats.ts). Storing those averages per boat + date lets a
-- whole season be summarised without re-reading every session's log: the season
-- reference curves on the X-Y plots (the KND report's "upbsp-26" lines) are
-- medians over these rows (src/lib/seasonCurves.ts).
--
-- Derived data. Recomputed from sessions.log_data + xml_data whenever
-- stats_version (the maths) or polar_id (the boat's active polar) changes, so a
-- row can always be rebuilt and nothing here is a source of truth.
--
-- Access follows sessions: read = boat access on the session's date (date-ranged
-- consultants included); write = the roles that may write a session, and only for
-- dates they can read.
--
-- Additive, idempotent. Run after 0059.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.session_phase_stats (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id             UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id             UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    session_id          UUID REFERENCES public.sessions(id) ON DELETE CASCADE,
    date                DATE NOT NULL,
    season              SMALLINT GENERATED ALWAYS AS (EXTRACT(YEAR FROM date)::SMALLINT) STORED,
    stats_version       SMALLINT NOT NULL,
    polar_id            UUID REFERENCES public.polars(id) ON DELETE SET NULL,
    polar_name          TEXT,
    log_rows            INTEGER,
    phase_count         INTEGER NOT NULL DEFAULT 0,
    phases              JSONB NOT NULL DEFAULT '[]'::jsonb,
    computed_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (boat_id, date)
);

CREATE INDEX IF NOT EXISTS session_phase_stats_season_idx
    ON public.session_phase_stats(team_id, boat_id, season);

ALTER TABLE public.session_phase_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_phase_stats_select ON public.session_phase_stats;
CREATE POLICY session_phase_stats_select ON public.session_phase_stats
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, date));

DROP POLICY IF EXISTS session_phase_stats_insert ON public.session_phase_stats;
CREATE POLICY session_phase_stats_insert ON public.session_phase_stats
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    );

DROP POLICY IF EXISTS session_phase_stats_update ON public.session_phase_stats;
CREATE POLICY session_phase_stats_update ON public.session_phase_stats
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    )
    WITH CHECK (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    );

DROP POLICY IF EXISTS session_phase_stats_delete ON public.session_phase_stats;
CREATE POLICY session_phase_stats_delete ON public.session_phase_stats
    FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']));
