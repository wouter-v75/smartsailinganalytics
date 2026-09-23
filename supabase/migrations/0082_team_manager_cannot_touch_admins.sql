-- A team manager must not be able to act on a site admin.
--
-- 0081 scoped a team manager's people powers to "users in a team I manage".
-- The site admin is a member of teams — that is how they see anything — so
-- manages_user() returned true for them, and a team manager could set the site
-- admin's status to 'disabled'. Verified before this fix: it worked.
--
-- That is a lock-out, and it is available to anyone a team manager invites into
-- their own team: make yourself team_manager of a team the admin is in, disable
-- the admin, and there is nobody left who can undo it.
--
-- Fixed in both halves of the check, because they answer different questions and
-- either one alone is a gap:
--   - the POLICY decides which rows a team manager may touch at all
--   - the TRIGGER decides which columns survive, and is what actually stops a
--     write that slips past a future policy change
--
-- Admins remain able to do everything, including to each other; that is what
-- being the site admin means.

-- ── the policy: an admin's row is not yours to write ────────────────────────
DROP POLICY IF EXISTS users_update_team_manager ON public.users;
CREATE POLICY users_update_team_manager ON public.users
    FOR UPDATE TO authenticated
    USING (
        public.manages_user(id)
        AND id <> auth.uid()
        AND global_role IS DISTINCT FROM 'admin'
    )
    WITH CHECK (
        public.manages_user(id)
        AND id <> auth.uid()
        AND global_role IS DISTINCT FROM 'admin'
    );

-- ── the trigger: the same rule, one layer down ──────────────────────────────
CREATE OR REPLACE FUNCTION public.users_protect_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NULL OR public.is_admin() THEN
        IF NEW.recording_consent IS DISTINCT FROM OLD.recording_consent THEN
            NEW.recording_consent_at := now();
        END IF;
        RETURN NEW;
    END IF;

    -- Team manager acting on one of their own team's people, who is not an
    -- admin and not themselves: status and the approval stamp, nothing else.
    IF OLD.id <> auth.uid()
       AND OLD.global_role IS DISTINCT FROM 'admin'
       AND public.manages_user(OLD.id)
    THEN
        NEW.id                   := OLD.id;
        NEW.email                := OLD.email;
        NEW.global_role          := OLD.global_role;
        NEW.recording_consent    := OLD.recording_consent;
        NEW.recording_consent_at := OLD.recording_consent_at;
        NEW.privacy_accepted_at  := OLD.privacy_accepted_at;
        IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'active' THEN
            NEW.approved_at := COALESCE(NEW.approved_at, now());
            NEW.approved_by := COALESCE(NEW.approved_by, auth.uid());
        END IF;
        RETURN NEW;
    END IF;

    -- Anyone else, including a team manager who reached an admin's row: this is
    -- a self-update at most. Name and consent only.
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
    'Column guard on public.users. Self: name + consent. Team manager on a NON-ADMIN in their own team: status + approval stamp. Admin and service role: unrestricted.';
