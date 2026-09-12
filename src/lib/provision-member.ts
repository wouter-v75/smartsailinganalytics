// Provision a team member the moment a manager invites them by email.
//
// WHY. The old flow only created an INVITE: the recipient opened the link, filled
// in the signup form, waited for a Supabase confirmation email, clicked that, and
// only then was the invitation redeemed and their status flipped to active. Two
// steps too many — the invite already went to their address, so confirming it
// proves nothing — and until they finished, they sat in the admin's approval
// queue, which is why an "approve this user" message appeared for an invite that
// said access was automatic.
//
// Now the manager's click does the whole job server-side: the account exists with
// the address already confirmed, the user is active, and the team membership is
// in place. Their first login works, with nothing to approve.
//
// The Supabase client is passed in (not imported) so this can be tested against a
// fake without a database.

export interface ProvisionArgs {
  email: string
  teamId: string
  role: string
  boatId?: string | null
  validFrom?: string | null
  validTo?: string | null
  dataFrom?: string | null
  dataTo?: string | null
  /** Manager doing the inviting — recorded as the approver. */
  approvedBy?: string | null
  /** Name to show until the person edits it; defaults to the address's local part. */
  name?: string | null
}

export interface ProvisionResult {
  ok: boolean
  userId?: string
  /** True when we created the account (so they still need to set a password). */
  created?: boolean
  /** The address belongs to an account a global admin disabled. */
  disabled?: boolean
  error?: string
}

// Supabase's "already registered" wording has changed more than once; match loosely.
const isAlreadyRegistered = (msg: string) =>
  /already\s+(been\s+)?registered|already\s+exists|duplicate/i.test(msg || '')

const isDuplicate = (msg: string) => /duplicate|already exists|unique constraint/i.test(msg || '')

export function normaliseEmail(email: string): string {
  return String(email || '').trim().toLowerCase()
}

export function nameFromEmail(email: string): string {
  return normaliseEmail(email).split('@')[0] || 'crew'
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Service = any

export async function provisionTeamMember(
  service: Service,
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const email = normaliseEmail(args.email)
  if (!email) return { ok: false, error: 'email required' }

  // 1. Do they already have an account? public.users mirrors auth.users (the
  //    handle_new_user trigger), so one lookup answers it.
  const existing = await service.from('users').select('id, status').ilike('email', email).maybeSingle()
  let userId: string | undefined = existing?.data?.id
  let created = false

  // A global admin disabled this account. A team manager inviting them must not
  // quietly bring it back — say so and let an admin decide.
  if (existing?.data?.status === 'disabled') {
    return { ok: false, error: 'that account is disabled — a global admin must reactivate it first', disabled: true }
  }

  // 2. Create it if not — with the address already confirmed, so no confirmation
  //    email and no "unconfirmed" account that cannot log in.
  if (!userId) {
    const res = await service.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { name: args.name || nameFromEmail(email) },
    })
    if (res?.error && !isAlreadyRegistered(res.error.message || '')) {
      return { ok: false, error: res.error.message || 'could not create the account' }
    }
    userId = res?.data?.user?.id
    created = Boolean(userId)
    if (!userId) {
      // Raced with another invite (or the address exists in auth only): re-read.
      const again = await service.from('users').select('id').ilike('email', email).maybeSingle()
      userId = again?.data?.id
      created = false
    }
    if (!userId) return { ok: false, error: 'account exists but could not be found' }
  }

  // 3. Active, approved, with no leftover "requested" hints — nothing for an
  //    admin to approve.
  const upd = await service
    .from('users')
    .update({
      status: 'active',
      approved_at: new Date().toISOString(),
      approved_by: args.approvedBy || null,
      requested_team_id: null,
      requested_role: null,
      requested_boat_id: null,
    })
    .eq('id', userId)
  if (upd?.error) return { ok: false, error: upd.error.message }

  // 4. The membership itself — what the first login actually needs. A repeated
  //    invite must not fail on the duplicate.
  const mem = await service.from('memberships').insert({
    user_id: userId,
    team_id: args.teamId,
    boat_id: args.boatId || null,
    role: args.role,
    valid_from: args.validFrom || null,
    valid_to: args.validTo || null,
    data_from: args.dataFrom || null,
    data_to: args.dataTo || null,
  })
  if (mem?.error && !isDuplicate(mem.error.message || '')) {
    return { ok: false, error: mem.error.message }
  }

  return { ok: true, userId, created }
}

/**
 * A one-click link for someone who has no password yet: Supabase verifies it,
 * /auth/callback exchanges it for a session and sends them to /auth/reset-password
 * to choose one. Null when Supabase will not mint it — the email then just points
 * at the site, where "Forgot password?" does the same job.
 */
export async function firstLoginLink(
  service: Service,
  email: string,
  origin: string,
): Promise<string | null> {
  try {
    const res = await service.auth.admin.generateLink({
      type: 'recovery',
      email: normaliseEmail(email),
      options: { redirectTo: `${origin}/auth/callback?next=%2Fauth%2Freset-password` },
    })
    return res?.data?.properties?.action_link || null
  } catch {
    return null
  }
}
