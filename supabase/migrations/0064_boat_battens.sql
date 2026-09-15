-- ============================================================================
-- SSA — 0064  The batten card.
--
-- A mainsail's battens are tensioned to a number of turns against a stiffness,
-- and the right answer moves with the breeze: soft and eased in the light so the
-- sail can take up shape, stiffer and wound on as it builds so the leech stops
-- falling away. Every team keeps this on a laminated card in the boat. This is
-- that card, per boat.
--
-- ONE ROW PER BOAT, holding the whole grid in JSONB, rather than a row per
-- (batten, wind band). Three reasons:
--
--   1. it is EDITED as a grid. A cell-per-row table would need a diff on every
--      save, and a half-applied diff is a card that is wrong in the boat.
--   2. it is READ whole. Nothing ever asks for "batten 2 in 15–20 knots" across
--      boats; it is always "show me the card".
--   3. it is small and hand-entered — twelve battens by six bands is the ceiling,
--      and the shape is settled by src/lib/battens.ts, which validates on the way
--      in and is forgiving on the way out.
--
-- The card is the TARGET. What the battens actually were at a moment is recorded
-- on a sail-change tag (ssa_tag_events.meta.sail.battens, see 0062) — a setting
-- belongs to the day, not to the boat's reference card.
--
-- Shape of `card`:
--   { "count": 3,
--     "rows": [ { "0-5":  { "tension": "soft",  "turns": 5 },
--                 "15-20":{ "tension": "stiff", "turns": -2 } },
--               { … }, { … } ] }
--
-- rows[0] is the TOP batten — that is how a crew counts them, standing on deck
-- looking up, and the top one is the one that gets touched.
--
-- Turns may be NEGATIVE: winding a batten off the reference mark is a real
-- setting, so nothing here constrains the sign.
--
-- Who may write it: the same leadership set that owns the rest of boat config
-- (Boat → Sail inventory, Rig settings). A batten card is boat setup, not a
-- crew observation.
--
-- Idempotent. Run after 0063.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.boat_battens (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,

    -- The grid. Validated by src/lib/battens.ts before it gets here; the CHECK
    -- below is the database's own floor, not a substitute for that.
    card               JSONB NOT NULL DEFAULT '{"count":3,"rows":[{},{},{}]}'::jsonb,

    updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One card per boat. This is also what the API's upsert arbitrates on, so it
    -- must be a plain unique constraint: a partial index could not be named in an
    -- ON CONFLICT that PostgREST generates. (Same lesson as 0062's detection
    -- index — see the comment there.)
    CONSTRAINT boat_battens_one_per_boat UNIQUE (team_id, boat_id)
);

-- A card must be an object with a rows ARRAY. Anything else is a client bug, and
-- letting it land makes every later read defensive.
ALTER TABLE public.boat_battens DROP CONSTRAINT IF EXISTS boat_battens_card_shape;
ALTER TABLE public.boat_battens ADD CONSTRAINT boat_battens_card_shape
    CHECK (jsonb_typeof(card) = 'object' AND jsonb_typeof(card -> 'rows') = 'array');

COMMENT ON TABLE public.boat_battens IS
    'Per-boat batten card: target stiffness + turns per batten (top-down) per wind band. One row per boat; see src/lib/battens.ts.';

ALTER TABLE public.boat_battens ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can see the boat. The card is what the crew sets the battens
-- to; a trimmer who cannot read it cannot use it.
DROP POLICY IF EXISTS boat_battens_select ON public.boat_battens;
CREATE POLICY boat_battens_select ON public.boat_battens
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access(team_id, boat_id)
    );

-- Write: boat setup, so the boat-config leadership set. Spelled out rather than
-- assumed to ladder — has_team_role is not a general ordering (see 0062).
DROP POLICY IF EXISTS boat_battens_insert ON public.boat_battens;
CREATE POLICY boat_battens_insert ON public.boat_battens
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

DROP POLICY IF EXISTS boat_battens_update ON public.boat_battens;
CREATE POLICY boat_battens_update ON public.boat_battens
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

DROP POLICY IF EXISTS boat_battens_delete ON public.boat_battens;
CREATE POLICY boat_battens_delete ON public.boat_battens
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

-- Keep updated_at honest. 0003 already defines public.touch_updated_at().
DROP TRIGGER IF EXISTS boat_battens_touch ON public.boat_battens;
CREATE TRIGGER boat_battens_touch
    BEFORE UPDATE ON public.boat_battens
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
