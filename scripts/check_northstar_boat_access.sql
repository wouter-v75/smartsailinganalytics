-- Who can see which Northstar boat? (read-only)
-- Per member: their membership rows, and a verdict of which boats they can see.
--   boat_id = NULL         → ALL boats in the team (72 + 76 today)
--   boat_id = <Northstar 72> only → 72 ONLY  ← the people reporting the problem
--   two rows (72 and 76)   → both, explicitly
--
-- Run in Supabase → SQL editor. Change the team name if yours differs.

WITH team AS (
  SELECT id FROM public.teams WHERE name ILIKE 'northstar%' LIMIT 1
),
boats AS (
  SELECT id, name FROM public.boats WHERE team_id = (SELECT id FROM team)
)
SELECT
  u.name,
  u.email,
  -- one line per member: the set of boats their memberships resolve to
  CASE
    WHEN bool_or(m.boat_id IS NULL)                       THEN 'ALL boats (72 + 76)'
    WHEN bool_or(b.name = 'Northstar 76')
     AND bool_or(b.name = 'Northstar 72')                 THEN 'both (explicit rows)'
    WHEN bool_or(b.name = 'Northstar 76')                 THEN 'Northstar 76 only'
    WHEN bool_or(b.name = 'Northstar 72')                 THEN 'Northstar 72 ONLY  <-- cannot see 76'
    ELSE 'no boat rows?'
  END AS can_see,
  string_agg(DISTINCT coalesce(b.name, 'ALL') || ' [' || m.role || ']', ', ' ORDER BY coalesce(b.name, 'ALL') || ' [' || m.role || ']') AS memberships
FROM public.memberships m
JOIN public.users u ON u.id = m.user_id
LEFT JOIN boats b   ON b.id = m.boat_id
WHERE m.team_id = (SELECT id FROM team)
GROUP BY u.name, u.email
ORDER BY can_see DESC, u.name;
