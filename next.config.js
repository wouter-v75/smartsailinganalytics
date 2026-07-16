/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse (dynamically imported in src/lib/pdfText.ts for the sail-scans
    // route) ships a bundled pdf.js worker that webpack cannot parse
    // ("Unterminated string constant" in pdf.worker.js). Marking it external
    // makes Next require() it at runtime instead of bundling/parsing it. It is
    // a server-only dependency, so this is safe and does not affect the client.
    serverComponentsExternalPackages: ['pdf-parse'],
  },
}

module.exports = nextConfig
