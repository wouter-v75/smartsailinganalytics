-- 0103 — tell an imported ARCHIVE apart from a polled observation.
--
-- WHY, AND IT IS NOT OPTIONAL. The poller sweeps wind_observations on every
-- run, deleting anything older than RETAIN_DAYS. That is right for rows the
-- poller itself wrote: they are a rolling record of the recent past. It is
-- fatal for an imported historical archive. ISPRA's Rete Mareografica
-- Nazionale publishes 10-minute wind back to 2014 under CC-BY, and importing
-- it into this table without an exemption means the next poll — within half an
-- hour — deletes every row of it. The import would appear to work and then
-- silently vanish.
--
-- So `archive` marks rows that did not come from a poll and must never be
-- pruned by one. The sweep in src/app/api/obs/poll/route.ts filters on it.
--
-- `validated` records whether the SOURCE considers the data validated. ISPRA
-- publish the real-time series at validation level L0 — explicitly
-- unvalidated, with their own notice that it "may contain errors not
-- attributable to ISPRA" — while their validated series appear later after
-- review. Those are two different quantities and must not be averaged
-- together when fitting a correction, which is exactly what would happen if
-- the distinction were not stored. NULL means the source says nothing either
-- way, which is the honest value for most of the network.
--
-- Both columns are nullable or defaulted, so every existing row keeps its
-- meaning: archive FALSE (they were all polled) and validated NULL (no source
-- said).
--
-- Additive and idempotent. Run after 0102.

ALTER TABLE public.wind_observations
    ADD COLUMN IF NOT EXISTS archive   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS validated BOOLEAN;

-- The retention sweep's query shape: everything older than the cutoff that is
-- NOT archive. Partial, because archive rows are the minority it must skip and
-- a partial index keeps the sweep reading only what it can delete.
CREATE INDEX IF NOT EXISTS wind_observations_prunable_t_idx
    ON public.wind_observations (t)
    WHERE archive = FALSE;

COMMENT ON COLUMN public.wind_observations.archive IS
    'TRUE for rows imported from a historical archive (e.g. ISPRA RMN). The poller''s retention sweep never prunes these.';
COMMENT ON COLUMN public.wind_observations.validated IS
    'Whether the SOURCE considers the reading validated. ISPRA RMN real-time series are level L0, i.e. FALSE. NULL = the source says nothing.';
