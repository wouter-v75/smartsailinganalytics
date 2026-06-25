// src/lib/pdfText.ts
// ─────────────────────────────────────────────────────────────────────────────
// Server-side PDF → text extraction tuned for SailScan reports.
//
// pdf-parse's default renderer concatenates every glyph on a line with NO
// separators, so a North stripe row comes out as "75%41.313.733-2181.171.5" —
// impossible to split back into columns. We supply a custom `pagerender` that
// rebuilds whitespace from each text item's transform (x position) and width:
// a horizontal gap becomes a space, a vertical change becomes a newline. The
// result reads like `pdftotext` output and both report parsers can tokenise it.
//
// pdf-parse is an optional/runtime dependency (dynamic import) so the build
// never hard-depends on it; callers handle the throw if it's absent.
// ─────────────────────────────────────────────────────────────────────────────

interface TextItem {
  str: string
  width?: number
  transform: number[] // [a, b, c, d, e(x), f(y)]
}

// Rebuild a page's text with positional spacing. Tunables are deliberately
// loose: SailScan tables have wide inter-column gaps and clear line steps.
function renderPageWithSpacing(pageData: any): Promise<string> {
  return pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((tc: { items: TextItem[] }) => {
      let last: TextItem | null = null
      let text = ''
      for (const item of tc.items) {
        if (last) {
          const dy = Math.abs(item.transform[5] - last.transform[5])
          const dx = item.transform[4] - (last.transform[4] + (last.width || 0))
          if (dy > 3) text += '\n'
          else if (dx > 1.2) text += ' '
        }
        text += item.str
        last = item
      }
      return text + '\n'
    })
}

export async function extractPdfText(buf: Buffer): Promise<string> {
  // optional dep — resolved at runtime; suppress missing-types if not installed
  // @ts-ignore
  const mod: any = await import('pdf-parse/lib/pdf-parse.js')
  const pdf = mod.default || mod
  const parsed = await pdf(buf, { pagerender: renderPageWithSpacing })
  return parsed.text || ''
}
