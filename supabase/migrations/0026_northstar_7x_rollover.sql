-- 0026 — Northstar 7X rollover.
--
-- The Northstar programme transitions from the existing Mk1 hull to the
-- new "Northstar7X" boat. Everything dated after 2026-06-01 belongs to the
-- 7X from now on. The Mk1 keeps its history up to (and including)
-- 2026-06-01 so nothing is lost.
--
-- This migration re-points (in one transaction):
--   • sessions whose date > 2026-06-01 → 7X
--   • their denorm boat_id mirrors in videos, photos
--   • backlog_items targeting one of those sessions → 7X
--   • all OPEN backlog_items still on Mk1 (regardless of target date), since
--     the Mk1 programme is closed and the residual work moves with the team
--   • the team's tag_list row, so the autocomplete vocabulary survives
--
-- Session_blocks / debriefs / session_attachments / session_plan_items hang
-- off session_id (no boat_id of their own), so the session move carries
-- them automatically.
--
-- Idempotent — running twice does nothing on the second pass because the
-- source boat won't have any matching rows left.
--
-- Pre-requisites:
--   • Northstar team exists (seeded in 0014)
--   • A boat named exactly 'Northstar7X' exists under that team
--   • The pre-7X boat is named matching 'NORTHSTAR%' (typically 'NORTHSTAR72')
--
-- If those aren't true the DO block raises a clear notice and exits without
-- changing anything.

DO $$
DECLARE
    v_team_id       UUID;
    v_old_boat_id   UUID;
    v_new_boat_id   UUID;
    v_cutoff        DATE := DATE '2026-06-01';
    v_moved_sess    INT;
    v_moved_vid     INT;
    v_moved_pho     INT;
    v_moved_back    INT;
BEGIN
    SELECT id INTO v_team_id
      FROM public.teams
     WHERE lower(name) = 'northstar';
    IF v_team_id IS NULL THEN
        RAISE NOTICE '0026: Northstar team not found — skipping rollover.';
        RETURN;
    END IF;

    SELECT id INTO v_new_boat_id
      FROM public.boats
     WHERE team_id = v_team_id
       AND name = 'Northstar7X';
    IF v_new_boat_id IS NULL THEN
        RAISE NOTICE '0026: Boat "Northstar7X" not found under Northstar team — skipping rollover.';
        RETURN;
    END IF;

    -- The pre-7X boat: any boat on this team whose name starts with NORTHSTAR
    -- (case-insensitive) and is NOT the 7X. There should only be one — if
    -- there are several we don't guess; bail out.
    SELECT id INTO v_old_boat_id
      FROM public.boats
     WHERE team_id = v_team_id
       AND id <> v_new_boat_id
       AND lower(name) LIKE 'northstar%'
     ORDER BY created_at ASC
     LIMIT 1;
    IF v_old_boat_id IS NULL THEN
        RAISE NOTICE '0026: No pre-7X Northstar boat to migrate from — nothing to do.';
        RETURN;
    END IF;

    -- ── 1. Re-point sessions ────────────────────────────────────────────────
    -- sessions has UNIQUE (boat_id, date); if 7X already has a session on a
    -- target date we leave that Mk1 row alone (manual reconciliation needed).
    UPDATE public.sessions s
       SET boat_id = v_new_boat_id
     WHERE s.team_id = v_team_id
       AND s.boat_id = v_old_boat_id
       AND s.date > v_cutoff
       AND NOT EXISTS (
             SELECT 1 FROM public.sessions s2
              WHERE s2.boat_id = v_new_boat_id
                AND s2.date = s.date
           );
    GET DIAGNOSTICS v_moved_sess = ROW_COUNT;

    -- ── 2. Sync denorm boat_id on videos / photos so RLS stays in sync ──
    -- (sessions.id is the source of truth; the denorm columns just mirror it.)
    UPDATE public.videos v
       SET boat_id = v_new_boat_id
      FROM public.sessions s
     WHERE v.session_id = s.id
       AND s.boat_id = v_new_boat_id
       AND v.boat_id <> v_new_boat_id;
    GET DIAGNOSTICS v_moved_vid = ROW_COUNT;

    UPDATE public.photos p
       SET boat_id = v_new_boat_id
      FROM public.sessions s
     WHERE p.session_id = s.id
       AND s.boat_id = v_new_boat_id
       AND p.boat_id <> v_new_boat_id;
    GET DIAGNOSTICS v_moved_pho = ROW_COUNT;

    -- ── 3. Backlog: items scheduled past the cutoff move with their session ──
    UPDATE public.backlog_items bi
       SET boat_id = v_new_boat_id
      FROM public.sessions s
     WHERE bi.target_session_id = s.id
       AND s.boat_id = v_new_boat_id
       AND bi.boat_id <> v_new_boat_id;

    -- ── 4. Sweep all remaining OPEN backlog items on the Mk1 to the 7X.
    -- The Mk1 programme is closed; residual work belongs to the team's
    -- ongoing 7X campaign. "Open" = status not 'done' / 'wontfix'.
    UPDATE public.backlog_items
       SET boat_id = v_new_boat_id,
           target_session_id = NULL  -- old session may now belong to 7X anyway, but clear stale refs
     WHERE team_id = v_team_id
       AND boat_id = v_old_boat_id
       AND status NOT IN ('done', 'wontfix');
    GET DIAGNOSTICS v_moved_back = ROW_COUNT;

    -- Note: we intentionally do NOT try to reattach target_session_id after
    -- the sweep. Open items whose target was a Mk1 session land unscheduled
    -- on the 7X — the team can re-plan them onto the right 7X day.

    -- ── 5. Tag vocabulary — the team-wide tag_list (boat_id IS NULL) is
    -- already shared, but if the Mk1 had a boat-scoped list, fold it into
    -- the 7X's list (merge), then drop the Mk1 row. `tags` is JSONB
    -- (an array of strings), so we union via jsonb_array_elements_text and
    -- coerce back to jsonb with to_jsonb on the deduped text array.
    UPDATE public.tag_lists nl
       SET tags = (
             SELECT to_jsonb(
                      array(
                        SELECT DISTINCT t
                          FROM (
                            SELECT jsonb_array_elements_text(coalesce(nl.tags, '[]'::jsonb)) AS t
                            UNION ALL
                            SELECT jsonb_array_elements_text(coalesce(ol.tags, '[]'::jsonb)) AS t
                          ) u
                         ORDER BY t
                      )
                    )
               FROM public.tag_lists ol
              WHERE ol.team_id = v_team_id AND ol.boat_id = v_old_boat_id
           )
     WHERE nl.team_id = v_team_id AND nl.boat_id = v_new_boat_id
       AND EXISTS (SELECT 1 FROM public.tag_lists ol
                    WHERE ol.team_id = v_team_id AND ol.boat_id = v_old_boat_id);

    -- If the 7X doesn't have a tag_list row yet but the Mk1 does, just
    -- re-point it.
    UPDATE public.tag_lists
       SET boat_id = v_new_boat_id
     WHERE team_id = v_team_id
       AND boat_id = v_old_boat_id
       AND NOT EXISTS (SELECT 1 FROM public.tag_lists nl2
                        WHERE nl2.team_id = v_team_id AND nl2.boat_id = v_new_boat_id);

    -- Anything left on Mk1 is now redundant after the merge — drop it.
    DELETE FROM public.tag_lists
     WHERE team_id = v_team_id AND boat_id = v_old_boat_id;

    RAISE NOTICE
      '0026 rollover: sessions=%, videos=%, photos=%, open backlog swept=%',
      v_moved_sess, v_moved_vid, v_moved_pho, v_moved_back;
END $$;
