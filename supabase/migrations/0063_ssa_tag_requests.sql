-- ============================================================================
-- SSA — 0063  Requests, and private-by-default tags.
--
-- Two things the crew do with a tagged moment beyond tagging it.
--
-- 1. ASK FOR VIDEO. The bow wants to see the peel they just fluffed. A day makes
--    far more footage than anyone will ever upload, so pulling a clip is a
--    request someone approves rather than something that happens by default.
--    Approvers: coach / team manager / admin, and anyone in the MEDIA section —
--    the drone operator is the person who actually has the footage.
--
-- 2. ASK TO DEBRIEF IT. Different shape entirely: there is no approval. Anyone
--    nominates a moment, the nominations form the shortlist, and the coach picks
--    from that shortlist to build the evening's agenda. Selection IS the
--    approval, and it is recorded on the tag itself as reel_order.
--
--    Because nomination is open, several people asking about the same gybe is
--    itself information — so requests are one per person per tag, and the count
--    is worth showing.
--
-- Plus one column: ssa_tag_defs.private_by_default, so a "Personal note" can be
-- SHARED vocabulary whose every application is private. Without it a personal
-- tag definition would need an owner (see the scope-shape CHECK in 0062), which
-- would mean seeding one per user per team.
--
-- Idempotent. Run after 0062.
-- ============================================================================

-- ── 1. Private-by-default vocabulary ────────────────────────────────────────
-- The definition is general (everyone sees "Personal note" in the picker); each
-- APPLICATION of it is scope='personal' and owned by whoever pressed it, which
-- 0062's RLS already keeps private to them.
ALTER TABLE public.ssa_tag_defs
    ADD COLUMN IF NOT EXISTS private_by_default BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. ssa_tag_requests ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ssa_tag_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    session_date  DATE NOT NULL,
    tag_event_id  UUID NOT NULL REFERENCES public.ssa_tag_events(id) ON DELETE CASCADE,

    -- 'video'   → wants footage pulled; needs an approver.
    -- 'debrief' → wants it discussed; no approver, the coach's selection decides.
    kind          TEXT NOT NULL CHECK (kind IN ('video', 'debrief')),
    -- Only meaningful for kind='video'.
    media_kind    TEXT CHECK (media_kind IS NULL OR media_kind IN ('video', 'photo', 'drone')),

    -- A debrief request is born 'open' and is closed by the coach putting the tag
    -- on the reel (or explicitly declining it). A video request is born 'open'
    -- and an approver moves it on; 'fulfilled' means the clip actually exists.
    status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'approved', 'declined', 'fulfilled')),
    note          TEXT,

    requested_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by_user_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decided_at    TIMESTAMPTZ,
    decision_note TEXT,
    -- What was produced, once it exists (a video id, a photo key).
    asset_kind    TEXT,
    asset_id      TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A video request must say what medium; a debrief request must not.
    CONSTRAINT ssa_tag_requests_kind_shape CHECK (
        (kind = 'video'   AND media_kind IS NOT NULL) OR
        (kind = 'debrief' AND media_kind IS NULL)
    )
);

-- One request per person per tag per kind. Asking twice is editing your request,
-- and it keeps the nomination COUNT meaningful — five people wanting to talk
-- about the same gybe is the strongest signal the shortlist has.
CREATE UNIQUE INDEX IF NOT EXISTS ssa_tag_requests_one_each_idx
    ON public.ssa_tag_requests (tag_event_id, kind, requested_by_user_id);

CREATE INDEX IF NOT EXISTS ssa_tag_requests_day_idx
    ON public.ssa_tag_requests (boat_id, session_date, kind, status);
CREATE INDEX IF NOT EXISTS ssa_tag_requests_tag_idx
    ON public.ssa_tag_requests (tag_event_id);

DROP TRIGGER IF EXISTS ssa_tag_requests_touch ON public.ssa_tag_requests;
CREATE TRIGGER ssa_tag_requests_touch BEFORE UPDATE ON public.ssa_tag_requests
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 3. Who may approve a video request ──────────────────────────────────────
-- Coach, team manager and admin — plus anyone in the MEDIA section, because the
-- drone operator is the person who actually holds the footage and should not
-- need a coach's sign-off to hand over a clip they already have.
CREATE OR REPLACE FUNCTION public.can_approve_media(p_team_id UUID, p_boat_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT public.is_admin()
        OR public.has_team_role(p_team_id, ARRAY['coach', 'team_manager'])
        OR 'media' = ANY (public.my_sections(p_team_id, p_boat_id));
$$;

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.ssa_tag_requests ENABLE ROW LEVEL SECURITY;

-- Everyone who can read the day can see what has been asked for. That is the
-- point: a request nobody can see is a request nobody will action, and the
-- nomination count only means something if the crew can see it.
DROP POLICY IF EXISTS ssa_tag_requests_select ON public.ssa_tag_requests;
CREATE POLICY ssa_tag_requests_select ON public.ssa_tag_requests
    FOR SELECT TO authenticated
    USING (public.is_admin()
           OR public.has_boat_access_dated(team_id, boat_id, session_date));

-- Anyone who sails may ask. This is the whole point of the tagger: the bow asks
-- for their own peel without going through an analyst.
DROP POLICY IF EXISTS ssa_tag_requests_insert ON public.ssa_tag_requests;
CREATE POLICY ssa_tag_requests_insert ON public.ssa_tag_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        requested_by_user_id = auth.uid()
        AND (public.is_admin()
             OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant']))
    );

-- Editing: the requester may reword or withdraw their own; an approver may
-- decide a video request; the coach tier may decide a debrief nomination.
DROP POLICY IF EXISTS ssa_tag_requests_update ON public.ssa_tag_requests;
CREATE POLICY ssa_tag_requests_update ON public.ssa_tag_requests
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR requested_by_user_id = auth.uid()
        OR (kind = 'video'   AND public.can_approve_media(team_id, boat_id))
        OR (kind = 'debrief' AND public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager']))
    );

DROP POLICY IF EXISTS ssa_tag_requests_delete ON public.ssa_tag_requests;
CREATE POLICY ssa_tag_requests_delete ON public.ssa_tag_requests
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR requested_by_user_id = auth.uid()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'team_manager'])
    );
