-- ============================================================================
-- SSA — 0062  The tagger.
--
-- Three kinds of tag, one timeline:
--
--   general   — the boat/team vocabulary everyone shares (the old tag_lists,
--               now first-class rows with a colour and a minimum role).
--   section   — owned by a CREW SECTION (afterguard, trim, pit, bow, nav …).
--               Offered to that section's crew; readable by everyone who can
--               already read the day, so a trimmer's tag is still visible to
--               the navigator reviewing the same leg.
--   personal  — private to one user. Never leaves their account.
--
-- Three tables:
--   memberships.section  the crew section a membership sails in (NULL = none)
--   ssa_tag_defs         the VOCABULARY: what tags exist and who may apply them
--   ssa_tag_events       APPLIED tags: one row per tag on the day's timeline,
--                        each with its own [t0, t1) window and optional media
--                        target. This is what the .ssa event file serialises.
--   ssa_phases           steady-state phase segments (the 30 s auto-phases the
--                        tagger cuts out of a selected part of the track).
--
-- Gating is enforced TWICE, as everywhere else in SSA: RLS below is the
-- authority, src/lib/tagging/gating.ts is the UI's copy so the app never
-- offers something the database will refuse.
--
-- RLS sets the COARSE tier (may this role touch tags at all, is this their
-- section). A definition's own `min_role` narrows it further per tag — that one
-- is checked in the API route and the UI, because it is editorial policy the
-- crew sets for itself, not a security boundary.
--
-- Idempotent. Run after 0061.
-- ============================================================================

-- ── 1. Crew section on a membership ─────────────────────────────────────────
-- Free text with a CHECK so the app and the database agree on the vocabulary;
-- extend the list here and in src/lib/tagging/sections.ts together.
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_section_check;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_section_check
    CHECK (section IS NULL OR section IN (
        'afterguard', 'navigation', 'helm', 'trim', 'pit', 'mast', 'bow',
        'grinders', 'coaching', 'shore', 'media'
    ));

-- Which sections a user sails in, for the current team/boat. SECURITY DEFINER so
-- the policies below can consult memberships without recursing through its RLS.
CREATE OR REPLACE FUNCTION public.my_sections(p_team_id UUID, p_boat_id UUID)
RETURNS TEXT[]
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT COALESCE(array_agg(DISTINCT m.section) FILTER (WHERE m.section IS NOT NULL), '{}')
      FROM public.memberships m
     WHERE m.user_id = auth.uid()
       AND m.team_id = p_team_id
       AND (m.boat_id IS NULL OR p_boat_id IS NULL OR m.boat_id = p_boat_id)
       AND (m.valid_from IS NULL OR m.valid_from <= now())
       AND (m.valid_to   IS NULL OR m.valid_to   >= now());
$$;

-- ── 2. ssa_tag_defs — the vocabulary ────────────────────────────────────────
-- slug is the stable key (lower-kebab); label is what the crew reads.
-- min_role is the LOWEST membership role that may APPLY the tag — 'tl1' means
-- everyone from TL1 up, 'tl3' keeps it to the afterguard tier, and so on.
-- section is set (and required) only for scope='section'.
-- owner_user_id is set (and required) only for scope='personal'.
CREATE TABLE IF NOT EXISTS public.ssa_tag_defs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id       UUID REFERENCES public.boats(id) ON DELETE CASCADE,  -- NULL = whole team
    scope         TEXT NOT NULL CHECK (scope IN ('general', 'section', 'personal')),
    section       TEXT,
    owner_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    slug          TEXT NOT NULL,
    label         TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '#06B6D4',
    min_role      TEXT NOT NULL DEFAULT 'tl1',
    kind          TEXT NOT NULL DEFAULT 'point' CHECK (kind IN ('point', 'range')),
    builtin       BOOLEAN NOT NULL DEFAULT FALSE,   -- seeded from the app's base vocabulary
    archived      BOOLEAN NOT NULL DEFAULT FALSE,
    sort          INTEGER NOT NULL DEFAULT 100,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ssa_tag_defs_scope_shape CHECK (
        (scope = 'section'  AND section IS NOT NULL AND owner_user_id IS NULL) OR
        (scope = 'personal' AND owner_user_id IS NOT NULL AND section IS NULL) OR
        (scope = 'general'  AND section IS NULL AND owner_user_id IS NULL)
    )
);

