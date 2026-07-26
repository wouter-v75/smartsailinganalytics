'use client'
// RichText — the ONE renderer for every free-text notes field in SSA
// (debrief notes, speed-team meeting notes, weather notes, plan, timings, sail-scan
// notes). Notes are stored as plain text; this turns a light Markdown subset into
// readable structure at render time. Nothing about the stored value changes, so
// existing notes keep rendering exactly as before — a note with no markers is still
// just lines of text.
//
// Supported, deliberately small:
//   ## Heading            (# .. #### — the summary tool emits ##)
//   - bullet / * bullet / • bullet   (two leading spaces = one nesting level)
//   1. numbered
//   > quote
//   ---                   horizontal rule
//   **bold**  *italic*  `code`
//   #tag                  (existing behaviour — coloured)
//   [[clip:id|label]] / [[item:id|label]]  (existing behaviour — clickable chip)
//
// Two things it must NOT break:
//   • `#tag` is not a heading. A heading needs a SPACE after the hashes, a tag never
//     has one, so `#gybe` stays a tag and `## Learnings` becomes a heading.
//   • `_underscores_` are NOT italic. Field names like speed_long_term and
//     next_focus appear in these notes constantly and would be mangled. Only
//     *asterisks* mean italic.
//
// No lookbehind in the regexes: Safari only got it in 16.4 and the crew are on
// whatever iPads they have.

import * as React from 'react'

export type OpenRef = (kind: string, id: string, label: string) => void

const HEAD = '#7DD3FC' // section headings — same cyan as the field labels
const TAG = '#A78BFA'
const CHIP_BORDER = '#06B6D455'
const CHIP_BG = '#06B6D415'
const CHIP_FG = '#7DD3FC'
const QUOTE_BAR = '#1E3A5A'
const RULE = '#1E3A5A'
const CODE_BG = 'rgba(148,163,184,0.14)'

// ── inline ────────────────────────────────────────────────────────────────────
// One pass, one alternation. Order matters: [[link]] before anything else, and
// **bold** before *italic* so `**x**` isn't read as an empty italic.
const INLINE = /\[\[(clip|item):([^|\]]+)\|([^\]]+)\]\]|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|(#[\w-]+)/g

function renderInline(text: string, onOpenRef?: OpenRef, keyBase = ''): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={`${keyBase}t${k++}`}>{text.slice(last, m.index)}</span>)
    const [, linkKind, linkId, linkLabel, bold, italic, code, tag] = m
    if (linkKind) {
      out.push(
        <button
          key={`${keyBase}l${k++}`}
          type="button"
          onClick={() => onOpenRef?.(linkKind, linkId, linkLabel)}
          disabled={!onOpenRef}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12,
            border: `1px solid ${CHIP_BORDER}`, background: CHIP_BG, color: CHIP_FG,
            borderRadius: 5, padding: '0 6px', margin: '0 1px',
            cursor: onOpenRef ? 'pointer' : 'default',
          }}
        >
          {linkKind === 'clip' ? '▶' : '◳'} {linkLabel}
        </button>
      )
    } else if (bold) {
      out.push(<strong key={`${keyBase}b${k++}`} style={{ fontWeight: 700, color: '#F1F5F9' }}>{bold}</strong>)
    } else if (italic) {
      out.push(<em key={`${keyBase}i${k++}`} style={{ fontStyle: 'italic' }}>{italic}</em>)
    } else if (code) {
      out.push(
        <code key={`${keyBase}c${k++}`} style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.92em', background: CODE_BG, borderRadius: 4, padding: '0 4px' }}>{code}</code>
      )
    } else if (tag) {
      out.push(<span key={`${keyBase}h${k++}`} style={{ color: TAG, fontWeight: 600 }}>{tag}</span>)
    }
    last = INLINE.lastIndex
  }
  if (last < text.length) out.push(<span key={`${keyBase}t${k++}`}>{text.slice(last)}</span>)
  return out
}

// ── blocks ────────────────────────────────────────────────────────────────────
const RE_HEAD = /^(#{1,4})\s+(.+?)\s*#*$/
const RE_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const RE_BULLET = /^(\s*)[-*•]\s+(.*)$/
const RE_NUM = /^(\s*)(\d{1,2})[.)]\s+(.*)$/
const RE_QUOTE = /^\s*>\s?(.*)$/

