-- ============================================================================
-- SSA — 0101  wind_observations: our own history of other people's stations
--
-- WHY THIS EXISTS. The observation sources do not keep the same past. NDBC
-- holds 45 days, METAR serves any &hours=, Météo-France 24 h — but the two that
-- matter most keep NOTHING. A Davis club station and a Pioupiou beacon serve
-- "now" and only "now", and those are the ones actually on the water, where a
-- trimmer wants to see whether 12 kn has been steady for an hour or has climbed
-- six in forty minutes.
--
-- So we keep our own record. It also makes 24/12/6/1 h mean the same thing for
-- every source instead of "whatever that network happens to retain", and a
-- station that goes offline keeps its past instead of vanishing with it.
--
-- NOT A FORECAST AND NOT OUR BOATS. Every row here is somebody else's PUBLIC
-- station. No team's own log data is ever written to this table — see the
-- project's standing rule on that. There is deliberately no team_id, no
-- boat_id and no session_id: this is public weather, visible to every signed-in
-- user, and nothing in it is anyone's competitive material.
--
-- SHAPE. One row per (station, instant). `t` is the observation's OWN time, not
-- when we fetched it, so re-polling the same five-minute reading upserts rather
-- than duplicating — which is the whole reason for the primary key. A station
-- that reports every 5 minutes and is polled every 15 simply gives us every
-- third reading, and that is fine for a trace.
--
-- `station_id` is the id the adapters already mint (`ndbc:46088`,
-- `metar:EGHI`, `wle:<uuid>`, `piou:2217`), so nothing has to translate.
-- Position and name are denormalised onto every row on purpose: a buoy drifts,
-- a ship moves, and a club renames its station — the row should say where the
-- reading was taken, not where the station is today.
--
-- RETENTION is enforced by the poller, not by the database: it deletes beyond
-- the window after each run. At ~100 stations every 15 minutes this is about
-- 10k rows a day, so 90 days is a few hundred MB and nothing needs partitioning.
--
-- RLS: any signed-in user reads; only the service key writes (the poller runs
-- on the regatta box with the service key). Public weather is not per-team.
--
-- Additive, idempotent. Run after 0100.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wind_observations (
    station_id TEXT        NOT NULL,
    t          TIMESTAMPTZ NOT NULL,
    source     TEXT        NOT NULL,
    name       TEXT,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    tws_kn     REAL        NOT NULL,
    gust_kn    REAL,
    -- Degrees the wind is FROM, true. NULL is a real answer: calm, or a station
    -- reporting variable. Storing 0 for "unknown" would be a northerly nobody
    -- measured.
    twd_deg    REAL,
    -- Anemometer height where the network publishes it. Almost always NULL, and
    -- that is the honest value — a guessed height becomes a correction that
    -- looks like a measurement.
    height_m   REAL,
    surface    TEXT        NOT NULL DEFAULT 'land' CHECK (surface IN ('sea', 'land')),
    trust      SMALLINT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (station_id, t)
);

-- The only query shape the app has: one station, newest first, over a window.
CREATE INDEX IF NOT EXISTS wind_observations_station_t_idx
    ON public.wind_observations (station_id, t DESC);

-- For the retention sweep, and for "what did this venue see that afternoon".
CREATE INDEX IF NOT EXISTS wind_observations_t_idx
    ON public.wind_observations (t DESC);

ALTER TABLE public.wind_observations ENABLE ROW LEVEL SECURITY;

-- Read: anyone signed in. This is public weather — scoping it per team would
-- store the same buoy once per customer and answer no question anyone asks.
DROP POLICY IF EXISTS wind_observations_read ON public.wind_observations;
CREATE POLICY wind_observations_read ON public.wind_observations
    FOR SELECT TO authenticated
    USING (true);

-- Write: nobody through the API. The poller uses the service key, which bypasses
-- RLS; leaving no INSERT/UPDATE/DELETE policy means a leaked anon key cannot
-- forge a wind reading.
