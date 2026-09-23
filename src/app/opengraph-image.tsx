// The link-preview card: the boat, not a typographic panel.
//
// WhatsApp, Slack and iMessage render the title and description as text NEXT to
// the image, so words on the image only duplicate them. What the text cannot do
// is prove these people actually sail — so the card is the footage, with just
// enough overlay to say whose boat it is and who shot it.
//
// Node runtime rather than edge so the frame can be read straight off disk;
// inlining 64 KB of base64 into source would be worse in every way. Next caches
// the result, so the read happens once, not per preview bot.
import { ImageResponse } from 'next/og'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const alt =
  'Northstar, 2026 Maxi World Champion, racing at Porto Cervo — Shared Sailing Analytics'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// 1200×630, cropped and scaled from the hero clip (see public/media/og-hero.jpg).
const frame = readFileSync(join(process.cwd(), 'public/media/og-hero.jpg'))
const frameUri = `data:image/jpeg;base64,${frame.toString('base64')}`

const CYAN = '#22D3EE'
const PALE = '#EAF6FA'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={frameUri} width={1200} height={630} alt="" style={{ objectFit: 'cover' }} />

        {/* A band rather than a full-height wash: the sky and the spray are the
            reason this card exists and should not be dimmed. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 168,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            padding: '0 48px 38px',
            background: 'linear-gradient(to top, rgba(4,16,26,0.92), rgba(4,16,26,0))',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <svg width="34" height="34" viewBox="0 0 64 64">
                <path d="M30 10 L16 52 L34 52 Q39 30 30 10 Z" fill={CYAN} />
                <path d="M44 20 L36 52 L50 52 Q54 35 44 20 Z" fill={PALE} />
              </svg>
              <div style={{ color: PALE, fontSize: 31, fontWeight: 700, letterSpacing: -0.4 }}>
                Shared Sailing Analytics
              </div>
            </div>
            <div style={{ color: 'rgba(234,246,250,0.78)', fontSize: 21, marginTop: 9 }}>
              Northstar · 2026 Maxi World Champion · Porto Cervo
            </div>
          </div>

          <div style={{ color: 'rgba(234,246,250,0.6)', fontSize: 17, display: 'flex' }}>
            Footage: Jonathan Gagachian
          </div>
        </div>
      </div>
    ),
    size,
  )
}
