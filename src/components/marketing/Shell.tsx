// Chrome for the public pages: nav, footer, and the page container.
//
// Server component — these pages are static text and should render without
// shipping React state to a visitor who is only reading. The one interactive
// thing on the site (the request form) is its own client component.
//
// No cookie banner, because there is no analytics cookie to consent to. Every
// competitor has one; not needing it is the better answer.
import Link from 'next/link'

const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/support', label: 'Support' },
  { href: '/privacy', label: 'Data & AI' },
]

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg antialiased">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-5 py-3.5">
          <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight">
            <Burgee />
            <span className="text-[15px]">Shared Sailing Analytics</span>
          </Link>
          <nav className="ml-auto hidden items-center gap-5 text-[13px] text-secondary sm:flex">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="transition-colors hover:text-fg">{n.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:ml-0">
            <Link href="/login" className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-secondary transition-colors hover:border-border-strong hover:text-fg">
              Sign in
            </Link>
            <Link href="/request-access" className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-fg transition-opacity hover:opacity-90">
              Request access
            </Link>
          </div>
        </div>
        {/* The nav collapses out of the header on a phone rather than becoming a
            hamburger — four links do not justify a menu, and the reader who
            arrived from a forwarded link is here for the page they landed on. */}
        <nav className="flex items-center gap-5 overflow-x-auto border-t border-border px-5 py-2 text-[13px] text-secondary sm:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="whitespace-nowrap">{n.label}</Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-5">{children}</main>

      <footer className="mt-24 border-t border-border">
        <div className="mx-auto grid max-w-5xl gap-8 px-5 py-10 text-[13px] sm:grid-cols-3">
          <div>
            <div className="mb-2 flex items-center gap-2 font-bold"><Burgee /> SSA</div>
            <p className="text-muted">
              The whole of a sailing day, joined and shared with everyone on the programme.
            </p>
          </div>
          <div>
            <div className="mb-2 font-semibold text-secondary">Product</div>
            <ul className="space-y-1.5 text-muted">
              <li><Link href="/features" className="hover:text-fg">Features</Link></li>
              <li><Link href="/pricing" className="hover:text-fg">Pricing</Link></li>
              <li><Link href="/support" className="hover:text-fg">Support &amp; manual</Link></li>
              <li><Link href="/support#classes" className="hover:text-fg">Supported boats</Link></li>
              <li><Link href="/privacy" className="hover:text-fg">Data &amp; AI</Link></li>
            </ul>
          </div>
          <div>
            <div className="mb-2 font-semibold text-secondary">Get in touch</div>
            <ul className="space-y-1.5 text-muted">
              <li><Link href="/request-access" className="hover:text-fg">Request access</Link></li>
              <li><Link href="/login" className="hover:text-fg">Sign in</Link></li>
              <li><a href="mailto:wouterv@runbox.com" className="hover:text-fg">wouterv@runbox.com</a></li>
            </ul>
          </div>
        </div>
        <div className="mx-auto max-w-5xl px-5 pb-10 text-[12px] text-faint">
          © {new Date().getFullYear()} Shared Sailing Analytics. Data held in the EU.
        </div>
      </footer>
    </div>
  )
}

// A burgee, drawn rather than imported — one shape, no image request.
function Burgee() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path d="M3 1.5v13" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 2.5h9l-3.2 2.6L13 7.7H4z" fill="var(--accent)" />
    </svg>
  )
}

// ── Shared page furniture ──────────────────────────────────────────────────

export function Hero({ eyebrow, title, children }: {
  eyebrow?: string; title: string; children?: React.ReactNode
}) {
  return (
    <section className="border-b border-border py-14 sm:py-20">
      {eyebrow && (
        <div className="mb-3 text-[12px] font-bold uppercase tracking-[0.14em] text-accent">{eyebrow}</div>
      )}
      <h1 className="max-w-3xl text-[28px] font-bold leading-[1.2] tracking-tight sm:text-[40px] sm:leading-[1.15]">
        {title}
      </h1>
      {children && <div className="mt-5 max-w-2xl text-[15px] leading-relaxed text-secondary">{children}</div>}
    </section>
  )
}

export function Section({ id, title, lead, children }: {
  id?: string; title: string; lead?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-24 border-b border-border py-12 sm:py-16">
      <h2 className="text-[20px] font-bold tracking-tight sm:text-[24px]">{title}</h2>
      {lead && <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">{lead}</div>}
      <div className="mt-7">{children}</div>
    </section>
  )
}

export function Card({ title, badge, children }: {
  title: string; badge?: string; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[15px] font-bold">{title}</h3>
        {badge && (
          <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
            {badge}
          </span>
        )}
      </div>
      <div className="text-[14px] leading-relaxed text-secondary">{children}</div>
    </div>
  )
}
