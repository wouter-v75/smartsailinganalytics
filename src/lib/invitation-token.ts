// Random opaque token generator. Used as the URL portion of invitation
// links, e.g. https://ssa.wvsailing.co.uk/join/<token>.
//
// 24 base32-ish chars (≈ 120 bits). Not predictable; not a JWT.

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789' // no 0/1/l to avoid confusion

export function generateInviteToken(length = 24): string {
  const out: string[] = []
  // crypto.getRandomValues is available in both Node 19+ and the browser.
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  for (let i = 0; i < length; i++) {
    out.push(ALPHABET[arr[i] % ALPHABET.length])
  }
  return out.join('')
}
