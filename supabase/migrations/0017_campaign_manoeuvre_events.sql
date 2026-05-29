-- ============================================================================
-- SSA Campaign Engine — 0017 manoeuvre events
--
-- One row per tack/gybe/round-up/bear-away, with loss/recovery metrics, so
-- boathandling becomes measurable and trendable across sessions. Auto-seedable
-- from Expedition tackJibe events (source='log-auto'); coach validates.
--
-- RLS matches 0003. Idempotent. Run after 0016.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.manoeuvre_events (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             UUID REFERENCES public.runs(id) ON DELETE CASCADE,      -- nullable
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    video_id           UUID REFERENCES public.videos(id) ON DELETE SET NULL,   -- link to clip if any
    utc                TIMESTAMPTZ,
    clip_offset_ms     INTEGER,
    kind               TEXT NOT NULL
                       CHECK (kind IN ('tack','gybe','roundup','bearaway')),
    vmg_loss           NUMERIC,   -- VMG lost (boat lengths)
    time_lost_s        NUMERIC,   -- seconds vs reference
    recovery_s         NUMERIC,   -- time to recover target speed
    entry_tws          NUMERIC,
    entry_twa          NUMERIC,
    valid              BOOLEAN NOT NULL DEFAULT true,   -- include in trends? (mirrors isValidPerf)
    source             TEXT NOT NULL DEFAULT 'manual'
                       CHECK (source IN ('log-auto','manual')),
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mano_run_idx        ON public.manoeuvre_events(run_id);
CREATE INDEX IF NOT EXISTS mano_session_idx    ON public.manoeuvre_events(session_id, kind);
CREATE INDEX IF NOT EXISTS mano_team_boat_idx  ON public.manoeuvre_events(team_id, boat_id);

-- ── updated_at trigger ───────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS manoeuvre_events_touch ON public.manoeuvre_events;
CREATE TRIGGER manoeuvre_events_touch BEFORE UPDATE ON public.manoeuvre_events
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.manoeuvre_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manoeuvre_events_select ON public.manoeuvre_events;
DROP POLICY IF EXISTS manoeuvre_events_insert ON public.manoeuvre_events;
DROP POLICY IF EXISTS manoeuvre_events_update ON public.manoeuvre_events;
DROP POLICY IF EXISTS manoeuvre_events_delete ON public.manoeuvre_events;
CREATE POLICY manoeuvre_events_select ON public.manoeuvre_events FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY manoeuvre_events_insert ON public.manoeuvre_events FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY manoeuvre_events_update ON public.manoeuvre_events FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));
CREATE POLICY manoeuvre_events_delete ON public.manoeuvre_events FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manoeuvre_events TO authenticated;
REVOKE ALL ON public.manoeuvre_events FROM anon;
