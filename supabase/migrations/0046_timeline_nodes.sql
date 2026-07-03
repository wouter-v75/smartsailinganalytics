-- ============================================================================
-- SSA — Timeline Tree (Phase 2 spine).
--
-- One typed, timestamped node per moment of a racing programme:
--   season → regatta → day → race → {start, tack, gybe, mark, finish}
--   plus event nodes (sail_change, weather, meeting, note, debrief, analysis).
-- The same tree renders as the season semantic-zoom timeline, the vertical day
-- feed, and the race scrubber; media + metrics hang off each node.
--
-- id is a DETERMINISTIC text key (e.g. "<boat>:<date>:race:1:tack:<utc>") so
-- producers can upsert idempotently. parent_id is a plain text edge (no FK, so
-- batch upserts don't depend on insert order). Written by producers when a
-- session is processed. See docs/regatta-os-spec-and-plan-2026-07.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.timeline_nodes (
  id            TEXT PRIMARY KEY,
  team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  parent_id     TEXT,                              -- tree edge (another node's id)

  kind          TEXT NOT NULL,                     -- season|regatta|day|race|start|tack|gybe|mark|finish|sail_change|weather|meeting|note|debrief|analysis
  t0            TIMESTAMPTZ NOT NULL,              -- window start (true UTC)
  t1            TIMESTAMPTZ NOT NULL,              -- window end (point events: t1 = t0)
  title         TEXT NOT NULL,
  subtitle      TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',      -- auto | human | ai
  producer      TEXT NOT NULL DEFAULT 'eventfile', -- eventfile | icon | log | sailscan | user | ai

  metrics       JSONB,                             -- denormalised { vmgPct, dHeel, tacks, ... }
  meta          JSONB,                             -- { raceNum, top, valid, sails, refs... }
  session_date  DATE,                              -- for the consultant date-window RLS

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timeline_nodes_boat_time_idx ON public.timeline_nodes (boat_id, t0);
CREATE INDEX IF NOT EXISTS timeline_nodes_parent_idx    ON public.timeline_nodes (parent_id);
CREATE INDEX IF NOT EXISTS timeline_nodes_boat_kind_idx ON public.timeline_nodes (boat_id, kind, t0);

ALTER TABLE public.timeline_nodes ENABLE ROW LEVEL SECURITY;

-- SELECT: same boat-access + consultant date-window gate as session media.
DROP POLICY IF EXISTS timeline_nodes_select ON public.timeline_nodes;
CREATE POLICY timeline_nodes_select ON public.timeline_nodes
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, session_date));

-- INSERT/UPDATE: team members who can write (tl1/tl2 gate covers the crew).
DROP POLICY IF EXISTS timeline_nodes_insert ON public.timeline_nodes;
CREATE POLICY timeline_nodes_insert ON public.timeline_nodes
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl2']));
DROP POLICY IF EXISTS timeline_nodes_update ON public.timeline_nodes;
CREATE POLICY timeline_nodes_update ON public.timeline_nodes
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl2']));
DROP POLICY IF EXISTS timeline_nodes_delete ON public.timeline_nodes;
CREATE POLICY timeline_nodes_delete ON public.timeline_nodes
  FOR DELETE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['tl1','tl2']));
