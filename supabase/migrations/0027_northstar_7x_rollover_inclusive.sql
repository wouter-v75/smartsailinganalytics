-- 0027 — Northstar 7X rollover (corrected cutoff).
--
-- 0026 used a strict `>` cutoff, leaving the 1 June session on Northstar72.
-- The team's actual rule is: everything **from** 2026-06-01 (inclusive) onwards
-- belongs to Northstar7X. This migration re-runs the rollover with `>=`.
--
-- Idempotent: row counts only reflect rows that still needed moving.

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
        RAISE NOTICE '0027: Northstar team not found — skipping.';
        RETURN;
    END IF;

    SELECT id INTO v_new_boat_id
      FROM public.boats
     WHERE team_id = v_team_id
       AND name = 'Northstar7X';
    IF v_new_boat_id IS NULL THEN
        RAISE NOTICE '0027: Boat "Northstar7X" not found — skipping.';
        RETURN;
    END IF;

    SELECT id INTO v_old_boat_id
      FROM public.boats
     WHERE team_id = v_team_id
       AND name = 'Northstar72';
    IF v_old_boat_id IS NULL THEN
        RAISE NOTICE '0027: Boat "Northstar72" not found — skipping.';
        RETURN;
    END IF;

    -- 1. Re-point sessions on/after the cutoff to the 7X (idempotent: rows
    --    already on the 7X simply don't match the WHERE clause). The UNIQUE
    --    (boat_id, date) constraint blocks the move if the 7X already has
    --    that date; the NOT EXISTS guards against that.
    UPDATE public.sessions s
       SET boat_id = v_new_boat_id
     WHERE s.team_id = v_team_id
       AND s.boat_id = v_old_boat_id
       AND s.date >= v_cutoff
       AND NOT EXISTS (
             SELECT 1 FROM public.sessions s2
              WHERE s2.boat_id = v_new_boat_id
                AND s2.date = s.date
           );
    GET DIAGNOSTICS v_moved_sess = ROW_COUNT;

    -- 2. Sync the denorm boat_id mirrors on videos and photos.
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

    -- 3. Backlog items whose target session is now on the 7X follow it.
    UPDATE public.backlog_items bi
       SET boat_id = v_new_boat_id
      FROM public.sessions s
     WHERE bi.target_session_id = s.id
       AND s.boat_id = v_new_boat_id
       AND bi.boat_id <> v_new_boat_id;

    -- 4. Sweep any remaining OPEN backlog items off Northstar72 onto the 7X.
    --    Mk1 is closed; residual work moves to the team's live boat.
    UPDATE public.backlog_items
       SET boat_id = v_new_boat_id,
           target_session_id = NULL  -- old session may be a Mk1 day; let the team re-plan
     WHERE team_id = v_team_id
       AND boat_id = v_old_boat_id
       AND status NOT IN ('done', 'wontfix');
    GET DIAGNOSTICS v_moved_back = ROW_COUNT;

    -- 5. Tag vocabulary — merge the Mk1's boat-scoped list into the 7X's,
    --    then drop the Mk1 row. `tags` is JSONB (an array of strings).
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

    UPDATE public.tag_lists
       SET boat_id = v_new_boat_id
     WHERE team_id = v_team_id
       AND boat_id = v_old_boat_id
       AND NOT EXISTS (SELECT 1 FROM public.tag_lists nl2
                        WHERE nl2.team_id = v_team_id AND nl2.boat_id = v_new_boat_id);

    DELETE FROM public.tag_lists
     WHERE team_id = v_team_id AND boat_id = v_old_boat_id;

    RAISE NOTICE
      '0027 rollover (>= 2026-06-01): sessions=%, videos=%, photos=%, open backlog swept=%',
      v_moved_sess, v_moved_vid, v_moved_pho, v_moved_back;
END $$;
