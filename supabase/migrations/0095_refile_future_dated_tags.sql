-- 0095_refile_future_dated_tags.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Put tags back on the day they were made.
--
-- A tag carries two times that nothing kept in step: `t0`, the instant the crew
-- pressed the button, and `session_date`, the day the APP happened to be showing.
-- The app could open a day in the future (a video with a mis-read sessionDate
-- dragged it there), and every press then went to that day — correctly timed,
-- filed under a day nobody had sailed, and invisible on the day they belonged to.
--
-- A session_date in the FUTURE is the one case that needs no judgement: nobody
-- has sailed tomorrow. Anything else is left alone, because a session that runs
-- through local midnight legitimately has tags whose local date differs from the
-- day they belong to, and a blanket re-file would break exactly those.
--
-- Idempotent. Run it twice and the second run moves nothing.
--
-- BEFORE: see what will move.
--
--   SELECT session_date, slug, label, t0,
--          ((t0 AT TIME ZONE 'UTC') + INTERVAL '2 hours')::date AS goes_to
--   FROM public.ssa_tag_events
--   WHERE session_date > CURRENT_DATE
--   ORDER BY t0;
-- ─────────────────────────────────────────────────────────────────────────────

-- The venue's offset from UTC, as the event file declares it (<utc_offset
-- event_file hours="2"/> — St Tropez, CEST). It only matters for a tag pressed
-- either side of midnight; a day's sailing lands on the same date with or
-- without it. Change it if you are re-filing a day from another venue.
DO $$
DECLARE
  venue_offset INTERVAL := INTERVAL '2 hours';
  moved_events INT;
  moved_requests INT;
  moved_notes INT;
BEGIN
  -- The tags themselves. t0 is the authority: it is the instant somebody was
  -- standing on the boat pressing the button, and it has always been right.
  WITH refiled AS (
    UPDATE public.ssa_tag_events
    SET session_date = ((t0 AT TIME ZONE 'UTC') + venue_offset)::date
    WHERE session_date > CURRENT_DATE
    RETURNING id
  )
  SELECT count(*) INTO moved_events FROM refiled;

  -- The requests raised with them. "Grab video" writes a tag AND a video
  -- request, and a request stranded on a day the tag has left is a piece of
  -- work nobody can see — which is the whole reason the button exists.
  WITH refiled AS (
    UPDATE public.ssa_tag_requests r
    SET session_date = e.session_date
    FROM public.ssa_tag_events e
    WHERE r.tag_event_id = e.id
      AND r.session_date <> e.session_date
    RETURNING r.id
  )
  SELECT count(*) INTO moved_requests FROM refiled;

  -- Personal day notes written on the same wrong day. Nothing links these to an
  -- instant, so only a future date can be judged wrong, and it is moved to the
  -- day whose tags just arrived from it — or left for a human if that is
  -- ambiguous.
  -- Never over a note that is already there: (team, boat, date, user, kind) is
  -- unique, and a collision would abort the whole re-file over a note nobody
  -- asked to move.
  UPDATE public.ssa_day_notes n
  SET session_date = CURRENT_DATE
  WHERE n.session_date > CURRENT_DATE
    AND EXISTS (
      SELECT 1 FROM public.ssa_tag_events e
      WHERE e.boat_id = n.boat_id AND e.session_date = CURRENT_DATE
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ssa_day_notes x
      WHERE x.team_id = n.team_id AND x.boat_id = n.boat_id
        AND x.user_id = n.user_id AND x.kind = n.kind
        AND x.session_date = CURRENT_DATE
    );
  GET DIAGNOSTICS moved_notes = ROW_COUNT;

  RAISE NOTICE 're-filed % tag(s), % request(s), % day note(s)',
    moved_events, moved_requests, moved_notes;
END $$;
