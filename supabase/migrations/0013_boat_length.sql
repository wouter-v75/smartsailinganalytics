-- ============================================================================
-- SSA — Per-boat hull length.
--
-- The start-line gauge reads DST_LINE straight from the Expedition log (in
-- boat lengths), but the BL-loss analytics chart and a few other places still
-- need an actual length to convert metres → boat lengths. Previously that
-- length was parsed out of the boat name (e.g. "NORTHSTAR72" → 72 ft) — a
-- guess. This column lets admins set the value explicitly in metres so the
-- conversion is correct regardless of how the boat is named.
--
-- Stored canonically in metres; the admin UI offers an m/ft input toggle.
--
-- Run after 0012. Idempotent.
-- ============================================================================

ALTER TABLE public.boats
    ADD COLUMN IF NOT EXISTS length_m NUMERIC(6, 2);

COMMENT ON COLUMN public.boats.length_m IS
    'Boat hull length in metres (LOA). NULL = not set; consumers should fall back to parsing the length out of the boat name.';
