import type { Metadata } from 'next'
import './globals.css'
import { siteUrl, SITE_NAME } from '../lib/siteMeta'

// metadataBase turns every relative OG/canonical URL below into an absolute one;
// without it Next warns and social cards resolve against nothing. The public
// pages override title/description via pageMeta(); what stays here is the
// template, the card defaults and the crawling rules.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: SITE_NAME,
    // Page titles read "Pricing — Shared Sailing Analytics" without each page
    // having to repeat the suffix.
    template: `%s — ${SITE_NAME}`,
  },
  description:
    'The whole of a sailing day — video, instrument data, sail shape and the debrief — joined to the minute it happened and shared with the whole programme.',
  applicationName: SITE_NAME,
  openGraph: {
    siteName: SITE_NAME,
    type: 'website',
    locale: 'en_GB',
  },
  twitter: { card: 'summary_large_image' },
  robots: {
    // The marketing pages should be found; everything behind auth is excluded
    // by robots.ts, which is the file crawlers actually read for paths.
    index: true,
    follow: true,
  },
}

// Video and poster hosts. Opening the connection (DNS + TCP + TLS) while the
// page loads takes those round trips off a clip's first play — on a phone over
// marina wifi that is a noticeable part of the wait. Each host twice: hls.js
// fetches with CORS, the <video> element and <img> posters without, and a
// preconnect is only reused by requests of the same mode.
const MEDIA_HOSTS = [process.env.BUNNY_CDN_HOSTNAME, process.env.BUNNY_PULL_HOST]
  .filter((h): h is string => Boolean(h))
  .map((h) => h.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {MEDIA_HOSTS.map((h) => (
          <link key={`${h}-cors`} rel="preconnect" href={`https://${h}`} crossOrigin="anonymous" />
        ))}
        {MEDIA_HOSTS.map((h) => (
          <link key={h} rel="preconnect" href={`https://${h}`} />
        ))}
      </head>
      <body>{children}</body>
    </html>
  )
}
