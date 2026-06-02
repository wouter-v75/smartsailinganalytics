-- 0028 — Sessions get an Event (regatta) name.
--
-- The campaign target date used to live as a single value in
-- teams.features.campaign_target_date. We're replacing that with multiple
-- regattas planned through the year: a session marked with one or more
-- 'racing' blocks can also carry an event name (e.g. "Worlds 2026",
-- "Cowes Week"). The Plan view then auto-derives:
--   • "Next Event"  = the earliest session in the future where event is set
--   • "Days to go"  = days from today to that session's date
--   • "Training days to go" = non-racing sessions between today and the next event
--
-- Multi-day regattas are represented as a sequence of racing sessions sharing
-- the same event name. The shape of "a regatta" is therefore emergent — no
-- separate events table needed.
--
-- Idempotent.

ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS event TEXT;

-- Trim very long values silently to keep the chip layout sane.
ALTER TABLE public.sessions
    DROP CONSTRAINT IF EXISTS sessions_event_len_check;
ALTER TABLE public.sessions
    ADD CONSTRAINT sessions_event_len_check
    CHECK (event IS NULL OR char_length(event) <= 80);
