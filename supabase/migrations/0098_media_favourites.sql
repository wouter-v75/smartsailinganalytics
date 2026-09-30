-- ============================================================================
-- SSA — 0098  media_favourites: a person's own favourite photos and videos
--
-- The heart on every photo and clip — thumbnail and viewer, in the timeline,
-- the Videos and Photos tabs and a sail's media — and the "favourites only"
-- filter above each. PERSONAL: a favourite is one user's, seen by nobody else,
-- so a crew of twelve can each keep their own reel without it becoming a vote.
--
-- One row per (user, kind, media). `kind` because photos and videos are two
-- tables; there is no foreign key to either for the same reason, and a row
-- whose photo has gone is harmless — nothing lists favourites without joining
-- to what is still there. `team_id` is copied from the media row by the API
-- (src/app/api/favourites/route.ts), for the delete-with-the-team cascade and
-- so a later "the team's most-loved" has something to group by.
--
-- RLS: a user reads, adds and removes only their own rows. Admins get no
-- special read — a personal favourite is not audit data.
--
-- Additive, idempotent. Run after 0097.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_favourites (
    user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
    kind       TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
    media_id   UUID NOT NULL,
    team_id    UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, media_id)
);

CREATE INDEX IF NOT EXISTS media_favourites_user_idx ON public.media_favourites(user_id, created_at DESC);

ALTER TABLE public.media_favourites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_favourites_select ON public.media_favourites;
CREATE POLICY media_favourites_select ON public.media_favourites FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS media_favourites_insert ON public.media_favourites;
CREATE POLICY media_favourites_insert ON public.media_favourites FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS media_favourites_delete ON public.media_favourites;
CREATE POLICY media_favourites_delete ON public.media_favourites FOR DELETE TO authenticated
    USING (user_id = auth.uid());

COMMENT ON TABLE public.media_favourites IS
    'A user''s own favourite photos and videos (the heart). Personal: RLS shows each user only their rows. See 0098.';
