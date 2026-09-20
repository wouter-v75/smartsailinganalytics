-- 0072_squad_share_media.sql
-- ---------------------------------------------------------------------------
-- The same "shared with the squad" decision, on videos and photos.
--
-- 0071 shared tracks only, on the reasoning that a track is a fact about where
-- a boat sailed while a video is a crew talking about its own mistakes. That
-- holds for a camera in the cockpit and NOT for the case that actually happens
-- most days: ONE drone operator or coach films the whole squad from the RIB.
-- That footage is of everybody, was taken by somebody working for everybody,
-- and keeping it locked to whichever team happened to upload it is the wrong
-- default in the other direction.
--
-- So the decision moves to the same place as the track's: per item, off by
-- default, set when it is uploaded and changeable afterwards. Onboard footage
-- with crew audio simply stays unticked, which is a choice the person who shot
-- it is in a position to make and the schema is not.
--
-- A NOTE ON WHAT THIS DOES NOT CHANGE: the video BYTES live in Bunny behind
-- signed URLs, and the route that signs them checks access. Sharing a row makes
-- the video visible to the squad through that route; it does not hand anyone a
-- permanent link. `video_shares` remains the way to give a clip to someone
-- outside SSA entirely.
-- ---------------------------------------------------------------------------

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS shared_with_squad BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.photos
    ADD COLUMN IF NOT EXISTS shared_with_squad BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS videos_shared_idx
    ON public.videos(session_id) WHERE shared_with_squad;
CREATE INDEX IF NOT EXISTS photos_shared_idx
    ON public.photos(session_id) WHERE shared_with_squad;

-- Extends 0042's policies; the date-gated clause is unchanged, so a consultant
-- whose window has closed still cannot see the media inside it.
DROP POLICY IF EXISTS videos_select ON public.videos;
CREATE POLICY videos_select ON public.videos
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id,
             (SELECT s.date FROM public.sessions s WHERE s.id = session_id))
        OR (shared_with_squad AND public.shares_squad_with(team_id))
    );

DROP POLICY IF EXISTS photos_select ON public.photos;
CREATE POLICY photos_select ON public.photos
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR public.has_boat_access_dated(team_id, boat_id,
             (SELECT s.date FROM public.sessions s WHERE s.id = session_id))
        OR (shared_with_squad AND public.shares_squad_with(team_id))
    );
