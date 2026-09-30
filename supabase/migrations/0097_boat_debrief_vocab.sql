-- ============================================================================
-- SSA — 0097 a boat's own debrief vocabulary
--
-- The glossary is what makes the debrief summaries usable. It is also, in part,
-- hard-coded: src/lib/debriefGlossary.ts holds this squad's crew, its rivals and
-- its mishearings under TEAM_VOCAB, and says so itself —
--
--     "This is per-TEAM data living in code, which is the wrong home for it.
--      The right one is a column on the boat, edited from the Boat tab the way
--      the sail inventory already is, so a debrief correction does not need a
--      deploy."
--
-- This is that home, with one correction to it: a TABLE, not a column on boats.
--
-- WHY NOT A COLUMN. boats_update (0004) is admin or team_manager. The person who
-- notices a mishearing is whoever read the transcript — the coach, the
-- strategist, whoever ran the debrief — and on a column they would have been
-- refused by RLS, silently, after typing it in. The Boat tab's own edit gate is
-- TL3+, so the UI would have offered an edit the database then threw away.
-- boat_battens met the same wall in 0064 and moved off the boat for the same
-- reason; this follows it, including the role set.
--
-- Two things follow from being editable at all, which a deploy cannot give:
--
--   1. A term goes in while the debrief is fresh. A mishearing noticed in the
--      transcript is worth nothing a week later, when nobody remembers which
--      word was actually said.
--   2. One team's names stop reaching another team's recogniser. Whisper primed
--      with a name will place that name in a session the person was never at,
--      and a wrong name asserted confidently is worse than a garbled one. A
--      shared source file cannot separate them; a per-boat row is nothing but
--      separation.
--
-- SHAPE. One JSONB document, not six tables, for the same reason 0064 chose one
-- document per batten card: it is a small thing edited as a whole and read
-- entirely or not at all, and the alternative is six joins to assemble a prompt.
-- src/lib/debriefVocab.ts is the authority on its contents — the route and the
-- editor both normalise through it, so what the browser calls a blank row and
-- what this table stores cannot drift apart.
--
--   {
--     "crew":       ["Pedro", "Mika"],
--     "boats":      ["Jethou", "Tilakkhana II"],
--     "roles":      [["Nick", "tactician"]],
--     "manoeuvres": ["Sandukan"],
--     "aliases":    [["Sandukan", "gybe set at the top mark"]],
--     "fixups":     [["Jesu", "Jethou (boat name)"]]
--   }
--
-- EMPTY MEANS INHERIT, not "no vocabulary". A boat with no row, or with an empty
-- list, keeps the code defaults; the merge only overrides a list that has
-- something in it. So this migration changes no behaviour on its own, which is
-- the point — it can run ahead of the UI.
--
-- Idempotent. No backfill: the existing TEAM_VOCAB entries stay in code and keep
-- working, and copying them in here would create two sources for the same names
-- with no rule about which wins.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.boat_debrief_vocab (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,

    -- The six lists. Validated by src/lib/debriefVocab.ts before it gets here;
    -- the CHECK below is the database's own floor, not a substitute for that.
    vocab              JSONB NOT NULL DEFAULT '{}'::jsonb,

    updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One vocabulary per boat. This is also what the API's upsert arbitrates on,
    -- so it must be a plain unique constraint: a partial index could not be
    -- named in an ON CONFLICT that PostgREST generates. (0064's lesson, and
    -- 0062's before it.)
    CONSTRAINT boat_debrief_vocab_one_per_boat UNIQUE (team_id, boat_id)
);

-- An object, nothing else. A bare array or a string here is a client bug, and
-- letting it land makes every later read defensive.
ALTER TABLE public.boat_debrief_vocab DROP CONSTRAINT IF EXISTS boat_debrief_vocab_shape;
ALTER TABLE public.boat_debrief_vocab ADD CONSTRAINT boat_debrief_vocab_shape
    CHECK (jsonb_typeof(vocab) = 'object');

COMMENT ON TABLE public.boat_debrief_vocab IS
    'Per-boat debrief glossary: crew, rival boats, roles, manoeuvres, slang and '
    'known mishearings, as one JSONB document. Merged OVER the shared defaults '
    'in src/lib/debriefGlossary.ts at read time; an empty list inherits rather '
    'than clears. Normalised by src/lib/debriefVocab.ts — edit it through the '
    'Boat tab, not by hand, or the editor and this table will disagree about '
    'what a blank row is.';

ALTER TABLE public.boat_debrief_vocab ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can see the boat. The vocabulary is fed into every debrief
-- recording made on this boat, and a crew member who cannot read it cannot tell
-- why the summary called something what it did.
DROP POLICY IF EXISTS boat_debrief_vocab_select ON public.boat_debrief_vocab;
CREATE POLICY boat_debrief_vocab_select ON public.boat_debrief_vocab
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access(team_id, boat_id)
    );

-- Write: the same set that owns the rest of boat config. Spelled out rather than
-- assumed to ladder — has_team_role is not a general ordering (see 0062).
DROP POLICY IF EXISTS boat_debrief_vocab_insert ON public.boat_debrief_vocab;
CREATE POLICY boat_debrief_vocab_insert ON public.boat_debrief_vocab
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

DROP POLICY IF EXISTS boat_debrief_vocab_update ON public.boat_debrief_vocab;
CREATE POLICY boat_debrief_vocab_update ON public.boat_debrief_vocab
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

DROP POLICY IF EXISTS boat_debrief_vocab_delete ON public.boat_debrief_vocab;
CREATE POLICY boat_debrief_vocab_delete ON public.boat_debrief_vocab
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );

-- Keep updated_at honest. 0003 already defines public.touch_updated_at().
DROP TRIGGER IF EXISTS boat_debrief_vocab_touch ON public.boat_debrief_vocab;
CREATE TRIGGER boat_debrief_vocab_touch
    BEFORE UPDATE ON public.boat_debrief_vocab
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
