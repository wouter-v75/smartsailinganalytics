// The shared social card, generated rather than shipped as a binary.
//
// Applies to every route that does not define its own, so one file covers the
// whole public site. Drawn with the app icon's palette (src/app/icon.svg) so a
// pasted link looks like the product it opens.
//
// Deliberately plain: a headline, a line of plain English, and the price. The
// card is read in a WhatsApp group in two seconds by someone who has never
// heard of SSA, which is the same job the front page has and the same reason
// there are no adjectives on it.
import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Shared Sailing Analytics — the whole of a sailing day, on one timeline, with the whole team'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const NAVY = '#0B2032'
const CYAN = '#22D3EE'
const PALE = '#EAF6FA'
const MUTED = '#8FA6B8'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: NAVY,
          padding: '64px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Wordmark, with the icon's sails redrawn at card scale. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <svg width="52" height="52" viewBox="0 0 64 64">
            <path d="M30 10 L16 52 L34 52 Q39 30 30 10 Z" fill={CYAN} />
            <path d="M44 20 L36 52 L50 52 Q54 35 44 20 Z" fill={PALE} />
          </svg>
          <div style={{ color: PALE, fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>
            Shared Sailing Analytics
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              color: PALE,
              fontSize: 60,
              fontWeight: 700,
              lineHeight: 1.12,
              letterSpacing: -1.5,
              maxWidth: 940,
            }}
          >
            The whole of a sailing day, on one timeline, with the whole team.
          </div>
          <div style={{ color: MUTED, fontSize: 27, marginTop: 26, maxWidth: 900, lineHeight: 1.4 }}>
            Video, data, sail shape and the debrief — joined to the minute they happened,
            and shared with everyone on the programme before dinner.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              background: CYAN,
              color: NAVY,
              fontSize: 21,
              fontWeight: 700,
              padding: '10px 20px',
              borderRadius: 10,
            }}
          >
            For grand-prix programmes and Olympic squads
          </div>
          <div style={{ color: MUTED, fontSize: 21 }}>From €1,200/year · every boat included</div>
        </div>
      </div>
    ),
    size,
  )
}
