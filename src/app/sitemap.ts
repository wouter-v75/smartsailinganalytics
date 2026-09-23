// sitemap.xml — the five public pages, and only those.
//
// `/` is listed because for an anonymous visitor (which is what a crawler is)
// it renders the marketing front page, not the app.
import type { MetadataRoute } from 'next'
import { siteUrl } from '../lib/siteMeta'

const PAGES: { path: string; priority: number }[] = [
  { path: '/', priority: 1 },
  { path: '/features', priority: 0.8 },
  { path: '/pricing', priority: 0.8 },
  { path: '/support', priority: 0.7 },
  { path: '/privacy', priority: 0.5 },
  { path: '/request-access', priority: 0.6 },
]

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  return PAGES.map(({ path, priority }) => ({
    url: new URL(path, siteUrl).toString(),
    lastModified,
    changeFrequency: 'monthly' as const,
    priority,
  }))
}
