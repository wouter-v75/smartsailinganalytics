-- ============================================================================
-- SSA L3.0 — data schema (sessions, photos, videos, mast_settings, tag_lists)
--
-- All five tables are scoped to (team, boat). RLS is enforced via the helper
-- functions defined in 0002_rls_policies.sql:
--   has_boat_access(team, boat)  → SELECT gate, respects consultant window
--   has_team_role(team, [roles]) → INSERT / UPDATE / DELETE gates
--   is_admin()                   → escape hatch for site admin
--
-- Run after 0001 and 0002. Idempotent.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- sessions — a sailing day for one boat. Aggregates videos, photos,
-- mast_settings, log/xml.
--
-- One row per (boat, date). Date is stored as YYYY-MM-DD; we keep timezone
-- handling at the app layer because race day spans local-tz midnight on
-- some camera/log files.
--
-- created_by_user_id is the user who created the row, kept for audit only;
-- visibility is governed by team / boat membership, not ownership.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    date               DATE NOT NULL,
    title              TEXT,
    log_data           JSONB,                 -- parsed log file (small)
    xml_data           JSONB,                 -- parsed Expedition / SailRacer xml
    tz_offset_minutes  INTEGER,               -- session timezone vs UTC
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (boat_id, date)
);

CREATE INDEX IF NOT EXISTS sessions_team_boat_idx
    ON public.sessions(team_id, boat_id, date DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- videos — metadata for a clip belonging to a session.
--
-- The blob itself lives in Bunny Stream (referenced by bunny_stream_id) or
-- Bunny Storage (bunny_storage_path); both are nullable since some videos
-- may only ever live locally (legacy IndexedDB) until uploaded.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.videos (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm for RLS
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm for RLS
    title              TEXT,
    start_utc          TIMESTAMPTZ,
    duration_ms        INTEGER,
    tags               JSONB DEFAULT '[]'::jsonb,
    sync_offset_secs   INTEGER NOT NULL DEFAULT 0,
    thumbnail_url      TEXT,
    bunny_stream_id    TEXT,
    bunny_storage_path TEXT,
    bytes              BIGINT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS videos_session_idx ON public.videos(session_id, start_utc);
CREATE INDEX IF NOT EXISTS videos_team_boat_idx ON public.videos(team_id, boat_id);

-- ────────────────────────────────────────────────────────────────────────────
-- photos — photo metadata + SailScan analysis. Blob lives in Bunny Storage.
-- analysis_data is a JSON blob that grows with the SailScan pipeline; keeping
-- it as JSONB lets us evolve the shape without migrations.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.photos (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm for RLS
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm for RLS
    taken_utc          TIMESTAMPTZ,
    exif_data          JSONB,
    bunny_storage_path TEXT,
    thumbnail_url      TEXT,
    bytes              BIGINT,
    analysis_data      JSONB,                 -- SailScan results: stripes, mids, metrics
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS photos_session_idx ON public.photos(session_id, taken_utc);
CREATE INDEX IF NOT EXISTS photos_team_boat_idx ON public.photos(team_id, boat_id);

-- ────────────────────────────────────────────────────────────────────────────
-- mast_settings — pre-race rig setup snapshot per session.
-- Schema is intentionally a JSON blob since rig parameters vary by class.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mast_settings (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    settings           JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- tag_lists — editable tag vocabulary per (team, boat). Used by the
-- video/photo tagger UI. boat_id NULL means "team-wide tag list" (visible
-- to every boat in the team).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tag_lists (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID REFERENCES public.boats(id) ON DELETE CASCADE,
    tags               JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, boat_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- updated_at triggers — sessions, mast_settings, tag_lists. Cheap helper to
-- keep updated_at fresh without app code touching it.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_touch ON public.sessions;
CREATE TRIGGER sessions_touch
    BEFORE UPDATE ON public.sessions
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS mast_settings_touch ON public.mast_settings;
CREATE TRIGGER mast_settings_touch
    BEFORE UPDATE ON public.mast_settings
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS tag_lists_touch ON public.tag_lists;
CREATE TRIGGER tag_lists_touch
    BEFORE UPDATE ON public.tag_lists
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — enable on every new table.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.videos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mast_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_lists     ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- Permission matrix (matches docs/auth/permissions.md):
--
--   SELECT  : has_boat_access(team_id, boat_id)  ⇒ any role with active
--             membership covering this boat (consultant honours window).
--   INSERT  : team role is coach/tl1/tl2  (consultant ❌).
--   UPDATE  : team role is coach/tl1/tl2 AND row was created by self
--             OR team role is coach (coach can edit anyone's).
--   DELETE  : team role is coach.
--
-- Admin bypasses every gate.
-- ────────────────────────────────────────────────────────────────────────────

-- Helper to keep the policies short.
-- own_or_coach: true if the row's created_by_user_id is the caller, OR the
-- caller is a coach for the row's team.
CREATE OR REPLACE FUNCTION public.own_or_coach(p_team_id UUID, p_creator UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT auth.uid() = p_creator
        OR public.has_team_role(p_team_id, ARRAY['coach']);
$$;

-- ── sessions ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sessions_select   ON public.sessions;
DROP POLICY IF EXISTS sessions_insert   ON public.sessions;
DROP POLICY IF EXISTS sessions_update   ON public.sessions;
DROP POLICY IF EXISTS sessions_delete   ON public.sessions;

CREATE POLICY sessions_select ON public.sessions
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

CREATE POLICY sessions_insert ON public.sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2'])
    );

CREATE POLICY sessions_update ON public.sessions
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    )
    WITH CHECK (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    );

CREATE POLICY sessions_delete ON public.sessions
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

-- ── videos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS videos_select ON public.videos;
DROP POLICY IF EXISTS videos_insert ON public.videos;
DROP POLICY IF EXISTS videos_update ON public.videos;
DROP POLICY IF EXISTS videos_delete ON public.videos;

CREATE POLICY videos_select ON public.videos
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

CREATE POLICY videos_insert ON public.videos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2'])
    );

CREATE POLICY videos_update ON public.videos
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    )
    WITH CHECK (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    );

CREATE POLICY videos_delete ON public.videos
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

-- ── photos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS photos_select ON public.photos;
DROP POLICY IF EXISTS photos_insert ON public.photos;
DROP POLICY IF EXISTS photos_update ON public.photos;
DROP POLICY IF EXISTS photos_delete ON public.photos;

CREATE POLICY photos_select ON public.photos
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

CREATE POLICY photos_insert ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2'])
    );

CREATE POLICY photos_update ON public.photos
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    )
    WITH CHECK (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    );

CREATE POLICY photos_delete ON public.photos
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

-- ── mast_settings ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS mast_settings_select ON public.mast_settings;
DROP POLICY IF EXISTS mast_settings_insert ON public.mast_settings;
DROP POLICY IF EXISTS mast_settings_update ON public.mast_settings;
DROP POLICY IF EXISTS mast_settings_delete ON public.mast_settings;

CREATE POLICY mast_settings_select ON public.mast_settings
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));

