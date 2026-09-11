/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse must be REQUIRED at runtime, never bundled.
  //
  // src/lib/pdfText.ts imports it dynamically precisely so the build does not
  // hard-depend on it, but a dynamic import does not stop webpack following the
  // package: it walks into pdf-parse's vendored pdf.js build and fails to parse
  // lib/pdf.js/v1.9.426/build/pdf.worker.js ("Unterminated string constant"),
  // which is a prebuilt artefact never meant to go through a bundler.
  //
  // Listing it here leaves it to Node's own require at runtime on the server,
  // which is what the dynamic import was always trying to express.
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse'],
  },
  // Clip thumbnails come from Bunny's CDN as full 1280×720 JPEGs; the image
  // optimiser serves them at card size (src/lib/thumbSrc.ts).
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**.b-cdn.net' }],
  },
}

module.exports = nextConfig
