-- 0070_trackers_and_training_days.sql
-- ---------------------------------------------------------------------------
-- The squad scope, and the devices that feed it.
--
-- Two additive changes, deliberately in one migration because the dinghy
-- ingestion path needs both and neither is useful alone. NOTHING existing is
-- altered beyond one nullable column: `sessions` keeps UNIQUE (boat_id, date)
-- and every foreign key that points at it.
--
-- WHY A PARENT RATHER THAN A WIDER SESSION
-- A session is one boat on one day, enforced by that uniqueness constraint, and
-- photos, videos, tags, session_phase_stats and session_phases all hang off
-- session_id. Making sessions multi-boat would break every one of them. A squad
-- day with six boats is six sessions plus one training_day that groups them —
-- and the training day is where the things that span boats live: the wind
-- solution, the drill timeline, the pair tests, the coach-boat track.
--
-- NAMING: `public.events` is ALREADY TAKEN by the audit log (action/details/ts).
-- It is not a regatta. Regattas live in the campaign spine (timeline_nodes).
-- Hence `training_days`, which is also what the thing actually is.
--
-- WHY THE COMPASS OFFSET IS ON THE TRACKER, NOT THE BOAT
-- Devices move between boats, so a magnetometer bias is a property of the
-- instrument. Measured on two real Atlas units sailing together: -5.1 deg and
-- -14.4 deg. It is only identifiable on a NON-TIDAL day, because a cross-wind
-- current produces exactly the same tack-independent signature -- hence
-- hdg_offset_source and hdg_offset_at, so a stale or ill-founded calibration is
-- visible rather than silently trusted.
-- ---------------------------------------------------------------------------

-- ── training_days ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.training_days (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id           UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    date              DATE NOT NULL,
    venue             TEXT,
    lat               DOUBLE PRECISION,
    lon               DOUBLE PRECISION,
    -- One clock for the whole squad. Six devices, six cameras, one offset.
    tz_offset_minutes INTEGER,
    title             TEXT,
    notes             TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, date, venue)
);

CREATE INDEX IF NOT EXISTS training_days_team_date_idx
    ON public.training_days(team_id, date DESC);

ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS training_day_id UUID
    REFERENCES public.training_days(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sessions_training_day_idx
    ON public.sessions(training_day_id);

-- ── trackers ───────────────────────────────────────────────────────────────
-- A physical device the squad owns. Tracker exports carry NO identity of their
-- own -- the published VKX spec has no serial, no boat name and no session
-- header, and the CSV export is the same -- so identity has to be held here and
-- in memberships, never read from the file.
CREATE TABLE IF NOT EXISTS public.trackers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,          -- 'vakaros' | 'velocitek' | 'sailmon' | 'phone' | 'garmin' | 'gopro'
    label       TEXT,                   -- what is written on the sticker: 'ATLAS-3'
    serial      TEXT,
    notes       TEXT,
    -- Per-device compass calibration. See the header for why it lives here.
    hdg_offset_deg    REAL,
    hdg_offset_source TEXT,             -- 'squad-solve' | 'manual'
    hdg_offset_at     DATE,             -- so a stale calibration is visible
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, label)
);

CREATE INDEX IF NOT EXISTS trackers_team_idx ON public.trackers(team_id);

-- Which boat a tracker was on, and when. The TackTracker pattern: a permanent
-- ID on the device plus a schedule mapping it to a competitor, rather than
-- writing the boat's name into the device.
CREATE TABLE IF NOT EXISTS public.tracker_assignments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracker_id  UUID NOT NULL REFERENCES public.trackers(id) ON DELETE CASCADE,
    boat_id     UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    valid_from  DATE NOT NULL,
    valid_to    DATE,                   -- NULL = still on that boat
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tracker_assignments_tracker_idx
    ON public.tracker_assignments(tracker_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS tracker_assignments_boat_idx
    ON public.tracker_assignments(boat_id, valid_from DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Uses the schema's OWN helpers (is_admin / has_boat_access / has_team_role /
-- own_or_coach) rather than re-implementing the membership test. Hand-rolling
-- it here would drift from every other table, and would also have got the
-- comparison wrong: memberships.valid_from/valid_to are TIMESTAMPTZ, not DATE.
ALTER TABLE public.training_days        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trackers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracker_assignments  ENABLE ROW LEVEL SECURITY;

-- training_days: a squad day is team-scoped, so any live member of the team may
-- read it; coaches and team leads may create and amend it.
DROP POLICY IF EXISTS training_days_select ON public.training_days;
CREATE POLICY training_days_select ON public.training_days
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','tl3','team_manager','owner','consultant']));

DROP POLICY IF EXISTS training_days_insert ON public.training_days;
CREATE POLICY training_days_insert ON public.training_days
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','team_manager']));

DROP POLICY IF EXISTS training_days_update ON public.training_days;
CREATE POLICY training_days_update ON public.training_days
    FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));

-- trackers: the squad's kit list. Readable by the team, managed by coaches.
DROP POLICY IF EXISTS trackers_select ON public.trackers;
CREATE POLICY trackers_select ON public.trackers
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','tl3','team_manager','owner','consultant']));

DROP POLICY IF EXISTS trackers_write ON public.trackers;
CREATE POLICY trackers_write ON public.trackers
    FOR ALL TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','team_manager']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2','team_manager']));

-- tracker_assignments: gated on the BOAT, so a sailor sees the assignments for
-- boats they have access to and not the rest of the squad's kit history.
DROP POLICY IF EXISTS tracker_assignments_select ON public.tracker_assignments;
CREATE POLICY tracker_assignments_select ON public.tracker_assignments
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.trackers t
            WHERE t.id = tracker_assignments.tracker_id
              AND public.has_boat_access(t.team_id, tracker_assignments.boat_id)
        )
    );

DROP POLICY IF EXISTS tracker_assignments_write ON public.tracker_assignments;
CREATE POLICY tracker_assignments_write ON public.tracker_assignments
    FOR ALL TO authenticated
    USING (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.trackers t
            WHERE t.id = tracker_assignments.tracker_id
              AND public.has_team_role(t.team_id, ARRAY['coach','tl1','tl2','team_manager'])
        )
    )
    WITH CHECK (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.trackers t
            WHERE t.id = tracker_assignments.tracker_id
              AND public.has_team_role(t.team_id, ARRAY['coach','tl1','tl2','team_manager'])
        )
    );
