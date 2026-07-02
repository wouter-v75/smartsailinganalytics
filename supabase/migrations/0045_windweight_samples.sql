-- ============================================================================
-- SSA — windweight MOS store.
--
-- One row per (session, time-bin) joining the FORECAST windweight (from the box
-- ICON product, interpolated to the boat's position/time) with the OBSERVED
-- windweight (computed on the client from on-board masthead TWS + air-T + SST +
-- RH via the bulk MOST route) and the boat's HEEL RESIDUAL (heel − targHeel,
-- upwind) — the label we regress windweight against. This is the conditions↔
-- outcome join that lets us (a) verify/calibrate the forecast index and (b) run
-- MOS: WW vs Δheel, and forecast-WW vs observed-WW at constant TWS.
--
-- Read-only analysis table; write via the app when a log is processed.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.windweight_samples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  ts            TIMESTAMPTZ NOT NULL,           -- time-bin centre (true UTC)
  session_date  DATE,                           -- for the consultant date-window RLS

  -- observed (on-board) --------------------------------------------------------
  obs_tws_kt    DOUBLE PRECISION,               -- masthead TWS
  obs_air_t     DOUBLE PRECISION,               -- °C
  obs_sea_t     DOUBLE PRECISION,               -- °C (SST)
  obs_rh        DOUBLE PRECISION,               -- 0..1
  obs_baro      DOUBLE PRECISION,               -- hPa
  obs_ww        DOUBLE PRECISION,               -- observed windweight %
  obs_veff      DOUBLE PRECISION,               -- effective TWS (kt)
  obs_factors   JSONB,                          -- {rho,profile,gust,funnel}
  obs_inputs    JSONB,                          -- {ustar,L,z0,rho,TI,dT}

  -- forecast (box ICON product at boat position/time) --------------------------
  fc_ww         DOUBLE PRECISION,
  fc_veff       DOUBLE PRECISION,
  fc_cls        TEXT,
  fc_factors    JSONB,
  fc_inputs     JSONB,
  fc_cycle      TEXT,                            -- e.g. 2026070200
  fc_venue      TEXT,

  -- label + context ------------------------------------------------------------
  twa           DOUBLE PRECISION,
  heel          DOUBLE PRECISION,
  targ_heel     DOUBLE PRECISION,
  d_heel        DOUBLE PRECISION,                -- heel − targHeel (the MOS label)
  upwind        BOOLEAN DEFAULT FALSE,
  n_samples     INTEGER,                         -- rows averaged into this bin

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one sample per boat per hour (session_id may be null for local-only sessions,
  -- so we key on boat_id+ts, which upsert can dedupe on).
  UNIQUE (boat_id, ts)
);

CREATE INDEX IF NOT EXISTS windweight_samples_team_boat_idx
  ON public.windweight_samples (team_id, boat_id, ts);
CREATE INDEX IF NOT EXISTS windweight_samples_session_idx
  ON public.windweight_samples (session_id);

ALTER TABLE public.windweight_samples ENABLE ROW LEVEL SECURITY;

-- SELECT: same boat-access + consultant date-window gate as session media.
DROP POLICY IF EXISTS windweight_samples_select ON public.windweight_samples;
CREATE POLICY windweight_samples_select ON public.windweight_samples
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, session_date));

-- INSERT/UPDATE: team members who can write (tl1/tl2 gate covers the crew).
DROP POLICY IF EXISTS windweight_samples_write ON public.windweight_samples;
CREATE POLICY windweight_samples_write ON public.windweight_samples
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl2']));
DROP POLICY IF EXISTS windweight_samples_update ON public.windweight_samples;
CREATE POLICY windweight_samples_update ON public.windweight_samples
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl2']));
