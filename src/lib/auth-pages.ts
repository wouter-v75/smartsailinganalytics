// src/lib/auth-pages.ts
// ─────────────────────────────────────────────────────────────────────────────
// The plain HTML pages that stand outside the app: choose a password, and
// "that link is no good any more".
//
// Served by route handlers, not rendered by Next, so they cannot reach the
// design system — and that is deliberate. Somebody arriving here has no
// session, often no account yet, and is usually on a phone. A dependency-free
// page with a plain form POST works with JavaScript off, loads in one round
// trip, and cannot be broken by anything else in the app.
//
// They live here rather than in a route file because two roads use them:
// /welcome/<token> (the manager's invite) and /auth/callback (a password
// reset). One stylesheet, one set of field names, one place to fix a button
// that is too small for a thumb.
// ─────────────────────────────────────────────────────────────────────────────

/** `<`, `>`, `&` and `"` — these land in attribute values, which are quoted. */
export const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** The floor, everywhere a password can be chosen. */
export const MIN_PASSWORD = 8

const SHELL = `
  :root { color-scheme: dark }
  /* Without this the form's own padding adds to its 100% width and eats the
     body's gutter, so the card runs edge-to-edge on a phone — which is where
     an invited person opens the link. */
  *, *::before, *::after { box-sizing: border-box }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         background:#0A1929; color:#E2E8F0;
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px }
  main, form { width:100%; max-width:380px; background:#0F2A45; border:1px solid #1E3A5A;
         border-radius:14px; padding:26px 24px }
  h1 { margin:0 0 18px; font-size:19px; font-weight:800; color:#38BDF8 }
  label { display:block; margin:0 0 5px; font-size:11px; font-weight:700;
          letter-spacing:.04em; text-transform:uppercase; color:#94A3B8 }
  input { width:100%; min-height:46px; margin:0 0 15px;
          padding:0 12px; border:1px solid #1E3A5A; border-radius:9px;
          background:#0A1929; color:#E2E8F0; font-size:16px }
  input[readonly] { color:#94A3B8; background:#0C2136 }
  /* A consent is a sentence to READ, not a field label. Without these three
     resets it inherits the uppercase, letter-spaced, bold label styling above
     and becomes a wall of shouting that nobody reads before ticking, which is
     the opposite of what a consent is for. (No backticks in here: this comment
     lives inside a template literal, and one closed the string.) */
  .consent { display:flex; gap:9px; align-items:flex-start; margin:0 0 13px;
             text-transform:none; letter-spacing:normal; font-weight:400 }
  .consent input { width:20px; min-height:20px; height:20px; margin:2px 0 0; flex:0 0 auto }
  .consent span { font-size:12.5px; color:#B6C2D2; line-height:1.45 }
  .hint { margin:0 0 18px; font-size:12px; color:#64748B }
  .err { margin:0 0 16px; padding:9px 11px; border:1px solid #7F1D1D; border-radius:8px;
         background:rgba(127,29,29,.28); color:#FCA5A5; font-size:12.5px }
  button { width:100%; min-height:48px; border:0; border-radius:10px; cursor:pointer;
           background:#38BDF8; color:#06203A; font-size:15px; font-weight:700 }
  button:hover { background:#7DD3FC }
  a { color:#7DD3FC }
`