-- One definition per (team, boat, scope, section/owner, slug). COALESCE keeps the
-- uniqueness real across the nullable discriminators (a plain UNIQUE would let
-- duplicates through, since NULL <> NULL).
CREATE UNIQUE INDEX IF NOT EXISTS ssa_tag_defs_unique_idx ON public.ssa_tag_defs (
    team_id,
    COALESCE(boat_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scope,
    COALESCE(section, ''),
    COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slug
);
CREATE INDEX IF NOT EXISTS ssa_tag_defs_team_idx ON public.ssa_tag_defs (team_id, boat_id, scope);

-- ── 3. ssa_tag_events — applied tags on the day's timeline ──────────────────
-- Every tag the crew puts on the timeline, with its own window. A point tag has
-- t1 = t0. target_kind/target_id attach it to a clip, photo or scan instead of
-- (or as well as) the track; 'track' means the day's own time axis.
CREATE TABLE IF NOT EXISTS public.ssa_tag_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    session_id    UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    session_date  DATE NOT NULL,                     -- the day this tag belongs to
    tag_def_id    UUID REFERENCES public.ssa_tag_defs(id) ON DELETE SET NULL,
    -- Denormalised from the definition so the event file and the filters stay
    -- readable even if the definition is later renamed or archived.
    slug          TEXT NOT NULL,
    label         TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '#06B6D4',
    scope         TEXT NOT NULL CHECK (scope IN ('general', 'section', 'personal')),
    section       TEXT,
    owner_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    t0            TIMESTAMPTZ NOT NULL,
    t1            TIMESTAMPTZ NOT NULL,
    target_kind   TEXT NOT NULL DEFAULT 'track'
                  CHECK (target_kind IN ('track', 'video', 'photo', 'scan', 'phase')),
    target_id     TEXT,
    note          TEXT,
    source        TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'auto', 'ai')),
    meta          JSONB,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ssa_tag_events_window CHECK (t1 >= t0),
    CONSTRAINT ssa_tag_events_scope_shape CHECK (
        (scope = 'section'  AND section IS NOT NULL AND owner_user_id IS NULL) OR
        (scope = 'personal' AND owner_user_id IS NOT NULL AND section IS NULL) OR
        (scope = 'general'  AND section IS NULL AND owner_user_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS ssa_tag_events_day_idx    ON public.ssa_tag_events (boat_id, session_date, t0);
CREATE INDEX IF NOT EXISTS ssa_tag_events_slug_idx   ON public.ssa_tag_events (boat_id, slug);
CREATE INDEX IF NOT EXISTS ssa_tag_events_target_idx ON public.ssa_tag_events (target_kind, target_id);

-- ── 4. ssa_phases — steady-state segments cut from the track ────────────────
-- The tagger's phase builder writes these: pick a stretch of the day, it slices
-- it into fixed-length (default 30 s) phases and drops the ones whose log data
-- is not steady enough to average. `rejected` keeps the discarded slices so the
-- crew can see WHY a gap is there rather than wondering.
CREATE TABLE IF NOT EXISTS public.ssa_phases (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    session_id    UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    session_date  DATE NOT NULL,
    batch_id      UUID NOT NULL,                     -- one "build phases" run
    t0            TIMESTAMPTZ NOT NULL,
    t1            TIMESTAMPTZ NOT NULL,
    mode          TEXT CHECK (mode IN ('up', 'down', 'reach')),
    tack          TEXT CHECK (tack IN ('port', 'stbd')),
    n_samples     INTEGER NOT NULL DEFAULT 0,
    rejected      BOOLEAN NOT NULL DEFAULT FALSE,
    reject_reason TEXT,
    metrics       JSONB,
    source        TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('human', 'auto', 'ai')),
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ssa_phases_window CHECK (t1 > t0)
);

CREATE INDEX IF NOT EXISTS ssa_phases_day_idx   ON public.ssa_phases (boat_id, session_date, t0);
CREATE INDEX IF NOT EXISTS ssa_phases_batch_idx ON public.ssa_phases (batch_id);

-- ── 5. updated_at triggers ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS ssa_tag_defs_touch ON public.ssa_tag_defs;
CREATE TRIGGER ssa_tag_defs_touch BEFORE UPDATE ON public.ssa_tag_defs
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS ssa_tag_events_touch ON public.ssa_tag_events;
CREATE TRIGGER ssa_tag_events_touch BEFORE UPDATE ON public.ssa_tag_events
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.ssa_tag_defs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ssa_tag_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ssa_phases     ENABLE ROW LEVEL SECURITY;

-- Definitions: a personal tag is visible ONLY to its owner; general and section
-- definitions to anyone with boat access. (Section tags are readable team-wide
-- on purpose — you should be able to see what the bow called a moment even if
-- you can't apply their tags yourself.)
DROP POLICY IF EXISTS ssa_tag_defs_select ON public.ssa_tag_defs;
CREATE POLICY ssa_tag_defs_select ON public.ssa_tag_defs
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal' AND public.has_boat_access(team_id, boat_id))
    );

-- Writing the vocabulary: personal tags are the user's own business; general and
-- section definitions are curated by TL3 and up (the tier that already edits the
-- campaign). A section definition additionally has to be for a section the writer
-- actually sails in — coach/manager/admin excepted, they curate for everyone.
DROP POLICY IF EXISTS ssa_tag_defs_insert ON public.ssa_tag_defs;
CREATE POLICY ssa_tag_defs_insert ON public.ssa_tag_defs
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (scope = 'personal'
            AND owner_user_id = auth.uid()
            AND public.is_team_member(team_id))
        OR (scope = 'general'
            AND public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']))
        -- A coach or manager curates any section's vocabulary; a TL3 curates
        -- only the section they actually sail in.
        OR (scope = 'section'
            AND (public.has_team_role(team_id, ARRAY['coach', 'team_manager'])
                 OR (public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );

DROP POLICY IF EXISTS ssa_tag_defs_update ON public.ssa_tag_defs;
CREATE POLICY ssa_tag_defs_update ON public.ssa_tag_defs
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal' AND public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']))
    );

