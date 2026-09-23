-- team_manager runs their own team's people, not just its boats.
--
-- Most of what a team_manager needs already existed (0004/0005): boats CRUD,
-- memberships CRUD including role and the consultant date window, invitations,
-- team rename, tag lists. Two things did not, and both meant a team manager had
-- to come to us for something about their own team:
--
--   1. APPROVING AND DISABLING PEOPLE. `users_update_admin` is is_admin() only,
--      so a new sailor sat at "awaiting approval" until the site admin noticed.
--      The support page even told them to email us. Now their team manager can
--      do it, for people in their own team.
--   2. SEEING THEIR TEAM'S ACTIVITY. events_select is self-or-admin, so a team
--      manager could not see who uploaded what or when someone last signed in.
--
-- WHAT IS DELIBERATELY NOT GRANTED: editing or deleting events. `events` is the
-- audit log. Its whole value is that it records what happened and cannot be
-- rewritten by the person who did it — a team manager who can delete the record
-- of their own action is the one thing an audit log must not allow. Admin keeps
-- update/delete for data-protection erasure requests, which is a different job
-- with a different reason. Reading is the part a team manager actually needs and
-- that is what they get.
--
-- SCOPE: "their own team" throughout. A team manager of Team A gets nothing over
-- a user who is only in Team B.

-- ── helper: is this user in a team I manage? ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.manages_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships mine
          JOIN public.memberships theirs ON theirs.team_id = mine.team_id
         WHERE mine.user_id = auth.uid()
           AND mine.role = 'team_manager'
           AND theirs.user_id = p_user_id
           AND (mine.valid_from IS NULL OR mine.valid_from <= now())
           AND (mine.valid_to   IS NULL OR mine.valid_to   >= now())
    );
$$;

COMMENT ON FUNCTION public.manages_user(UUID) IS
    'True when the caller is an active team_manager of a team the given user belongs to. Scopes a team manager''s people powers to their own team.';

-- ── users: approve / disable, within the team ───────────────────────────────
-- A pending user has no membership yet in the normal invite flow, so the
-- invitation stash (0005) is what links them to the team; once redeemed they
-- have a membership and this policy applies. A user who is genuinely in no team
-- remains the site admin's to approve.
DROP POLICY IF EXISTS users_update_team_manager ON public.users;
CREATE POLICY users_update_team_manager ON public.users
    FOR UPDATE TO authenticated
    USING (public.manages_user(id) AND id <> auth.uid())
    WITH CHECK (public.manages_user(id) AND id <> auth.uid());

-- The row-level policy says WHICH rows; the trigger below says WHICH COLUMNS.
-- Without it a team manager could set global_role = 'admin' on a teammate, which
-- is the same escalation 0078 closed for self-updates, one step removed.

CREATE OR REPLACE FUNCTION public.users_protect_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
    -- Service role and the signup trigger: auth.uid() is NULL. Admin: trusted.
    IF auth.uid() IS NULL OR public.is_admin() THEN
        IF NEW.recording_consent IS DISTINCT FROM OLD.recording_consent THEN
            NEW.recording_consent_at := now();
        END IF;
        RETURN NEW;
    END IF;

    -- A team manager acting on one of their own team's people may set status
    -- (approve / disable) and stamp the approval. Everything that would let them
    -- mint an admin, or move the account to another identity, is put back.
    IF OLD.id <> auth.uid() AND public.manages_user(OLD.id) THEN
        NEW.id                := OLD.id;
        NEW.email             := OLD.email;
        NEW.global_role       := OLD.global_role;
        NEW.recording_consent := OLD.recording_consent;      -- consent is the person's own
        NEW.recording_consent_at := OLD.recording_consent_at;
        NEW.privacy_accepted_at  := OLD.privacy_accepted_at;
        IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'active' THEN
            NEW.approved_at := COALESCE(NEW.approved_at, now());
            NEW.approved_by := COALESCE(NEW.approved_by, auth.uid());
        END IF;
        RETURN NEW;
    END IF;

    -- Otherwise: a user editing their own row. Name and consent only.
    NEW.id          := OLD.id;
    NEW.email       := OLD.email;
    NEW.status      := OLD.status;
    NEW.global_role := OLD.global_role;
    NEW.approved_at := OLD.approved_at;
    NEW.approved_by := OLD.approved_by;

    IF NEW.recording_consent IS DISTINCT FROM OLD.recording_consent THEN
        NEW.recording_consent_at := now();
    ELSE
        NEW.recording_consent_at := OLD.recording_consent_at;
    END IF;

    IF OLD.privacy_accepted_at IS NOT NULL THEN
        NEW.privacy_accepted_at := OLD.privacy_accepted_at;
    ELSIF NEW.privacy_accepted_at IS NOT NULL THEN
        NEW.privacy_accepted_at := now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.users_protect_privileged_columns() IS
    'Column guard on public.users. Self-update: name + consent only. Team manager on their own team: status and approval stamp, never global_role. Admin and service role: unrestricted.';

-- ── events: a team manager can READ their team's audit trail ────────────────
DROP POLICY IF EXISTS events_select_team_manager ON public.events;
CREATE POLICY events_select_team_manager ON public.events
    FOR SELECT TO authenticated
    USING (public.manages_user(user_id));

-- No events_update / events_delete for team_manager, on purpose. See the header.
