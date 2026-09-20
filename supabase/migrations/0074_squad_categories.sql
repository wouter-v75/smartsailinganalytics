-- 0074_squad_categories.sql
-- ---------------------------------------------------------------------------
-- What a team CONTRIBUTES to its squad, per category.
--
-- 0071 shipped one boolean per session. That answers "which days", and leaves
-- "which KINDS of thing" unasked — so a team that wanted to share tracks had no
-- way to say "…but not our debrief notes", which is precisely the line every
-- squad actually draws.
--
-- THE TWO-LEVEL MODEL, which is the whole design:
--
--     CATEGORY enables          (squad_members.shares, set once on joining)
--     SESSION decides           (sessions.shared_with_squad, per day)
--
-- Ticking "tracks" means THIS TEAM CONTRIBUTES TRACKS AT ALL. It does not
-- share a single one; each day still carries its own flag. So a team can join
-- a squad wholeheartedly and still hold back the day the mast came down. Both
-- must be true for anything to be visible, and the category is the one a team
-- sets deliberately, in front of a list, when it joins.
--
-- Everything defaults to FALSE / 'none'. Joining a squad shares nothing.
--
-- HOW JOINING WORKS, using 0071's existing status column rather than a new
-- table: an ADMIN adds a team with status 'invited' — that is "this team may
-- join". The team's own coach or manager flips it to 'active', choosing its
-- categories as they do. A team can never enrol itself in a squad it was not
-- invited to, and an admin can never make a team share anything.
--
-- ONE THING RLS CANNOT DO, said plainly. `logdata` is the difference between a
-- thinned position track and every channel in the log — a COLUMN distinction
-- inside one row. Postgres policies are row-level, so this one is enforced in
-- /api/squads/tracks/[date], which returns thinned positions unless `logdata`
-- is shared. It is the single place that reads another team's log, and the
-- comment there says so. If a second route ever does, it must ask too.
-- ---------------------------------------------------------------------------

-- ── what a member contributes ───────────────────────────────────────────────
-- JSONB rather than eight columns: the set is product-driven and will grow
-- (sail scans did not exist when squads were designed), and a new category
-- should not be a migration on a table that teams have rows in.
ALTER TABLE public.squad_members
    ADD COLUMN IF NOT EXISTS shares JSONB NOT NULL DEFAULT '{
        "tracks":    false,
        "logdata":   false,
        "videos":    false,
        "photos":    false,
        "sailscans": false,
        "comments":  false,
        "notes":     false,
        "tags":      "none"
    }'::jsonb;

-- ── the category test ───────────────────────────────────────────────────────
-- shares_squad_with() from 0071 answers "are we in a squad together"; this
-- narrows it to "…and do they contribute THIS". SECURITY DEFINER for the same
-- reason as its sibling: it reads squad_members and memberships on the
-- caller's behalf and must not be gated by the policies it exists to answer.
CREATE OR REPLACE FUNCTION public.squad_shares(p_team_id UUID, p_category TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.squad_members owner
          JOIN public.squad_members viewer
            ON viewer.squad_id = owner.squad_id
           AND viewer.team_id <> owner.team_id
          JOIN public.memberships m
            ON m.team_id = viewer.team_id
         WHERE owner.team_id  = p_team_id
           AND owner.status  = 'active'
           AND viewer.status = 'active'
           AND m.user_id = auth.uid()
           -- the category, as a boolean OR as the tags tri-state
           AND COALESCE(owner.shares ->> p_category, 'false') NOT IN ('false', 'none')
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
           AND (owner.valid_from  IS NULL OR owner.valid_from  <= CURRENT_DATE)
           AND (owner.valid_to    IS NULL OR owner.valid_to    >= CURRENT_DATE)
           AND (viewer.valid_from IS NULL OR viewer.valid_from <= CURRENT_DATE)
           AND (viewer.valid_to   IS NULL OR viewer.valid_to   >= CURRENT_DATE)
    );
$$;

-- 'none' | 'race' | 'all'. A separate function because tags are the one
-- category with a middle setting: plenty of teams will show the squad what
-- happened in a RACE and not what their coach flagged in training.
CREATE OR REPLACE FUNCTION public.squad_tag_visibility(p_team_id UUID)
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT COALESCE(MAX(owner.shares ->> 'tags'), 'none')
      FROM public.squad_members owner
      JOIN public.squad_members viewer
        ON viewer.squad_id = owner.squad_id
       AND viewer.team_id <> owner.team_id
      JOIN public.memberships m ON m.team_id = viewer.team_id
     WHERE owner.team_id  = p_team_id
       AND owner.status  = 'active'
       AND viewer.status = 'active'
       AND m.user_id = auth.uid();
