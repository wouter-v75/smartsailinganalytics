-- ============================================================================
-- SSA Campaign Engine — 0016 debrief + the ONE backlog
--
--   • clip_notes          — timestamped debrief annotations on a clip.
--   • backlog_items       — the single prioritised backlog: actions, FMEA,
--                           tasks, deliverables, milestones (one table,
--                           discriminated by `kind`). Filtered to a sub-team
--                           via subteam_id; testability gated by a wind band.
--   • session_plan_items  — the day plan: an ordered selection of backlog
--                           items chosen for a session (join, not a copy).
--   • cross-FKs           — wires runs.backlog_item_id and
--                           clip_notes.promoted_to_id now that backlog_items
--                           exists (resolves the 0015 forward-reference).
--
-- Design decisions (from docs/campaign-spine-schema.md & operating-model.md):
--   D1  one backlog table, FMEA S/O/D/RPN in meta JSONB.
--   priority: SMALLINT 1..5, set top-down (coach/afterguard); sub-teams filter.
--   wind band: simple min/max kt, both NULL = "any condition".
--   day plan: a join table (an item may be planned across several days).
--
-- RLS matches 0003. Idempotent. Run after 0015.
-- ============================================================================

-- ── clip_notes ───────────────────────────────────────────────────────────────
-- promoted_to_id FK is added after backlog_items exists (below).
CREATE TABLE IF NOT EXISTS public.clip_notes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id           UUID NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    t_offset_ms        INTEGER,            -- timestamp within the clip the note pins to
    body               TEXT NOT NULL,
    promoted_to_id     UUID,               -- FK → backlog_items, added below
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clip_notes_video_idx     ON public.clip_notes(video_id, t_offset_ms);
CREATE INDEX IF NOT EXISTS clip_notes_session_idx   ON public.clip_notes(session_id);
CREATE INDEX IF NOT EXISTS clip_notes_team_boat_idx ON public.clip_notes(team_id, boat_id);

-- ── backlog_items — the ONE backlog ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.backlog_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    kind               TEXT NOT NULL DEFAULT 'task'
                       CHECK (kind IN ('action','fmea','task','deliverable','milestone')),
    -- Functional-area owner = the sub-team filter. NULL = unassigned (treat as
    -- whole-team in the UI). FK keeps it in step with the team's vocabulary.
    subteam_id         UUID REFERENCES public.subteams(id) ON DELETE SET NULL,
    title              TEXT NOT NULL,
    body               TEXT,
    status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','done','parked','wontfix')),
    priority           SMALLINT
                       CHECK (priority IS NULL OR (priority BETWEEN 1 AND 5)),
    owner_user_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    target_session_id  UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    due_date           DATE,
    is_milestone       BOOLEAN NOT NULL DEFAULT false,
    -- Testable wind band, knots. Both NULL = "any condition". Powers the
    -- on-water "what can we test in this breeze?" re-sort.
    wind_min_kt        NUMERIC,
    wind_max_kt        NUMERIC,
    -- Provenance — the differentiator vs a generic task list.
    source_note_id     UUID REFERENCES public.clip_notes(id) ON DELETE SET NULL,
    source_run_id      UUID REFERENCES public.runs(id) ON DELETE SET NULL,
    source_clip_id     UUID REFERENCES public.videos(id) ON DELETE SET NULL,
    meta               JSONB,   -- kind-specific extras; FMEA: {severity,occurrence,detection,rpn}
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backlog_team_boat_idx ON public.backlog_items(team_id, boat_id);
CREATE INDEX IF NOT EXISTS backlog_subteam_idx   ON public.backlog_items(subteam_id);
CREATE INDEX IF NOT EXISTS backlog_status_idx     ON public.backlog_items(team_id, status, priority);
CREATE INDEX IF NOT EXISTS backlog_kind_idx       ON public.backlog_items(team_id, kind);
CREATE INDEX IF NOT EXISTS backlog_wind_idx       ON public.backlog_items(wind_min_kt, wind_max_kt);

