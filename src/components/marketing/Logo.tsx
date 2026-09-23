// The SSA mark, in one place.
//
// This is the artwork from src/app/icon.svg — the tab icon — rather than a
// second drawing that merely resembles it. The public site previously used a
// hand-drawn burgee, which meant the thing in the browser tab and the thing at
// the top of the page were different logos. Inlined as SVG rather than loaded
// as an <img> so it needs no request and inherits nothing it should not.
//
// Keep the geometry identical to icon.svg. If the mark changes, change both.
export default function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="64" height="64" rx="15" fill="#0B2032" />
      <path d="M30 10 L16 52 L34 52 Q39 30 30 10 Z" fill="#22D3EE" />
      <path d="M44 20 L36 52 L50 52 Q54 35 44 20 Z" fill="#EAF6FA" />
    </svg>
  )
}
