-- Schema tests for 0064_boat_battens.sql.
-- See supabase/tests/README.md for how to run these.
--
-- What is worth asserting here is what reading the migration cannot tell you:
-- that the unique constraint can actually arbitrate the upsert the API does,
-- that the CHECK catches a malformed card without catching a legitimate one,
-- and that a negative turn count survives the round trip — winding a batten OFF
-- is a real setting and the obvious "turns >= 0" instinct would destroy it.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-0000000000b1', 'Batten test team')
ON CONFLICT DO NOTHING;
INSERT INTO public.boats (id, team_id, name) VALUES
    ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'Test boat'),
    ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', 'Other boat')
ON CONFLICT DO NOTHING;

-- ── 1. A card lands, with the shape src/lib/battens.ts writes ───────────────
INSERT INTO public.boat_battens (team_id, boat_id, card) VALUES (
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000b2',
    '{"count":3,"rows":[
        {"0-5":{"tension":"soft","turns":5},"15-20":{"tension":"stiff","turns":-2}},
        {},
        {"25+":{"tension":"stiff","turns":2}}
     ]}'::jsonb
);

DO $$
BEGIN
    IF (SELECT card -> 'count' FROM public.boat_battens
        WHERE boat_id = '00000000-0000-0000-0000-0000000000b2')::int <> 3 THEN
        RAISE EXCEPTION 'test 1 FAILED: the card did not round-trip';
    END IF;
    RAISE NOTICE 'test 1 ok: a card stores and reads back';
END $$;

-- ── 2. NEGATIVE turns survive ───────────────────────────────────────────────
-- The whole point. A schema that quietly clamped this to zero would be wrong in
-- the boat and nobody would notice until a designer asked why the top batten
-- reads "stiff 0" in every breeze.
DO $$
DECLARE t int;
BEGIN
    SELECT (card -> 'rows' -> 0 -> '15-20' ->> 'turns')::int INTO t
    FROM public.boat_battens WHERE boat_id = '00000000-0000-0000-0000-0000000000b2';
    IF t <> -2 THEN
        RAISE EXCEPTION 'test 2 FAILED: expected -2 turns, got %', t;
    END IF;
    RAISE NOTICE 'test 2 ok: a batten wound OFF the mark stays wound off';
END $$;

-- ── 3. One card per boat, and the constraint can arbitrate ON CONFLICT ──────
-- This is the assertion that matters for the API: the route upserts on
-- (team_id, boat_id), and PostgREST can only name a plain unique constraint.
INSERT INTO public.boat_battens (team_id, boat_id, card) VALUES (
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000b2',
    '{"count":4,"rows":[{},{},{},{}]}'::jsonb
)
ON CONFLICT (team_id, boat_id) DO UPDATE SET card = EXCLUDED.card;

DO $$
DECLARE n bigint; c int;
BEGIN
    SELECT count(*), max((card ->> 'count')::int) INTO n, c
    FROM public.boat_battens WHERE boat_id = '00000000-0000-0000-0000-0000000000b2';
    IF n <> 1 THEN RAISE EXCEPTION 'test 3 FAILED: % rows for one boat', n; END IF;
    IF c <> 4 THEN RAISE EXCEPTION 'test 3 FAILED: the upsert did not replace the card'; END IF;
    RAISE NOTICE 'test 3 ok: one card per boat, replaced in place by the upsert';
END $$;

-- ── 4. A second boat in the same team gets its own card ────────────────────
-- Scoping the constraint to the team alone would make two boats share one card,
-- which is the kind of bug that only shows up in a two-boat testing programme —
-- exactly when it hurts most.
INSERT INTO public.boat_battens (team_id, boat_id, card) VALUES (
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000b3',
    '{"count":2,"rows":[{},{}]}'::jsonb
);

DO $$
BEGIN
    IF (SELECT count(*) FROM public.boat_battens
        WHERE team_id = '00000000-0000-0000-0000-0000000000b1') <> 2 THEN
        RAISE EXCEPTION 'test 4 FAILED: the two boats did not get separate cards';
    END IF;
    RAISE NOTICE 'test 4 ok: a card belongs to a boat, not to a team';
END $$;

-- ── 5. The shape CHECK rejects a card that is not a grid ───────────────────
DO $$
BEGIN
    BEGIN
        INSERT INTO public.boat_battens (team_id, boat_id, card)
        VALUES ('00000000-0000-0000-0000-0000000000b1',
                gen_random_uuid(), '"just a string"'::jsonb);
        RAISE EXCEPTION 'test 5 FAILED: a string was accepted as a card';
    EXCEPTION
        WHEN check_violation THEN RAISE NOTICE 'test 5a ok: a non-object card is refused';
        WHEN foreign_key_violation THEN RAISE EXCEPTION 'test 5 INCONCLUSIVE: FK fired first';
    END;

    BEGIN
        INSERT INTO public.boat_battens (team_id, boat_id, card)
        VALUES ('00000000-0000-0000-0000-0000000000b1',
                '00000000-0000-0000-0000-0000000000b3',
                '{"count":3,"rows":{"0-5":{}}}'::jsonb);
        RAISE EXCEPTION 'test 5 FAILED: rows as an object was accepted';
    EXCEPTION
        WHEN check_violation THEN RAISE NOTICE 'test 5b ok: rows must be an array';
        WHEN unique_violation THEN RAISE EXCEPTION 'test 5 INCONCLUSIVE: unique fired first';
    END;
END $$;

-- ── 6. An empty card is legal ──────────────────────────────────────────────
-- A boat that has not filled the card in yet must still be able to have a row —
-- otherwise "set the batten count to 4, fill it in later" cannot be saved.
DO $$
BEGIN
    UPDATE public.boat_battens
    SET card = '{"count":3,"rows":[{},{},{}]}'::jsonb
    WHERE boat_id = '00000000-0000-0000-0000-0000000000b3';
    RAISE NOTICE 'test 6 ok: a blank card is storable';
END $$;

-- ── 7. The trigger owns updated_at ─────────────────────────────────────────
-- Asserted as "the trigger OVERRIDES what the client sent", not as "the clock
-- advanced": touch_updated_at uses now(), which is transaction time and is
-- therefore constant inside this test's single BEGIN. Overriding is the
-- property that actually matters anyway — a client must not be able to backdate
-- when the card was last changed.
DO $$
DECLARE after_ts timestamptz;
BEGIN
    UPDATE public.boat_battens
    SET card = card || '{"count":5}'::jsonb,
        updated_at = TIMESTAMPTZ '1999-01-01'
    WHERE boat_id = '00000000-0000-0000-0000-0000000000b2';

    SELECT updated_at INTO after_ts FROM public.boat_battens
    WHERE boat_id = '00000000-0000-0000-0000-0000000000b2';

    IF after_ts <> now() THEN
        RAISE EXCEPTION 'test 7 FAILED: the trigger did not set updated_at (got %)', after_ts;
    END IF;
    RAISE NOTICE 'test 7 ok: updated_at is the trigger''s, not the client''s';
END $$;

-- ── 8. Deleting the boat takes its card with it ────────────────────────────
DELETE FROM public.boats WHERE id = '00000000-0000-0000-0000-0000000000b3';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.boat_battens
               WHERE boat_id = '00000000-0000-0000-0000-0000000000b3') THEN
        RAISE EXCEPTION 'test 8 FAILED: an orphaned card survived its boat';
    END IF;
    RAISE NOTICE 'test 8 ok: the card goes with the boat';
END $$;

ROLLBACK;
