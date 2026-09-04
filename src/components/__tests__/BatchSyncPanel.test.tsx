import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BatchSyncPanel } from '../SmartSailingAnalytics_UI'

// Two clips on this device, one already uploaded.
const videos = [
  { id: 'a', hasLocalBlob: true, hasProxy: false, hasOriginal: true },
  { id: 'b', hasLocalBlob: true, hasProxy: false, hasOriginal: false },
]
const setWidth = (w: number) => { (window as any).innerWidth = w; }

// jsdom has no matchMedia; useIsMobile's resize handler calls it.
const mockMatchMedia = (w: number) => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: /max-width:\s*767/.test(q) ? w < 768 : false,
  media: q, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
}))
const setup = (w: number) => { setWidth(w); mockMatchMedia(w) }

beforeEach(() => { setup(1440); vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' }) })

describe('cloud sync panel wording', () => {
  it('does NOT call an imported file an HD original on desktop', () => {
    // The confusion this fixes: with a pre-compressed workflow the file being
    // uploaded IS the 720p proxy, so a purple "Originals · HD" bar advancing
    // beside the per-file progress read as a second, full-resolution upload
    // running in parallel. It never was — the bar is a completion count.
    render(<BatchSyncPanel videos={videos} syncState={null} onSyncProxies={() => {}} onUploadOriginals={() => {}} />)
    expect(screen.queryByText(/Originals · HD/)).toBeNull()
    expect(screen.getByText(/the file you imported/)).toBeTruthy()
  })

  it('keeps the proxy/original distinction on mobile, where it is real', () => {
    setup(400)
    render(<BatchSyncPanel videos={videos} syncState={null} onSyncProxies={() => {}} onUploadOriginals={() => {}} />)
    expect(screen.getByText(/Originals · HD/)).toBeTruthy()
    expect(screen.getByText(/Proxies · 720p/)).toBeTruthy()
  })

  it('counts only clips whose source is on this device', () => {
    render(<BatchSyncPanel
      videos={[...videos, { id: 'c', hasLocalBlob: false, hasOriginal: false }]}
      syncState={null} onSyncProxies={() => {}} onUploadOriginals={() => {}} />)
    expect(screen.getByText('1/2')).toBeTruthy()   // not 1/3
  })

  it('says clips, not originals, on the desktop button', () => {
    render(<BatchSyncPanel videos={videos} syncState={null} onSyncProxies={() => {}} onUploadOriginals={() => {}} />)
    expect(screen.getByText(/Upload 1 clip/)).toBeTruthy()
  })

  it('explains that the bar is a count and nothing uploads twice', () => {
    render(<BatchSyncPanel videos={videos} syncState={null} onSyncProxies={() => {}} onUploadOriginals={() => {}} />)
    expect(screen.getByText(/not compressed or uploaded twice/)).toBeTruthy()
  })
})
