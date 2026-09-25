-- ============================================================================
-- SSA RigShot — 0090 rig models on boats, and the astern geometry measurement
--
--   • boats.rig_model    — the handful of dimensions that turn pixels into
--                          millimetres, with the provenance of each one. The
--                          `boats` table has carried no specs at all until now.
--   • rig_shots          — mast centreline → jib clew / jib leech at spreader 2
--                          / boom, measured off one astern frame, with the pose
--                          that produced them and every mark that was clicked.
--
-- WHY A SEPARATE TABLE FROM sail_scans. A sail scan is the SHAPE of one sail —
-- camber, draft, twist per stripe — and comes from a scan report or the boat's
-- own lidar. A rig shot is the POSITION of the sails relative to the boat, from
-- a photograph taken from another boat. Different source, different geometry,
-- different failure modes, and one row per PHOTO rather than per sail. They
-- join through photo_id and session_id where both exist.
--
-- NOT YET APPLIED. Written so that the day the rig designer's dimensions
-- arrive it is one `npm run db:push` away, and so the shape is on the record
-- while the definitions are still being settled. Additive and idempotent.
-- See docs/rig-geometry-from-astern-2026-09.md.
-- ============================================================================

-- ── boats.rig_model ──────────────────────────────────────────────────────────
-- Mirrors src/lib/rigModel.ts. Shape:
--   {
--     "scaleRefs": [ { "key":"spreader2", "label":"Spreader 2, tip to tip",
--                      "mm":6240, "sigmaMm":5, "source":"designer",
--                      "depthMm":0 }, … ],
--     "baselines": [ { "key":"bow-transom", "mm":20880, "sigmaMm":20,
--                      "source":"designer" }, … ],
--     "depths":    { "leech":{...}, "clew":{...}, "boom":{...} },
--     "sensorWidthMm": 36,
--     "notes": "2026 rig drawing, sheet 4"
--   }
--
-- `source` is part of the data on purpose: a measurement made against an
-- estimate must be able to say so, all the way through to the report.
ALTER TABLE public.boats
    ADD COLUMN IF NOT EXISTS rig_model JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.boats.rig_model IS
    'RigShot rig dimensions: athwartships scale references, centreplane baselines, '
    'fore-and-aft target offsets. Every value carries source = designer|measured|estimate.';

-- ── rig_shots ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rig_shots (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm RLS
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm RLS
    session_id         UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    run_id             UUID REFERENCES public.runs(id)     ON DELETE SET NULL,
    photo_id           UUID REFERENCES public.photos(id)   ON DELETE SET NULL,
    captured_at        TIMESTAMPTZ,

    -- The three numbers, both ways round. Which one the speed team means is a
    -- definition, not a fact, and the 6 Sept compilations say boat-frame — so
    -- both are stored and neither is thrown away.
    --   [{ "key":"leechSpr2", "boatFrameMm":1902, "boatFrameSigmaMm":31,
    --      "worldHorizontalMm":2066, "worldHorizontalSigmaMm":38,
    --      "naiveMm":1845, "depthMm":6000 }, …]
    measurements       JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- How the camera was standing when the shutter went, which is what makes
    -- the measurements comparable between frames:
    --   mm_per_px_at_mast, range_mm, psi_deg + sigma + measured,
    --   heel_deg (logged), image_heel_deg (from the horizon), mast_tilt_deg,
    --   horizon_tilt_deg + rms_px, horizontal_from
    pose               JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- The rig model AS IT WAS when this was measured. Copied, not referenced:
    -- a measurement must stay reproducible after someone corrects a dimension.
    rig_model          JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Every mark the operator placed, so a number can be reopened and argued
    -- with — and so these become the training labels for the detector.
    marks              JSONB NOT NULL DEFAULT '{}'::jsonb,
    checks             JSONB NOT NULL DEFAULT '[]'::jsonb,

    algorithm_version  TEXT,
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rig_shots_team_boat_idx ON public.rig_shots(team_id, boat_id, captured_at);
CREATE INDEX IF NOT EXISTS rig_shots_session_idx   ON public.rig_shots(session_id);
CREATE INDEX IF NOT EXISTS rig_shots_photo_idx     ON public.rig_shots(photo_id);

DROP TRIGGER IF EXISTS rig_shots_touch ON public.rig_shots;
CREATE TRIGGER rig_shots_touch BEFORE UPDATE ON public.rig_shots
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS, matching sail_scans exactly ─────────────────────────────────────────
-- Reads go through the analysis gate (0086) because a rig shot IS analysis;
-- writes through the same leadership set as sail scans (0037). Deliberately
-- copied rather than invented: a new table with its own idea of who may read
-- is how a gate ends up open on one route and shut on another.
ALTER TABLE public.rig_shots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rig_shots_select ON public.rig_shots;
CREATE POLICY rig_shots_select ON public.rig_shots FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_analysis_access(team_id, boat_id));

DROP POLICY IF EXISTS rig_shots_insert ON public.rig_shots;
CREATE POLICY rig_shots_insert ON public.rig_shots FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));

DROP POLICY IF EXISTS rig_shots_update ON public.rig_shots;
CREATE POLICY rig_shots_update ON public.rig_shots FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));

DROP POLICY IF EXISTS rig_shots_delete ON public.rig_shots;
CREATE POLICY rig_shots_delete ON public.rig_shots FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));

-- NOTE when this is applied: sail_scans also carries a SQUAD read route
-- (sail_scans_squad_select, 0086). Decide deliberately whether a rig shot of
-- your boat should reach a squad partner before adding the equivalent here —
-- policies OR together, so an open squad policy opens the whole gate.
