-- Recording consent, and the guard that makes self-service columns safe.
--
-- Recording a team debrief captures the voice of everyone in the room, which is
-- personal data belonging to each of them and not to the team. Until now SSA
-- relied on the coach telling the crew — /privacy said so in as many words. This
-- makes it a product feature: consent is asked at signup, held per user, changed
-- by that user at any time, and the team debrief recorder refuses to run until
-- everyone who could be in the room has agreed.
--
-- Three things happen here.
--
-- 1. THE COLUMNS. Consent is affirmative: the default is false, never NULL-means-
--    maybe. `privacy_accepted_at` records agreement to the data clause at signup,
--    which is a different thing from agreeing to be recorded and is why it is a
--    separate column.
--
-- 2. THE GUARD. `users_update_self` (migration 0002) is
--        FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid())
--    with NO column restriction, and there is no trigger on the table. Since
--    `is_admin()` reads `public.users.global_role`, any authenticated user could
--    run `UPDATE users SET global_role='admin', status='active' WHERE id=auth.uid()`
--    and become site admin. That hole predates this migration, but this migration
--    is the first to invite users to write to their own row on purpose, so it is
--    closed here rather than left for later. The trigger reverts protected
--    columns instead of raising, so an ordinary self-update (name, consent) still
--    succeeds and only the escalation is silently undone.
--
-- 3. THE READ. A coach needs to know whether the team has consented WITHOUT
--    being handed everyone's profile. `team_recording_consent()` answers exactly
--    that question and nothing else, and refuses callers who are not in the team.
--
-- WHO HAS TO AGREE. Only the people who are actually in the debrief: the sailing
-- roles and their coach — coach, tl1, tl2, tl3. A team_manager (owner), a
-- consultant on a date-boxed window and a guest are not in the room, and letting
-- any of them block the recorder would mean a coach could not debrief because an
-- owner never opened their profile. They can still set their own flag; it simply
-- does not gate anyone.

-- ── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS privacy_accepted_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recording_consent     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS recording_consent_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.users.recording_consent IS
    'Affirmative consent to being captured in a team debrief recording. Default false — never treat unanswered as yes.';
COMMENT ON COLUMN public.users.recording_consent_at IS
    'When recording_consent last changed. Stamped by trigger, not by the app, so it cannot be forged or forgotten.';
COMMENT ON COLUMN public.users.privacy_accepted_at IS
    'When the data/privacy clause was accepted at signup. Separate from recording consent on purpose: one is required to have an account, the other is optional and revocable.';

-- ── 2. Guard trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.users_protect_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
    -- auth.uid() is NULL for the service role and for the signup trigger's own
    -- inserts, so server-side code is unaffected. Admins are trusted here
    -- because users_update_admin already grants them the whole row.
    IF auth.uid() IS NULL OR public.is_admin() THEN
        -- Still stamp the consent timestamp, so an admin correction is dated.
        IF NEW.recording_consent IS DISTINCT FROM OLD.recording_consent THEN
            NEW.recording_consent_at := now();
        END IF;
        RETURN NEW;
    END IF;

    -- A user editing their own row may change their name and their consent.
    -- Everything that decides what they are allowed to do is put back.
    NEW.id          := OLD.id;
    NEW.email       := OLD.email;
    NEW.status      := OLD.status;
    NEW.global_role := OLD.global_role;
    NEW.approved_at := OLD.approved_at;
    NEW.approved_by := OLD.approved_by;

    -- The timestamp is derived from the change, never accepted from the client.
    IF NEW.recording_consent IS DISTINCT FROM OLD.recording_consent THEN
        NEW.recording_consent_at := now();
    ELSE
        NEW.recording_consent_at := OLD.recording_consent_at;
    END IF;

    -- Accepting the privacy clause can only ever be set, never cleared or
    -- back-dated, and only by the person themselves.
    IF OLD.privacy_accepted_at IS NOT NULL THEN
        NEW.privacy_accepted_at := OLD.privacy_accepted_at;
    ELSIF NEW.privacy_accepted_at IS NOT NULL THEN
        NEW.privacy_accepted_at := now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS users_protect_privileged ON public.users;
CREATE TRIGGER users_protect_privileged
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.users_protect_privileged_columns();

COMMENT ON FUNCTION public.users_protect_privileged_columns() IS
    'Reverts status/global_role/approved_* on a self-update. Without it, users_update_self permits self-promotion to admin.';

-- ── 3. Signup carries the answers through ───────────────────────────────────
--
-- The client passes both flags in auth signUp metadata, exactly as it already
-- passes `name`. Anything missing or malformed reads as NO — the COALESCE
-- defaults are deliberately the refusing ones.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_privacy  BOOLEAN := COALESCE((NEW.raw_user_meta_data->>'privacy_accepted')::BOOLEAN, false);
    v_consent  BOOLEAN := COALESCE((NEW.raw_user_meta_data->>'recording_consent')::BOOLEAN, false);
BEGIN
    INSERT INTO public.users (id, email, name, status,
                              privacy_accepted_at, recording_consent, recording_consent_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        'pending',
        CASE WHEN v_privacy THEN now() END,
        v_consent,
        CASE WHEN v_consent THEN now() END
    );
    INSERT INTO public.user_quota (user_id, bytes_limit)
    VALUES (NEW.id, 5 * 1024::BIGINT * 1024 * 1024);
    INSERT INTO public.events (user_id, action, details)
    VALUES (NEW.id, 'signup', jsonb_build_object(
        'email', NEW.email,
        'privacy_accepted', v_privacy,
        'recording_consent', v_consent
    ));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 4. The team's answer, without handing over the team ─────────────────────

CREATE OR REPLACE FUNCTION public.team_recording_consent(p_team_id UUID)
RETURNS TABLE (total INT, consented INT, pending_names TEXT[])
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    -- SECURITY DEFINER bypasses RLS, so the membership check is the access
    -- control. Admins may ask about any team; everyone else only about their own.
    IF NOT public.is_admin() AND NOT EXISTS (
        SELECT 1 FROM public.memberships m
         WHERE m.team_id = p_team_id
           AND m.user_id = auth.uid()
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    ) THEN
        RAISE EXCEPTION 'not a member of this team';
    END IF;

    RETURN QUERY
    WITH members AS (
        -- DISTINCT because a user can hold several memberships in one team
        -- (per-boat rows, or two roles); they are still one person in the room.
        SELECT DISTINCT u.id, u.name, u.recording_consent
          FROM public.memberships m
          JOIN public.users u ON u.id = m.user_id
         WHERE m.team_id = p_team_id
           AND u.status = 'active'
           AND m.role IN ('coach', 'tl1', 'tl2', 'tl3')
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    )
    SELECT COUNT(*)::INT,
           COUNT(*) FILTER (WHERE members.recording_consent)::INT,
           COALESCE(
               ARRAY_AGG(members.name ORDER BY members.name)
                   FILTER (WHERE NOT members.recording_consent),
               '{}'::TEXT[]
           )
      FROM members;
END;
$$;

COMMENT ON FUNCTION public.team_recording_consent(UUID) IS
    'Whether every coach/tl1/tl2/tl3 in a team has consented to debrief recording. Owners, consultants and guests are not counted — they are not in the room. Returns counts plus the names still to answer, and nothing else about them.';

REVOKE ALL ON FUNCTION public.team_recording_consent(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.team_recording_consent(UUID) TO authenticated;
