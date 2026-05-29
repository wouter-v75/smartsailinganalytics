-- ============================================================================
-- SSA Campaign Engine — 0014 org / sharing layer
--
-- Adds the organisational plumbing the campaign engine needs, WITHOUT touching
-- the existing single-tenant flow:
--   • teams.features         — per-team feature flags (campaign engine is gated
--                              ON for NORTHSTAR only; every other team is
--                              unaffected by the new tables).
--   • subteams               — reference vocabulary of functional areas, split
--                              into 'racing' and 'technical' categories, plus a
--                              'whole-team' catch-all. Team-scoped so each team
--                              can define its own.
--   • membership_subteams    — a member can belong to MANY sub-teams (join).
--
-- RLS matches the house style (0002/0003): has_boat_access / has_team_role /
-- is_team_member / is_admin. Idempotent. Run after 0013.
-- ============================================================================

-- ── teams.features ───────────────────────────────────────────────────────────
-- JSONB flag bag. {"campaign_engine": true} enables the campaign UI for a team.
ALTER TABLE public.teams
    ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── subteams — functional-area vocabulary, per team ──────────────────────────
CREATE TABLE IF NOT EXISTS public.subteams (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    category           TEXT NOT NULL
                       CHECK (category IN ('racing', 'technical', 'whole-team')),
    key                TEXT NOT NULL,          -- machine slug, e.g. 'coach-boat'
    label              TEXT NOT NULL,          -- display name, e.g. 'Coach Boat'
    seq                INTEGER NOT NULL DEFAULT 0,
    active             BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, key)
);

CREATE INDEX IF NOT EXISTS subteams_team_idx ON public.subteams(team_id, category, seq);

-- ── membership_subteams — many-to-many member × subteam ──────────────────────
-- team_id is denormalised for cheap RLS (mirrors the pattern on every other
-- table). A row says "this membership participates in this sub-team".
CREATE TABLE IF NOT EXISTS public.membership_subteams (
    membership_id UUID NOT NULL REFERENCES public.memberships(id) ON DELETE CASCADE,
    subteam_id    UUID NOT NULL REFERENCES public.subteams(id)    ON DELETE CASCADE,
    team_id       UUID NOT NULL REFERENCES public.teams(id)       ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (membership_id, subteam_id)
);

CREATE INDEX IF NOT EXISTS membership_subteams_subteam_idx
    ON public.membership_subteams(subteam_id);
CREATE INDEX IF NOT EXISTS membership_subteams_team_idx
    ON public.membership_subteams(team_id);

-- ── updated_at trigger for subteams ──────────────────────────────────────────
DROP TRIGGER IF EXISTS subteams_touch ON public.subteams;
CREATE TRIGGER subteams_touch
    BEFORE UPDATE ON public.subteams
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.subteams            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_subteams ENABLE ROW LEVEL SECURITY;

-- subteams: any team member reads; coach (or admin) curates the vocabulary.
DROP POLICY IF EXISTS subteams_select ON public.subteams;
DROP POLICY IF EXISTS subteams_insert ON public.subteams;
DROP POLICY IF EXISTS subteams_update ON public.subteams;
DROP POLICY IF EXISTS subteams_delete ON public.subteams;

CREATE POLICY subteams_select ON public.subteams
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.is_team_member(team_id));

CREATE POLICY subteams_insert ON public.subteams
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

CREATE POLICY subteams_update ON public.subteams
    FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

CREATE POLICY subteams_delete ON public.subteams
    FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- membership_subteams: any team member can see who's in which sub-team; coach
-- (or admin) assigns. (Self-service join could be added later by widening
-- INSERT to the membership owner.)
DROP POLICY IF EXISTS membership_subteams_select ON public.membership_subteams;
DROP POLICY IF EXISTS membership_subteams_insert ON public.membership_subteams;
DROP POLICY IF EXISTS membership_subteams_delete ON public.membership_subteams;

CREATE POLICY membership_subteams_select ON public.membership_subteams
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.is_team_member(team_id));

CREATE POLICY membership_subteams_insert ON public.membership_subteams
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

CREATE POLICY membership_subteams_delete ON public.membership_subteams
    FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subteams            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.membership_subteams TO authenticated;
REVOKE ALL ON public.subteams            FROM anon;
REVOKE ALL ON public.membership_subteams FROM anon;

-- ============================================================================
-- SEED — NORTHSTAR only. Enables the campaign engine and loads the sub-team
-- vocabulary. Safe to re-run (idempotent via ON CONFLICT / WHERE name match).
-- ============================================================================

-- Turn the campaign engine ON for NORTHSTAR.
UPDATE public.teams
   SET features = features || '{"campaign_engine": true}'::jsonb
 WHERE lower(name) = 'northstar';

-- Load the sub-team vocabulary for NORTHSTAR.
INSERT INTO public.subteams (team_id, category, key, label, seq)
SELECT t.id, v.category, v.key, v.label, v.seq
  FROM public.teams t
 CROSS JOIN (VALUES
        -- Racing
        ('racing',     'bow',         'Bow',          10),
        ('racing',     'speed',       'Speed',        20),
        ('racing',     'afterguard',  'Afterguard',   30),
        ('racing',     'coach-boat',  'Coach Boat',   40),
        ('racing',     'design',      'Design',       50),
        ('racing',     'shore',       'Shore',        60),
        -- Technical
        ('technical',  'electronics', 'Electronics',  110),
        ('technical',  'mechanical',  'Mechanical',   120),
        ('technical',  'structural',  'Structural',   130),
        ('technical',  'rig',         'Rig',          140),
        ('technical',  'rigging',     'Rigging',      150),
        ('technical',  'sails',       'Sails',        160),
        ('technical',  'boatbuilding','Boatbuilding', 170),
        -- Catch-all
        ('whole-team', 'whole-team',  'Whole Team',   900)
     ) AS v(category, key, label, seq)
 WHERE lower(t.name) = 'northstar'
ON CONFLICT (team_id, key) DO NOTHING;
