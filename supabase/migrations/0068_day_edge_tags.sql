-- ============================================================================
-- SSA — 0068  Day start, Day end, and making sure Finish is actually there.
--
-- Same problem as 0067, and it will keep recurring: the base vocabulary lives
-- in src/lib/tagging/baseTags.ts and a team gets its copy ONCE, the first time
-- somebody opens the tagger. Adding a tag to the code therefore reaches exactly
-- the teams that have not started yet. Everybody already tagging keeps the
-- vocabulary they were seeded with, for ever, unless a migration carries them.
--
-- Three definitions, inserted only where they are missing:
--
--   day-start / day-end   the two ends of the day on the water. Distinct from
--                         dock out / dock in — those are the dock, these are
--                         when the day's RECORD starts and stops, which is what
--                         the event file knows and what every other screen
--                         measures from. Detected from DayStart/DayStop where
--                         the file has them; on the Racing button when it does
--                         not.
--
--   race-finish           already in baseTags.ts and already named by the
--                         Racing button group — but a team seeded before it was
--                         added simply has no definition behind it, and
--                         groupMembers SKIPS what it cannot resolve. The button
--                         then quietly offers four moments instead of five and
--                         nothing looks broken. This is why "add finish" was
--                         worth asking for on a build that already had it.
--
-- A team that has these already, or has archived them on purpose, is untouched:
-- every insert is guarded on the slug not existing for that (team, boat).
--
-- Idempotent. Run after 0067.
-- ============================================================================

INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
    v.slug, v.label, v.color, 'tl1', 'point', v.lead_sec, v.lag_sec,
    '[]'::jsonb, FALSE, TRUE, v.sort
  FROM public.ssa_tag_defs d
 CROSS JOIN (VALUES
        -- slug,          label,        colour,    lead, lag, sort
        ('day-start',     'Day start',  '#F59E0B',   30,  30,  68),
        ('day-end',       'Day end',    '#F59E0B',   30,  30,  69),
        ('race-finish',   'Finish',     '#EF4444',   30,  20,  19)
     ) AS v(slug, label, color, lead_sec, lag_sec, sort)
 WHERE d.builtin
   AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs e
        WHERE e.slug = v.slug
          AND e.team_id = d.team_id
          AND e.boat_id IS NOT DISTINCT FROM d.boat_id
          AND e.scope = 'general'
   );
