-- ============================================================================
-- SSA — carry the consultant data-date window on the INVITATION.
--
-- 0042 added memberships.data_from / data_to (the range of session dates a
-- consultant may VIEW). But a sailmaker is usually onboarded via an email
-- invitation, not by hand-adding a membership. So the invitation must also
-- carry the window and hand it to the membership it creates on redemption.
--
--   invitations.data_from / data_to  (DATE, nullable)
--     NULL/NULL → no date restriction (normal member).
--     set       → copied onto the membership created when the invite is
--                 redeemed (see invitation-redeem.ts).
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS data_from DATE;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS data_to   DATE;
