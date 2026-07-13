-- 0051 — Restore the TL3 write policies. Two earlier migrations never took effect.
--
-- ── WHAT WE FOUND (from pg_policy on the live DB) ───────────────────────────
--   sessions_update  USING/CHECK = is_admin() OR own_or_coach(team_id, created_by_user_id)
--   sessions_insert  WITH CHECK  = is_admin() OR has_team_role(team_id, {coach,tl1,tl2})
--
-- Both are the ORIGINAL 0003 definitions:
--
--  • 0025_tl3_role.sql redefined sessions_update to also admit {tl3, team_manager}.
--    That is NOT what is live — so 0025's version was never applied (or was later
--    clobbered).
--  • 0049_tl3_upload_policies.sql (this session) rewrote the insert policies. Also NOT
--    live: TWO migration files shared the version prefix `0049`
--    (0049_fix_video_start_utc_mvhd_tz_retry.sql and 0049_tl3_upload_policies.sql).
--    Supabase records the VERSION, so once `0049` was marked applied the second file
--    was skipped forever. Hence this migration is 0051, not a re-issue of 0049.
--
-- ── THE BUG THIS CAUSED ────────────────────────────────────────────────────
-- `own_or_coach()` has no role escalation, and `sessions_update` lists no roles at all.
-- So a TL3 who did not create the session and is not a coach cannot UPDATE it. Every
-- write path that upserts the day's session row therefore failed for crew:
--
--     new row violates row-level security policy (USING expression) for table "sessions"
--
-- That is one policy silently breaking VIDEO upload, PHOTO upload and the LOG/event
-- cloud save — all of which upsert `sessions` (videos, photos and sessions/[date]).
-- TL3 could still INSERT only by luck: 0040's has_team_role() escalates tl3 through any
-- gate admitting tl1/tl2, and sessions_insert happens to list tl2.
--
-- Idempotent: DROP ... IF EXISTS then CREATE.

-- ── sessions: UPDATE ───────────────────────────────────────────────────────
-- Restores 0025's intent. The creator/coach path stays; tl3 + team_manager are added
-- back. tl1/tl2 reach it via has_team_role()'s escalation, same as everywhere else.
DROP POLICY IF EXISTS sessions_update ON public.sessions;
CREATE POLICY sessions_update ON public.sessions
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
        OR public.has_team_role(team_id, ARRAY['tl3', 'team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.own_or_coach(team_id, created_by_user_id)
        OR public.has_team_role(team_id, ARRAY['tl3', 'team_manager'])
    );

-- ── sessions / videos / photos: INSERT ─────────────────────────────────────
-- What 0049 meant to do. tl3 already squeaks through via the tl1/tl2 escalation, but
-- relying on that is fragile — name the roles explicitly. `consultant` is preserved
-- from 0007; team_manager is added so it matches the rest of the schema.
DROP POLICY IF EXISTS sessions_insert ON public.sessions;
CREATE POLICY sessions_insert ON public.sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
    );

DROP POLICY IF EXISTS videos_insert ON public.videos;
CREATE POLICY videos_insert ON public.videos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
    );

DROP POLICY IF EXISTS photos_insert ON public.photos;
CREATE POLICY photos_insert ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'tl3', 'team_manager', 'consultant'])
    );

-- ── Report what is now live, so this can't go unnoticed again ──────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT polname,
           CASE polcmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' ELSE polcmd::text END AS cmd
    FROM pg_policy
    WHERE polrelid IN ('public.sessions'::regclass, 'public.videos'::regclass, 'public.photos'::regclass)
      AND polcmd IN ('a', 'w')
    ORDER BY polname
  LOOP
    RAISE NOTICE '0051: % (%) reasserted', r.polname, r.cmd;
  END LOOP;
END $$;
