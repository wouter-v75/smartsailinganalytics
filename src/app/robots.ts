// robots.txt
//
// The public pages exist to be found — NN/g's point that people search for
// their problem rather than your solution is why the support page's questions
// are phrased the way they are, and none of that works if the page is not
// indexed.
//
// Everything else is either behind auth or meaningless to a crawler, and a few
// of them (share links, invitations) are secret-bearing URLs that must never be
// indexed even though they are technically reachable without a session.
import type { MetadataRoute } from 'next'
import { siteUrl } from '../lib/siteMeta'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/admin/',
        '/profile',
        '/login',
        '/signup',
        '/auth/',
        '/join/',       // invitation redemption — carries a token
        '/share/',      // single-clip share links — carries a token
      ],
    },
    sitemap: new URL('/sitemap.xml', siteUrl).toString(),
  }
}
