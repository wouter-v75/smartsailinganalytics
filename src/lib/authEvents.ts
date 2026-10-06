// src/lib/authEvents.ts
// ─────────────────────────────────────────────────────────────────────────────
// Every step of getting somebody into SSA, written down where the person who
// can FIX it will see it.
//
// Three audiences, and they need different things:
//
//   the person signing up  needs one sentence on screen saying what to do next
//                          ("use Forgot password", "ask your manager") — they
//                          cannot see a log and must never be left guessing.
//   the team manager       needs to know their invite did not land, in SSA,
//                          beside the invitation itself — not in a Vercel log
//                          they will never open.
//   the admin              needs every failure across every team in one list,
//                          because the pattern matters more than the instance:
//                          one bounced address is a typo, six is a broken
//                          sender domain.
//
// Before this, a failed invite email was a console.error on a serverless
// function and an `email_sent: false` buried in an events row nothing rendered.
// The manager saw "invitation created" and assumed it had arrived. That is how
// somebody waits three days for mail that was never sent.
//
// The `events` table already existed for the audit trail; this gives it a
// vocabulary and a severity so it can also be a to-do list.
// ─────────────────────────────────────────────────────────────────────────────

export type AuthEventLevel = 'info' | 'warn' | 'error'

export interface AuthEventDetails {
  [k: string]: unknown
  /** Address the step concerned, when there is one. */
  to?: string | null
  /** What went wrong, verbatim from whatever refused. */
  error?: string | null
  team_id?: string | null
  invitation_id?: string | null
  member_user_id?: string | null
}

/**
 * The actions this module knows how to describe, and how bad each one is.
 *
 * An action missing from here still records — the table takes any string — it
 * just reads as itself in the UI rather than as a sentence. Better a row nobody
 * worded than a step nobody wrote down.
 */
const LEVELS: Record<string, AuthEventLevel> = {
  'invitation.create': 'info',
  'invitation.provisioned': 'info',
  'invitation.email_failed': 'error',
  'invitation.provision_refused': 'warn',
  'invitation.provision_failed': 'error',
  'invitation.resent': 'info',
  'invitation.resend_failed': 'error',
  'welcome.password_set': 'info',
  'welcome.link_dead': 'warn',
  'welcome.signin_failed': 'error',
  'join.requested': 'info',
  'join.failed': 'error',
  'join.notify_failed': 'error',
  'user.approved': 'info',
  'user.approve_email_failed': 'error',
  'user.declined': 'info',
}

export const authEventLevel = (action: string): AuthEventLevel => LEVELS[action] ?? 'info'

/** Everything that is not routine — what a manager or admin should act on. */
export const isAuthProblem = (action: string): boolean => authEventLevel(action) !== 'info'

const who = (d: AuthEventDetails): string => String(d.to || d.member_user_id || 'somebody')

/**
 * One sentence, for a human, in the past tense.
 *
 * Written for the MANAGER and the ADMIN — the person signing up never sees
 * these; they get their own words on the page in front of them.
 */
export function describeAuthEvent(action: string, details: AuthEventDetails = {}): string {
  const e = details.error ? ` — ${details.error}` : ''
  switch (action) {
    case 'invitation.create':
      return `Invitation created for ${who(details)}.`
    case 'invitation.provisioned':
      return details.email_sent === false
        ? `${who(details)} was set up, but the email did not send${e}`
        : `${who(details)} was set up and emailed.`
    case 'invitation.email_failed':
      return `The invitation email to ${who(details)} was refused${e}`
    case 'invitation.provision_refused':
      return `Refused to invite ${who(details)}${e}`
    case 'invitation.provision_failed':
      return `Could not set up ${who(details)}, so an invite link was sent instead${e}`
    case 'invitation.resent':
      return `Invitation to ${who(details)} was sent again.`
    case 'invitation.resend_failed':
      return `Could not re-send the invitation to ${who(details)}${e}`
    case 'welcome.password_set':
      return `${who(details)} chose a password and signed in.`
    case 'welcome.link_dead':
      return `${who(details)} opened an invitation link that was ${details.state || 'not usable'}.`
    case 'welcome.signin_failed':
      return `${who(details)} set a password but could not be signed in${e}`
    case 'join.requested':
      return `${who(details)} asked to join from the QR code and is waiting for approval.`
    case 'join.failed':
      return `${who(details)} could not sign up from the QR code${e}`
    case 'join.notify_failed':
      return `${who(details)} asked to join, but the manager could not be told${e}`
    case 'user.approved':
      return `${who(details)} was approved.`
    case 'user.approve_email_failed':
      return `${who(details)} was approved, but the email telling them did not send${e}`
    case 'user.declined':
      return `${who(details)} was declined.`
    default:
      return `${action}${e}`
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Service = any

/**
 * Write one down. Never throws and never blocks the thing it is recording:
 * a failure to log a failure must not turn into a second failure.
 */
export async function recordAuthEvent(
  service: Service,
  args: { action: string; actorUserId?: string | null; details?: AuthEventDetails }
): Promise<void> {
  try {
    await service.from('events').insert({
      user_id: args.actorUserId || null,
      action: args.action,
      details: {
        ...(args.details || {}),
        level: authEventLevel(args.action),
      },
    })
  } catch {
    // Deliberately silent. The caller has a person in front of it.
  }
}
