import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Shared Sailing Analytics',
  description: 'Sailing team video intelligence platform',
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
