-- 0093_five_minute_gun_race_tag.sql
-- ---------------------------------------------------------------------------
-- The 5 minute gun counts as a RACE tag.
--
-- race_tag_slugs() (0074) is what "share race tags only" means when a team
-- opts into that middle setting for its squad: starts, marks and finishes go,
-- training tags stay private. A team that picked it would expect the gun that
-- began the sequence to travel with the start it belongs to — and without this
-- it silently would not, which is the worst shape of bug in a sharing feature:
-- nothing errors, the tag is simply missing from a partner's screen and only
-- the owning team can see that it should be there.
--
-- ONE LIST, TWO PLACES. This array and the 'racing' group in
-- src/lib/tagging/barGroups.ts answer the same question — "is this a racing
-- moment?" — and a policy and a picker must never disagree about it. They are
-- kept in step by hand; 0074's own comment says so, and this migration is what
-- keeping them in step looks like.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.race_tag_slugs()
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE
AS $$ SELECT ARRAY[
    'race',
    'day-start',
    'five-minute-gun',
    'race-start',
    'topmark',
    'gate',
    'mark',
    'race-finish',
    'day-end'
] $$;
