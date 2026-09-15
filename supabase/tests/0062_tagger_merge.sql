-- ============================================================================
-- 0062 — the tagger's merge guarantees.
--
-- The whole design rests on one promise: re-running detection must never undo a
-- human's edit. That promise lives in three schema features — a unique index on
-- detection_key, the edited_fields[] diff, and the t1 >= t0 window — and none of
-- the three can be verified by reading the migration. Hence this.
--
-- Both bugs these tests caught the first time they ran are worth remembering:
--   • moving a point tag by writing t0 alone trips the window CHECK (t1 >= t0);
--   • a PARTIAL unique index cannot arbitrate ON CONFLICT unless the statement
--     repeats its predicate — which PostgREST cannot express, so the index is
--     deliberately non-partial (NULLs are distinct, which is what we want).
--
-- Rolls back. Run per supabase/tests/README.md.
-- ============================================================================
BEGIN;

INSERT INTO public.teams (id, name) VALUES ('11111111-1111-1111-1111-111111111111','Test team');
INSERT INTO public.boats (id, team_id, name)
VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Test boat');
\set T '11111111-1111-1111-1111-111111111111'
\set B '22222222-2222-2222-2222-222222222222'

-- The detector finds the third tack of race 2 at 12:00:00, confident.
INSERT INTO public.ssa_tag_events
  (team_id,boat_id,session_date,slug,label,scope,t0,t1,source,producer,detection_key,auto_t0,confidence)
VALUES (:'T',:'B','2026-09-11','tack','Tack','general',
        '2026-09-11T12:00:00Z','2026-09-11T12:00:00Z','auto','manoeuvres','b:r2:tack:3',
        '2026-09-11T12:00:00Z',0.9);

-- A human watches the video and moves it 4 s later, recording the edit.
-- BOTH endpoints shift — writing t0 alone would trip ssa_tag_events_window.
UPDATE public.ssa_tag_events
   SET t0 = t0 + interval '4 seconds',
       t1 = t1 + interval '4 seconds',
       edited_fields = ARRAY['t0','t1']
 WHERE detection_key = 'b:r2:tack:3';

-- ── 1. the same detection cannot land twice ────────────────────────────────
SAVEPOINT s1;
INSERT INTO public.ssa_tag_events
  (team_id,boat_id,session_date,slug,label,scope,t0,t1,source,producer,detection_key)
VALUES (:'T',:'B','2026-09-11','tack','Tack','general',
        '2026-09-11T12:00:09Z','2026-09-11T12:00:09Z','auto','manoeuvres','b:r2:tack:3');
\echo '   ^^ TEST 1 expects a unique-violation ERROR immediately above'
ROLLBACK TO s1;

-- ── 2. hand-placed tags are unconstrained (detection_key NULL is distinct) ──
SAVEPOINT s2;
INSERT INTO public.ssa_tag_events
  (team_id,boat_id,session_date,slug,label,scope,t0,t1,source,producer)
SELECT :'T',:'B','2026-09-11','review','Review','general',
       '2026-09-11T12:05:00Z','2026-09-11T12:05:00Z','human','user'
FROM generate_series(1,3);
\echo '   ^^ TEST 2 expects INSERT 0 3'
RELEASE s2;

-- ── 3. scope shape is enforced ─────────────────────────────────────────────
SAVEPOINT s3;
INSERT INTO public.ssa_tag_events (team_id,boat_id,session_date,slug,label,scope,section,t0,t1)
VALUES (:'T',:'B','2026-09-11','x','X','general','bow',
        '2026-09-11T12:00:00Z','2026-09-11T12:00:00Z');
\echo '   ^^ TEST 3 expects a scope_shape CHECK ERROR immediately above'
ROLLBACK TO s3;