-- ── resolve forward references now that backlog_items exists ──────────────────
-- clip_notes.promoted_to_id → backlog_items
ALTER TABLE public.clip_notes
    DROP CONSTRAINT IF EXISTS clip_notes_promoted_to_fk;
ALTER TABLE public.clip_notes
    ADD CONSTRAINT clip_notes_promoted_to_fk
    FOREIGN KEY (promoted_to_id) REFERENCES public.backlog_items(id) ON DELETE SET NULL;

-- runs.backlog_item_id → backlog_items (the plan item that drove the run)
ALTER TABLE public.runs
    DROP CONSTRAINT IF EXISTS runs_backlog_item_fk;
ALTER TABLE public.runs
    ADD CONSTRAINT runs_backlog_item_fk
    FOREIGN KEY (backlog_item_id) REFERENCES public.backlog_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS runs_backlog_item_idx ON public.runs(backlog_item_id);

-- ── session_plan_items — the day plan (ordered selection for a session) ───────
CREATE TABLE IF NOT EXISTS public.session_plan_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    backlog_item_id    UUID NOT NULL REFERENCES public.backlog_items(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    seq                INTEGER,
    status             TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned','answered','skipped')),
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, backlog_item_id)
);

CREATE INDEX IF NOT EXISTS plan_items_session_idx   ON public.session_plan_items(session_id, seq);
CREATE INDEX IF NOT EXISTS plan_items_team_boat_idx ON public.session_plan_items(team_id, boat_id);

-- ── updated_at triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS clip_notes_touch ON public.clip_notes;
CREATE TRIGGER clip_notes_touch BEFORE UPDATE ON public.clip_notes
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS backlog_items_touch ON public.backlog_items;
CREATE TRIGGER backlog_items_touch BEFORE UPDATE ON public.backlog_items
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.clip_notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backlog_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_plan_items ENABLE ROW LEVEL SECURITY;

-- clip_notes
DROP POLICY IF EXISTS clip_notes_select ON public.clip_notes;
DROP POLICY IF EXISTS clip_notes_insert ON public.clip_notes;
DROP POLICY IF EXISTS clip_notes_update ON public.clip_notes;
DROP POLICY IF EXISTS clip_notes_delete ON public.clip_notes;
CREATE POLICY clip_notes_select ON public.clip_notes FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY clip_notes_insert ON public.clip_notes FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY clip_notes_update ON public.clip_notes FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));
CREATE POLICY clip_notes_delete ON public.clip_notes FOR DELETE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));

-- backlog_items — anyone with boat access reads the shared backlog; coach/tl1/tl2
-- create; author-or-coach edit; coach deletes.
DROP POLICY IF EXISTS backlog_items_select ON public.backlog_items;
DROP POLICY IF EXISTS backlog_items_insert ON public.backlog_items;
DROP POLICY IF EXISTS backlog_items_update ON public.backlog_items;
DROP POLICY IF EXISTS backlog_items_delete ON public.backlog_items;
CREATE POLICY backlog_items_select ON public.backlog_items FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY backlog_items_insert ON public.backlog_items FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY backlog_items_update ON public.backlog_items FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id))
    WITH CHECK (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));
CREATE POLICY backlog_items_delete ON public.backlog_items FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- session_plan_items
DROP POLICY IF EXISTS plan_items_select ON public.session_plan_items;
DROP POLICY IF EXISTS plan_items_insert ON public.session_plan_items;
DROP POLICY IF EXISTS plan_items_update ON public.session_plan_items;
DROP POLICY IF EXISTS plan_items_delete ON public.session_plan_items;
CREATE POLICY plan_items_select ON public.session_plan_items FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY plan_items_insert ON public.session_plan_items FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY plan_items_update ON public.session_plan_items FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY plan_items_delete ON public.session_plan_items FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clip_notes         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backlog_items      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_plan_items TO authenticated;
REVOKE ALL ON public.clip_notes         FROM anon;
REVOKE ALL ON public.backlog_items      FROM anon;
REVOKE ALL ON public.session_plan_items FROM anon;
