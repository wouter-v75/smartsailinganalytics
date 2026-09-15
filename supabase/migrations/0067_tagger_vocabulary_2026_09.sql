-- ============================================================================
-- SSA — 0067  Button bar: Technical replaces Gear damage, Incident steps back,
--             Grab video joins.
--
-- The base vocabulary lives in src/lib/tagging/baseTags.ts, and a team gets its
-- copy ONCE — the seed route runs only when a team has no definitions at all.
-- That is the right behaviour (a team may curate its own bar and should not
-- have it rewritten under them), and it means a change to the code's vocabulary
-- reaches exactly the teams that have not started yet. Everybody already
-- tagging keeps the old bar for ever unless a migration carries them across.
-- This is that migration.
--
-- Three changes, and only the first is destructive in any sense:
--
--   1. GEAR DAMAGE → TECHNICAL. Renamed in place, definition and events alike.
--      "Gear damage" named the worst case and so was pressed only for the worst
--      case; most of what a crew wants to flag is a system misbehaving. Renaming
--      the EVENTS too is the point: a season of tags that no longer match any
--      definition is a season that has quietly stopped being searchable.
--
--   2. INCIDENT off the bar. Not archived, not deleted: it stays in the picker
--      and every tag already placed under it keeps its meaning. It was the same
--      reflex as Technical, and two buttons for one reflex means neither is
--      used consistently.
--
--   3. GRAB VIDEO added. Pressing it tags the moment AND raises a video request
--      (the app does the second half — see TaggerTab). Only teams that have the
--      seeded vocabulary get it, at the settings baseTags.ts declares.
--
-- A team that has CUSTOMISED any of this keeps its customisation: the renames
-- leave a re-worded label alone, and the insert skips a team that already has
-- the slug.
--
-- Idempotent. Run after 0063.
-- ============================================================================

-- ── 1. Gear damage → Technical ──────────────────────────────────────────────
-- Skipped for a team that somehow holds both slugs already, because the unique
-- index (team, boat, scope, section, owner, slug) would reject the rename and
-- take the whole migration down with it.
UPDATE public.ssa_tag_defs d
   SET slug  = 'technical',
       -- Only rename a label still saying what the seed said. A team that calls
       -- it something of their own has made a decision, and a migration is not
       -- the place to overrule it.
       label = CASE WHEN d.label = 'Gear damage' THEN 'Technical' ELSE d.label END
 WHERE d.slug = 'gear-damage'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs o
        WHERE o.slug = 'technical'
          AND o.team_id = d.team_id
          AND o.boat_id IS NOT DISTINCT FROM d.boat_id
          AND o.scope = d.scope
          AND o.section IS NOT DISTINCT FROM d.section
          AND o.owner_user_id IS NOT DISTINCT FROM d.owner_user_id
   );

-- The tags themselves. ssa_tag_events denormalises slug and label from the
-- definition (0062) precisely so the event file and the filters survive a
-- rename — which only works if the rename reaches them.
UPDATE public.ssa_tag_events
   SET slug  = 'technical',
       label = CASE WHEN label = 'Gear damage' THEN 'Technical' ELSE label END
 WHERE slug = 'gear-damage';

-- ── 2. Incident off the bar ─────────────────────────────────────────────────
UPDATE public.ssa_tag_defs
   SET on_button_bar = FALSE
 WHERE slug = 'incident'
   AND builtin
   AND on_button_bar;

-- ── 3. Grab video ───────────────────────────────────────────────────────────
-- One per (team, boat) that already carries the seeded general vocabulary. The
-- settings mirror baseTags.ts: 30 s of lead, because the moment you want filmed
-- started before you thought to ask for it.
INSERT INTO public.ssa_tag_defs
    (team_id, boat_id, scope, section, owner_user_id, slug, label, color,
     min_role, kind, lead_sec, lag_sec, label_groups, on_button_bar, builtin, sort)
SELECT DISTINCT
    d.team_id, d.boat_id, 'general', NULL::text, NULL::uuid, 'grab-video', 'Grab video', '#06B6D4',
    'tl1', 'point', 30, 20,
    '[{"group":"Wanted","options":["onboard","drone","either"]}]'::jsonb,
    TRUE, TRUE, 82
  FROM public.ssa_tag_defs d
 WHERE d.builtin
   AND d.scope = 'general'
   AND NOT EXISTS (
       SELECT 1 FROM public.ssa_tag_defs g
        WHERE g.slug = 'grab-video'
          AND g.team_id = d.team_id
          AND g.boat_id IS NOT DISTINCT FROM d.boat_id
          AND g.scope = 'general'
   );
