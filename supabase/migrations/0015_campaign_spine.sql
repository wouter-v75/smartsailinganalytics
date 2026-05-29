-- ============================================================================
-- SSA Campaign Engine — 0015 session/run spine
--
-- The session-centric spine: a day's `session` extended with conditions +
-- objective; the test `run` as the unit of work; a per-run `config` (setup
-- log); and `datasets` as the SINGLE surface the external analysis engine
-- reads/writes. Clips gain a run_id so footage hangs off the run.
--
-- These tables are global (additive) but only surfaced for teams whose
-- features.campaign_engine = true (NORTHSTAR). Other teams never see them.
--
-- RLS matches 0003. Idempotent. Run after 0014.
-- ============================================================================

-- ── sessions — EXTEND (no new table) ─────────────────────────────────────────
ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS conditions JSONB,   -- wind range/dir, sea, current, tide
    ADD COLUMN IF NOT EXISTS objective  TEXT;     -- the day's test plan / intent

-- ── runs — the unit of test ──────────────────────────────────────────────────
-- start_utc/end_utc window INTO sessions.log_data (we slice, never copy).
-- backlog_item_id is a plain UUID here; the FK to backlog_items is added in
-- 0016 once that table exists (avoids a cross-migration circular dependency).
CREATE TABLE IF NOT EXISTS public.runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm RLS
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm RLS
    seq                INTEGER,
    label              TEXT,
    mode               TEXT
                       CHECK (mode IS NULL OR mode IN
                              ('upwind','reach','downwind','start','manoeuvre','transit')),
    start_utc          TIMESTAMPTZ,
    end_utc            TIMESTAMPTZ,
    objective          TEXT,
    backlog_item_id    UUID,                       -- FK added in 0016
    conditions         JSONB,
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_session_idx   ON public.runs(session_id, seq);
CREATE INDEX IF NOT EXISTS runs_team_boat_idx ON public.runs(team_id, boat_id);

-- ── configs — per-run setup log (1:1 with run) ───────────────────────────────
-- The handful of typed columns are the ones trended across sessions; the rest
-- lives in `settings` JSONB (same philosophy as mast_settings).
CREATE TABLE IF NOT EXISTS public.configs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    sail_config        TEXT,        -- headline combo, e.g. "Full main + J2 + staysail"
    keel_cant_deg      NUMERIC,     -- canting-keel angle (programme-specific, trended)
    rudder_toe_deg     NUMERIC,     -- twin-rudder toe (programme-specific, trended)
    rake_mm            NUMERIC,
    forestay_mm        NUMERIC,
    settings           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- tensions, ballast, deflectors…
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS configs_team_boat_idx ON public.configs(team_id, boat_id);

-- ── datasets — computed summaries + the analysis-engine boundary ─────────────
-- run_id nullable (may be session-level). Raw log rows are NOT copied here;
-- a dataset stores the window pointer + computed result.
CREATE TABLE IF NOT EXISTS public.datasets (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             UUID REFERENCES public.runs(id) ON DELETE CASCADE,
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    kind               TEXT NOT NULL,   -- run-summary | polar-observed | mode-map | flying-shape | vpp-correlation
    window_start_utc   TIMESTAMPTZ,
    window_end_utc     TIMESTAMPTZ,
    source             TEXT NOT NULL DEFAULT 'ssa-auto'
                       CHECK (source IN ('ssa-auto', 'analysis-engine')),
    metrics            JSONB,           -- headline numbers
    payload            JSONB,           -- richer analysis output
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS datasets_run_idx       ON public.datasets(run_id);
CREATE INDEX IF NOT EXISTS datasets_session_idx   ON public.datasets(session_id, kind);
CREATE INDEX IF NOT EXISTS datasets_team_boat_idx ON public.datasets(team_id, boat_id);

-- ── videos.run_id — attach a clip to its run ─────────────────────────────────
ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES public.runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS videos_run_idx ON public.videos(run_id);

-- ── updated_at triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS runs_touch ON public.runs;
CREATE TRIGGER runs_touch BEFORE UPDATE ON public.runs
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS configs_touch ON public.configs;
CREATE TRIGGER configs_touch BEFORE UPDATE ON public.configs
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS datasets_touch ON public.datasets;
CREATE TRIGGER datasets_touch BEFORE UPDATE ON public.datasets
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.datasets ENABLE ROW LEVEL SECURITY;

-- runs
DROP POLICY IF EXISTS runs_select ON public.runs;
DROP POLICY IF EXISTS runs_insert ON public.runs;
DROP POLICY IF EXISTS runs_update ON public.runs;
DROP POLICY IF EXISTS runs_delete ON public.runs;
CREATE POLICY runs_select ON public.runs FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY runs_insert ON public.runs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY runs_update ON public.runs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));
CREATE POLICY runs_delete ON public.runs FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- configs
DROP POLICY IF EXISTS configs_select ON public.configs;
DROP POLICY IF EXISTS configs_insert ON public.configs;
DROP POLICY IF EXISTS configs_update ON public.configs;
DROP POLICY IF EXISTS configs_delete ON public.configs;
CREATE POLICY configs_select ON public.configs FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY configs_insert ON public.configs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY configs_update ON public.configs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));
CREATE POLICY configs_delete ON public.configs FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- datasets — the analysis engine writes here (as an authed coach/admin via the
-- /api/datasets endpoint, or a service role that bypasses RLS).
DROP POLICY IF EXISTS datasets_select ON public.datasets;
DROP POLICY IF EXISTS datasets_insert ON public.datasets;
DROP POLICY IF EXISTS datasets_update ON public.datasets;
DROP POLICY IF EXISTS datasets_delete ON public.datasets;
CREATE POLICY datasets_select ON public.datasets FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY datasets_insert ON public.datasets FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY datasets_update ON public.datasets FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));
CREATE POLICY datasets_delete ON public.datasets FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.runs     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.configs  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.datasets TO authenticated;
REVOKE ALL ON public.runs     FROM anon;
REVOKE ALL ON public.configs  FROM anon;
REVOKE ALL ON public.datasets FROM anon;
