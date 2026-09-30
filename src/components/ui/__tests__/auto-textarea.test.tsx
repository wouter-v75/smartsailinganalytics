import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AutoTextarea } from '../auto-textarea'

// jsdom lays nothing out, so scrollHeight is always 0 and the growth cannot be
// observed for real — that was measured in Chromium (a rows={5} box hid 97px of
// a 211px debrief section). What CAN be pinned here is the arithmetic around it,
// and one line of it is easy to lose: the box is collapsed to `auto` before
// being measured. scrollHeight never reports less than the height already set,
// so without the collapse a box can grow and never shrink — and a re-run that
// replaces a long draft with a short one leaves a field of empty space.

let fakeScrollHeight = 0
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return this.style.height === 'auto' ? fakeScrollHeight : 0 },
  })
})
afterEach(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original)
  vi.restoreAllMocks()
})

const ta = () => screen.getByRole('textbox') as HTMLTextAreaElement

describe('AutoTextarea', () => {
  it('sizes itself to its content on mount', () => {
    fakeScrollHeight = 211
    render(<AutoTextarea readOnly value="a debrief section" />)
    expect(ta().style.height).toBe('211px')
  })

  it('SHRINKS when the value gets shorter, not only grows', () => {
    fakeScrollHeight = 400
    const { rerender } = render(<AutoTextarea readOnly value="long" />)
    expect(ta().style.height).toBe('400px')
    fakeScrollHeight = 60
    rerender(<AutoTextarea readOnly value="short" />)
    expect(ta().style.height).toBe('60px')
  })

  it('re-measures when the value changes from outside, not just on typing', () => {
    // A re-run of the summariser replaces the draft wholesale. Sizing only in
    // onChange would leave the new text in the old box's height.
    fakeScrollHeight = 100
    const { rerender } = render(<AutoTextarea readOnly value="first draft" />)
    fakeScrollHeight = 300
    rerender(<AutoTextarea readOnly value="second, much longer draft" />)
    expect(ta().style.height).toBe('300px')
  })

  it('caps its height so a long transcript cannot push the page away', () => {
    fakeScrollHeight = 5000
    render(<AutoTextarea readOnly value="forty minutes of debrief" maxHeight="60vh" />)
    expect(ta().style.maxHeight).toBe('60vh')
    expect(ta().style.overflowY).toBe('auto')
  })

  it('keeps the caller’s own styling', () => {
    fakeScrollHeight = 50
    render(<AutoTextarea readOnly value="x" style={{ background: 'rgb(10, 25, 41)', fontSize: 13 }} />)
    expect(ta().style.background).toBe('rgb(10, 25, 41)')
    expect(ta().style.fontSize).toBe('13px')
  })

  it('still behaves as a textarea', () => {
    fakeScrollHeight = 50
    const onChange = vi.fn()
    render(<AutoTextarea value="x" onChange={onChange} />)
    fireEvent.change(ta(), { target: { value: 'xy' } })
    expect(onChange).toHaveBeenCalled()
  })
})
