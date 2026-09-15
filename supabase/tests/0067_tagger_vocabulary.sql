-- Schema tests for 0067_tagger_vocabulary_2026_09.sql.
-- See supabase/tests/README.md for how to run these.
--
-- A vocabulary migration is data reconciliation, and the failure mode is that it
-- half-works: the definition renamed but not the tags under it, or a second
-- "Grab video" appearing every time somebody re-runs it. Both are silent. So
-- these run the migration's own statements against fixtures and check what came
-- out, then run them AGAIN and check nothing moved.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures: a team that seeded the OLD vocabulary ─────────────────────────
INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-00000000a001', 'Vocabulary test')
ON CONFLICT DO NOTHING;
INSERT INTO public.boats (id, team_id, name) VALUES
    ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000a001', 'Old bar')
ON CONFLICT DO NOTHING;

INSERT INTO public.ssa_tag_defs (id, team_id, boat_id, scope, slug, label, color, on_button_bar, builtin) VALUES
    ('00000000-0000-0000-0000-00000000a010', '00000000-0000-0000-0000-00000000a001', NULL, 'general', 'gear-damage', 'Gear damage', '#EF4444', TRUE, TRUE),
    ('00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a001', NULL, 'general', 'incident',    'Incident',    '#EF4444', TRUE, TRUE),
    ('00000000-0000-0000-0000-00000000a012', '00000000-0000-0000-0000-00000000a001', NULL, 'general', 'review',      'Review this', '#8B5CF6', TRUE, TRUE);

-- A day already tagged under the old name.
INSERT INTO public.ssa_tag_events
    (id, team_id, boat_id, session_date, tag_def_id, slug, label, color, scope, t0, t1, source, producer)
VALUES
    ('00000000-0000-0000-0000-00000000a020', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002',
     '2026-09-11', '00000000-0000-0000-0000-00000000a010', 'gear-damage', 'Gear damage', '#EF4444', 'general',
     TIMESTAMPTZ '2026-09-11 11:40:00+00', TIMESTAMPTZ '2026-09-11 11:40:20+00', 'human', 'user'),
    -- And one a crew re-worded for themselves, which must survive untouched.
    ('00000000-0000-0000-0000-00000000a021', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002',
     '2026-09-11', '00000000-0000-0000-0000-00000000a010', 'gear-damage', 'Kit failure', '#EF4444', 'general',
     TIMESTAMPTZ '2026-09-11 12:06:00+00', TIMESTAMPTZ '2026-09-11 12:06:20+00', 'human', 'user');

-- ── Run the migration's statements ──────────────────────────────────────────
-- Twice, so idempotence is tested rather than assumed.
DO $mig$
DECLARE pass int;
BEGIN
FOR pass IN 1..2 LOOP
    UPDATE public.ssa_tag_defs d
       SET slug  = 'technical',
           label = CASE WHEN d.label = 'Gear damage' THEN 'Technical' ELSE d.label END
     WHERE d.slug = 'gear-damage'
       AND NOT EXISTS (
           SELECT 1 FROM public.ssa_tag_defs o
            WHERE o.slug = 'technical' AND o.team_id = d.team_id
              AND o.boat_id IS NOT DISTINCT FROM d.boat_id
              AND o.scope = d.scope
              AND o.section IS NOT DISTINCT FROM d.section
              AND o.owner_user_id IS NOT DISTINCT FROM d.owner_user_id);

    UPDATE public.ssa_tag_events
       SET slug  = 'technical',
           label = CASE WHEN label = 'Gear damage' THEN 'Technical' ELSE label END
     WHERE slug = 'gear-damage';

    UPDATE public.ssa_tag_defs
       SET on_button_bar = FALSE
     WHERE slug = 'incident' AND builtin AND on_button_bar;

    INSERT INTO public.ssa_tag_defs
        (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
         min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
    SELECT DISTINCT
        d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid, 'grab-video', 'Grab video', '#06B6D4',
        'tl1', 'point', 30, 20,
        '[{"group":"Wanted","options":["onboard","drone","either"]}]'::jsonb,
        TRUE, TRUE, 82
      FROM public.ssa_tag_defs d
     WHERE d.builtin AND d.scope = 'general'
       AND NOT EXISTS (
           SELECT 1 FROM public.ssa_tag_defs g
            WHERE g.slug = 'grab-video' AND g.team_id = d.team_id
              AND g.boat_id IS NOT DISTINCT FROM d.boat_id AND g.scope = 'general');
END LOOP;
END $mig$;

-- ── 1. The definition is renamed ────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.ssa_tag_defs
                   WHERE id = '00000000-0000-0000-0000-00000000a010'
                     AND slug = 'technical' AND label = 'Technical') THEN
        RAISE EXCEPTION 'test 1 FAILED: Gear damage was not renamed';
    END IF;
    RAISE NOTICE 'test 1 ok: the definition is Technical';
