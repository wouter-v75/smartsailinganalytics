-- ============================================================================
-- SSA — 0059  users.requested_role: allow every role that exists
--
-- The CHECK dates from 0006 and still lists the original five. Since then tl3
-- (0025), guest (0008) and owner (0058) were added to memberships.role and
-- invitations.role but never here — so the manual-approval path in
-- redeemInvitation, which writes the invite's role into users.requested_role,
-- fails on the constraint for those roles. An invite for an owner (or a tl3, or
-- a guest) that is NOT auto-approved would error instead of queueing.
--
-- 0006 created the constraint INLINE with ADD COLUMN, so its name was generated
-- and cannot be assumed: drop whatever check on public.users mentions
-- requested_role, then add the full set under a known name.
--
-- Idempotent. Run after 0058.
-- ============================================================================

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = 'public'
           AND rel.relname = 'users'
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) ILIKE '%requested_role%'
    LOOP
        EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

ALTER TABLE public.users ADD CONSTRAINT users_requested_role_check
    CHECK (requested_role IS NULL OR requested_role IN
        ('team_manager', 'coach', 'tl3', 'tl2', 'tl1', 'owner', 'consultant', 'guest'));