const HEAD_SIZE = ['1.12em', '1em', '0.94em', '0.9em'] // h1..h4, relative to the box

export function RichText({
  text,
  onOpenRef,
  style,
  className,
}: {
  text?: string | null
  onOpenRef?: OpenRef
  style?: React.CSSProperties
  className?: string
}) {
  const raw = text == null ? '' : String(text)
  if (!raw.trim()) return null

  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0

  const push = (node: React.ReactNode) => blocks.push(node)

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      // Collapse a run of blank lines into one gap — pasted notes are full of them.
      while (i < lines.length && !lines[i].trim()) i++
      if (blocks.length) push(<div key={`gap${i}`} style={{ height: 8 }} />)
      continue
    }

    if (RE_RULE.test(line)) {
      push(<hr key={`hr${i}`} style={{ border: 0, borderTop: `1px solid ${RULE}`, margin: '10px 0' }} />)
      i++
      continue
    }

    const h = line.match(RE_HEAD)
    if (h) {
      const level = Math.min(4, h[1].length)
      push(
        <div
          key={`h${i}`}
          style={{
            fontSize: HEAD_SIZE[level - 1],
            fontWeight: 700,
            color: HEAD,
            letterSpacing: 0.2,
            margin: blocks.length ? '10px 0 4px' : '0 0 4px',
          }}
        >
          {renderInline(h[2], onOpenRef, `h${i}`)}
        </div>
      )
      i++
      continue
    }

    // A run of list items — bullets and numbers can interleave; each keeps its marker.
    if (RE_BULLET.test(line) || RE_NUM.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length) {
        const b = lines[i].match(RE_BULLET)
        const n = b ? null : lines[i].match(RE_NUM)
        if (!b && !n) break
        const indent = Math.min(3, Math.floor((b ? b[1] : n![1]).replace(/\t/g, '  ').length / 2))
        const marker = b ? (indent ? '◦' : '•') : `${n![2]}.`
        const body = b ? b[2] : n![3]
        items.push(
          <div
            key={`li${i}`}
            style={{ display: 'flex', gap: 7, marginTop: items.length ? 3 : 0, paddingLeft: indent * 14 }}
          >
            <span style={{ flex: '0 0 auto', minWidth: b ? 8 : 15, color: b ? HEAD : 'inherit', opacity: b ? 0.9 : 0.75, textAlign: b ? 'left' : 'right' }}>{marker}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{renderInline(body, onOpenRef, `li${i}`)}</span>
          </div>
        )
        i++
      }
      push(<div key={`ul${i}`}>{items}</div>)
      continue
    }

    const q = line.match(RE_QUOTE)
    if (q) {
      const parts: React.ReactNode[] = []
      let j = i
      while (j < lines.length) {
        const qq = lines[j].match(RE_QUOTE)
        if (!qq) break
        parts.push(<div key={`q${j}`}>{renderInline(qq[1], onOpenRef, `q${j}`)}</div>)
        j++
      }
      push(
        <div key={`bq${i}`} style={{ borderLeft: `2px solid ${QUOTE_BAR}`, paddingLeft: 8, margin: '4px 0', opacity: 0.9 }}>
          {parts}
        </div>
      )
      i = j
      continue
    }

    // Plain line. Consecutive plain lines stay on separate lines (people write notes
    // as line-per-thought, and pre-wrap used to preserve that — keep it).
    push(<div key={`p${i}`}>{renderInline(line, onOpenRef, `p${i}`)}</div>)
    i++
  }

  return (
    <div className={className} style={{ lineHeight: 1.5, overflowWrap: 'anywhere', ...style }}>
      {blocks}
    </div>
  )
}

// Shown under the editors so people know the markers exist at all — a formatting
// feature nobody can see is a formatting feature nobody uses.
export function FormatHint({ style }: { style?: React.CSSProperties }) {
  const code: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', color: '#94A3B8' }
  return (
    <div style={{ fontSize: 10.5, color: '#8A97A9', marginTop: 4, ...style }}>
      <span style={code}>## Heading</span> · <span style={code}>- bullet</span> ·{' '}
      <span style={code}>**bold**</span> · <span style={code}>*italic*</span> ·{' '}
      <span style={code}>#tag</span>
    </div>
  )
}

export default RichText
