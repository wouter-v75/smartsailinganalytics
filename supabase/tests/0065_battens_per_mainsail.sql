-- Schema tests for 0065_battens_per_mainsail.sql.
-- See supabase/tests/README.md for how to run these.
--
-- The migration's whole job is to widen 0064 from one card per boat to one per
-- mainsail WITHOUT losing the cards already typed in, so that is what these
-- assert: that two mains can now hold different cards, that the old constraint
-- is really gone (it would have silently blocked the second one), that a card
-- with an obvious owner gets adopted and an ambiguous one does not, and that the
-- upsert the API relies on still has an index it can name.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-0000000000c1', 'Batten sail test')
ON CONFLICT DO NOTHING;
INSERT INTO public.boats (id, team_id, name) VALUES
    ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'Two mains'),
    ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1', 'One main'),
    ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000c1', 'No main')
ON CONFLICT DO NOTHING;

INSERT INTO public.sails (id, team_id, boat_id, name, kind, retired) VALUES
    ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 'Main 2026', 'mainsail', false),
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 'Delivery main', 'mainsail', false),
    ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'The main', 'mainsail', false),
    ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'Old main', 'mainsail', true),
    ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c4', 'J2', 'jib', false)
ON CONFLICT DO NOTHING;

-- ── 1. Two mains on one boat hold DIFFERENT cards ──────────────────────────
-- The point of the migration. Under 0064's constraint the second insert failed.
INSERT INTO public.boat_battens (team_id, boat_id, sail_id, card) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000d1',
     '{"count":3,"rows":[{"10-15":{"tension":"stiff","turns":2}},{},{}]}'::jsonb),
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000d2',
     '{"count":3,"rows":[{"10-15":{"tension":"soft","turns":-1}},{},{}]}'::jsonb);

DO $$
DECLARE a text; b text;
BEGIN
    SELECT card -> 'rows' -> 0 -> '10-15' ->> 'tension' INTO a
    FROM public.boat_battens WHERE sail_id = '00000000-0000-0000-0000-0000000000d1';
    SELECT card -> 'rows' -> 0 -> '10-15' ->> 'tension' INTO b
    FROM public.boat_battens WHERE sail_id = '00000000-0000-0000-0000-0000000000d2';
    IF a IS DISTINCT FROM 'stiff' OR b IS DISTINCT FROM 'soft' THEN
        RAISE EXCEPTION 'test 1 FAILED: the two mains do not hold separate cards (% / %)', a, b;
    END IF;
    RAISE NOTICE 'test 1 ok: two mains on one boat, two different cards';
END $$;

-- ── 2. Still one card per (boat, sail) ─────────────────────────────────────
INSERT INTO public.boat_battens (team_id, boat_id, sail_id, card) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000d1',
     '{"count":4,"rows":[{},{},{},{}]}'::jsonb)
ON CONFLICT (team_id, boat_id, sail_id) DO UPDATE SET card = EXCLUDED.card;

DO $$
DECLARE n bigint; c int;
BEGIN
    SELECT count(*), max((card ->> 'count')::int) INTO n, c
    FROM public.boat_battens WHERE sail_id = '00000000-0000-0000-0000-0000000000d1';
    IF n <> 1 THEN RAISE EXCEPTION 'test 2 FAILED: % cards for one sail', n; END IF;
    IF c <> 4 THEN RAISE EXCEPTION 'test 2 FAILED: the upsert did not replace the card'; END IF;
    RAISE NOTICE 'test 2 ok: one card per sail, and the index can arbitrate ON CONFLICT';
END $$;

-- ── 3. The old one-per-BOAT constraint is gone ─────────────────────────────
-- Asserted directly rather than inferred from test 1, because a leftover
-- constraint would only bite on the day somebody buys a second main.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.boat_battens'::regclass
          AND conname = 'boat_battens_one_per_boat'
    ) THEN
        RAISE EXCEPTION 'test 3 FAILED: the one-card-per-boat constraint survived';
    END IF;
    RAISE NOTICE 'test 3 ok: the one-per-boat constraint is gone';
END $$;

