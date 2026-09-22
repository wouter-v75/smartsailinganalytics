-- 0076_squad_managers.sql
-- ---------------------------------------------------------------------------
-- A team manager can run a squad without an administrator.
--
-- 0071–0074 left squad creation and team invitation to a global admin, which
-- made every squad in the system depend on one person being available. This
-- moves both to the person who actually organises the training.
--
-- THE PROBLEM WITH "INVITE ANOTHER TEAM". squad_members_write only permits
-- rows for a team you already hold a role in — deliberately, so nobody enrols
-- a team they do not run. But a squad manager by definition wants to invite
-- teams they do NOT run, and the obvious fix (a picker listing every team)
-- would hand any team manager the names of every campaign in the system,
-- across organisations that have nothing to do with each other.
--
-- SO: A JOIN CODE, exactly as SSA already invites PEOPLE. The squad manager
-- mints an opaque token and sends it however they like — WhatsApp, email, out
-- loud in a briefing. The other team's own coach or manager redeems it on
-- their own team page. Three properties fall out of that:
--
--   • no team directory is exposed to anyone
--   • the squad manager never needs to know who runs the other team
--   • CONSENT STAYS WHERE IT WAS. Redeeming creates an 'invited' row, not a
--     membership. The receiving team still chooses its categories and presses
--     Join, so a code cannot make anybody share anything.
--
-- WHAT A SQUAD MANAGER CANNOT DO, which is the line that makes this safe to
-- hand out: set another team's `shares`. They may invite a team and eject one;
-- they may not decide what it contributes. That remains the team's own, and is
-- why the delete permission below is a separate policy rather than widening
-- squad_members_write to cover managers.
-- ---------------------------------------------------------------------------

-- ── who runs a squad ────────────────────────────────────────────────────────
-- The creator, for now. A separate table would allow handing over and several
-- managers per squad; that is a real need eventually and deliberately not
-- guessed at here. SECURITY DEFINER so a policy can ask without tripping over
-- squads' own policy.
CREATE OR REPLACE FUNCTION public.is_squad_manager(p_squad_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.squads s
         WHERE s.id = p_squad_id
           AND s.created_by_user_id = auth.uid()
    );
$$;

-- ── the codes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.squad_join_codes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id           UUID NOT NULL REFERENCES public.squads(id) ON DELETE CASCADE,
    token              TEXT UNIQUE NOT NULL,
    note               TEXT,
    max_uses           INTEGER NOT NULL DEFAULT 10 CHECK (max_uses >= 1),
    used_count         INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS squad_join_codes_squad_idx ON public.squad_join_codes(squad_id);

ALTER TABLE public.squad_join_codes ENABLE ROW LEVEL SECURITY;

-- Only the squad's manager sees or mints its codes. A code is a capability:
-- anyone holding one can put their team in front of this squad, so it is not
-- something other member teams should be able to read off the table and pass
-- on.
DROP POLICY IF EXISTS squad_join_codes_all ON public.squad_join_codes;
CREATE POLICY squad_join_codes_all ON public.squad_join_codes
    FOR ALL TO authenticated
    USING (public.is_admin() OR public.is_squad_manager(squad_id))
    WITH CHECK (public.is_admin() OR public.is_squad_manager(squad_id));

-- ── redeeming ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER because the redeemer must NOT be able to read
-- squad_join_codes — they hold one token and that is all they are entitled to
-- know. The function validates it on their behalf and writes the one row.
--
-- It creates an 'invited' row and nothing more. The receiving team's Squad
-- panel then shows the invitation, and joining — with categories — remains a
-- separate, deliberate act by that team.
CREATE OR REPLACE FUNCTION public.redeem_squad_code(p_token TEXT, p_team_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    c        public.squad_join_codes%ROWTYPE;
    v_new_id UUID;
BEGIN
    -- You may only bring in a team you actually run. Checked FIRST so a
    -- stranger cannot use this to test whether a token is valid.
    IF NOT public.has_team_role(p_team_id, ARRAY['coach','tl1','tl2','team_manager']) THEN
        RAISE EXCEPTION 'you do not run that team';
    END IF;

    SELECT * INTO c FROM public.squad_join_codes WHERE token = p_token;
    IF NOT FOUND                      THEN RAISE EXCEPTION 'no such code'; END IF;
    IF c.revoked_at IS NOT NULL       THEN RAISE EXCEPTION 'that code was withdrawn'; END IF;
    IF c.expires_at < now()           THEN RAISE EXCEPTION 'that code has expired'; END IF;
    IF c.used_count >= c.max_uses     THEN RAISE EXCEPTION 'that code has been used up'; END IF;

    INSERT INTO public.squad_members (squad_id, team_id, status, invited_by_user_id)
         VALUES (c.squad_id, p_team_id, 'invited', c.created_by_user_id)
    ON CONFLICT (squad_id, team_id) DO NOTHING
      RETURNING id INTO v_new_id;

    -- A team redeeming twice, or one already invited, does not burn a use.
    IF v_new_id IS NOT NULL THEN
        UPDATE public.squad_join_codes SET used_count = used_count + 1 WHERE id = c.id;
    END IF;

    RETURN c.squad_id;
END $$;

-- ── a squad manager may EJECT a team, but never speak for one ───────────────
-- Separate from squad_members_write on purpose. Widening that policy would
-- also let a manager UPDATE another team's `shares`, which is the one thing
-- this whole design refuses: what a team contributes is the team's own answer.
DROP POLICY IF EXISTS squad_members_manager_delete ON public.squad_members;
CREATE POLICY squad_members_manager_delete ON public.squad_members
    FOR DELETE TO authenticated
    USING (public.is_squad_manager(squad_id));

-- The manager must also be able to SEE the squad's membership to manage it,
-- including teams they have no role in. my_squad_ids() (0073) only covers
-- squads you belong to via a team.
DROP POLICY IF EXISTS squad_members_select ON public.squad_members;
CREATE POLICY squad_members_select ON public.squad_members
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR squad_id IN (SELECT public.my_squad_ids())
        OR public.is_squad_manager(squad_id)
    );

DROP POLICY IF EXISTS squads_select ON public.squads;
CREATE POLICY squads_select ON public.squads
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR id IN (SELECT public.my_squad_ids())
        OR public.is_squad_manager(id)
    );
