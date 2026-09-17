// SSA lint rules.
//
// `npm run lint` had never actually run: there was no config at all, so `next lint`
// dropped into its interactive setup wizard and waited for a keypress — which means
// it could never run in CI either, and nobody had ever seen a warning from it. The
// first real run found a SYNTAX ERROR sitting in lib/localStore.js, dead code no
// build had touched in months.
//
// The rules below are the ones whose warnings are worth reading. Everything turned
// off is turned off with a reason, not because it was noisy.

module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'plugin:@typescript-eslint/recommended'],

  ignorePatterns: [
    'node_modules/',
    '.next/',
    // Separate projects that live in this repo but are not built by it.
    'sail-scan-ai/',
    'sailscan-backfill/',
    'ml/',
    'fixtures/',
    // One-off data scripts run through vite-node, not shipped.
    'scripts/',
  ],

  rules: {
    // ── Kept: these catch real bugs ──────────────────────────────────────────
    // An effect whose deps lie is how the GPSTrackMap render loop got in.
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],

    // ── Off, deliberately ────────────────────────────────────────────────────
    // `any` is how this codebase meets untyped third parties: Leaflet, Plotly, d3,
    // jsPDF, heic2any, pdf-parse, mediabunny, raw Supabase rows. 426 warnings for a
    // house style nobody intends to change would bury the ~17 hook warnings that are
    // real. The PLUGIN still has to be installed even with the rule off, so that the
    // `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comments
    // already written through the source resolve — without it, each one was a hard
    // lint error ("Definition for rule ... was not found").
    '@typescript-eslint/no-explicit-any': 'off',

    // @ts-ignore is used where a package ships no type declarations (tz-lookup,
    // hls.js/light). Every one already carries a comment saying which and why.
    '@typescript-eslint/ban-ts-comment': 'off',

    // Typographic apostrophes in JSX prose are correct English, not a bug.
    'react/no-unescaped-entities': 'off',

    // next/image cannot serve blob: URLs, and the Bunny thumbnails are already sized
    // by src/lib/thumbSrc.ts. Both would be a regression, not an optimisation.
    '@next/next/no-img-element': 'off',
  },
}
