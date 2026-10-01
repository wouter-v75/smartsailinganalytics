-- ============================================================================
-- SSA — 0098 when the drone was actually filming
--
-- Nothing in the app has ever known the difference between "the drone was not
-- up" and "nobody cut that bit yet". On 30 September the top mark at 14:42:24
-- and the gate at 15:05:33 were both tagged and neither produced a clip: the
-- drone was on the deck through a 14-minute gap for the first and had landed
-- before the second. The only way to find that out was to read the cutter's
-- clip table line by line, after the fact, on the laptop.
--
-- The card knows, and the card is only ever plugged into one machine. So the
-- coverage is measured once when the drive is connected (scripts/drone-coverage)
-- and stored with the day, where the track can draw it for everybody.
--
-- SHAPE. One document, written whole by the scan, read whole by the track:
--
--   {
--     "footage":    [{"from": 1790000000000, "to": 1790000500000}, …],
--     "clips":      [{"from": 1790000100000, "to": 1790000160000}, …],
--     "scannedAt":  "2026-09-30T18:04:11.000Z",
--     "tzOffsetMin": 120,
--     "fileCount":  11
--   }
--
-- src/lib/droneCoverage.ts is the authority on it; the route and the track both
-- normalise through that one function, so a column left in an older shape by a
-- previous version cannot break a track.
--
-- EPOCH MILLISECONDS, TRUE UTC. The card is venue-local wall time — the drone's
-- filenames and its SRT sidecars both — and the conversion happens once, in the
-- script, before anything is written. `tzOffsetMin` records which offset did it,
-- so a wrong one is recognisable rather than merely suspected. Storing the
-- card's own clock here would put every band two hours off the track it exists
-- to annotate, which is CLAUDE.md's first trap and has cost this project a day
-- more than once.
--
-- WHY ON sessions. It is one document per (team, boat, date) and `sessions` is
-- already exactly that, with the policies to match: a crew member who can see
-- the day can see where the footage is. No new table and no new policy — a
-- second idea about who may see a day is how a gate ends up open on one route
-- and shut on another (0091's reasoning, and 0097's).
--
-- WRITES come from the scan, which runs with the service-role key and so passes
-- RLS regardless. Nothing in the app writes this column: a browser has never
-- seen the card.
--
-- Additive and idempotent. NULL means nobody has scanned that day's card, which
-- is different from a day whose drone never flew ({"footage": []}), and the
-- track says so differently.
-- ============================================================================

ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS drone_coverage JSONB;

COMMENT ON COLUMN public.sessions.drone_coverage IS
    'When the drone was recording, and which of it is already cut: '
    '{footage:[{from,to}], clips:[{from,to}], scannedAt, tzOffsetMin, fileCount}. '
    'Epoch ms, TRUE UTC — the card is venue-local and the scan converts once. '
    'Written by scripts/drone-coverage.ts when the drive is connected; read by '
    'the Tags tab track. NULL = never scanned, which is not the same as a day '
    'with no footage. See src/lib/droneCoverage.ts.';
