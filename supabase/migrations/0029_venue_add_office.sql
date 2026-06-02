-- 0029 — Extend "venue" (called "Location" in the UI as of this release) to
-- include 'office'. Used for desk/admin work — debrief writeups, planning,
-- procurement etc.
--
-- The DB column name stays `venue` for stability; UI now reads "Location".
-- Idempotent.

ALTER TABLE public.backlog_items
    DROP CONSTRAINT IF EXISTS backlog_items_venue_check;
ALTER TABLE public.backlog_items
    ADD CONSTRAINT backlog_items_venue_check
    CHECK (venue IS NULL OR venue IN ('on-water', 'dock', 'shed', 'office'));

ALTER TABLE public.session_blocks
    DROP CONSTRAINT IF EXISTS session_blocks_venue_check;
ALTER TABLE public.session_blocks
    ADD CONSTRAINT session_blocks_venue_check
    CHECK (venue IS NULL OR venue IN ('on-water', 'dock', 'shed', 'office'));
