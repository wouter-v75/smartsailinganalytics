-- What is in the workspace menu, and why — read-only.
--
-- Paste into the Supabase SQL editor. Nothing is changed.
--
-- The user pill lists one workspace per team+BOAT. A membership with
-- boat_id NULL ("all boats") expands to one entry per boat in that team, which
-- is how rivals got in: migration 0091 files a competitor under the team that
-- photographs it, because a coach has to be able to see it to measure it.
--
-- Column `why` is the answer:
--   expanded, ours        a real workspace
--   expanded, COMPETITOR  a rival. Nothing of theirs exists to look at — no
--                         session, no log, no upload. Hidden from the menu as
--                         of the expandWorkspaces change; they remain
--                         measurable in SailTrim, which is the only place they
--                         were ever for.
--   named explicitly      somebody was given this exact boat on purpose. Kept.
--   own team              the rival has a TEAM of its own, not just a boat.
--                         The menu change does NOT hide these — see below.

SELECT
    u.email,
    t.name                                   AS team,
    COALESCE(b.name, '(all boats)')          AS boat,
    m.role,
    b.is_competitor,
    CASE
        WHEN m.boat_id IS NOT NULL AND b.is_competitor THEN 'named explicitly (competitor)'
        WHEN m.boat_id IS NOT NULL                     THEN 'named explicitly'
        WHEN b.is_competitor                           THEN 'expanded, COMPETITOR'
        ELSE                                                'expanded, ours'
    END                                      AS why
FROM public.memberships m
JOIN public.teams t  ON t.id = m.team_id
JOIN public.users u  ON u.id = m.user_id
LEFT JOIN public.boats b
       ON (m.boat_id IS NOT NULL AND b.id = m.boat_id)
       OR (m.boat_id IS NULL     AND b.team_id = m.team_id)
WHERE u.email = 'wouterv@runbox.com'       -- ← the account whose menu you are looking at
ORDER BY t.name, b.is_competitor NULLS FIRST, b.name;

-- If a rival appears here as its OWN TEAM (its name in the `team` column,
-- rather than as a boat under your own team), the menu change will not hide it:
-- that is a membership, and the fix is to drop it. Creating a team auto-grants
-- the creator a team_manager membership (api/admin/teams/route.ts), which is
-- how that happens. Check first, then delete only what you mean to:
--
--   SELECT m.id, t.name
--   FROM public.memberships m JOIN public.teams t ON t.id = m.team_id
--   JOIN public.users u ON u.id = m.user_id
--   WHERE u.email = 'wouterv@runbox.com'
--     AND t.name IN ('Balthasar','Django','Bella Mente','Capricorno','Jolt','Jethou');
--
--   DELETE FROM public.memberships WHERE id IN ( …the ids you just read… );
--
-- Deleting a MEMBERSHIP removes your access to that team, nothing else. The
-- team, its boats and their rig models stay exactly where they are, which is
-- what SailTrim reads. Do not delete the teams themselves without checking
-- whether a boat under them carries a rig model you measured.
