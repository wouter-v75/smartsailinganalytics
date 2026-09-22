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
import { getServerSupabase } from '../lib/supabase/server'
import Home from '../components/marketing/Home'
import AppHome from './AppHome'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const { data: { user } } = await getServerSupabase().auth.getUser()
  return user ? <AppHome /> : <Home />
}
