// POST an IRC certificate PDF → the rig model it describes.
//
//   POST  body: the PDF bytes  → { ok, boat, sailNumber, rigModel, summary }
//
// PARSES, DOES NOT STORE. The caller applies the model exactly as it applies a
// pasted one, and saving still goes through PUT /api/boats/rig-model, which is
// where the coach-only gate lives. One gate, one place; a second route that
// could also write a rig model is how one of them ends up open.
//
// WHY THE SERVER. pdf-parse is a Node library, and the same extractPdfText()
// already turns these PDFs into text for scripts/irc-rigmodel.ts. Doing it here
// means one implementation of "what does this certificate say" rather than a
// second one in the browser, and no PDF reader in the client bundle.
//
// Until now the app took the certificate's TEXT — select all in the PDF, copy,
// paste — which works and is still there. It asks somebody standing in a marina
// office with a PDF on their phone to do the one thing a phone makes hardest.

import { NextResponse, type NextRequest } from 'next/server'
import { requireActiveUser } from '../../../../../lib/supabase/admin-guard'
import { extractPdfText } from '../../../../../lib/pdfText'
import { parseIrcCertificate, rigModelFromIrc } from '../../../../../lib/ircCertificate'

// pdf-parse is Node-only.
export const runtime = 'nodejs'

/** An IRC certificate is a page or two; anything bigger is not one. */
const MAX_BYTES = 10 * 1024 * 1024

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

export async function POST(req: NextRequest) {
  const guard = await requireActiveUser()
  if (!guard.ok) return guard.response

  const type = req.headers.get('content-type') || ''
  let bytes: ArrayBuffer
  if (type.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return bad('no file in the upload')
    bytes = await file.arrayBuffer()
  } else {
    bytes = await req.arrayBuffer()
  }

  if (!bytes.byteLength) return bad('the upload was empty')
  if (bytes.byteLength > MAX_BYTES) {
    return bad(`that file is ${(bytes.byteLength / 1048576).toFixed(1)} MB; a certificate is a page or two`, 413)
  }

  const buf = Buffer.from(bytes)
  // %PDF-. Checked rather than trusted from the content-type, which a browser
  // guesses from the extension.
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return bad('that is not a PDF — upload the certificate as the PDF the rating office issued')
  }

  let text: string
  try {
    text = await extractPdfText(buf)
  } catch (e) {
    return bad(`could not read that PDF (${(e as Error)?.message || e})`, 422)
  }
  if (!text.trim()) {
    // A scan has no text layer. Say which problem it is: "not an IRC
    // certificate" would send somebody looking for the wrong file.
    return bad(
      'that PDF has no text in it — it is probably a scan or a photograph of a certificate. '
      + 'Ask the rating office for the issued PDF, which carries the numbers as text.',
      422
    )
  }

  const cert = parseIrcCertificate(text)
  if (!cert) {
    return bad('that PDF does not read as an IRC certificate — nothing was changed', 422)
  }

  const model = rigModelFromIrc(cert)
  return NextResponse.json({
    ok: true,
    boat: cert.name || null,
    sailNumber: cert.sailNumber || null,
    rigModel: model,
    // What to show so somebody can check the parse against the paper in front
    // of them before it becomes the scale for every measurement after it.
    summary: {
      p: cert.rig.p ?? null,
      e: cert.rig.e ?? null,
      j: cert.rig.j ?? null,
      hlu: cert.rig.hlu ?? null,
      hlp: cert.rig.hlp ?? null,
    },
  })
}
