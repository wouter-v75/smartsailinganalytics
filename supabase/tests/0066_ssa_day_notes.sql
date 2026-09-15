-- Schema tests for 0066_ssa_day_notes.sql.
-- See supabase/tests/README.md for how to run these.
--
-- The migration makes one promise that cannot be read off the table: that a
-- personal note is visible to its author and to NOBODY else — not a coach, not
-- a team manager, not the global admin. The card says so in as many words, so
-- the policy is the feature and it is what these tests are mostly about.
--
-- The RLS half needs auth.uid() to be steerable, which it is on the scratch
-- cluster (_stubs.sql defines it as a constant NULL) and is not on a real
-- Supabase project. It is therefore SKIPPED, loudly, against the real thing —
-- redefining the platform's own auth.uid(), even inside a transaction that
-- rolls back, is not something a test should do to a live database.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000e1', 'trimmer@example.com'),
    ('00000000-0000-0000-0000-0000000000e2', 'coach@example.com'),
    ('00000000-0000-0000-0000-0000000000e3', 'nosy@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO public.teams (id, name) VALUES
    ('00000000-0000-0000-0000-0000000000f1', 'Day notes test')
ON CONFLICT DO NOTHING;
INSERT INTO public.boats (id, team_id, name) VALUES
    ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f1', 'Notebook')
ON CONFLICT DO NOTHING;

-- 0001 mirrors auth.users into public.users via a trigger; insert directly in
-- case that trigger is not present on a bare cluster.
INSERT INTO public.users (id, email, name, status) VALUES
    ('00000000-0000-0000-0000-0000000000e1', 'trimmer@example.com', 'Sam Whitcombe', 'active'),
    ('00000000-0000-0000-0000-0000000000e2', 'coach@example.com',   'Wouter van Dam', 'active'),
    ('00000000-0000-0000-0000-0000000000e3', 'nosy@example.com',    'Nosy Parker',    'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.memberships (id, user_id, team_id, boat_id, role) VALUES
    ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e1',
     '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 'tl1'),
    ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000e2',
     '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 'coach'),
    -- A coach on the same boat, who reads everything else about this day.
    ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000e3',
     '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 'coach')
ON CONFLICT DO NOTHING;

-- ── 1. One page per person per day, and the upsert can name it ─────────────
-- The card SAVES rather than appends, so a second row would be a second page
-- nobody can see. The API relies on ON CONFLICT finding this index.
INSERT INTO public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind, body) VALUES
    ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
     '2026-09-11', '00000000-0000-0000-0000-0000000000e1', 'debrief', 'Jib lead felt aft all day.');

INSERT INTO public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind, body) VALUES
    ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
     '2026-09-11', '00000000-0000-0000-0000-0000000000e1', 'debrief', 'Jib lead — one hole forward.')
ON CONFLICT (team_id, boat_id, session_date, user_id, kind) DO UPDATE SET body = EXCLUDED.body;

DO $$
DECLARE n bigint; b text;
BEGIN
    SELECT count(*), max(body) INTO n, b FROM public.ssa_day_notes
    WHERE user_id = '00000000-0000-0000-0000-0000000000e1' AND session_date = '2026-09-11';
    IF n <> 1 THEN RAISE EXCEPTION 'test 1 FAILED: % pages for one person and day', n; END IF;
    IF b <> 'Jib lead — one hole forward.' THEN
        RAISE EXCEPTION 'test 1 FAILED: the upsert did not replace the body (%)', b;
    END IF;
    RAISE NOTICE 'test 1 ok: one page per person per day, and ON CONFLICT can arbitrate';
END $$;

-- ── 2. Two people keep separate pages on the same day ──────────────────────
INSERT INTO public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind, body) VALUES
    ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
     '2026-09-11', '00000000-0000-0000-0000-0000000000e2', 'debrief', 'Ask about the second start.');

DO $$
BEGIN
    IF (SELECT count(*) FROM public.ssa_day_notes WHERE session_date = '2026-09-11') <> 2 THEN
        RAISE EXCEPTION 'test 2 FAILED: two people cannot both keep notes on one day';
    END IF;
    RAISE NOTICE 'test 2 ok: a page each';
END $$;

-- ── 3. The same person, two kinds, two pages ───────────────────────────────
-- `kind` exists so the next personal card needs no migration; prove it does not
-- collide with the debrief page.
INSERT INTO public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind, body) VALUES
    ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
     '2026-09-11', '00000000-0000-0000-0000-0000000000e1', 'speed', 'Rake +20 felt quick.');

