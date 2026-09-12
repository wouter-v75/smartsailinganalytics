import { describe, it, expect, vi } from 'vitest'
import { shareMessage, shareSubject, whatsappUrl, smsUrl, mailtoUrl, canNativeShare, nativeShare, instagramUrl } from '../shareTargets'

const subj = { title: 'R1 start', url: 'https://ssa.wvsailing.co.uk/share/abc123', from: 'Northstar 76' }

describe('share message', () => {
  it('names the clip and the boat, then the link', () => {
    expect(shareMessage(subj)).toBe('Northstar 76: R1 start\nhttps://ssa.wvsailing.co.uk/share/abc123')
    expect(shareSubject(subj)).toBe('Northstar 76 — R1 start')
  })
  it('copes with a clip that has no title and no boat', () => {
    expect(shareMessage({ url: 'https://x/share/t' })).toBe('a clip\nhttps://x/share/t')
  })
})

describe('deep links', () => {
  it('encodes the message once, keeping the link intact', () => {
    const wa = whatsappUrl(subj)
    expect(wa.startsWith('https://wa.me/?text=')).toBe(true)
    expect(decodeURIComponent(wa.split('text=')[1])).toBe(shareMessage(subj))
    expect(wa).not.toContain('%2520')          // no double encoding
  })
  it('uses the sms spelling both iOS and Android accept', () => {
    expect(smsUrl(subj).startsWith('sms:?&body=')).toBe(true)
    expect(decodeURIComponent(smsUrl(subj).split('body=')[1])).toContain(subj.url)
  })
  it('puts a subject and a body in the mail link', () => {
    const m = mailtoUrl(subj)
    expect(decodeURIComponent(m.split('subject=')[1].split('&body=')[0])).toBe(shareSubject(subj))
    expect(decodeURIComponent(m.split('&body=')[1])).toBe(shareMessage(subj))
  })
})

describe('instagram', () => {
  it('opens the app on a phone and the website on a desktop — it takes no link either way', () => {
    expect(instagramUrl('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toBe('instagram://app')
    expect(instagramUrl('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('instagram://app')
    expect(instagramUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('https://www.instagram.com/')
    expect(instagramUrl(null)).toBe('https://www.instagram.com/')
  })
})

describe('native sheet', () => {
  it('is offered only when the browser has one', () => {
    expect(canNativeShare({ share: () => {} })).toBe(true)
    expect(canNativeShare({})).toBe(false)
    expect(canNativeShare(null)).toBe(false)
  })
  it('passes the link to the sheet', async () => {
    const share = vi.fn(async () => {})
    expect(await nativeShare(subj, { share } as unknown as Navigator)).toBe(true)
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: subj.url }))
  })
  it('reports false when the viewer dismisses it, so the buttons stay usable', async () => {
    const share = vi.fn(async () => { throw new Error('AbortError') })
    expect(await nativeShare(subj, { share } as unknown as Navigator)).toBe(false)
  })
})
