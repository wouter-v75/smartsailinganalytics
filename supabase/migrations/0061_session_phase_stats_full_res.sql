-- ============================================================================
-- SSA — 0061  session_phase_stats: log resolution, manoeuvres, headlines
--
-- The cloud copy of a log keeps a row every ~6 s (reduceLogForCloud), which blurs
-- maxima, narrow TWA bands and manoeuvre timing. The importing device still has
-- the full-resolution log, so it computes the phase stats + tack/gybe metrics
-- from every row and stores them here; other devices then read those instead of
-- recomputing from the 6 s copy.
--
--   resolution_s     median seconds between the log rows the stats came from
--                    (≈1 from the full log, ≈6 from the cloud copy). A finer row is
--                    never replaced by a coarser one unless it is out of date.
--   manoeuvres       the day's tacks and gybes with their metrics (lib/manoeuvres)
--   headlines        { headlines: string[], bottomLine: string[], dropped: string[] } —
--                    written by Mistral on Scaleway (EU) from the stored numbers only
--   headlines_model  the model that wrote them
--   headlines_at     when
--
-- Additive, idempotent. Run after 0060.
-- ============================================================================

ALTER TABLE public.session_phase_stats
    ADD COLUMN IF NOT EXISTS resolution_s    REAL,
    ADD COLUMN IF NOT EXISTS manoeuvres      JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS headlines       JSONB,
    ADD COLUMN IF NOT EXISTS headlines_model TEXT,
    ADD COLUMN IF NOT EXISTS headlines_at    TIMESTAMPTZ;
