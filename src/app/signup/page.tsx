// /signup — kept only as a redirect, because links to it are in old emails,
// old messages and people's bookmarks, and a 404 teaches them nothing.
//
// There are two roads into SSA and neither of them is a signup form:
//
//   Road 1  a team manager invites an address. The account is created there and
//           then, and /welcome/<token> sets the password and signs them in.
//   Road 2  a team manager shares a QR code. /join/<token> takes a name, an
//           address and a password, and a manager approves.
//
// What used to be here was a third road that could not work. It called
// supabase.auth.signUp, whose confirmation email Supabase REFUSES to deliver to
// anybody outside the project's own team unless custom SMTP is configured — so
// the person was told "check your inbox" for mail that was never sent. Behind
// that sat a `pending` status, an admin approval queue, a requested_team/role/
// boat triple and a /stash endpoint whose only job was to survive the
// confirmation link expiring before the queue was worked. All of it supported a
// door the product says is closed: "SSA is invite-only, and onboarding is done
// with you rather than by a signup form."
//
// So it says that instead, on the page that already says it.

import { redirect } from 'next/navigation'

export default function SignupPage() {
  redirect('/request-access')
}
