-- 0099_love_this_setup_tag.sql
-- ---------------------------------------------------------------------------
-- "I love this setup 👌🏼" — one press that marks something GOOD.
--
-- The button bar was eight buttons and every one of them recorded a problem: a
-- note, a technical, something to come back to. So a day came out tagged only
-- where it went wrong, and the setup that made the boat fast — the one thing
-- nobody can reconstruct a week later — had nothing pointing at it. Not for
-- want of data: the log holds the whole state at that second, rig loads, trim,
-- targets. What was missing was somebody saying THIS one, and that has to be as
-- cheap as the complaint.
--
-- WHY A MIGRATION AND NOT JUST baseTags.ts. The seed route only runs for a boat
-- with an empty vocabulary (TaggerTab seeds when defs.length === 0), so a new
-- base tag reaches nobody who is already using the tagger. Without this it is
-- in the code and on no existing team's button bar. Same shape as 0093, 0094
-- and 0096.
--
-- NOT added to race_tag_slugs(). That array is what "share race tags only"
-- means for a squad, and this is not a racing moment — it is the crew's opinion
-- of their own boat, which is theirs. A squad partner seeing which setups the
-- other team loved is not a feature anybody asked for.
--
-- 30 s either side rather than review's 20: a setup is a state, not an event,
-- so the window exists to average the instruments over.
-- ---------------------------------------------------------------------------

-- One row per (team, boat) that already has a builtin general vocabulary, and
-- only where this slug is not there yet — so running it twice adds nothing.
INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid,
    'love-setup', 'I love this setup 👌🏼', '#A3E635',
    'tl1', 'point', 30, 30,
    '[{"group":"What","options":["whole boat","main","jib","kite","rig","mode"]}]'::jsonb,
    TRUE, TRUE, 91
  FROM public.ssa_tag_defs d
 WHERE d.builtin
   AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs g
        WHERE g.slug = 'love-setup'
          AND g.team_id = d.team_id
          AND g.boat_id IS NOT DISTINCT FROM d.boat_id
          AND g.scope = 'general'
   );

-- The label, for anyone who ran an earlier copy of this file. The INSERT above
-- is NOT EXISTS-guarded, so on a second run it adds nothing and would leave the
-- first wording in place for ever. Only `builtin` rows and only the label —
-- which is the same rule the seed route follows for a base-vocabulary change,
-- so a team that has renamed the tag themselves keeps their name.
UPDATE public.ssa_tag_defs
   SET label = 'I love this setup 👌🏼'
 WHERE slug = 'love-setup'
   AND builtin
   AND scope = 'general'
   AND label <> 'I love this setup 👌🏼';
