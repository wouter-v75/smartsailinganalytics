-- Schema tests for 0068_day_edge_tags.sql.
-- See supabase/tests/README.md for how to run these.
--
-- A vocabulary insert has two silent failure modes: it misses the teams it was
-- written for, or it fires twice and gives a boat two "Day start" buttons. Both
-- look like nothing at all from the outside, so both are asserted here — the
-- migration's own statement is run TWICE and the counts checked after.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-00000000b001', 'Seeded long ago'),
    ('00000000-0000-0000-0000-00000000b002', 'Already has them')
ON CONFLICT DO NOTHING;

-- A team seeded before any of these existed: builtin general vocabulary, but
-- no finish and no day edges.
INSERT INTO public.ssa_tag_defs (team_id, boat_id, scope, slug, label, builtin) VALUES
    ('00000000-0000-0000-0000-00000000b001', NULL, 'general', 'race-start', 'Race start', TRUE),
    ('00000000-0000-0000-0000-00000000b001', NULL, 'general', 'topmark',    'Top mark',   TRUE);

-- A team that already has Day start, and has RENAMED it.
INSERT INTO public.ssa_tag_defs (team_id, boat_id, scope, slug, label, builtin) VALUES
    ('00000000-0000-0000-0000-00000000b002', NULL, 'general', 'race-start', 'Race start', TRUE),
    ('00000000-0000-0000-0000-00000000b002', NULL, 'general', 'day-start',  'Lines off',  TRUE);

-- ── Run the migration's statement, twice ────────────────────────────────────
DO $mig$
DECLARE pass int;
BEGIN
FOR pass IN 1..2 LOOP
    INSERT INTO public.ssa_tag_defs
        (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
         min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
    SELECT DISTINCT
        d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
        v.slug, v.label, v.color, 'tl1', 'point', v.lead_sec, v.lag_sec,
        '[]'::jsonb, FALSE, TRUE, v.sort
      FROM public.ssa_tag_defs d
     CROSS JOIN (VALUES
            ('day-start',   'Day start', '#F59E0B', 30, 30, 68),
            ('day-end',     'Day end',   '#F59E0B', 30, 30, 69),
            ('race-finish', 'Finish',    '#EF4444', 30, 20, 19)
         ) AS v(slug, label, color, lead_sec, lag_sec, sort)
     WHERE d.builtin AND d.scope = 'general'
       AND NOT EXISTS (
           SELECT 1 FROM public.ssa_tag_defs e
            WHERE e.slug = v.slug AND e.team_id = d.team_id
              AND e.boat_id IS NOT DISTINCT FROM d.boat_id AND e.scope = 'general');
END LOOP;
END $mig$;

-- ── 1. The team that was missing them has all three, once each ─────────────
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM public.ssa_tag_defs
     WHERE team_id = '00000000-0000-0000-0000-00000000b001'
       AND slug IN ('day-start', 'day-end', 'race-finish');
    IF n <> 3 THEN RAISE EXCEPTION 'test 1 FAILED: % of the three arrived (re-running must not duplicate)', n; END IF;
    RAISE NOTICE 'test 1 ok: day-start, day-end and race-finish, one each';
END $$;

-- ── 2. Finish is the one that mattered ─────────────────────────────────────
-- The Racing button already NAMED race-finish; groupMembers skips what it
-- cannot resolve, so the button quietly offered four moments instead of five.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.ssa_tag_defs
         WHERE team_id = '00000000-0000-0000-0000-00000000b001'
           AND slug = 'race-finish' AND label = 'Finish' AND lead_sec = 30
    ) THEN
        RAISE EXCEPTION 'test 2 FAILED: the finish did not arrive with its lead time';
    END IF;
    RAISE NOTICE 'test 2 ok: the Racing button has a finish behind it now';
END $$;

-- ── 3. A team's own wording survives ───────────────────────────────────────
DO $$
DECLARE l text; n bigint;
BEGIN
    SELECT count(*), max(label) INTO n, l FROM public.ssa_tag_defs
     WHERE team_id = '00000000-0000-0000-0000-00000000b002' AND slug = 'day-start';
    IF n <> 1 THEN RAISE EXCEPTION 'test 3 FAILED: % day-start rows for a team that had one', n; END IF;
    IF l <> 'Lines off' THEN RAISE EXCEPTION 'test 3 FAILED: a renamed tag was overwritten (%)', l; END IF;
    RAISE NOTICE 'test 3 ok: a team that renamed it keeps their name';
END $$;

-- ── 4. Nothing lands on a team with no seeded vocabulary ───────────────────
-- The insert keys off existing builtin general defs, so a team that has never
-- opened the tagger stays empty and gets the CURRENT vocabulary when it does.
INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-00000000b003', 'Never opened it') ON CONFLICT DO NOTHING;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.ssa_tag_defs
               WHERE team_id = '00000000-0000-0000-0000-00000000b003') THEN
        RAISE EXCEPTION 'test 4 FAILED: a team with no vocabulary was given three tags';
    END IF;
    RAISE NOTICE 'test 4 ok: an unseeded team is left for the seeder';
END $$;

-- ── 5. Per BOAT, not per team ──────────────────────────────────────────────
-- A boat-scoped vocabulary gets its own copies; the NULL boat (team-wide) is a
-- different row again, and NOT DISTINCT is what keeps the two apart.
INSERT INTO public.boats (id, team_id, name) VALUES
    ('00000000-0000-0000-0000-00000000b010', '00000000-0000-0000-0000-00000000b001', 'Second boat')
ON CONFLICT DO NOTHING;
INSERT INTO public.ssa_tag_defs (team_id, boat_id, scope, slug, label, builtin) VALUES
    ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b010', 'general', 'race-start', 'Race start', TRUE);

INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
    v.slug, v.label, v.color, 'tl1', 'point', v.lead_sec, v.lag_sec,
    '[]'::jsonb, FALSE, TRUE, v.sort
  FROM public.ssa_tag_defs d
 CROSS JOIN (VALUES
        ('day-start', 'Day start', '#F59E0B', 30, 30, 68)
     ) AS v(slug, label, color, lead_sec, lag_sec, sort)
 WHERE d.builtin AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs e
        WHERE e.slug = v.slug AND e.team_id = d.team_id
          AND e.boat_id IS NOT DISTINCT FROM d.boat_id AND e.scope = 'general');

DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM public.ssa_tag_defs
     WHERE team_id = '00000000-0000-0000-0000-00000000b001'
       AND boat_id = '00000000-0000-0000-0000-00000000b010' AND slug = 'day-start';
    IF n <> 1 THEN RAISE EXCEPTION 'test 5 FAILED: the boat-scoped vocabulary got % day-start rows', n; END IF;
    RAISE NOTICE 'test 5 ok: a boat with its own vocabulary gets its own copy';
END $$;

ROLLBACK;
