-- ============================================================================
-- SSA — 0069  Phases SSA builds itself: per-boat thresholds + uploaded sets
--
-- Until now a session's phases came only from the KND event file (30 s blocks in
-- <phase> tags). SSA can now cut its own phases from the log — a selected stretch
-- of the track, or a timed test — and this migration is where that work becomes
-- team data instead of one laptop's.
--
-- Two additions:
--
--   boat_phase_settings    the thresholds a phase has to meet on THIS boat. Every
--                          serious tool keeps these per boat: a 37 m maxi and a
--                          sportsboat do not hold the same angles, and the numbers
--                          are the whole difference between a clean reference
--                          dataset and a polluted one. No row = the app's defaults.
--                          Its own table rather than a column on boats: tuning the
--                          gate is a COACH's job, while boats itself may only be
--                          edited by a team manager, and RLS cannot gate one column.
--
--   session_phases         uploaded phase sets, versioned, one active per boat and
--                          date. Deliberately NOT in session_phase_stats: that row
--                          is derived and gets rebuilt whenever the maths version or
--                          the boat's polar changes, and hand-curated work must never
--                          live somewhere that is routinely recomputed.
--
-- The event file's phases are never touched. A set records how it was resolved
-- against them ('add' = the event file stands where they overlap, 'override' = the
-- built phases win in their own ranges) so the decision can be explained or undone —
-- the merged result is not stored, only the two sides and the choice.
--
-- Access: reading follows the session's date like every other per-day table. WRITING
-- IS COACH AND UP (coach / team_manager / admin), one step above the TL2 who may
-- build phases locally: uploading changes what the rest of the team sees and what
-- later work is measured against.
--
-- Additive, idempotent. Run after 0068.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.boat_phase_settings (
    boat_id             UUID PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
    team_id             UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    settings            JSONB NOT NULL,
    updated_by_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.boat_phase_settings IS
    'Per-boat phase builder thresholds (src/lib/phaseSettings.ts). No row = app defaults.';

ALTER TABLE public.boat_phase_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS boat_phase_settings_select ON public.boat_phase_settings;
CREATE POLICY boat_phase_settings_select ON public.boat_phase_settings
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

DROP POLICY IF EXISTS boat_phase_settings_write ON public.boat_phase_settings;
CREATE POLICY boat_phase_settings_write ON public.boat_phase_settings
    FOR ALL TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'team_manager']));

CREATE TABLE IF NOT EXISTS public.session_phases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id             UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id             UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    session_id          UUID REFERENCES public.sessions(id) ON DELETE CASCADE,
    date                DATE NOT NULL,
    season              SMALLINT GENERATED ALWAYS AS (EXTRACT(YEAR FROM date)::SMALLINT) STORED,
    -- 'ssa' today; the column exists so an import from another tool is not a schema change.
    source              TEXT NOT NULL DEFAULT 'ssa',
    phase_len_s         REAL NOT NULL,
    settings            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- what built them
    runs                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- the named line-ups / tests
    phases              JSONB NOT NULL DEFAULT '[]'::jsonb,   -- the phases themselves
    phase_count         INTEGER NOT NULL DEFAULT 0,
    -- How this set sits with the event file's phases, and what that choice dropped.
    resolution_mode     TEXT CHECK (resolution_mode IN ('add', 'override')),
    resolution          JSONB,
    note                TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active set per boat and day; older uploads stay for history, as polars do.
CREATE UNIQUE INDEX IF NOT EXISTS session_phases_one_active_idx
    ON public.session_phases(boat_id, date) WHERE is_active;

CREATE INDEX IF NOT EXISTS session_phases_season_idx
    ON public.session_phases(team_id, boat_id, season);

ALTER TABLE public.session_phases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_phases_select ON public.session_phases;
CREATE POLICY session_phases_select ON public.session_phases
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, date));

DROP POLICY IF EXISTS session_phases_insert ON public.session_phases;
CREATE POLICY session_phases_insert ON public.session_phases
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'team_manager'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    );

DROP POLICY IF EXISTS session_phases_update ON public.session_phases;
CREATE POLICY session_phases_update ON public.session_phases
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'team_manager'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    )
    WITH CHECK (
        public.is_admin()
        OR (public.has_team_role(team_id, ARRAY['coach', 'team_manager'])
            AND public.has_boat_access_dated(team_id, boat_id, date))
    );

DROP POLICY IF EXISTS session_phases_delete ON public.session_phases;
CREATE POLICY session_phases_delete ON public.session_phases
    FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'team_manager']));
