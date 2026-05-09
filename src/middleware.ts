// SSA route gating + Supabase session refresh.
//
// Runs on every request that matches `config.matcher`. Two jobs:
//   1. Refresh the Supabase auth cookie if it's near expiry (so a user who
//      idles a tab doesn't get silently logged out).
//   2. Redirect based on auth + app-level status:
//        - unauthenticated + protected route → /login
//        - authenticated + status='active'   + on /login or /signup → /
//        - authenticated + status='pending'  → /login?reason=pending
//        - authenticated + status='disabled' → /login?reason=disabled
//        - authenticated + missing public.users row → /login?reason=missing-profile
//
// For non-active users we clear the Supabase auth cookies on the redirect
// response, otherwise the next request would loop right back here.
//
// Anything under /api stays accessible — those routes do their own auth.

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/signup',
  '/auth/callback',
  '/auth/confirm',
])

// Path-prefix matches that bypass the auth gate entirely (anonymous AND
// non-active users can hit them). /join/<token> is an invite redemption
// landing page that needs to work for unauth, pending, and active alike.
function isAlwaysPublic(pathname: string): boolean {
  return pathname.startsWith('/join/')
}

function clearAuthCookies(request: NextRequest, redirectTo: URL) {
  const res = NextResponse.redirect(redirectTo)
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith('sb-')) {
      res.cookies.set({
        name: cookie.name,
        value: '',
        maxAge: 0,
        path: '/',
      })
    }
  }
  return res
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const response = NextResponse.next({ request: { headers: request.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: CookieOptions) {
          response.cookies.set({ name, value: '', ...options })
        },
      },
    }
  )

  // Calling getUser() refreshes the session cookie if needed.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isPublic = PUBLIC_PATHS.has(pathname) || isAlwaysPublic(pathname)

  // /join/* is reachable regardless of auth state — the page itself decides
  // what to do (redirect unauth to /signup?invite=, redeem for auth users).
  if (isAlwaysPublic(pathname)) return response

  // Unauthenticated and visiting a protected page → /login.
  if (!user) {
    if (isPublic) return response
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Authenticated — fetch app status to decide what to do.
  const { data: appUser } = await supabase
    .from('users')
    .select('status')
    .eq('id', user.id)
    .maybeSingle()

  const status = appUser?.status as
    | 'pending'
    | 'active'
    | 'disabled'
    | undefined

  if (!status) {
    // public.users row missing — should never happen because of the
    // handle_new_user trigger. Clear cookies and bounce to /login.
    if (pathname === '/login') return response
    return clearAuthCookies(
      request,
      new URL('/login?reason=missing-profile', request.url)
    )
  }

  if (status === 'pending') {
    if (pathname === '/login') return response
    return clearAuthCookies(
      request,
      new URL('/login?reason=pending', request.url)
    )
  }

  if (status === 'disabled') {
    if (pathname === '/login') return response
    return clearAuthCookies(
      request,
      new URL('/login?reason=disabled', request.url)
    )
  }

  // status === 'active'. Bounce them off /login or /signup → /.
  if (pathname === '/login' || pathname === '/signup') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return response
}

// Match every page route except API, _next assets, and static files.
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot)).*)',
  ],
}
