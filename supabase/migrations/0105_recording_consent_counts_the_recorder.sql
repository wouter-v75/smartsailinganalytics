-- The consent gate did not count the person pressing record.
--
-- WHAT HAPPENED. Wouter, 8 Nov 2026: a team he had just created, of which he was
-- the only member, and whose profile box was already ticked, refused the debrief
-- recorder with "Not all of your team have agreed to team recording. They can do
-- so in their profile." There was nobody else to ask, and the panel named nobody,
-- because there WAS nobody — a dead end with no next step in it.
--
-- WHY. `team_recording_consent()` (migration 0078) counts only the roles that
-- are in the room by virtue of sailing the boat: coach, tl1, tl3. (0078 also
-- listed tl2; migration 0083 removed that role and promoted every holder to tl3,
-- so it has matched nothing for 22 migrations and is dropped here rather than
-- copied on.) That
-- exclusion is right as far as it goes — an owner who never opens their profile
-- must not stop a coach debriefing. But `POST /api/admin/teams` auto-grants the
-- CREATOR a `team_manager` membership, so a new one-person team has
--
--     total = 0, consented = 0
--
-- and the route reads `total > 0 AND consented = total` as its answer, which is
-- false. A team of one consenting person was told its team had not consented.
--
-- The deeper error is the same one in a form that bites bigger teams too: the
-- gate asked who is in the room by ROLE and never counted the one person it can
-- be certain of. Whoever presses "Summarise from a recording" is in that room —
-- that is what pressing it means. A team_manager or a consultant who runs the
-- debrief themselves was gated on everyone else's consent and never on their own.
--
-- THE FIX. The caller is counted alongside the debrief roles, whatever their
-- role, provided they hold a live membership in the team. So:
--   * the one-person team is total = 1 and passes on its own tick;
--   * an owner who has NOT ticked can no longer record, which is the point —
--     their voice is on the recording;
--   * an owner who never records still gates nobody, exactly as before.
--
-- `you_consented` is added so the app can tell "you have not agreed" from
-- "somebody else has not", and offer the tick box on the spot instead of sending
-- the only member of a team to a page where the box was already ticked. For the
-- same reason `pending_names` now leaves the caller out: their own answer has its
-- own control, and "Still to agree: you" is not a list, it is a bug report.
--
-- Additive and idempotent; follows 0104. The return type changes, so the
-- function is dropped first — nothing but
-- /api/teams/[teamId]/recording-consent calls it.

DROP FUNCTION IF EXISTS public.team_recording_consent(UUID);

CREATE FUNCTION public.team_recording_consent(p_team_id UUID)
RETURNS TABLE (total INT, consented INT, pending_names TEXT[], you_consented BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_member BOOLEAN;
    v_mine   BOOLEAN;
BEGIN
    -- SECURITY DEFINER bypasses RLS, so the membership check is the access
    -- control. Admins may ask about any team; everyone else only about their own.
    SELECT EXISTS (
        SELECT 1 FROM public.memberships m
         WHERE m.team_id = p_team_id
           AND m.user_id = auth.uid()
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    ) INTO v_member;

    IF NOT v_member AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'not a member of this team';
    END IF;

    -- Read straight off the caller's own row rather than out of the aggregate
    -- below: an admin asking about a team they are not in is not in that room,
    -- so they would aggregate to NULL and read as "you have not agreed".
    SELECT COALESCE(u.recording_consent, false) INTO v_mine
      FROM public.users u WHERE u.id = auth.uid();
    v_mine := COALESCE(v_mine, false);

    RETURN QUERY
    WITH members AS (
        -- DISTINCT because a user can hold several memberships in one team
        -- (per-boat rows, or two roles); they are still one person in the room.
        SELECT DISTINCT u.id, u.name, u.recording_consent
          FROM public.memberships m
          JOIN public.users u ON u.id = m.user_id
         WHERE m.team_id = p_team_id
           AND u.status = 'active'
           -- The sailing roles, plus whoever is asking. Asking is what being
           -- about to record a debrief looks like from here.
           AND (m.role IN ('coach', 'tl1', 'tl3') OR m.user_id = auth.uid())
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    )
    SELECT COUNT(*)::INT,
           COUNT(*) FILTER (WHERE members.recording_consent)::INT,
           COALESCE(
               ARRAY_AGG(members.name ORDER BY members.name)
                   FILTER (WHERE NOT members.recording_consent
                             AND members.id IS DISTINCT FROM auth.uid()),
               '{}'::TEXT[]
           ),
           v_mine
      FROM members;
END;
$$;

COMMENT ON FUNCTION public.team_recording_consent(UUID) IS
    'Whether everyone who will be in a debrief has consented: coach/tl1/tl3 PLUS the caller, who is in the room by virtue of asking. Owners, consultants and guests who are not recording still gate nobody. Returns counts, the OTHER people still to answer, and the caller''s own flag — nothing else about anyone.';

REVOKE ALL ON FUNCTION public.team_recording_consent(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.team_recording_consent(UUID) TO authenticated;
