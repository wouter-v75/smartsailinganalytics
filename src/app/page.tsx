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
  const { data: { user } } = await getServerSupabase().auth.getUser()
  return user ? <AppHome /> : <Home />
}