DROP POLICY IF EXISTS ssa_tag_defs_delete ON public.ssa_tag_defs;
CREATE POLICY ssa_tag_defs_delete ON public.ssa_tag_defs
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal' AND public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']))
    );

-- Applied tags: same day-window read gate as every other piece of session data,
-- with personal tags again private to their owner.
DROP POLICY IF EXISTS ssa_tag_events_select ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_select ON public.ssa_tag_events
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal'
            AND public.has_boat_access_dated(team_id, boat_id, session_date))
    );

-- Applying a tag is crew work — TL1 and up (so owner passes too). A SECTION tag
-- may only be applied by someone in that section (or coach and above).
DROP POLICY IF EXISTS ssa_tag_events_insert ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_insert ON public.ssa_tag_events
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (scope = 'personal'
            AND owner_user_id = auth.uid()
            AND public.has_boat_access(team_id, boat_id))
        OR (scope = 'general'
            AND public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant']))
        OR (scope = 'section'
            AND (public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                 OR (public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );

-- Moving / editing a tag: its author, anyone in its section, or coach and above.
DROP POLICY IF EXISTS ssa_tag_events_update ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_update ON public.ssa_tag_events
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal'
            AND (created_by_user_id = auth.uid()
                 OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                 OR (scope = 'section'
                     AND public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );

DROP POLICY IF EXISTS ssa_tag_events_delete ON public.ssa_tag_events;
CREATE POLICY ssa_tag_events_delete ON public.ssa_tag_events
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR (scope = 'personal' AND owner_user_id = auth.uid())
        OR (scope <> 'personal'
            AND (created_by_user_id = auth.uid()
                 OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
                 OR (scope = 'section'
                     AND public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
                     AND section = ANY (public.my_sections(team_id, boat_id)))))
    );

-- Phases: read with the day, written by the crew (TL1+), tidied by coach+.
DROP POLICY IF EXISTS ssa_phases_select ON public.ssa_phases;
CREATE POLICY ssa_phases_select ON public.ssa_phases
    FOR SELECT TO authenticated
    USING (public.is_admin()
           OR public.has_boat_access_dated(team_id, boat_id, session_date));

DROP POLICY IF EXISTS ssa_phases_insert ON public.ssa_phases;
CREATE POLICY ssa_phases_insert ON public.ssa_phases
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant']));

DROP POLICY IF EXISTS ssa_phases_update ON public.ssa_phases;
CREATE POLICY ssa_phases_update ON public.ssa_phases
    FOR UPDATE TO authenticated
    USING (public.is_admin()
           OR created_by_user_id = auth.uid()
           OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']));

DROP POLICY IF EXISTS ssa_phases_delete ON public.ssa_phases;
CREATE POLICY ssa_phases_delete ON public.ssa_phases
    FOR DELETE TO authenticated
    USING (public.is_admin()
           OR created_by_user_id = auth.uid()
           OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']));
