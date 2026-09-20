-- 0071_squads.sql
-- ---------------------------------------------------------------------------
-- Squads: teams that train together, sharing tracks by consent.
--
-- Every comparable tool assumes ONE owner — Njord's sharing is "invite a
-- teammate to the boat so they can access all data", per user, whole boat, no
-- scope. That breaks the moment the boats are PEERS: a 49er crew's data belongs
-- to that crew, not to whoever is coaching this week, and two boats in the same
-- national squad are selection rivals who will share a training block and not a
-- season.
--
-- THE MODEL
--   1. A TEAM joins a SQUAD. Its own manager or coach decides, and can leave.
--   2. Sharing is PER SESSION — sessions.shared_with_squad — chosen when the
--      track is uploaded and changeable afterwards in Analytics. Not a standing
--      grant over everything a boat will ever do, which is the thing a rival
--      would never agree to.
--   3. A coach who works with several boats holds a MEMBERSHIP in each team, so
--      they can upload for each. No cross-team write grant exists, and none is
--      needed: the upload is recorded as that coach, in a team that admitted
--      them. A squad never owns data — it is an agreement about visibility —
--      which is what keeps leaving one clean rather than a migration.
--
-- Default is FALSE. Nothing becomes visible because a team joined a squad; it
-- becomes visible because somebody ticked a box for that track.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.squads (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT NOT NULL,
    note               TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per TEAM in the squad. Joining is a decision by that team, recorded
-- with who invited and who accepted, and bounded by an optional window so a
-- winter training block does not quietly become a standing arrangement.
CREATE TABLE IF NOT EXISTS public.squad_members (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id           UUID NOT NULL REFERENCES public.squads(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id)  ON DELETE CASCADE,
    status             TEXT NOT NULL DEFAULT 'invited'
                       CHECK (status IN ('invited', 'active', 'left')),
    valid_from         DATE,
    valid_to           DATE,
    invited_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decided_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decided_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (squad_id, team_id)
);

CREATE INDEX IF NOT EXISTS squad_members_team_idx  ON public.squad_members(team_id, status);
CREATE INDEX IF NOT EXISTS squad_members_squad_idx ON public.squad_members(squad_id, status);

-- The whole sharing decision, one boolean per session.
ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS shared_with_squad BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS sessions_shared_idx
    ON public.sessions(team_id, date) WHERE shared_with_squad;

-- ---------------------------------------------------------------------------
-- Does the CALLER share an active squad with this team?
--
-- SECURITY DEFINER for the same reason has_boat_access is: it reads memberships
-- and squad_members on the caller's behalf, and must not be gated by the very
-- policies it exists to answer.
--
-- `viewer.team_id <> owner.team_id` on purpose: a team's own sessions are
-- already covered by has_boat_access_dated, and letting this answer for them
-- would make the squad path able to widen access inside a team.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shares_squad_with(p_team_id UUID)
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
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
           AND (owner.valid_from  IS NULL OR owner.valid_from  <= CURRENT_DATE)
           AND (owner.valid_to    IS NULL OR owner.valid_to    >= CURRENT_DATE)
           AND (viewer.valid_from IS NULL OR viewer.valid_from <= CURRENT_DATE)
           AND (viewer.valid_to   IS NULL OR viewer.valid_to   >= CURRENT_DATE)
    );
$$;

-- ── sessions: the squad can read a session that was SHARED ──────────────────
-- Extends 0042's policy; the existing clauses are unchanged.
DROP POLICY IF EXISTS sessions_select ON public.sessions;
CREATE POLICY sessions_select ON public.sessions
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id, date)
        OR (shared_with_squad AND public.shares_squad_with(team_id))
    );

-- ── boats: a shared track needs a boat NAME to be worth anything ────────────
-- This exposes the NAMES of a squad partner's boats, not their data. Squad
-- members are training together and already know each other's boats; gating it
-- on "has a shared session" instead would cost a subquery on every row to hide
-- something nobody is hiding.
DROP POLICY IF EXISTS boats_select ON public.boats;
CREATE POLICY boats_select ON public.boats
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access(team_id, id)
        OR public.shares_squad_with(team_id)
    );

-- ── squads / squad_members ──────────────────────────────────────────────────
ALTER TABLE public.squads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_members ENABLE ROW LEVEL SECURITY;

-- A squad is visible to any team in it, whatever their status: a team that has
-- been INVITED must be able to see what it is being asked to join.
DROP POLICY IF EXISTS squads_select ON public.squads;
CREATE POLICY squads_select ON public.squads
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.squad_members sm
            WHERE sm.squad_id = squads.id
              AND public.has_team_role(sm.team_id,
                    ARRAY['coach','tl1','tl2','tl3','team_manager','owner','consultant'])
        )
    );

DROP POLICY IF EXISTS squads_write ON public.squads;
CREATE POLICY squads_write ON public.squads
    FOR ALL TO authenticated
    USING (public.is_admin() OR created_by_user_id = auth.uid())
    WITH CHECK (public.is_admin() OR created_by_user_id = auth.uid());

-- Members of a squad see each other — who else is in it is part of deciding
-- whether to join, and hiding it would make the decision impossible to take.
DROP POLICY IF EXISTS squad_members_select ON public.squad_members;
CREATE POLICY squad_members_select ON public.squad_members
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.squad_members mine
            WHERE mine.squad_id = squad_members.squad_id
              AND public.has_team_role(mine.team_id,
                    ARRAY['coach','tl1','tl2','tl3','team_manager','owner','consultant'])
        )
    );

-- Only a team's OWN manager or coach may join it to a squad, or take it out
-- again. Nobody can enrol a team they do not run.
DROP POLICY IF EXISTS squad_members_write ON public.squad_members;
CREATE POLICY squad_members_write ON public.squad_members
    FOR ALL TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','team_manager'])
    );

DROP TRIGGER IF EXISTS squads_touch ON public.squads;
CREATE TRIGGER squads_touch BEFORE UPDATE ON public.squads
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS squad_members_touch ON public.squad_members;
CREATE TRIGGER squad_members_touch BEFORE UPDATE ON public.squad_members
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
