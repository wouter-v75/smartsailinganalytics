// Where a share link can go from the player: WhatsApp, the phone's messages,
// email, or whatever else the device offers.
//
// Deep links rather than SDKs: nothing to load, nothing to consent to, and they
// work from a phone browser, which is where a clip actually gets shared. The
// native sheet is offered when the browser has one (phones, and Safari), since
// that covers AirDrop, Signal, Slack and the rest.

export interface ShareSubject {
  /** Clip title, e.g. "R1 start" — may be blank. */
  title?: string | null
  /** The /share/<token> link. */
  url: string
  /** Boat or team name, for a little context in the message. */
  from?: string | null
}

/** One line of prose plus the link — what lands in the chat. */
export function shareMessage(s: ShareSubject): string {
  const what = (s.title || '').trim() || 'a clip'
  const who = (s.from || '').trim()
  return `${who ? `${who}: ` : ''}${what}\n${s.url}`
}

export function shareSubject(s: ShareSubject): string {
  const what = (s.title || '').trim() || 'a clip'
  return `${(s.from || '').trim() ? `${(s.from || '').trim()} — ` : ''}${what}`
}

export function whatsappUrl(s: ShareSubject): string {
  return `https://wa.me/?text=${encodeURIComponent(shareMessage(s))}`
}

/** Messages / SMS. "sms:?&body=" is the spelling both iOS and Android accept. */
export function smsUrl(s: ShareSubject): string {
  return `sms:?&body=${encodeURIComponent(shareMessage(s))}`
}

export function mailtoUrl(s: ShareSubject): string {
  return `mailto:?subject=${encodeURIComponent(shareSubject(s))}&body=${encodeURIComponent(shareMessage(s))}`
}

// Instagram accepts no link from a web page: there is no web intent, and its app
// cannot be handed a URL by the browser. The honest path is to copy the link and
// open Instagram so it can be pasted into a story or a DM — and on a phone the
// device's own share sheet ("Other app…") lists Instagram directly, which is why
// the sheet is offered first when the browser has one.
export const INSTAGRAM_APP_URL = 'instagram://app'
export const INSTAGRAM_WEB_URL = 'https://www.instagram.com/'

/** Where to send someone for Instagram: the app if this is a phone, else the site. */
export function instagramUrl(ua?: string | null): string {
  return /iPhone|iPad|iPod|Android/i.test(ua || '') ? INSTAGRAM_APP_URL : INSTAGRAM_WEB_URL
}

export function canNativeShare(nav?: { share?: unknown } | null): boolean {
  return typeof nav?.share === 'function'
}

/** The device's own share sheet. Resolves false when it is unavailable or dismissed. */
export async function nativeShare(s: ShareSubject, nav?: Navigator | null): Promise<boolean> {
  const n = nav ?? (typeof navigator !== 'undefined' ? navigator : null)
  if (!canNativeShare(n)) return false
  try {
    await n!.share({ title: shareSubject(s), text: shareMessage(s), url: s.url })
    return true
  } catch {
    return false   // dismissed, or refused — the other buttons still work
  }
}