END $$;

-- ── 2. The tags under it came too ───────────────────────────────────────────
-- The silent half. A season of tags that no longer match any definition is a
-- season that has quietly stopped being searchable.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.ssa_tag_events WHERE slug = 'gear-damage') THEN
        RAISE EXCEPTION 'test 2 FAILED: tags kept the old slug';
    END IF;
    IF (SELECT label FROM public.ssa_tag_events WHERE id = '00000000-0000-0000-0000-00000000a020')
        <> 'Technical' THEN
        RAISE EXCEPTION 'test 2 FAILED: the tag kept the old label';
    END IF;
    RAISE NOTICE 'test 2 ok: the tags were carried across';
END $$;

-- ── 3. A hand-written label is left alone ───────────────────────────────────
DO $$
BEGIN
    IF (SELECT label FROM public.ssa_tag_events WHERE id = '00000000-0000-0000-0000-00000000a021')
        <> 'Kit failure' THEN
        RAISE EXCEPTION 'test 3 FAILED: a re-worded label was overwritten';
    END IF;
    RAISE NOTICE 'test 3 ok: a crew''s own wording survives the rename';
END $$;

-- ── 4. Incident off the bar, still in the picker ────────────────────────────
DO $$
DECLARE onbar boolean; arch boolean;
BEGIN
    SELECT on_button_bar, archived INTO onbar, arch
      FROM public.ssa_tag_defs WHERE id = '00000000-0000-0000-0000-00000000a011';
    IF onbar THEN RAISE EXCEPTION 'test 4 FAILED: Incident is still on the bar'; END IF;
    IF arch THEN RAISE EXCEPTION 'test 4 FAILED: Incident was archived, not just taken off the bar'; END IF;
    RAISE NOTICE 'test 4 ok: Incident is off the bar and still in the vocabulary';
END $$;

-- ── 5. Exactly one Grab video, after two passes ─────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM public.ssa_tag_defs
     WHERE slug = 'grab-video' AND team_id = '00000000-0000-0000-0000-00000000a001';
    IF n <> 1 THEN RAISE EXCEPTION 'test 5 FAILED: % Grab video definitions', n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ssa_tag_defs
                   WHERE slug = 'grab-video' AND on_button_bar AND lead_sec = 30) THEN
        RAISE EXCEPTION 'test 5 FAILED: Grab video did not arrive on the bar with its lead time';
    END IF;
    RAISE NOTICE 'test 5 ok: one Grab video, on the bar, and re-running adds no more';
END $$;

-- ── 6. A team that already has 'technical' is not broken by the rename ──────
-- The unique index would reject the collision and take the migration down with
-- it, so the guard has to hold rather than merely usually hold.
INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-00000000a101', 'Both slugs') ON CONFLICT DO NOTHING;
INSERT INTO public.ssa_tag_defs (team_id, boat_id, scope, slug, label, builtin) VALUES
    ('00000000-0000-0000-0000-00000000a101', NULL, 'general', 'gear-damage', 'Gear damage', TRUE),
    ('00000000-0000-0000-0000-00000000a101', NULL, 'general', 'technical',   'Technical',   TRUE);

DO $$
BEGIN
    UPDATE public.ssa_tag_defs d
       SET slug = 'technical'
     WHERE d.slug = 'gear-damage'
       AND NOT EXISTS (
           SELECT 1 FROM public.ssa_tag_defs o
            WHERE o.slug = 'technical' AND o.team_id = d.team_id
              AND o.boat_id IS NOT DISTINCT FROM d.boat_id
              AND o.scope = d.scope
              AND o.section IS NOT DISTINCT FROM d.section
              AND o.owner_user_id IS NOT DISTINCT FROM d.owner_user_id);
    IF NOT EXISTS (SELECT 1 FROM public.ssa_tag_defs
                   WHERE team_id = '00000000-0000-0000-0000-00000000a101' AND slug = 'gear-damage') THEN
        RAISE EXCEPTION 'test 6 FAILED: the guard let a colliding rename through';
    END IF;
    RAISE NOTICE 'test 6 ok: a team holding both slugs is skipped rather than broken';
END $$;

ROLLBACK;
