-- 0100_backfill_missing_race_tag_defs.sql
-- ---------------------------------------------------------------------------
-- The 5 minute gun and the Warning signal have been missing from every team
-- that was already using the tagger.
--
-- 0093 and 0094 added them, and each did only HALF the job: both redefined
-- race_tag_slugs() — the array that decides what "share race tags only" means
-- for a squad — and neither inserted the tag DEFINITION for teams whose
-- vocabulary was already seeded. The seed route only runs for a boat with an
-- empty list (TaggerTab seeds when defs.length === 0), so for Northstar the two
-- tags have existed in the code, in the sharing policy and in the Racing
-- group's declared membership, and nowhere a crew could press them.
--
-- And it failed SILENTLY, which is why it lasted: groupMembers() skips a slug
-- it cannot resolve, by design — "a team that has archived Gate simply does not
-- see it" — so the Racing picker quietly rendered eight members instead of ten
-- and nothing anywhere said a definition was missing. 0096's own header says
-- "TWO HALVES, as 0093 and 0094 had", which is how the gap survived review: it
-- was written down as done.
--
-- Caught by a new guardrail in src/lib/tagging/__tests__/baseTags.test.ts,
-- which asserts that every base tag added since teams started using the tagger
-- is inserted by some migration AND that the row still matches the code.
--
-- Both are already in race_tag_slugs() (0093, 0094, carried by 0096), so there
-- is nothing to change about sharing. Values are the current code definitions
-- in src/lib/tagging/baseTags.ts, which the guardrail holds them to.
-- ---------------------------------------------------------------------------

-- The 5 minute gun. A gun is a sound: nothing in a GPS trace marks it, so if
-- the crew does not press it, it is not there. askOnAdd on the start type,
-- because a gun that does not say whether what followed was a practice or a
-- race is a gun nobody can use a week later.
INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
    'five-minute-gun', '5 min gun', '#EF4444',
    'tl1', 'point', 20, 60,
    '[{"group":"Start type","options":["practise start","practise race","race"],"askOnAdd":true}]'::jsonb,
    FALSE, TRUE, 9
  FROM public.ssa_tag_defs d
 WHERE d.builtin
   AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs g
        WHERE g.slug = 'five-minute-gun'
          AND g.team_id = d.team_id
          AND g.boat_id IS NOT DISTINCT FROM d.boat_id
          AND g.scope = 'general'
   );

-- The warning signal. The same instant as the gun in the standard sequence, and
-- here because crews say both — a picker that refuses the word somebody
-- actually uses is a picker they stop reaching for.
INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
    'warning-signal', 'Warning signal', '#F59E0B',
    'tl1', 'point', 10, 10,
    '[]'::jsonb,
    FALSE, TRUE, 72
  FROM public.ssa_tag_defs d
 WHERE d.builtin
   AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs g
        WHERE g.slug = 'warning-signal'
          AND g.team_id = d.team_id
          AND g.boat_id IS NOT DISTINCT FROM d.boat_id
          AND g.scope = 'general'
   );