$$;

-- The slugs that mean "this happened in a race", kept in ONE place because a
-- policy and a picker must never disagree about it. Mirrors the 'racing' group
-- in src/lib/tagging/barGroups.ts, plus the 'race' range tag itself.
CREATE OR REPLACE FUNCTION public.race_tag_slugs()
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE
AS $$ SELECT ARRAY['race','day-start','race-start','topmark','gate','mark','race-finish','day-end'] $$;

-- "Category enables, session decides" for the tables that hang off a DAY
-- rather than carrying their own flag. Notes, scans and tags follow the
-- session they belong to: share the day, and the day's material travels with
-- it; hold the day back, and none of it goes.
CREATE OR REPLACE FUNCTION public.squad_day_shared(
    p_team_id UUID, p_boat_id UUID, p_date DATE
) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.sessions s
         WHERE s.team_id = p_team_id
           AND s.boat_id = p_boat_id
           AND s.date    = p_date
           AND s.shared_with_squad
    );
$$;

-- ── existing policies become category-aware ─────────────────────────────────
-- Each replaces the bare shares_squad_with() test from 0071/0072. A team that
-- shared a session before this migration keeps its session flag; it will stop
-- being visible until the team also ticks the category, which is the correct
-- direction to fail.
DROP POLICY IF EXISTS sessions_select ON public.sessions;
CREATE POLICY sessions_select ON public.sessions
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id, date)
        OR (shared_with_squad AND public.squad_shares(team_id, 'tracks'))
    );

DROP POLICY IF EXISTS videos_select ON public.videos;
CREATE POLICY videos_select ON public.videos
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id,
             (SELECT s.date FROM public.sessions s WHERE s.id = session_id))
        OR (shared_with_squad AND public.squad_shares(team_id, 'videos'))
    );

DROP POLICY IF EXISTS photos_select ON public.photos;
CREATE POLICY photos_select ON public.photos
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id,
             (SELECT s.date FROM public.sessions s WHERE s.id = session_id))
        OR (shared_with_squad AND public.squad_shares(team_id, 'photos'))
    );

-- ── the new categories ──────────────────────────────────────────────────────
-- These are ADDED as separate permissive policies rather than folded into the
-- existing ones. Postgres ORs permissive policies together, so a team's own
-- access is untouched by construction — there is no way for this migration to
-- narrow what somebody could already see, which is not a property you get by
-- rewriting a policy you cannot read back.

-- Sail scans follow their session's day. A scan with no session is a library
-- shot rather than a day's record, and is never shared.
DROP POLICY IF EXISTS sail_scans_squad_select ON public.sail_scans;
CREATE POLICY sail_scans_squad_select ON public.sail_scans
    FOR SELECT TO authenticated
    USING (
        session_id IS NOT NULL
        AND public.squad_shares(team_id, 'sailscans')
        AND EXISTS (
            SELECT 1 FROM public.sessions s
             WHERE s.id = sail_scans.session_id AND s.shared_with_squad
        )
    );

-- NOTES are timeline nodes, NOT ssa_day_notes. ssa_day_notes is a PRIVATE
-- per-user notebook — its policy is `user_id = auth.uid()`, so not even a
-- teammate sees it, and pushing it into a squad would be a betrayal of what
-- that table is. The speed-team meeting, the debrief, the timings and the plan
-- are timeline nodes, which is what the day actually shows.
--
-- Only the WRITTEN kinds. A timeline node of kind 'tack' or 'mark' is a track
-- event and travels with `tracks`; 'note', 'debrief', 'meeting' and 'analysis'
-- are what a person wrote down, and that is what this category is about.
DROP POLICY IF EXISTS timeline_nodes_squad_select ON public.timeline_nodes;
CREATE POLICY timeline_nodes_squad_select ON public.timeline_nodes
    FOR SELECT TO authenticated
    USING (
        kind IN ('note', 'debrief', 'meeting', 'analysis')
        AND public.squad_shares(team_id, 'notes')
        AND public.squad_day_shared(team_id, boat_id, session_date)
    );

