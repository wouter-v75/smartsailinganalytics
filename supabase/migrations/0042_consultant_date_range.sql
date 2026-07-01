-- ============================================================================
-- SSA — date-range data access for consultants (and any membership).
--
-- A consultant (e.g. a sailmaker) is granted access to a SPECIFIC RANGE OF DAYS
-- of the archive — independent of the real-time login window (valid_from/
-- valid_to). Example: on 1 Jul, give a sailmaker view access to sessions dated
-- 25–27 Jun only.
--
--   memberships.data_from / data_to  (DATE, nullable)
--     NULL/NULL  → no date restriction (normal member — sees everything).
--     set        → the member may only SEE sessions/videos/photos whose session
--                  DATE falls within [data_from, data_to] (inclusive).
--
-- Read-only scope: this only affects SELECT. Write policies are unchanged (a
-- consultant's own uploads still follow the existing rules). Adding overlay
-- variables is a client-side view feature and needs no extra permission.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS data_from DATE;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS data_to   DATE;

-- Boat access that ALSO honours a membership's optional data-date window. When
-- data_from/data_to are NULL this is identical to has_boat_access(), so existing
-- members are unaffected.
CREATE OR REPLACE FUNCTION public.has_boat_access_dated(p_team_id UUID, p_boat_id UUID, p_date DATE)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships m
         WHERE m.user_id = auth.uid()
           AND m.team_id = p_team_id
           AND (m.boat_id IS NULL OR m.boat_id = p_boat_id)
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
           AND (m.data_from  IS NULL OR p_date IS NULL OR p_date >= m.data_from)
           AND (m.data_to    IS NULL OR p_date IS NULL OR p_date <= m.data_to)
    );
$$;

-- ── sessions — SELECT gated by the session's own date ────────────────────────
DROP POLICY IF EXISTS sessions_select ON public.sessions;
CREATE POLICY sessions_select ON public.sessions
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, date));

-- ── videos — gated by the parent session's date ──────────────────────────────
DROP POLICY IF EXISTS videos_select ON public.videos;
CREATE POLICY videos_select ON public.videos
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id,
             (SELECT s.date FROM public.sessions s WHERE s.id = session_id))
    );

-- ── photos — gated by the parent session's date ──────────────────────────────
DROP POLICY IF EXISTS photos_select ON public.photos;
CREATE POLICY photos_select ON public.photos
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id,
             (SELECT s.date FROM public.sessions s WHERE s.id = session_id))
    );
