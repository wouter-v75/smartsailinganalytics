-- ============================================================================
-- SSA — 1 km wind-weight FORECAST archive.
--
-- One row per (venue, valid-hour) capturing the forecast windweight index from
-- the self-hosted SSA-Race product (icon-race/<domain>/<venue>/windweight.json,
-- 1 km nest preferred, 2 km fallback) as published by the box. This is the
-- forecast on its OWN — independent of any boat/session — so we accumulate a
-- venue-by-venue, day-by-day record of the modelled rig-load index for later
-- analysis (forecast climatology, forecast-vs-observed skill, lead-time drift).
--
-- The joined calculated-vs-observed store lives in windweight_samples; this is
-- the pure forecast side, written whenever the app fetches a venue's product
-- (best-effort, idempotent per venue + valid-hour, latest cycle wins).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.windweight_forecast (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain       TEXT NOT NULL,                 -- e.g. la_ciotat_1km
  venue        TEXT NOT NULL,                 -- e.g. la_ciotat
  ts           TIMESTAMPTZ NOT NULL,          -- valid time of the hour (true UTC)
  cycle        TEXT,                          -- model run this value came from, e.g. 2026072200
  ww           DOUBLE PRECISION,              -- windweight index %  (100 = standard day)
  v_eff        DOUBLE PRECISION,              -- effective TWS (kt)
  v_h          DOUBLE PRECISION,              -- masthead TWS (kt)
  cls          TEXT,                          -- class label (Calm / Light / ...)
  factors      JSONB,                         -- {rho,profile,gust,funnel}
  inputs       JSONB,                         -- model sub-inputs
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, venue, ts)
);

CREATE INDEX IF NOT EXISTS windweight_forecast_venue_ts_idx
  ON public.windweight_forecast (domain, venue, ts);
CREATE INDEX IF NOT EXISTS windweight_forecast_ts_idx
  ON public.windweight_forecast (ts);

ALTER TABLE public.windweight_forecast ENABLE ROW LEVEL SECURITY;

-- Model forecast product, not team-private data: any signed-in user may read it,
-- and any signed-in user may contribute captures (the app writes the currently
-- published series it just fetched).
DROP POLICY IF EXISTS windweight_forecast_select ON public.windweight_forecast;
CREATE POLICY windweight_forecast_select ON public.windweight_forecast
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS windweight_forecast_insert ON public.windweight_forecast;
CREATE POLICY windweight_forecast_insert ON public.windweight_forecast
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS windweight_forecast_update ON public.windweight_forecast;
CREATE POLICY windweight_forecast_update ON public.windweight_forecast
  FOR UPDATE TO authenticated USING (true);