-- ── 4. At most ONE unassigned card per boat ────────────────────────────────
-- NULLS NOT DISTINCT. Without it a boat accumulates a pile of NULL-sail cards
-- and the UI has no way to say which one it is offering.
INSERT INTO public.boat_battens (team_id, boat_id, sail_id, card) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c4',
     NULL, '{"count":3,"rows":[{},{},{}]}'::jsonb);

DO $$
BEGIN
    BEGIN
        INSERT INTO public.boat_battens (team_id, boat_id, sail_id, card) VALUES
            ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c4',
             NULL, '{"count":5,"rows":[{},{},{},{},{}]}'::jsonb);
        RAISE EXCEPTION 'test 4 FAILED: a second unassigned card was accepted';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'test 4 ok: NULLS NOT DISTINCT keeps unassigned cards to one';
    END;
END $$;

-- ── 5. An unassigned card can be adopted by an upsert naming the index ─────
INSERT INTO public.boat_battens (team_id, boat_id, sail_id, card) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c4',
     NULL, '{"count":6,"rows":[{},{},{},{},{},{}]}'::jsonb)
ON CONFLICT (team_id, boat_id, sail_id) DO UPDATE SET card = EXCLUDED.card;

DO $$
BEGIN
    IF (SELECT (card ->> 'count')::int FROM public.boat_battens
        WHERE boat_id = '00000000-0000-0000-0000-0000000000c4' AND sail_id IS NULL) <> 6 THEN
        RAISE EXCEPTION 'test 5 FAILED: the unassigned card did not upsert';
    END IF;
    RAISE NOTICE 'test 5 ok: an unassigned card upserts on the same index';
END $$;

-- ── 6. Deleting a sail takes its card, and only its card ───────────────────
DELETE FROM public.sails WHERE id = '00000000-0000-0000-0000-0000000000d2';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.boat_battens
               WHERE sail_id = '00000000-0000-0000-0000-0000000000d2') THEN
        RAISE EXCEPTION 'test 6 FAILED: an orphaned card survived its sail';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.boat_battens
                   WHERE sail_id = '00000000-0000-0000-0000-0000000000d1') THEN
        RAISE EXCEPTION 'test 6 FAILED: the OTHER main lost its card too';
    END IF;
    RAISE NOTICE 'test 6 ok: a deleted sail takes its own card and nothing else';
END $$;

-- ── 7. Adoption: exactly one non-retired main ──────────────────────────────
-- Re-running the migration's UPDATE, because the real one ran before these
-- fixtures existed. Boat c3 has one active main and one RETIRED one, so the
-- answer is unambiguous — a retired sail is still in the inventory and a naive
-- count(*) would have called this boat ambiguous and adopted nothing.
INSERT INTO public.boat_battens (team_id, boat_id, sail_id, card) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     NULL, '{"count":3,"rows":[{"0-5":{"tension":"soft","turns":9}},{},{}]}'::jsonb);

UPDATE public.boat_battens b
SET sail_id = only_main.id
FROM (
    SELECT s.boat_id, min(s.id::text)::uuid AS id
    FROM public.sails s
    WHERE s.kind = 'mainsail' AND NOT s.retired
    GROUP BY s.boat_id
    HAVING count(*) = 1
) AS only_main
WHERE b.sail_id IS NULL AND b.boat_id = only_main.boat_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.boat_battens
        WHERE boat_id = '00000000-0000-0000-0000-0000000000c3'
          AND sail_id = '00000000-0000-0000-0000-0000000000d3'
          AND (card -> 'rows' -> 0 -> '0-5' ->> 'turns')::int = 9
    ) THEN
        RAISE EXCEPTION 'test 7 FAILED: the boat with one main did not adopt its card';
    END IF;
    RAISE NOTICE 'test 7 ok: one active main, card adopted, turns intact';
END $$;

-- ── 8. Adoption declines when the answer is a guess ────────────────────────
-- Boat c4 has no mainsail at all, so its card must stay unassigned rather than
-- being attached to the jib.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.boat_battens
        WHERE boat_id = '00000000-0000-0000-0000-0000000000c4' AND sail_id IS NULL
    ) THEN
        RAISE EXCEPTION 'test 8 FAILED: a card was adopted by a boat with no mainsail';
    END IF;
    RAISE NOTICE 'test 8 ok: no mainsail, no adoption — the card waits for a person';
END $$;

ROLLBACK;
