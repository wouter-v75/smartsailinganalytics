// src/lib/shareInvite.ts
// ─────────────────────────────────────────────────────────────────────────────
// Getting a join link out of SSA and into a crew's WhatsApp group.
//
// A link nobody can send is not a way in. Until now the panel offered "Copy
// URL" and left the rest to whoever was holding the laptop — which on a phone,
// standing on a dock, means retyping a token by hand.
//
// TWO KINDS OF LINK, and they must not be shared the same way.
//
//   /join/<token>     an OPEN code. Made to be posted in a group: whoever
//                     scans it signs themselves up and waits for approval, so
//                     the worst a stranger can do is join a queue.
//   /welcome/<token>  one person's. It SETS THEIR PASSWORD, so anybody holding
//                     it can become them. It goes to that person and nobody
//                     else, and the wording here says so rather than offering
//                     the same cheerful "share to WhatsApp" button.
//
// Pure: builds strings. The component opens them.
// ─────────────────────────────────────────────────────────────────────────────

export interface InviteShare {
  /** The team they are joining. */
  teamName: string
  /** The link itself — /join/<token> or /welcome/<token>. */
  url: string
  /** Who is asking, when we know. */
  inviterName?: string | null
  /** True for /welcome: one person's link, which sets their password. */
  personal?: boolean
}

/**
 * The message a manager would otherwise type, and usually types worse.
 *
 * Short, because it is read on a phone in a list of other messages, and it
 * says what will happen rather than only where to click — "you'll be asked to
 * set a password" is the difference between a link people follow and a link
 * people ask about first.
 */
export function inviteMessage(s: InviteShare): string {
  const who = s.inviterName ? `${s.inviterName} has invited you` : 'You have been invited'
  return s.personal
    ? [
        `${who} to ${s.teamName} on SSA — sailing analytics for the team.`,
        '',
        'This link is yours alone: it sets your password, so do not forward it.',
        s.url,
      ].join('\n')
    : [
        `${who} to join ${s.teamName} on SSA — sailing analytics for the team.`,
        '',
        'Open this, choose a password, and the team manager approves you:',
        s.url,
      ].join('\n')
}

/** The subject line, when the channel has one. */
export const inviteSubject = (s: InviteShare): string =>
  s.personal ? `Your SSA access to ${s.teamName}` : `Join ${s.teamName} on SSA`

/**
 * WhatsApp, via wa.me with no number: the app asks who to send it to.
 *
 * api.whatsapp.com/send is the other form and opens a web page first on
 * desktop; wa.me hands straight to the installed app where there is one.
 */
export const whatsappHref = (text: string): string =>
  `https://wa.me/?text=${encodeURIComponent(text)}`

/** A mail draft. No recipient: an open code has no one address, and a personal
 *  link should be addressed deliberately rather than pre-filled from a row. */
export function mailtoHref(subject: string, body: string, to = ''): string {
  const q = new URLSearchParams({ subject, body })
  // URLSearchParams encodes a space as '+', which mail clients show literally
  // in a subject line. mailto wants percent-encoding throughout.
  return `mailto:${encodeURIComponent(to)}?${q.toString().replace(/\+/g, '%20')}`
}

/** A filename somebody will recognise in their downloads a week later. */
export const qrFileName = (teamName: string): string =>
  `${(teamName || 'team').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'team'}-ssa-join.png`
