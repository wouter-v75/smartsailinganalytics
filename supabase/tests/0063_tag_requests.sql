-- ============================================================================
-- 0063 — requests, and the shape of asking.
--
-- Two kinds that look similar and are not: a VIDEO request names a medium and
-- needs an approver; a DEBRIEF request is a nomination with no medium and no
-- approver at all. The CHECK constraint is what keeps them from blurring.
--
-- And one nomination per person per tag, because the vote count is the strongest
-- signal the shortlist has — five people asking about the same gybe means
-- something only if nobody can ask five times.
--
-- Rolls back. Run per supabase/tests/README.md.
-- ============================================================================
BEGIN;
INSERT INTO public.teams (id,name) VALUES ('11111111-1111-1111-1111-111111111111','T');
INSERT INTO public.boats (id,team_id,name) VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','B');
-- 0001's trigger mirrors this into public.users, so inserting there too would
-- collide — which is itself a useful check that the trigger is live.
INSERT INTO auth.users (id,email) VALUES ('33333333-3333-3333-3333-333333333333','a@b.c');
\set T '11111111-1111-1111-1111-111111111111'
\set B '22222222-2222-2222-2222-222222222222'
\set U '33333333-3333-3333-3333-333333333333'

INSERT INTO public.ssa_tag_events (id,team_id,boat_id,session_date,slug,label,scope,t0,t1)
VALUES ('44444444-4444-4444-4444-444444444444',:'T',:'B','2026-09-11','gybe','Gybe','general',
        '2026-09-11T12:00:00Z','2026-09-11T12:00:20Z');
\set E '44444444-4444-4444-4444-444444444444'

-- 1. a video request must name its medium
SAVEPOINT s1;
INSERT INTO public.ssa_tag_requests (team_id,boat_id,session_date,tag_event_id,kind,requested_by_user_id)
VALUES (:'T',:'B','2026-09-11',:'E','video',:'U');
\echo '   ^^ TEST 1 expects a kind_shape CHECK error (video with no media_kind)'
ROLLBACK TO s1;

-- 2. a debrief request must NOT
SAVEPOINT s2;
INSERT INTO public.ssa_tag_requests (team_id,boat_id,session_date,tag_event_id,kind,media_kind,requested_by_user_id)
VALUES (:'T',:'B','2026-09-11',:'E','debrief','video',:'U');
\echo '   ^^ TEST 2 expects a kind_shape CHECK error (debrief carrying a medium)'
ROLLBACK TO s2;

-- 3. one nomination per person per tag — asking twice edits, it does not stack
INSERT INTO public.ssa_tag_requests (team_id,boat_id,session_date,tag_event_id,kind,requested_by_user_id,note)
VALUES (:'T',:'B','2026-09-11',:'E','debrief',:'U','worth a look');
SAVEPOINT s3;
INSERT INTO public.ssa_tag_requests (team_id,boat_id,session_date,tag_event_id,kind,requested_by_user_id)
VALUES (:'T',:'B','2026-09-11',:'E','debrief',:'U');
\echo '   ^^ TEST 3 expects a unique violation (same person, same tag, same kind)'
ROLLBACK TO s3;

-- 4. the same person MAY ask for both a debrief and a video
INSERT INTO public.ssa_tag_requests (team_id,boat_id,session_date,tag_event_id,kind,media_kind,requested_by_user_id)
VALUES (:'T',:'B','2026-09-11',:'E','video','drone',:'U');
SELECT CASE WHEN count(*)=2 THEN 'TEST 4 PASS — debrief and video coexist for one person'
            ELSE 'TEST 4 FAIL' END FROM public.ssa_tag_requests WHERE tag_event_id=:'E';

-- 5. deleting the tag takes its requests with it
DELETE FROM public.ssa_tag_events WHERE id=:'E';
SELECT CASE WHEN count(*)=0 THEN 'TEST 5 PASS — requests cascade with their tag'
            ELSE 'TEST 5 FAIL' END FROM public.ssa_tag_requests WHERE tag_event_id=:'E';

-- 6. private_by_default landed on the vocabulary
SELECT CASE WHEN count(*)=1 THEN 'TEST 6 PASS — ssa_tag_defs.private_by_default exists'
            ELSE 'TEST 6 FAIL' END
FROM information_schema.columns
WHERE table_name='ssa_tag_defs' AND column_name='private_by_default';
ROLLBACK;
