import { it } from 'vitest'
import { writeFileSync } from 'fs'
import { passwordFormPage } from '../auth-pages'

// Not a test: a way to look at the real page at phone width. Skipped unless
// SSA_RENDER is set, so it costs nothing in the suite.
it.skipIf(!process.env.SSA_RENDER)('renders the welcome page for eyeballing', () => {
  writeFileSync(process.env.SSA_RENDER as string, passwordFormPage({
    hidden: { token: 'tok' },
    email: 'gwenael.leguen@example.com',
    heading: 'Welcome to SSA',
    intro: 'Choose a password and you are in — Northstar 76 is already set up for you.',
    consent: true, privacyHref: '/privacy',
  }))
})
