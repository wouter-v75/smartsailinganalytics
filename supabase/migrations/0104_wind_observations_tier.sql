-- 0104 — store WHICH STATIONS MAY BE FITTED AGAINST.
--
-- WHY A COLUMN AND NOT JUST `trust`. Every row already carries a 0-10 `trust`
-- from its source class, which is fine for weighting a map and useless for
-- deciding what a correction may be fitted against:
--
--   trust IS PER SOURCE, NOT PER STATION. All 301 Davis stations score 2
--   whether they stand on the Posillipo headland or in the Apennine interior.
--   Every Meteo-France land station scores 7 — including Cap Camarat, 107 m up
--   a cliff, which is a first-rate wind-sector indicator and a poor target for
--   an absolute bias. ABP's Bramble Bank post, out in the middle of the
--   Solent, scores the same as ABP's mast inside the docks behind a grain
--   terminal.
--
--   A NUMBER IS NOT A PERMISSION. trust = 2 does not say "never fit on this",
--   so nothing stops a fitting script pooling all 301 gardens and
--   down-weighting them. The Met Office's assessment of crowd-sourced wind is
--   that "the observation rejection rate is too high to be useful", and KNMI
--   measured about 19 % surviving quality control before any representativeness
--   test. Against that, down-weighting is not a defence. Refusing is.
--
-- THE THREE VALUES ARE PERMISSIONS:
--
--   fit        professionally sited and maintained, over water or with known
--              exposure. May be fitted against.
--   probation  a real instrument whose siting is compromised or whose metadata
--              is incomplete. Timing, gradient and wind-sector work yes;
--              absolute bias no, until something has checked it.
--   display    draw it, never compute from it.
--
-- The rule lives in src/lib/obsTier.ts — defaults by source, exceptions by
-- station, each with its reason — and is written onto every row at poll time
-- so that nothing downstream has to re-derive it or can disagree with it.
--
-- NULL is allowed and means "written before this column existed". A reader
-- that wants the fitting set must ask for tier = 'fit' explicitly; treating
-- NULL as fit would re-admit the whole garden network through the back door.
--
-- Additive and idempotent. Run after 0103.

ALTER TABLE public.wind_observations
    ADD COLUMN IF NOT EXISTS tier TEXT
        CHECK (tier IS NULL OR tier IN ('fit', 'probation', 'display'));

-- The query a fitting job makes: one tier, over a period, by station.
CREATE INDEX IF NOT EXISTS wind_observations_tier_t_idx
    ON public.wind_observations (tier, t DESC)
    WHERE tier = 'fit';

COMMENT ON COLUMN public.wind_observations.tier IS
    'Permission, not weighting: fit = may be fitted against, probation = timing/gradient only, display = draw only. Rule in src/lib/obsTier.ts. NULL = written before the column existed; never treat NULL as fit.';
