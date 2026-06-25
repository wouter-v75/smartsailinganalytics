-- ============================================================================
-- SSA Boat Config — 0039 rig_tunes (rig tuning baseline per boat, dated)
--
-- Stores the boat's rig tuning sheet (e.g. the JV76 "Sailing Info Summary")
-- parsed into per-sail-combination settings. Boat-level + dated: each upload is
-- `effective_date`-stamped (defaults to today) so a sailing session can later be
-- matched to the rig baseline that was current on that day. One active baseline
-- per boat (mirrors polars). Write gated to the TL3+ leadership set.
--
-- `data` JSONB shape (from src/lib/rigTuneParse.ts → parseRigTune):
--   { revision, sheetDate, columns: [ { section, mainsail, headsail, twsAtMh,
--       rakeDeg, mastbasePosition, shimStack, mastbaseLoadT,
--       upperDeflectorCylStroke, lowerDeflectorCylStroke } ] }
--
-- Additive, idempotent. Run after 0038.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rig_tunes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,                 -- e.g. "JV76 Sailing Info P3"
    source             TEXT,                          -- 'jv76-sheet','manual','other'
    revision           TEXT,                          -- sheet revision, e.g. "P3"
    effective_date     DATE NOT NULL DEFAULT CURRENT_DATE,  -- when this baseline applies from
    is_active          BOOLEAN NOT NULL DEFAULT false,
    data               JSONB NOT NULL DEFAULT '{}'::jsonb,
    report_ref         TEXT,                          -- original filename
    report_key         TEXT,                          -- Bunny Storage key of the original PDF (admin download)
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rig_tunes_team_boat_idx ON public.rig_tunes(team_id, boat_id);
CREATE INDEX IF NOT EXISTS rig_tunes_effective_idx ON public.rig_tunes(boat_id, effective_date DESC);
-- at most one active rig baseline per boat
CREATE UNIQUE INDEX IF NOT EXISTS rig_tunes_one_active_idx
    ON public.rig_tunes(boat_id) WHERE is_active;

DROP TRIGGER IF EXISTS rig_tunes_touch ON public.rig_tunes;
CREATE TRIGGER rig_tunes_touch BEFORE UPDATE ON public.rig_tunes
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.rig_tunes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rig_tunes_select ON public.rig_tunes;
DROP POLICY IF EXISTS rig_tunes_insert ON public.rig_tunes;
DROP POLICY IF EXISTS rig_tunes_update ON public.rig_tunes;
DROP POLICY IF EXISTS rig_tunes_delete ON public.rig_tunes;

CREATE POLICY rig_tunes_select ON public.rig_tunes FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY rig_tunes_insert ON public.rig_tunes FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY rig_tunes_update ON public.rig_tunes FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY rig_tunes_delete ON public.rig_tunes FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
