-- ============================================================================
-- SSA — 0066  A crew member's own notes on a day.
--
-- Campaign → Day already carries the team's Debrief notes, and that card is
-- edited by tl3 and above. That is right for the record of what the team
-- decided — and it leaves everybody else with nowhere to put what they want
-- RAISED at the debrief. A trimmer who spent the second beat thinking the jib
-- lead was wrong either remembers it until the evening or loses it, and what
-- actually happens is that they lose it.
--
-- So: one private note per person per day. Not a second team record — a
-- notebook. The team card stays exactly as it is.
--
-- PRIVATE, and meant literally. The card tells the crew member only they can
-- see it, so the policies below name auth.uid() and nothing else — no coach
-- tier, and deliberately not is_admin() either, which 0062 does grant over
-- personal TAGS. A note written on that promise should not be readable by
-- somebody holding a role. (The service-role key still bypasses RLS, as it does
-- for every row in this database; that is the platform, not a permission.)
--
-- `kind` is here so the next personal card on this screen — speed-team
-- thoughts, a general scratchpad — needs no migration. Only 'debrief' is
-- written today.
--
-- Idempotent. Run after 0063.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ssa_day_notes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    session_date  DATE NOT NULL,
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    kind          TEXT NOT NULL DEFAULT 'debrief'
                  CHECK (kind IN ('debrief', 'speed', 'general')),
    body          TEXT NOT NULL DEFAULT '',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One notebook page per person per day per kind. The card SAVES rather than
-- APPENDS, so a second row would be a second page nobody can see — and the
-- upsert the API does needs a unique index to arbitrate against.
CREATE UNIQUE INDEX IF NOT EXISTS ssa_day_notes_one_each_idx
    ON public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind);

-- "My notes for this day", which is the only way it is ever read.
CREATE INDEX IF NOT EXISTS ssa_day_notes_mine_idx
    ON public.ssa_day_notes (user_id, boat_id, session_date);

DROP TRIGGER IF EXISTS ssa_day_notes_touch ON public.ssa_day_notes;
CREATE TRIGGER ssa_day_notes_touch BEFORE UPDATE ON public.ssa_day_notes
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.ssa_day_notes ENABLE ROW LEVEL SECURITY;

-- Mine, and only mine. See the header: the card makes a promise and this is it.
DROP POLICY IF EXISTS ssa_day_notes_select ON public.ssa_day_notes;
CREATE POLICY ssa_day_notes_select ON public.ssa_day_notes
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Anyone who can open the day may keep notes on it. There is no role gate: a
-- guest's own notebook costs the team nothing and is visible to nobody. The
-- boat check is what stops a row being planted against a day somebody has no
-- business touching.
DROP POLICY IF EXISTS ssa_day_notes_insert ON public.ssa_day_notes;
CREATE POLICY ssa_day_notes_insert ON public.ssa_day_notes
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND public.has_boat_access_dated(team_id, boat_id, session_date)
    );

DROP POLICY IF EXISTS ssa_day_notes_update ON public.ssa_day_notes;
CREATE POLICY ssa_day_notes_update ON public.ssa_day_notes
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ssa_day_notes_delete ON public.ssa_day_notes;
CREATE POLICY ssa_day_notes_delete ON public.ssa_day_notes
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());
