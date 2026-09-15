-- ============================================================================
-- SSA — 0065  The batten card belongs to a MAINSAIL, not to a boat.
--
-- 0064 put one card on the boat. That is wrong for any programme with more than
-- one main: a new main and a three-season delivery main do not want the same
-- turns, and a two-boat testing week is exactly when the difference matters and
-- exactly when nobody has time to notice the card is describing the other sail.
--
-- So: `sail_id`, pointing at the mainsail the card is for.
--
-- NULLABLE, for one reason — the cards entered under 0064 belong to a boat and
-- nobody has said which main they describe. Deleting them to tidy the schema
-- would throw away hand-entered work, so an unassigned card survives as a row
-- with sail_id IS NULL and the UI offers it to a main that has none of its own.
-- Where a boat has exactly ONE mainsail in its inventory the answer is not
-- ambiguous, so this migration makes that assignment itself.
--
-- NULLS NOT DISTINCT on the unique index, so a boat can hold at most one
-- unassigned card rather than accumulating a pile of them. (PostgreSQL 15+.
-- Supabase is on 17; the throwaway cluster the tests run against is 16.)
--
-- Idempotent. Run after 0064.
-- ============================================================================

-- ── 1. The column ───────────────────────────────────────────────────────────
-- ON DELETE CASCADE: a card for a sail that no longer exists is not a record of
-- anything. Retiring a sail is a flag on the row, not a delete, so a retired
-- main keeps its card — which is what you want when last season's numbers are
-- the reason you are looking.
ALTER TABLE public.boat_battens
    ADD COLUMN IF NOT EXISTS sail_id UUID REFERENCES public.sails(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.boat_battens.sail_id IS
    'The mainsail this card describes. NULL = entered before 0065, not yet assigned to a sail.';

-- ── 2. One card per (boat, sail) ────────────────────────────────────────────
-- The old constraint said one per boat, which is the thing being fixed. It has
-- to go before the new one can exist, or the second main could never be saved.
ALTER TABLE public.boat_battens DROP CONSTRAINT IF EXISTS boat_battens_one_per_boat;

-- A plain unique INDEX rather than a constraint, because NULLS NOT DISTINCT is
-- only expressible on an index — and PostgREST can still name an index in the
-- ON CONFLICT that the API's upsert generates. (The 0062 lesson in reverse: a
-- PARTIAL index is what cannot arbitrate; a full one on a NULLable column can.)
CREATE UNIQUE INDEX IF NOT EXISTS boat_battens_one_per_sail_idx
    ON public.boat_battens (team_id, boat_id, sail_id) NULLS NOT DISTINCT;

-- ── 3. Adopt the unambiguous cards ──────────────────────────────────────────
-- Where the boat has exactly one mainsail that is not retired, the card can only
-- be describing that sail. Anything less certain is left for a person to decide.
UPDATE public.boat_battens b
SET sail_id = only_main.id
FROM (
    SELECT s.boat_id, min(s.id::text)::uuid AS id
    FROM public.sails s
    WHERE s.kind = 'mainsail' AND NOT s.retired
    GROUP BY s.boat_id
    HAVING count(*) = 1
) AS only_main
WHERE b.sail_id IS NULL
  AND b.boat_id = only_main.boat_id;

-- ── 4. Faster lookup of "every card for this boat" ─────────────────────────
-- Which is how the app reads them: the batten tab in the sail-change composer
-- needs the card for whichever main is UP, and fetching them one at a time would
-- be a request per sail on every press.
CREATE INDEX IF NOT EXISTS boat_battens_boat_idx
    ON public.boat_battens (team_id, boat_id);

COMMENT ON TABLE public.boat_battens IS
    'Batten card per MAINSAIL: target stiffness + turns per batten (top-down) per wind band. See src/lib/battens.ts. sail_id NULL = unassigned, from before 0065.';