const head = (title: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Smart Sailing Analytics</title>
<style>${SHELL}</style>
</head><body>`

export interface PasswordFormArgs {
  /** Hidden fields carried through the POST, as name → value. */
  hidden: Record<string, string | null | undefined>
  /** Shown read-only above the password fields. Display only — never trusted. */
  email?: string | null
  heading?: string
  /** One line under the heading, e.g. which team they are joining. */
  intro?: string | null
  submit?: string
  error?: string | null
  /** Show the two consents, required, with the privacy page linked. */
  consent?: boolean
  /** Where the data clause lives, so it can be read before it is agreed to. */
  privacyHref?: string
}

/**
 * Choose a password, twice, and be signed in.
 *
 * The address is `readonly` and NOT submitted: the account that gets the
 * password is whichever one the token resolves to, server-side. Trusting a
 * field the browser could change would let an edited link point a valid token
 * at a different address on screen.
 */
export function passwordFormPage(args: PasswordFormArgs): string {
  const hidden = Object.entries(args.hidden)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v as string)}">`)
    .join('')

  const heading = args.heading || 'Choose a password'
  const emailRow = args.email
    ? `<label for="email">Email</label>
       <input id="email" type="email" value="${esc(args.email)}" readonly autocomplete="username">`
    : ''

  return `${head(heading)}
  <form method="POST">
    ${hidden}
    <h1>${esc(heading)}</h1>
    ${args.error ? `<p class="err">${esc(args.error)}</p>` : ''}
    ${args.intro ? `<p class="hint">${esc(args.intro)}</p>` : ''}
    ${emailRow}
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" required minlength="${MIN_PASSWORD}"
           autocomplete="new-password" autofocus>
    <label for="pw2">Confirm password</label>
    <input id="pw2" name="confirm" type="password" required minlength="${MIN_PASSWORD}"
           autocomplete="new-password">
    <p class="hint">At least ${MIN_PASSWORD} characters. You will be signed in straight away.</p>
    ${args.consent ? consentBlock(args.privacyHref) : ''}
    <button type="submit">${esc(args.submit || 'Set password and sign in')}</button>
  </form>
</body></html>`
}

/**
 * The two things somebody has to agree to before there is an account.
 *
 * `required` on the inputs stops the ordinary case in the browser; the server
 * checks both again, because a form is not a contract and `required` is one
 * devtools click away. They are separate boxes rather than one: agreeing to how
 * data is handled is not the same as agreeing to be recorded, and a single
 * "I agree to everything" tick would record a consent nobody actually gave.
 *
 * The debrief recorder also reads this per team at run time — one crew member
 * who has not agreed blocks the recording for everybody — so a box ticked here
 * is doing real work, not decorating a sign-up page.
 */
function consentBlock(privacyHref?: string): string {
  const privacy = privacyHref
    ? `<a href="${esc(privacyHref)}" target="_blank" rel="noopener">how SSA handles your data</a>`
    : 'how SSA handles your data'
  return `
    <label class="consent">
      <input type="checkbox" name="privacy" value="yes" required>
      <span>I have read ${privacy}, and agree to it.</span>
    </label>
    <label class="consent">
      <input type="checkbox" name="recording" value="yes" required>
      <span>I agree to debriefs being <strong>voice-recorded</strong> and transcribed for
      the team, and to my voice appearing in them. You can withdraw this later in your
      profile &mdash; the team's recorder stops for everybody if anybody aboard has.</span>
    </label>`
}

/** A dead end that says what to do next, rather than only what went wrong. */
export function messagePage(args: {
  heading: string
  body: string
  linkHref?: string
  linkText?: string
}): string {
  return `${head(args.heading)}
  <main>
    <h1>${esc(args.heading)}</h1>
    <p class="hint">${esc(args.body)}</p>
    ${args.linkHref ? `<p><a href="${esc(args.linkHref)}">${esc(args.linkText || 'Continue')}</a></p>` : ''}
  </main>
</body></html>`
}

/** Both pages carry a token or set a session — never cache them. */
export const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
} as const

/** The password rules, in one place because three screens enforce them. */
export function checkPassword(password: string | null, confirm: string | null): string | null {
  if (!password || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`
  }
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}

/** Both consents, or the sentence saying which is missing. Server-side, because
 *  a `required` attribute is one devtools click away from not being there. */
export function checkConsent(privacy: unknown, recording: unknown): string | null {
  const yes = (v: unknown) => v === 'yes' || v === true || v === 'true' || v === 'on'
  if (!yes(privacy) && !yes(recording)) {
    return 'Please agree to both the data clause and the debrief recording to continue.'
  }
  if (!yes(privacy)) return 'Please confirm you have read how SSA handles your data.'
  if (!yes(recording)) {
    return 'Debriefs are voice-recorded, so agreeing to that is part of joining. You can withdraw it later in your profile.'
  }
  return null
}