-- TAGS are the one tri-state: 'none', 'race' or 'all'. A PERSONAL tag is never
-- shared under any setting — it is one person's private mark and the owning
-- team cannot consent on their behalf.
DROP POLICY IF EXISTS ssa_tag_events_squad_select ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_squad_select ON public.ssa_tag_events
    FOR SELECT TO authenticated
    USING (
        scope <> 'personal'
        AND public.squad_day_shared(team_id, boat_id, session_date)
        AND (
            public.squad_tag_visibility(team_id) = 'all'
            OR (public.squad_tag_visibility(team_id) = 'race'
                AND slug = ANY (public.race_tag_slugs()))
        )
    );

-- ── squad comments ──────────────────────────────────────────────────────────
-- The point of a squad debrief: a coach from ANOTHER team says something about
-- your tagged moment. That is a cross-team WRITE, which every other part of
-- this design refuses — so it is confined to its own table. A partner can add
-- a comment; they cannot touch the tag, the session or anything else. Your tag
-- stays yours, and deleting the tag takes its comments with it.
CREATE TABLE IF NOT EXISTS public.squad_comments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id       UUID NOT NULL REFERENCES public.squads(id) ON DELETE CASCADE,
    tag_event_id   UUID NOT NULL REFERENCES public.ssa_tag_events(id) ON DELETE CASCADE,
    -- Denormalised from the tag so a policy can test ownership without
    -- joining ssa_tag_events, whose own policy would then have to be satisfied
    -- first. The trigger below keeps it honest.
    owner_team_id  UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    author_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    author_team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    body           TEXT NOT NULL CHECK (length(trim(body)) > 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS squad_comments_tag_idx   ON public.squad_comments(tag_event_id, created_at);
CREATE INDEX IF NOT EXISTS squad_comments_squad_idx ON public.squad_comments(squad_id, created_at DESC);

-- owner_team_id is taken FROM THE TAG, never from the caller. A client that
-- sent someone else's team id would otherwise be writing a comment that the
-- wrong team's policy governs.
CREATE OR REPLACE FUNCTION public.squad_comments_set_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    SELECT team_id INTO NEW.owner_team_id
      FROM public.ssa_tag_events WHERE id = NEW.tag_event_id;
    IF NEW.owner_team_id IS NULL THEN
        RAISE EXCEPTION 'squad_comments: no such tag event %', NEW.tag_event_id;
    END IF;
    NEW.author_user_id := auth.uid();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS squad_comments_owner ON public.squad_comments;
CREATE TRIGGER squad_comments_owner BEFORE INSERT ON public.squad_comments
    FOR EACH ROW EXECUTE FUNCTION public.squad_comments_set_owner();

ALTER TABLE public.squad_comments ENABLE ROW LEVEL SECURITY;

-- Readable by the owning team always, and by the squad when that team shares
-- comments. A team can always read what was said about its own sailing, even
-- if it later stops contributing the category.
DROP POLICY IF EXISTS squad_comments_select ON public.squad_comments;
CREATE POLICY squad_comments_select ON public.squad_comments
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(owner_team_id,
             ARRAY['coach','tl1','tl2','tl3','team_manager','owner','consultant'])
        OR public.squad_shares(owner_team_id, 'comments')
    );

-- Writable by anyone the owning team shares comments with, and by the owning
-- team itself. The author's team must be their own — you comment AS your team.
DROP POLICY IF EXISTS squad_comments_insert ON public.squad_comments;
CREATE POLICY squad_comments_insert ON public.squad_comments
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_team_role(author_team_id,
          ARRAY['coach','tl1','tl2','tl3','team_manager','owner'])
        AND (
            public.has_team_role(owner_team_id, ARRAY['coach','tl1','tl2','tl3','team_manager','owner'])
            OR public.squad_shares(owner_team_id, 'comments')
        )
    );

-- You may edit or delete YOUR OWN comment, and nobody else's — not even the
-- team that owns the tag. Removing somebody's words from your debrief is not
-- a power the schema should hand out; un-sharing the category hides the thread.
DROP POLICY IF EXISTS squad_comments_update ON public.squad_comments;
CREATE POLICY squad_comments_update ON public.squad_comments
    FOR UPDATE TO authenticated
    USING (author_user_id = auth.uid())
    WITH CHECK (author_user_id = auth.uid());

DROP POLICY IF EXISTS squad_comments_delete ON public.squad_comments;
CREATE POLICY squad_comments_delete ON public.squad_comments
    FOR DELETE TO authenticated
    USING (public.is_admin() OR author_user_id = auth.uid());

DROP TRIGGER IF EXISTS squad_comments_touch ON public.squad_comments;
CREATE TRIGGER squad_comments_touch BEFORE UPDATE ON public.squad_comments
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
