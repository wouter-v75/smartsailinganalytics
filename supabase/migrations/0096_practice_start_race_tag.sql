-- 0096_practice_start_race_tag.sql
-- ---------------------------------------------------------------------------
-- A practice start is a start.
--
-- The crew want the clip — it is the one moment of a training day that looks
-- exactly like racing. What follows it is NOT a race: it is a crew milling
-- about until the real gun. That distinction is the whole reason this is a tag
-- of its own rather than a label on race-start, because the clip cutter bounds
-- a race by the NEXT gun, and a practice start logged as a race swallowed half
-- an hour of nothing on 29 September 2026 — six mark roundings of a crew
-- getting ready.
--
-- TWO HALVES, as 0093 and 0094 had.
--
-- race_tag_slugs() is what "share race tags only" means for a squad. A slug in
-- the Racing picker but not in this array shares nothing and says nothing: no
-- error, the tag is simply missing from a partner's screen, and only the owning
-- team can see that it should be there. src/lib/tagging/barGroups.ts holds the
-- picker's half of the same list, and a test asserts the two agree.
--
-- And the definition itself, for teams whose vocabulary was seeded before this
-- existed. Without it the tag is in the code and on nobody's button bar.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.race_tag_slugs()
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE
AS $$ SELECT ARRAY[
    'race',
    'day-start',
    'warning-signal',
    'five-minute-gun',
    'practice-start',
    'race-start',
    'topmark',
    'gate',
    'mark',
    'race-finish',
    'day-end'
] $$;

-- One row per (team, boat) that already has a builtin general vocabulary, and
-- only where this slug is not there yet — so running it twice adds nothing.
INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
    'practice-start', 'Practice start', '#EF4444',
    'tl1', 'point', 60, 30,
    '[{"group":"Quality","options":["good","ok","poor"]}]'::jsonb,
    FALSE, TRUE, 8
  FROM public.ssa_tag_defs d
 WHERE d.builtin
   AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs g
        WHERE g.slug = 'practice-start'
          AND g.team_id = d.team_id
          AND g.boat_id IS NOT DISTINCT FROM d.boat_id
          AND g.scope = 'general'
   );
