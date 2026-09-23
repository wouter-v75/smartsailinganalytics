// `/` is two pages behind one URL.
//
// Signed out, it is the public front page — the thing a coach forwards to a
// programme manager (docs/web-and-support-2026-09.md). Signed in, it is the app,
// exactly as before: AppHome is the previous contents of this file, unchanged
// but for its name.
//
// The session is read on the SERVER so a signed-in user never sees a flash of
// marketing, and an anonymous visitor is never bounced to /login from the front
// door. Middleware lets `/` through for both; the decision is made here.
import type { Metadata } from 'next'
import { pageMeta } from '../lib/siteMeta'
import { getServerSupabase } from '../lib/supabase/server'
import Home from '../components/marketing/Home'
import AppHome from './AppHome'

export const dynamic = 'force-dynamic'

// One title for both faces of this route. A signed-in user sees the app and
// never reads it; an anonymous visitor — and every link preview — sees this.
export const metadata: Metadata = pageMeta({
  title: 'The whole of a sailing day, with the whole team',
  description:
    'Video, photos, instrument data, the forecast, sail shape and what the team said about it — joined to the minute they happened, and shared with everyone on the programme before dinner.',
  path: '/',
})

export default async function Page() {
  // The front door must render even if the session lookup does not. An
  // anonymous visitor arriving from a forwarded link has no session to read, and
  // a transient auth failure showing them a 500 would cost exactly the first
  // impression this page exists for. Falling back to the marketing page is
  // always the safe direction: the worst case is a signed-in user seeing the
  // public page and clicking Sign in, which works.
  let user = null
  try {
    const result = await getServerSupabase().auth.getUser()
    user = result.data.user
  } catch (e) {
    console.warn('[page] auth lookup failed, showing marketing:', e instanceof Error ? e.message : e)
  }
  return user ? <AppHome /> : <Home />
}
