-- 0049 — Let TL3 (and team_manager) upload: add them to the sessions / videos /
-- photos INSERT policies.
--
-- THE BUG: these three INSERT policies date from 0003 and were last touched by 0007,
-- both of which predate the `tl3` role. They allow:
--
--     ARRAY['coach', 'tl1', 'tl2', 'consultant']
--
-- …which omits `tl3` — the MOST senior of the TL ladder (Boat Config is tl3-and-above,
-- so tl3 outranks tl2). Everywhere else in the schema the modern convention is
-- ARRAY['coach','tl3','team_manager'] (32 occurrences), so this is an oversight from
-- when tl3 was introduced, not a deliberate restriction.
--
-- THE SYMPTOM: a TL3 imports clips on their phone, taps Upload, and the upload
-- "completes" in under a second having done nothing. RLS refused the INSERT into
-- `videos`, the client discarded the status, and the queue reported success. So the
-- footage never left the device and no coach ever saw it. Same for a TL3 creating a
-- session row or uploading photos.
--
-- Client-side error reporting is fixed separately (the upload now surfaces the HTTP
-- status instead of swallowing it); this migration fixes the actual permission.
--
-- `tl1`/`tl2`/`consultant` are preserved so nobody who could upload before loses it.

-- ── sessions ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sessions_insert ON public.sessions;
CREATE POLICY sessions_insert ON public.sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
    );

-- ── videos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS videos_insert ON public.videos;
CREATE POLICY videos_insert ON public.videos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
    );

-- ── photos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS photos_insert ON public.photos;
CREATE POLICY photos_insert ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
    );

-- NOTE: UPDATE on videos is `own_or_coach(team_id, created_by_user_id)`, so a TL3 can
-- still update the rows they created (the proxy/original flags the upload writes back)
-- without this migration widening anything else.
