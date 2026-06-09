-- 0034 — Wind-model verification & calibration (skill score).
--
-- Stores: regatta venues, conditioned on-water wind observations (10-min bins),
-- model forecasts interpolated to mast height, matched pairs, per-venue/model
-- skill scores (speed & direction scored SEPARATELY), and learned adjustment
-- factors (incl. an hour-of-day/diurnal term for sea-breeze under-forecast).
--
-- MVP: single boat, but every obs row carries boat_id so more yachts can be
-- added without schema change. No PostGIS dependency — lat/lon are plain
-- columns (add geography later if we want spatial queries).
--
-- Access model: these tables are admin/service-role only. RLS is ENABLED with
-- NO policies, so the anon/auth keys can't read or write them; the admin pages
-- and pipeline use the service-role client (same pattern as the audit log).
--
-- Idempotent.

-- ── reference / method versioning ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wv_method_version (
    id            serial PRIMARY KEY,
    description   text NOT NULL,
    params        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wv_venue (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    lat           double precision,           -- representative centre
    lon           double precision,
    bbox          jsonb,                       -- {minLat,minLon,maxLat,maxLon}
    z0            double precision DEFAULT 0.0002,  -- sea roughness (m)
    tidal         boolean NOT NULL DEFAULT false,
    notes         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── bulk-upload tracking ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wv_batch (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id      uuid REFERENCES public.wv_venue(id) ON DELETE CASCADE,
    uploaded_by   uuid,                        -- users.id (soft ref)
    n_logs        integer NOT NULL DEFAULT 0,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── conditioned observations (10-min bins) ──────────────────────────────────
-- boat_id is a soft reference to public.boats(id); kept nullable so the MVP
-- can run with one boat and add the FK later once boat linkage is confirmed.
CREATE TABLE IF NOT EXISTS public.wv_obs_bin (
    id              bigserial PRIMARY KEY,
    venue_id        uuid REFERENCES public.wv_venue(id) ON DELETE CASCADE,
    boat_id         uuid,                      -- → public.boats.id
    batch_id        uuid REFERENCES public.wv_batch(id) ON DELETE SET NULL,
    t_start         timestamptz NOT NULL,
    t_end           timestamptz NOT NULL,
    local_hour      smallint,                  -- 0–23 local solar hour (diurnal key)
    lat             double precision,
    lon             double precision,
    mast_height_m   double precision,
    mean_heel_deg   double precision,
    z_eff_m         double precision,          -- mast_height * cos(heel)
    ref_frame       text CHECK (ref_frame IN ('ground', 'water')) DEFAULT 'ground',
    tws             double precision,          -- true wind speed (kt), masthead
    twd             double precision,          -- true wind direction (deg)
    gust            double precision,
    n_samples       integer,
    qc_flags        jsonb DEFAULT '{}'::jsonb,
    src_log_id      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wv_obs_bin_venue_time_idx
    ON public.wv_obs_bin (venue_id, t_start);

-- ── forecasts interpolated to mast height ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wv_forecast (
    id              bigserial PRIMARY KEY,
    venue_id        uuid REFERENCES public.wv_venue(id) ON DELETE CASCADE,
    obs_bin_id      bigint REFERENCES public.wv_obs_bin(id) ON DELETE CASCADE,
    model           text NOT NULL,             -- AROME | ECMWF | ICON | GFS | DMI | ...
    init_time       timestamptz,
    valid_time      timestamptz NOT NULL,
    lead_h          double precision,
    lat             double precision,
    lon             double precision,
    ws_levels       jsonb,                     -- { "10": .., "20": .., "50": .. }
    wd_levels       jsonb,
    ws_mast         double precision,          -- interpolated to mast height (kt)
    wd_mast         double precision,
    alpha           double precision,          -- fitted shear exponent (diagnostic)
    interp_method   text,                      -- 'powerlaw_lsq' | 'powerlaw_2pt' | ...
    confidence      text,                      -- 'high' | 'fair' | 'low'
    source_api      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wv_forecast_obs_model_idx
    ON public.wv_forecast (obs_bin_id, model);

-- ── matched obs↔forecast errors ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wv_match (
    id              bigserial PRIMARY KEY,
    obs_bin_id      bigint REFERENCES public.wv_obs_bin(id) ON DELETE CASCADE,
    forecast_id     bigint REFERENCES public.wv_forecast(id) ON DELETE CASCADE,
    model           text NOT NULL,
    lead_h          double precision,
    spd_err         double precision,          -- fcst − obs (kt)
    dir_err         double precision,          -- wrapped to ±180°
    u_err           double precision,
    v_err           double precision,
    vec_err         double precision
);
CREATE INDEX IF NOT EXISTS wv_match_model_idx ON public.wv_match (model);

-- ── per venue/model SCORES (speed & direction kept separate) ─────────────────
CREATE TABLE IF NOT EXISTS public.wv_model_score (
    id              bigserial PRIMARY KEY,
    venue_id        uuid REFERENCES public.wv_venue(id) ON DELETE CASCADE,
    model           text NOT NULL,
    lead_bin        text,                      -- 'short' | 'day1' | 'day2' | ...
    regime          text,                      -- 'gradient' | 'seabreeze' | 'all'
    n               integer,
    -- speed
    bias_spd        double precision,
    mae_spd         double precision,
    rmse_spd        double precision,
    si              double precision,          -- scatter index
    skill_spd       double precision,          -- vs multi-model mean
    rating_spd      double precision,          -- 0–100
    ci_spd_low      double precision,
    ci_spd_high     double precision,
    -- direction
    bias_dir        double precision,
    mae_dir         double precision,
    p_dir10         double precision,          -- P(|Δdir| ≤ 10°)
    p_dir20         double precision,
    skill_dir       double precision,
    rating_dir      double precision,
    ci_dir_low      double precision,
    ci_dir_high     double precision,
    confidence      text,                      -- vertical-resolution confidence
    method_version  integer REFERENCES public.wv_method_version(id),
    computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wv_model_score_venue_model_idx
    ON public.wv_model_score (venue_id, model, lead_bin);

-- ── learned ADJUSTMENT factors (MOS), incl. hour-of-day/diurnal term ─────────
CREATE TABLE IF NOT EXISTS public.wv_model_adjustment (
    id              bigserial PRIMARY KEY,
    venue_id        uuid REFERENCES public.wv_venue(id) ON DELETE CASCADE,
    model           text NOT NULL,
    target          text NOT NULL CHECK (target IN ('TWS', 'TWD')),
    method          text,                      -- 'mean_bias' | 'linear' | 'quantile' | ...
    scope           text,                      -- 'global' | 'by_hour' | 'by_sector' | 'by_speedbin'
    local_hour      smallint,                  -- diurnal term (NULL = all hours)
    sector          smallint,                  -- direction sector index (NULL = all)
    speed_bin       text,                      -- 'light'|'medium'|'strong' (NULL = all)
    lead_bin        text,
    coef            jsonb NOT NULL,            -- {a,b} | bin factors | quantile map
    n               integer,
    cv_rmse_raw     double precision,          -- out-of-sample, before adjustment
    cv_rmse_adj     double precision,          -- out-of-sample, after adjustment
    skill_gain      double precision,          -- (raw − adj) / raw
    valid_from      timestamptz,
    method_version  integer REFERENCES public.wv_method_version(id),
    computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wv_model_adjustment_lookup_idx
    ON public.wv_model_adjustment (venue_id, model, target, local_hour);

-- ── lock everything down (admin/service-role only) ───────────────────────────
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'wv_method_version','wv_venue','wv_batch','wv_obs_bin',
        'wv_forecast','wv_match','wv_model_score','wv_model_adjustment'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    END LOOP;
END $$;
-- No policies created on purpose: anon/auth keys are denied; the admin pages
-- and the verification pipeline use the service-role client.