DO $$
BEGIN
    IF (SELECT count(*) FROM public.ssa_day_notes
        WHERE user_id = '00000000-0000-0000-0000-0000000000e1' AND session_date = '2026-09-11') <> 2 THEN
        RAISE EXCEPTION 'test 3 FAILED: two kinds collided on one page';
    END IF;
    RAISE NOTICE 'test 3 ok: one page per kind';
END $$;

-- ── 4. An invented kind is refused ─────────────────────────────────────────
DO $$
BEGIN
    BEGIN
        INSERT INTO public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind, body) VALUES
            ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
             '2026-09-11', '00000000-0000-0000-0000-0000000000e1', 'typo', 'x');
        RAISE EXCEPTION 'test 4 FAILED: an unknown kind was accepted';
    EXCEPTION
        WHEN check_violation THEN RAISE NOTICE 'test 4 ok: the kind CHECK holds';
    END;
END $$;

-- ── 5. updated_at is the server's, not the client's ────────────────────────
-- now() is transaction time and constant inside this BEGIN, so "it moved"
-- cannot be asserted. What CAN be: that the trigger overrides whatever a client
-- sends, which is the property that makes the timestamp trustworthy.
UPDATE public.ssa_day_notes
   SET body = 'edited', updated_at = TIMESTAMPTZ '2001-01-01 00:00:00+00'
 WHERE user_id = '00000000-0000-0000-0000-0000000000e2';

DO $$
BEGIN
    IF (SELECT updated_at FROM public.ssa_day_notes
        WHERE user_id = '00000000-0000-0000-0000-0000000000e2') = TIMESTAMPTZ '2001-01-01 00:00:00+00' THEN
        RAISE EXCEPTION 'test 5 FAILED: a client-supplied updated_at survived';
    END IF;
    RAISE NOTICE 'test 5 ok: the touch trigger owns updated_at';
END $$;

-- ── 6. Deleting the person takes their notebook ────────────────────────────
DELETE FROM public.users WHERE id = '00000000-0000-0000-0000-0000000000e2';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.ssa_day_notes
               WHERE user_id = '00000000-0000-0000-0000-0000000000e2') THEN
        RAISE EXCEPTION 'test 6 FAILED: an orphaned private note survived its author';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ssa_day_notes
                   WHERE user_id = '00000000-0000-0000-0000-0000000000e1') THEN
        RAISE EXCEPTION 'test 6 FAILED: the other person lost their notes too';
    END IF;
    RAISE NOTICE 'test 6 ok: a deleted account takes its own notebook and nothing else';
END $$;

-- ── 7. RLS: mine, and only mine ────────────────────────────────────────────
-- The promise the card makes. Skipped against a real Supabase project, where
-- auth.uid() is the platform's and must not be redefined even transactionally.
DO $$
DECLARE steerable boolean;
BEGIN
    SELECT prosrc LIKE '%NULL::uuid%' INTO steerable
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'uid';

    IF NOT coalesce(steerable, false) THEN
        RAISE NOTICE 'test 7 SKIPPED: auth.uid() is the platform''s — run this on the scratch cluster';
        RETURN;
    END IF;

    EXECUTE $f$
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS
        $b$ SELECT nullif(current_setting('ssa.test_uid', true), '')::uuid $b$
    $f$;
    -- Supabase grants these by default; a bare cluster does not.
    EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.ssa_day_notes TO authenticated';

    -- Sam, the author.
    PERFORM set_config('ssa.test_uid', '00000000-0000-0000-0000-0000000000e1', true);
    SET LOCAL ROLE authenticated;
    IF (SELECT count(*) FROM public.ssa_day_notes) <> 2 THEN
        RAISE EXCEPTION 'test 7 FAILED: the author cannot read their own notes';
    END IF;
    RESET ROLE;

    -- A coach on the same boat (fixture e3). Reads the day, the tags, the team
    -- debrief card — and not this. That is the whole point of the table.
    PERFORM set_config('ssa.test_uid', '00000000-0000-0000-0000-0000000000e3', true);
    SET LOCAL ROLE authenticated;
    IF (SELECT count(*) FROM public.ssa_day_notes) <> 0 THEN
        RAISE EXCEPTION 'test 7 FAILED: a coach can read somebody else''s private notes';
    END IF;

    -- Nor write into somebody else's page.
    BEGIN
        INSERT INTO public.ssa_day_notes (team_id, boat_id, session_date, user_id, kind, body) VALUES
            ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
             '2026-09-12', '00000000-0000-0000-0000-0000000000e1', 'debrief', 'planted');
        RAISE EXCEPTION 'test 7 FAILED: a note was planted under another user''s id';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;   -- RLS refused, as it must
    END;
    RESET ROLE;

    RAISE NOTICE 'test 7 ok: the author reads their notebook and nobody else does';
END $$;

ROLLBACK;
