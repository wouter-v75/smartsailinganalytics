-- ============================================================================
-- SSA — 0106 a boat's sail chart (crossover chart)
--
-- Which sail to carry at each TWA × TWS: one closed shape per sail, drawn
-- through control points, imported from Expedition's <crossoverchart> XML and
-- edited on the Boat → Sail chart tab. src/lib/sailchart/model.ts is the
-- authority on the document's contents; the route and the editor both
-- normalise through it.
--
--   {
--     "version": 1, "fileName": "…xml", "importedAt": "…",
--     "sails": [{ "id", "name", "group", "colour", "alias": [], "points": [{twa,tws}],
--                 "opacity", "dashed", "lineWidth", "label", "visible",
--                 "sailIds": [<sails.id>, …] }]
--   }
--
-- A TABLE, not a column on boats, for the same reason as 0064 (battens) and
-- 0097 (debrief words): boats_update is team_manager only, and the people who
-- own a crossover chart — coach, TL3, the sailmaker's analyst — would be
-- refused by RLS after editing it. One JSONB document per boat: it is drawn
-- whole and saved whole. Links to sails are ids inside the document, not a
-- join table; a deleted sail leaves a dangling id that the editor shows as
-- "no longer in the inventory" rather than a cascade that silently unlinks.
--
-- Additive and idempotent. Follows 0105.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.boat_sailcharts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    chart              JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Plain unique constraint: the route's upsert names it in ON CONFLICT.
    CONSTRAINT boat_sailcharts_one_per_boat UNIQUE (team_id, boat_id)
);

ALTER TABLE public.boat_sailcharts DROP CONSTRAINT IF EXISTS boat_sailcharts_shape;
ALTER TABLE public.boat_sailcharts ADD CONSTRAINT boat_sailcharts_shape
    CHECK (jsonb_typeof(chart) = 'object');

COMMENT ON TABLE public.boat_sailcharts IS
    'Per-boat sail crossover chart (TWA x TWS shapes per sail, linked to sails.id), '
    'one JSONB document. Normalised by src/lib/sailchart/model.ts.';

ALTER TABLE public.boat_sailcharts ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can see the boat.
DROP POLICY IF EXISTS boat_sailcharts_select ON public.boat_sailcharts;
CREATE POLICY boat_sailcharts_select ON public.boat_sailcharts
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

-- Write: the set that owns the rest of boat config (Boat tab's TL3+ gate).
DROP POLICY IF EXISTS boat_sailcharts_insert ON public.boat_sailcharts;
CREATE POLICY boat_sailcharts_insert ON public.boat_sailcharts
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']));

DROP POLICY IF EXISTS boat_sailcharts_update ON public.boat_sailcharts;
CREATE POLICY boat_sailcharts_update ON public.boat_sailcharts
    FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']));

DROP POLICY IF EXISTS boat_sailcharts_delete ON public.boat_sailcharts;
CREATE POLICY boat_sailcharts_delete ON public.boat_sailcharts
    FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']));

DROP TRIGGER IF EXISTS boat_sailcharts_touch ON public.boat_sailcharts;
CREATE TRIGGER boat_sailcharts_touch
    BEFORE UPDATE ON public.boat_sailcharts
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