CREATE POLICY mast_settings_insert ON public.mast_settings
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2'])
    );

CREATE POLICY mast_settings_update ON public.mast_settings
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    )
    WITH CHECK (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
    );

CREATE POLICY mast_settings_delete ON public.mast_settings
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

-- ── tag_lists ───────────────────────────────────────────────────────────────
-- Slightly different: anyone with team access can SELECT; only coach/tl2
-- can edit. tl1 reads but doesn't curate.
DROP POLICY IF EXISTS tag_lists_select ON public.tag_lists;
DROP POLICY IF EXISTS tag_lists_insert ON public.tag_lists;
DROP POLICY IF EXISTS tag_lists_update ON public.tag_lists;
DROP POLICY IF EXISTS tag_lists_delete ON public.tag_lists;

CREATE POLICY tag_lists_select ON public.tag_lists
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (boat_id IS NULL AND public.is_team_member(team_id))
        OR (boat_id IS NOT NULL AND public.has_boat_access(team_id, boat_id))
    );

CREATE POLICY tag_lists_insert ON public.tag_lists
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl2'])
    );

CREATE POLICY tag_lists_update ON public.tag_lists
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl2'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl2'])
    );

CREATE POLICY tag_lists_delete ON public.tag_lists
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

-- ────────────────────────────────────────────────────────────────────────────
-- Grants.
-- ────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.videos        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photos        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mast_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tag_lists     TO authenticated;

REVOKE ALL ON public.sessions      FROM anon;
REVOKE ALL ON public.videos        FROM anon;
REVOKE ALL ON public.photos        FROM anon;
REVOKE ALL ON public.mast_settings FROM anon;
REVOKE ALL ON public.tag_lists     FROM anon;
