-- Is this person clear to get in? Read-only — nothing is written or sent.
--
-- Paste into the Supabase SQL editor. Change the two values on the next lines
-- and run the whole file; each block prints its own labelled result.

-- ── set these ───────────────────────────────────────────────────────────────
--   :who   the address, lower-case
--   :team  any part of the team name
-- Supabase's editor has no bind parameters, so they are written in literally
-- below. Find-and-replace 'gwenael.leguen@gmail.com' and 'Northstar'.

-- ── 1. THE ACCOUNT ──────────────────────────────────────────────────────────
-- On Road 1 the manager's invite CREATES the account, already confirmed and
-- active. So: status must be 'active'. 'pending' means it came in some other
-- way and is waiting on an approval; 'disabled' is a hard stop.
-- last_sign_in_at tells you whether he already has a password — if he does,
-- the welcome link is not what he needs, "Forgot password?" is.
SELECT
    'account'                       AS block,
    u.name,
    u.email,
    u.status,
    u.global_role,
    u.created_at,
    au.email_confirmed_at,
    au.last_sign_in_at,
    u.recording_consent,
    u.privacy_accepted_at,
    u.requested_team_id             AS asked_to_join_team  -- only the QR road sets this
FROM public.users u
LEFT JOIN auth.users au ON au.id = u.id
WHERE lower(u.email) = 'gwenael.leguen@gmail.com';

-- ── 2. THE MEMBERSHIP ───────────────────────────────────────────────────────
-- Without one he signs in to nothing. valid_to in the past is a consultant
-- window that has closed.
SELECT
    'membership'                    AS block,
    t.name                          AS team,
    COALESCE(b.name, 'all boats')   AS boat,
    m.role,
    m.valid_from,
    m.valid_to,
    CASE WHEN m.valid_to IS NOT NULL AND m.valid_to < now()
         THEN 'WINDOW CLOSED' ELSE 'ok' END AS window
FROM public.memberships m
JOIN public.users u ON u.id = m.user_id
JOIN public.teams t ON t.id = m.team_id
LEFT JOIN public.boats b ON b.id = m.boat_id
WHERE lower(u.email) = 'gwenael.leguen@gmail.com'
  AND t.name ILIKE '%Northstar%';

-- ── 3. THE INVITATION, AND WHETHER ITS LINK STILL WORKS ─────────────────────
-- The newest row is the one the email you just sent points at. `state` is what
-- /welcome/<token> will decide:
--   LIVE     he can set a password
--   USED     somebody already did — if not him, that matters
--   EXPIRED  press Re-send on the team page; it unspends the row AND pushes
--            the expiry out, so the mail already in his inbox starts working
--   REVOKED  withdrawn; make a new one
-- `welcome_url` is the link itself. Treat it like a password: it sets his.
SELECT
    'invitation'                    AS block,
    t.name                          AS team,
    i.role,
    i.created_at,
    i.expires_at,
    i.used_count || '/' || i.max_uses AS used,
    CASE
        WHEN i.revoked_at IS NOT NULL   THEN 'REVOKED'
        WHEN i.expires_at < now()       THEN 'EXPIRED'
        WHEN i.used_count >= i.max_uses THEN 'USED'
        ELSE                                 'LIVE'
    END                             AS state,
    'https://ssa.wvsailing.co.uk/welcome/' || i.token AS welcome_url
FROM public.invitations i
JOIN public.teams t ON t.id = i.team_id
WHERE lower(i.email) = 'gwenael.leguen@gmail.com'
  AND t.name ILIKE '%Northstar%'
ORDER BY i.created_at DESC;

-- ── 4. WHAT ACTUALLY HAPPENED ───────────────────────────────────────────────
-- Every step SSA recorded for this address, newest first. What to look for:
--   invitation.provisioned with email_sent false  → the mail never left
--   invitation.email_failed                       → and why
--   welcome.link_dead                             → he opened a link that was
--                                                   already used or expired
--   welcome.password_set                          → he is in
SELECT
    'history'                       AS block,
    e.ts,
    e.action,
    e.details ->> 'error'           AS error,
    e.details ->> 'state'           AS link_state,
    e.details ->> 'email_sent'      AS email_sent,
    e.details
FROM public.events e
WHERE e.details ->> 'to'    = 'gwenael.leguen@gmail.com'
   OR e.details ->> 'email' = 'gwenael.leguen@gmail.com'
ORDER BY e.ts DESC
LIMIT 25;

-- ── READING IT ──────────────────────────────────────────────────────────────
-- All clear when, together:
--   1  status = 'active', email_confirmed_at set, last_sign_in_at NULL
--   2  one membership row in Northstar, window ok
--   3  the newest invitation says LIVE
-- Then he opens the link, chooses a password twice, ticks both consents, and
-- is in — nothing to confirm, nobody to approve.
--
-- recording_consent false and privacy_accepted_at null are EXPECTED before he
-- has been through the welcome form: he gives both there, and cannot finish
-- without them.
