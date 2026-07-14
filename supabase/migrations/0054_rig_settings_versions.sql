-- 0054_rig_settings_versions.sql
-- ---------------------------------------------------------------------------
-- HISTORY for the editable Upwind/Reaching rig settings tables.
--
-- Until now a save was destructive: the PATCH route overwrote
-- rig_tunes.data->'settingsTable' in place, so the previous numbers were gone
-- the moment you hit Save. The rig settings ARE the record of what the boat was
-- tuned to on a given day — losing them loses the ability to say "what were we
-- on in La Spezia?" or to walk a change back after a bad day.
--
-- This table is APPEND-ONLY: one row per save, holding the FULL settings table
-- as saved, plus the notes that go with it and who saved it when. The newest
-- row for a rig tune IS the current table (rig_tunes.data.settingsTable stays as
-- the fast read path, and stays authoritative for the app).
--
-- No UPDATE or DELETE policy is granted, deliberately: history you can quietly
-- rewrite is not history. Rows go when the rig tune or the boat does.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rig_settings_versions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id          UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id          UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    rig_tune_id      UUID NOT NULL REFERENCES public.rig_tunes(id) ON DELETE CASCADE,
    settings         JSONB NOT NULL,               -- { upwind: {band: cell}, reaching: {band: cell} }
    notes            TEXT,                         -- why this change was made
    saved_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    saved_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The history list is always "newest first, for this rig tune".
CREATE INDEX IF NOT EXISTS rig_settings_versions_tune_idx
    ON public.rig_settings_versions(rig_tune_id, saved_at DESC);
CREATE INDEX IF NOT EXISTS rig_settings_versions_boat_idx
    ON public.rig_settings_versions(boat_id, saved_at DESC);

ALTER TABLE public.rig_settings_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rig_settings_versions_select ON public.rig_settings_versions;
DROP POLICY IF EXISTS rig_settings_versions_insert ON public.rig_settings_versions;

-- Anyone who can see the boat's rig can see its history.
CREATE POLICY rig_settings_versions_select ON public.rig_settings_versions FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
-- Only the people who can edit the rig can add to it (same set as rig_tunes).
CREATE POLICY rig_settings_versions_insert ON public.rig_settings_versions FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
