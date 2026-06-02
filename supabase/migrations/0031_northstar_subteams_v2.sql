-- 0031 — Tidy up Northstar sub-team vocabulary.
--
--   • 'Bow' → 'Boathandling' (the on-water grouping is broader than just
--     the foredeck — call it what it is).
--   • 'Shore' is deactivated: shore work belongs in the campaign's Day
--     blocks (block_type='shore') and on backlog items via venue='shed' or
--     'office'. Keeping it as a sub-team duplicates that axis.
--
-- We mutate in-place rather than dropping rows so any backlog items that
-- already reference these sub-teams keep working — the Bow rows survive
-- with their new identity, and Shore rows stay reachable via showing
-- inactive sub-teams.
--
-- Idempotent.

UPDATE public.subteams s
   SET key = 'boathandling', label = 'Boathandling'
  FROM public.teams t
 WHERE s.team_id = t.id
   AND lower(t.name) = 'northstar'
   AND s.key = 'bow';

UPDATE public.subteams s
   SET active = false
  FROM public.teams t
 WHERE s.team_id = t.id
   AND lower(t.name) = 'northstar'
   AND s.key = 'shore'
   AND s.active = true;
