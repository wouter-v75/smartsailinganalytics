-- 0032 — Sessions get a Location (regatta venue).
--
-- Pairs with sessions.event (added in 0028). A racing day belonging to a
-- regatta carries both the regatta name (event) and where it's held
-- (location, e.g. "St Tropez", "Porto Cervo"). The Regattas sub-tab in the
-- Campaign UI groups racing days by event name, sorted by date, and shows
-- the location alongside.
--
-- Idempotent.

ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS location TEXT;

ALTER TABLE public.sessions
    DROP CONSTRAINT IF EXISTS sessions_location_len_check;
ALTER TABLE public.sessions
    ADD CONSTRAINT sessions_location_len_check
    CHECK (location IS NULL OR char_length(location) <= 80);
