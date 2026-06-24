-- ============================================================================
-- SSA Boat Config — 0035 sails inventory, polars, structured sail scans
--
-- Adds the reference + capture entities the campaign spine was missing:
--   sails       — the boat's sail inventory (each physical sail + crossover)
--   polars      — target speed/VMG reference (design now, measured later)
--   sail_scans  — STRUCTURED trim-stripe shape per sail × conditions × time
--                 (camber/draft/twist/entry/exit/fore/back), source-tagged
--   configs.sail_ids — link each run's setup to the sails that were up
--
-- This is the boat-config foundation: every performance record now links to a
-- normalised sail and can be compared to a polar. Additive, idempotent, RLS
-- matches 0003/0015. Run after 0034.
-- ============================================================================

-- ── sails — the boat's inventory ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sails (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm RLS
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm RLS
    name               TEXT NOT NULL,              -- physical sail, e.g. "J2 #1 (2026)"
    kind               TEXT CHECK (kind IS NULL OR kind IN
                         ('mainsail','jib','genoa','staysail','spinnaker','gennaker','code','other')),
    category           TEXT,                       -- crossover label: J1/J1.5/J2/J3/A2/…
    sailmaker          TEXT,                       -- e.g. "North Sails"
    design_code        TEXT,                       -- maker design/string id
    in_service_date    DATE,
    retired            BOOLEAN NOT NULL DEFAULT false,
    -- crossover window (the sail chart), used to auto-suggest sail per condition
    tws_min_kn         NUMERIC,
    tws_max_kn         NUMERIC,
    twa_min_deg        NUMERIC,
    twa_max_deg        NUMERIC,
    specs              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- area, luff/leech/foot, cloth, batten map…
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sails_team_boat_idx ON public.sails(team_id, boat_id);
CREATE INDEX IF NOT EXISTS sails_active_idx    ON public.sails(boat_id, retired);

-- ── polars — target speed reference ──────────────────────────────────────────
-- `data` holds the grid as JSONB: { "tws": [6,8,10,...],
--   "twa": [40,52,60,...], "bsp": [[...]], "vmg_up": {...}, "vmg_dn": {...} }.
-- One active polar per boat (is_active); older ones kept for history.
CREATE TABLE IF NOT EXISTS public.polars (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,              -- "Design VPP v1", "Measured 2026-Q3"
    source             TEXT CHECK (source IS NULL OR source IN
                         ('design_vpp','measured','sailmaker','blend','other')),
    is_active          BOOLEAN NOT NULL DEFAULT false,
    valid_from         DATE,
    data               JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polars_team_boat_idx ON public.polars(team_id, boat_id);
-- at most one active polar per boat
CREATE UNIQUE INDEX IF NOT EXISTS polars_one_active_idx
    ON public.polars(boat_id) WHERE is_active;

-- ── sail_scans — STRUCTURED trim-stripe shape ────────────────────────────────
-- The crown-jewel capture: sail shape linked to the sail, the session/run, and
-- the conditions, over time. `stripes` is an array of per-stripe metrics:
--   [{ "pos":75, "camber":13.7, "draft":41.3, "twist":..,
--      "entry":33, "exit":-21, "fore":81.1, "back":71.5 }, ...]
-- pos = height % (25 head / 50 mid / 75 foot, North convention).
CREATE TABLE IF NOT EXISTS public.sail_scans (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    sail_id            UUID REFERENCES public.sails(id) ON DELETE SET NULL,
    session_id         UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    run_id             UUID REFERENCES public.runs(id) ON DELETE SET NULL,
    photo_id           UUID REFERENCES public.photos(id) ON DELETE SET NULL,  -- the still
    captured_at        TIMESTAMPTZ,
    source             TEXT CHECK (source IS NULL OR source IN
                         ('north','thesailcloud','ssa','manual','other')),
    tws_kn             NUMERIC,
    twa_deg            NUMERIC,
    conditions         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- forestay/backstay/sheet at scan…
    stripes            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- per-stripe metrics array
    summary            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- rolled-up (max camber, mean twist…)
    report_ref         TEXT,                        -- source filename / external id
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sail_scans_team_boat_idx ON public.sail_scans(team_id, boat_id);
CREATE INDEX IF NOT EXISTS sail_scans_sail_idx      ON public.sail_scans(sail_id, captured_at);
CREATE INDEX IF NOT EXISTS sail_scans_session_idx   ON public.sail_scans(session_id);

-- ── configs — link the run's setup to the sails that were up ─────────────────
ALTER TABLE public.configs
    ADD COLUMN IF NOT EXISTS sail_ids UUID[] NOT NULL DEFAULT '{}';

-- ── touch_updated_at triggers ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS sails_touch ON public.sails;
CREATE TRIGGER sails_touch BEFORE UPDATE ON public.sails
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS polars_touch ON public.polars;
CREATE TRIGGER polars_touch BEFORE UPDATE ON public.polars
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS sail_scans_touch ON public.sail_scans;
CREATE TRIGGER sail_scans_touch BEFORE UPDATE ON public.sail_scans
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS (matches 0015: read = boat access; write = coach/tl1/tl2; edit = own_or_coach) ──
ALTER TABLE public.sails      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.polars     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sail_scans ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sails','polars','sail_scans'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON public.%1$s;', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON public.%1$s;', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON public.%1$s;', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON public.%1$s;', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON public.%1$s FOR SELECT TO authenticated
        USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_insert ON public.%1$s FOR INSERT TO authenticated
        WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_update ON public.%1$s FOR UPDATE TO authenticated
        USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
        WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_delete ON public.%1$s FOR DELETE TO authenticated
        USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));$p$, t);
  END LOOP;
END $$;
