// jsdom has no canvas 2D context and no layout, so both are stubbed. What is
// NOT stubbed is the thing worth testing: that a wheel zooms about the cursor,
// a drag pans, Fit comes back, and none of it runs off the edge.

import React from 'react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PhotoCanvas from '../photos/PhotoCanvas'

const VIEW = { w: 900, h: 700 }          // CSS box; dpr is forced to 1 below
const IMG = { w: 4000, h: 6000 }         // a 24 MP frame

beforeAll(() => {
  // @ts-expect-error jsdom has no ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0, top: 0, width: VIEW.w, height: VIEW.h,
    right: VIEW.w, bottom: VIEW.h, x: 0, y: 0, toJSON: () => ({}),
  })) as never
})

const canvas = () => screen.getByTestId('photo-canvas') as HTMLCanvasElement
const pct = () => Number(screen.getByTestId('photo-detail-pct').textContent!.replace('%', ''))

function mount() {
  const source = document.createElement('canvas')
  source.width = IMG.w; source.height = IMG.h
  const r = render(<PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" />)
  // the backing store the component sizes itself to
  Object.defineProperty(canvas(), 'width', { value: VIEW.w, configurable: true })
  Object.defineProperty(canvas(), 'height', { value: VIEW.h, configurable: true })
  return r
}

/** Wheel is bound with addEventListener, not React, so dispatch it natively. */
const wheel = (x: number, y: number, deltaY: number) =>
  fireEvent(canvas(), new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, bubbles: true, cancelable: true }))

const drag = (from: [number, number], to: [number, number]) => {
  const c = canvas()
  fireEvent(c, new MouseEvent('pointerdown', { clientX: from[0], clientY: from[1], bubbles: true }))
  fireEvent(c, new MouseEvent('pointermove', { clientX: to[0], clientY: to[1], bubbles: true }))
  fireEvent(c, new MouseEvent('pointerup', { clientX: to[0], clientY: to[1], bubbles: true }))
}

describe('PhotoCanvas', () => {
  it('opens fitted, which on a 24 MP frame is about a tenth of the detail', () => {
    mount()
    // fit = 700/6000 ⇒ ~12 %
    expect(pct()).toBe(Math.round((VIEW.h / IMG.h) * 100))
    expect(pct()).toBeLessThan(15)
  })

  it('zooms in on the wheel and back out again', () => {
    mount()
    const fit = pct()
    wheel(450, 350, -100)
    const zoomed = pct()
    expect(zoomed).toBeGreaterThan(fit)
    wheel(450, 350, 100)
    expect(pct()).toBe(fit)
  })

  it('will not zoom out past the fit', () => {
    mount()
    const fit = pct()
    for (let i = 0; i < 10; i++) wheel(450, 350, 100)
    expect(pct()).toBe(fit)
  })

  it('reaches 1:1 and stops at the ceiling', () => {
    mount()
    for (let i = 0; i < 40; i++) wheel(450, 350, -100)
    expect(pct()).toBe(400)          // the 4:1 ceiling from photoViewport
  })

  it('Fit comes back from anywhere', () => {
    mount()
    const fit = pct()
    for (let i = 0; i < 6; i++) wheel(200, 120, -100)
    drag([400, 300], [700, 500])
    expect(pct()).toBeGreaterThan(fit)
    fireEvent.click(screen.getByText('Fit'))
    expect(pct()).toBe(fit)
  })

  it('the buttons zoom too', () => {
    mount()
    const fit = pct()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(pct()).toBeGreaterThan(fit)
    fireEvent.click(screen.getByLabelText('Zoom out'))
    expect(pct()).toBe(fit)
  })

  it('double-click toggles between fit and close up', () => {
    mount()
    const fit = pct()
    fireEvent.doubleClick(canvas(), { clientX: 300, clientY: 200 })
    expect(pct()).toBeGreaterThan(fit)
    fireEvent.doubleClick(canvas(), { clientX: 300, clientY: 200 })
    expect(pct()).toBe(fit)
  })

  it('says nothing and does nothing before a picture arrives', () => {
    render(<PhotoCanvas source={null} sourceSize={null} resetKey="none" />)
    expect(screen.queryByTestId('photo-detail-pct')).toBeNull()
    expect(screen.queryByText('Fit')).toBeNull()
    // and driving it does not throw
    expect(() => {
      fireEvent(screen.getByTestId('photo-canvas'), new MouseEvent('pointerdown', { clientX: 1, clientY: 1, bubbles: true }))
      fireEvent.doubleClick(screen.getByTestId('photo-canvas'), { clientX: 1, clientY: 1 })
    }).not.toThrow()
  })

  it('tells the same three-stage story the video player does', () => {
    const { rerender } = mount()
    const source = document.createElement('canvas')
    expect(screen.queryByText(/loading full resolution/)).toBeNull()

    rerender(<PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" fullStatus="loading" />)
    expect(screen.getByText(/loading full resolution/)).toBeTruthy()
    expect(screen.queryByText(/Still loading/)).toBeNull()      // not yet — it is not slow yet

    rerender(<PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" fullStatus="slow" />)
    expect(screen.getByText(/Still loading/)).toBeTruthy()

    rerender(<PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" fullStatus="missing" />)
    expect(screen.getByText('Thumbnail only')).toBeTruthy()
    expect(screen.queryByText(/loading full resolution/)).toBeNull()
  })

  it('offers a retry once waiting has turned into a problem, not before', () => {
    const onRetryFull = vi.fn()
    const source = document.createElement('canvas')
    const { rerender } = render(
      <PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" fullStatus="loading" onRetryFull={onRetryFull} />)
    expect(screen.queryByText('Try again')).toBeNull()

    rerender(<PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" fullStatus="slow" onRetryFull={onRetryFull} />)
    fireEvent.click(screen.getByText('Try again'))
    expect(onRetryFull).toHaveBeenCalledTimes(1)

    rerender(<PhotoCanvas source={source} sourceSize={IMG} resetKey="p1" fullStatus="missing" onRetryFull={onRetryFull} />)
    fireEvent.click(screen.getByText('Try again'))
    expect(onRetryFull).toHaveBeenCalledTimes(2)
  })
})
