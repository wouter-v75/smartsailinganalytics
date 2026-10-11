// src/components/__tests__/RichTextLongNote.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// A long debrief must come out whole.
//
// Baraka's Admiral's Cup note is 7158 characters over 67 lines, and the whole
// of it is in the database ending cleanly on "- **Action**: Add any missed
// points…". It still READ as cut short on screen, so this pins the renderer:
// whatever else is wrong, RichText is not dropping it.
//
// The shape matters as much as the length — bold sub-headers, bullets, nested
// bullets, parentheses and blank lines between sections — because the loop
// takes a different branch for each, and a branch that advanced without pushing
// would lose exactly one kind of line and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RichText } from '../RichText'

/** The real note's shape, at the real length. */
function longNote(sections = 9, bulletsPer = 6): { text: string; lines: string[] } {
  const lines: string[] = []
  for (let s = 0; s < sections; s++) {
    if (s) lines.push('')
    lines.push(`**Section ${s + 1}**`)
    for (let b = 0; b < bulletsPer; b++) {
      lines.push(`- Point ${s + 1}.${b + 1}: something said in the meeting (e.g., with a detail in brackets).`)
      if (b % 3 === 2) lines.push(`  - Sub-point ${s + 1}.${b + 1} nested under the one above.`)
    }
  }
  lines.push('- **Action**: Add any missed points to the app group or raise in the next online meeting.')
  return { text: lines.join('\n'), lines }
}

describe('RichText — a 67-line debrief', () => {
  it('renders the LAST line, which is the one that looks missing', () => {
    const { text } = longNote()
    render(<RichText text={text} />)
    expect(screen.getByText(/Add any missed points to the app group/)).toBeTruthy()
  })

  it('loses no line of any kind — header, bullet, nested, or action', () => {
    // The real test: every non-blank line's text is somewhere in the output.
    // A branch that advanced without pushing would drop one KIND of line and
    // leave the rest looking fine, which is how it would go unnoticed.
    const { text, lines } = longNote()
    const { container } = render(<RichText text={text} />)
    const rendered = container.textContent || ''
    const missing = lines
      .filter((l) => l.trim())
      .map((l) => l.replace(/\*\*/g, '').replace(/^\s*-\s*/, '').trim())
      .filter((l) => !rendered.includes(l))
    expect(missing).toEqual([])
  })

  it('handles a note well past the real one without thinning out', () => {
    // 7158 chars was enough to look wrong. Twice that must behave the same.
    const { text, lines } = longNote(20, 8)
    expect(text.length).toBeGreaterThan(14_000)
    const { container } = render(<RichText text={text} />)
    const rendered = container.textContent || ''
    expect(rendered).toContain('Section 20')
    expect(rendered).toContain('Add any missed points')
    expect(lines.filter((l) => l.trim()).every((l) =>
      rendered.includes(l.replace(/\*\*/g, '').replace(/^\s*-\s*/, '').trim()))).toBe(true)
  })

  it('puts no height or overflow limit of its own on the block', () => {
    // If a long note is ever clipped, it is a CONTAINER doing it — this says the
    // renderer is not, so the search starts one level up.
    const { container } = render(<RichText text={longNote().text} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.maxHeight).toBe('')
    expect(root.style.height).toBe('')
    expect(root.style.overflow).toBe('')
    expect(root.style.overflowY).toBe('')
  })
})