-- ── 4. THE GUARANTEE ───────────────────────────────────────────────────────
-- Detection runs again and now places the tack at 12:00:02 with more confidence.
-- The detector's own view must be recorded; the human's position must survive.
INSERT INTO public.ssa_tag_events
  (team_id,boat_id,session_date,slug,label,scope,t0,t1,source,producer,detection_key,auto_t0,confidence)
VALUES (:'T',:'B','2026-09-11','tack','Tack','general',
        '2026-09-11T12:00:02Z','2026-09-11T12:00:02Z','auto','manoeuvres','b:r2:tack:3',
        '2026-09-11T12:00:02Z',0.95)
ON CONFLICT (boat_id, session_date, detection_key) DO UPDATE
   SET auto_t0    = EXCLUDED.auto_t0,
       confidence = EXCLUDED.confidence,
       t0 = CASE WHEN 't0' = ANY(public.ssa_tag_events.edited_fields)
                 THEN public.ssa_tag_events.t0 ELSE EXCLUDED.t0 END,
       t1 = CASE WHEN 't1' = ANY(public.ssa_tag_events.edited_fields)
                 THEN public.ssa_tag_events.t1 ELSE EXCLUDED.t1 END;

SELECT CASE
         WHEN t0 = '2026-09-11T12:00:04Z' AND auto_t0 = '2026-09-11T12:00:02Z' AND confidence = 0.95
         THEN 'TEST 4 PASS — human t0 survived re-derivation, detector still recorded'
         ELSE 'TEST 4 FAIL — t0='||t0::text||' auto_t0='||auto_t0::text
       END AS result
FROM public.ssa_tag_events WHERE detection_key = 'b:r2:tack:3';

-- ── 5. re-derivation did not disturb the hand-placed tags ──────────────────
SELECT CASE WHEN count(*) = 3 THEN 'TEST 5 PASS — manual tags untouched'
            ELSE 'TEST 5 FAIL — '||count(*)||' manual rows' END AS result
FROM public.ssa_tag_events WHERE detection_key IS NULL;

-- ── 6-8. the vocabulary index must be upsertable ───────────────────────────
-- Seeding the base vocabulary is an upsert, so the unique index has to be
-- arbitrable by ON CONFLICT with a plain column list — which rules out the
-- COALESCE() expression index this started as. NULLS NOT DISTINCT (PG15+) gives
-- the same uniqueness and can be named.
SAVEPOINT v0;
INSERT INTO public.ssa_tag_defs (team_id,scope,slug,label,builtin)
VALUES (:'T','general','tack','Tack',true);

SAVEPOINT v1;
INSERT INTO public.ssa_tag_defs (team_id,scope,slug,label) VALUES (:'T','general','tack','Tack again');
\echo '   ^^ TEST 6 expects a unique violation — NULLs must NOT be distinct here'
ROLLBACK TO v1;

INSERT INTO public.ssa_tag_defs (team_id,scope,slug,label,color,builtin)
VALUES (:'T','general','tack','Tack','#1D9E75',true)
ON CONFLICT (team_id, boat_id, scope, section, owner_user_id, slug)
DO UPDATE SET label = EXCLUDED.label, color = EXCLUDED.color;
SELECT CASE WHEN count(*) = 1 AND max(color) = '#1D9E75'
            THEN 'TEST 7 PASS — ON CONFLICT arbitrated the NULLS NOT DISTINCT index'
            ELSE 'TEST 7 FAIL' END AS result
FROM public.ssa_tag_defs WHERE slug = 'tack';

INSERT INTO public.ssa_tag_defs (team_id,scope,section,slug,label) VALUES (:'T','section','bow','peel','Peel');
INSERT INTO public.ssa_tag_defs (team_id,scope,section,slug,label) VALUES (:'T','section','pit','peel','Peel');
SELECT CASE WHEN count(*) = 2 THEN 'TEST 8 PASS — one slug, two sections, no collision'
            ELSE 'TEST 8 FAIL' END AS result
FROM public.ssa_tag_defs WHERE slug = 'peel';
ROLLBACK TO v0;

ROLLBACK;
