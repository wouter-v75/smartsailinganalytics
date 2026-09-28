-- 0094_warning_signal_race_tag.sql
-- ---------------------------------------------------------------------------
-- The warning signal counts as a RACE tag too.
--
-- It joined the Racing picker alongside the 5 minute gun, and race_tag_slugs()
-- is the other half of that: what "share race tags only" means for a squad.
-- A slug in the picker but not in this array shares nothing and says nothing —
-- see 0093's note on why that shape of bug is the worst one here.
--
-- The warning signal and the 5 minute gun are the SAME instant in the standard
-- sequence. Both exist because crews say both; neither is the canonical one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.race_tag_slugs()
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE
AS $$ SELECT ARRAY[
    'race',
    'day-start',
    'warning-signal',
    'five-minute-gun',
    'race-start',
    'topmark',
    'gate',
    'mark',
    'race-finish',
    'day-end'
] $$;
