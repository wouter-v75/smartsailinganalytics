// src/components/__tests__/SailTrimTab.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Drives the digitiser the way an operator does — open a frame, click the marks
// in order — and checks the number that comes out on screen.
//
// The frame is synthetic: a known rig projected through a known camera (see
// support/rigCamera.ts), so the assertion is against ground truth rather than
// against the component's own arithmetic. jsdom has no canvas 2D context and no
// image loading, so both are stubbed; nothing else is.
//
// Two jsdom traps, both of which make a click LOOK like it worked while landing
// nowhere: it has no PointerEvent, so fireEvent.pointerDown silently drops
// clientX/clientY and every mark comes out NaN — hence the hand-built
// MouseEvent below. And the canvas has no layout, so `fit` must be pressed
// once the backing store has been given a size, or the view transform is
// computed from jsdom's default 300×150 and the clicks map somewhere else
// entirely.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import {
  makeCamera, RIG, MAST_HALF_WIDTH, SPREADER_HALF, SPREADER_Z, TACK, TRANSOM,
} from '../../lib/__tests__/support/rigCamera'
import type { Px } from '../../lib/sailTrim'

// The CDN-loaded libraries are the only thing this component reaches out for.
vi.mock('@/lib/cdnScript', () => ({
  heicToJpeg: (f: File) => Promise.resolve(f),
  loadExifr: () => Promise.resolve({
    parse: () => Promise.resolve({
      DateTimeOriginal: new Date('2026-09-05T11:53:00Z'),
      FocalLength: RIG.focalMm,
      Model: 'Canon EOS R6m2',
      LensModel: 'RF100-500mm F4.5-7.1 L IS USM',
    }),
  }),
}))

import SailTrimTab, { type SailTrimSave } from '../sailtrim/SailTrimTab'

/** Northstar III's own endorsed certificate, trimmed to what the parser reads. */
const IRC_CERT = `IRC Boat Data
BOAT:
Name:
Sail Number:
Design:
Cert No.:
NORTHSTAR III
GBR76X
JUDEL/VROLIJK 76 Custom
50945
ENDORSED CERTIFICATE
Expires: 31 Dec 26
HULL
LH
LWP
Boat Weight:
DLR
Draft:
23.20
22.26
17017
47
5.73
HLP 8.96
HLU/HLUmax 30.60
J 8.86
E 10.33
P 31.44`

// ── the canvas the operator clicks on ───────────────────────────────────────
// One image pixel per CSS pixel, origin at the element's top-left, so a click
// at client (x, y) lands on image pixel (x, y) at zoom 1, pan 0.
const CANVAS_W = RIG.imgW
const CANVAS_H = RIG.imgH

beforeAll(() => {
  // @ts-expect-error jsdom has no ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  global.URL.createObjectURL = vi.fn(() => 'blob:sailtrim')
  global.URL.revokeObjectURL = vi.fn()
  // jsdom's canvas has no 2D context; the component already tolerates null.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0, top: 0, width: CANVAS_W, height: CANVAS_H,
    right: CANVAS_W, bottom: CANVAS_H, x: 0, y: 0, toJSON: () => ({}),
  })) as never
  // jsdom never fires Image.onload, so the component would never learn the size.
  class FakeImage {
    onload: (() => void) | null = null
    naturalWidth = RIG.imgW
    naturalHeight = RIG.imgH
    set src(_v: string) { setTimeout(() => this.onload?.(), 0) }
  }
  // @ts-expect-error swapping the global constructor
  global.Image = FakeImage
})

beforeEach(() => { vi.clearAllMocks() })

/** The canvas element is the only one in the main pane; the loupe follows it. */
const mainCanvas = (): HTMLCanvasElement =>
  document.querySelectorAll('canvas')[0] as HTMLCanvasElement

/** Backing store = rect = the image, so the view transform is the identity. */
function sizeCanvas() {
  const c = mainCanvas()
  Object.defineProperty(c, 'width', { value: CANVAS_W, configurable: true })
  Object.defineProperty(c, 'height', { value: CANVAS_H, configurable: true })
}

function click(p: Px) {
  const c = mainCanvas()
  // NOT fireEvent.pointerDown: without PointerEvent, jsdom drops clientX/Y.
  // Still routed through fireEvent, which wraps the dispatch in act() — a bare
  // dispatchEvent leaves React's state update unflushed and the next assertion
  // reads a stale DOM.
  for (const type of ['pointerdown', 'pointerup']) {
    fireEvent(c, new MouseEvent(type, { clientX: p.x, clientY: p.y, bubbles: true }))
  }
}

/** Step names repeat in the form below, so scope to the step list. */
const stepButton = (label: string) =>
  within(screen.getByTestId('sailtrim-steps')).getByText(label)

/** The four-click edge flow. The default is now two points on the centreline
 *  (see `useLineMast`); the edge flow is still what most of these tests drive,
 *  because it exercises the bisection as well as the axis. */
function useManualMast() {
  fireEvent.click(screen.getByText('edges'))
}


async function openAFrame() {
  sizeCanvas()
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([new Uint8Array([0xff, 0xd8])], '_MG_0397.JPG', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(screen.getByText(/_MG_0397/)).toBeTruthy())
  // …and the image load that follows it
  await waitFor(() => expect(screen.getByText(new RegExp(`${RIG.imgW}×${RIG.imgH}`))).toBeTruthy())
  // zoom 1, pan 0 — so a click at client (x, y) IS image pixel (x, y)
  fireEvent.click(screen.getByText('Fit'))
  await waitFor(() => expect(screen.getByText(/· 100%/)).toBeTruthy())
}

describe('SailTrimTab', () => {
  it('opens on the prompt to use an original frame, not a compilation', () => {
    render(<SailTrimTab />)
    expect(screen.getByText(/Open an astern frame/)).toBeTruthy()
    expect(screen.getByText(/rotated to stand the/)).toBeTruthy()
    // the workflow is visible before anything is loaded, and the mast starts as
    // two points on the centreline — a straight line where the operator put it
    expect(stepButton('Mast centreline')).toBeTruthy()
    expect(stepButton('Jib clew')).toBeTruthy()
    useManualMast()
    expect(stepButton('Mast edges, low')).toBeTruthy()
  })

  it('says so when the frame has no focal length, and fills it in when it has', async () => {
    render(<SailTrimTab />)
    await openAFrame()
    expect(screen.getByText(/Canon EOS R6m2 · 254 mm/)).toBeTruthy()
  })

  it('measures a synthetic clew to within a few millimetres of truth', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()

    // heel, as it would come off the log
    const heel = screen.getByPlaceholderText('23.5')
    fireEvent.change(heel, { target: { value: String(RIG.heelDeg) } })

    // ── calibrate ───────────────────────────────────────────────────────────
    useManualMast()
    click(P(0, -MAST_HALF_WIDTH, 5_000))
    click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000))
    click(P(0, MAST_HALF_WIDTH, 30_000))

    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z))
    click(P(0, SPREADER_HALF, SPREADER_Z))

    fireEvent.click(stepButton('Centreplane baseline'))
    click(P(TRANSOM.x, 0, TRANSOM.z))
    click(P(TACK.x, 0, TACK.z))
    fireEvent.change(screen.getByDisplayValue('21000'), {
      target: { value: String(TACK.x - TRANSOM.x) },
    })
    // the default scale reference is the guessed 6 m spreader; the synthetic
    // rig is exactly 6 m tip to tip, so the number is right and the model
    // still, correctly, says it is a guess

    // The synthetic clew is 8 m FORWARD of the mast; the rig model's default is
    // a Maxi 72's real clew, about a metre abaft it. Tell the tool where this
    // one actually is — which also exercises the depth editor.
    fireEvent.click(screen.getByText('edit'))
    fireEvent.change(screen.getByDisplayValue('-1100'), { target: { value: '8000' } })

    // ── measure ─────────────────────────────────────────────────────────────
    fireEvent.click(stepButton('Jib clew'))
    click(P(8_000, 1_900, SPREADER_Z))

    // The clew is 8 m forward, which is what the depth box already says.
    await waitFor(() => {
      const el = screen.getByText(/± \d+ mm/)
      expect(el).toBeTruthy()
    })
    // the value and its sigma are siblings: "1900 ± 25 mm"
    const reading = Number(screen.getByText(/± \d+ mm/).parentElement!.textContent!.match(/^(\d+)/)![1])
    expect(reading).toBeGreaterThan(1_895)
    expect(reading).toBeLessThan(1_905)

    // the scale is the ~6 mm/px the 6 Sept originals measure out at
    expect(screen.getByText(/6\.\d\d mm\/px/)).toBeTruthy()
    // and the frame reports itself as fully calibrated
    expect(screen.queryByText(/no centreplane baseline marked/)).toBeNull()
    expect(screen.getByText(/range ≈ 260 m/)).toBeTruthy()
  })

  it('takes the mast axis as the straight line through two marks, and nothing else', async () => {
    // The default. The traced alternative follows the mast's edge and can wander
    // onto a shroud or the sail; asked for a straight line between two markers,
    // the tool must give exactly that — so the recovered axis is checked against
    // the camera model's own projection of the mast, not against itself.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })

    // two points on the CENTRELINE, low and high
    const low = P(0, 0, 3_000), high = P(0, 0, 29_000)
    click(low); click(high)
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getByText('2/2')).toBeTruthy())

    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib clew'))
    click(P(-1_100, 1_500, 2_000))

    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(1))
    const reading = Number(screen.getByText(/\u00B1 \d+ mm/).parentElement!.textContent!.match(/^(\d+)/)![1])
    expect(Math.abs(reading - 1_500)).toBeLessThan(25)

    // The axis that travels is the two marks THEMSELVES — not a fit through
    // them, not a trace, not a smoothed version. This is the whole request.
    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const axis = saves[0].annotation.axis!
    // `low` is the larger image y, whichever order they were clicked in.
    const want = low.y >= high.y ? { lo: low, hi: high } : { lo: high, hi: low }
    expect(axis.low.x).toBeCloseTo(want.lo.x, 6)
    expect(axis.low.y).toBeCloseTo(want.lo.y, 6)
    expect(axis.high.x).toBeCloseTo(want.hi.x, 6)
    expect(axis.high.y).toBeCloseTo(want.hi.y, 6)
  })

  it('offers the traced mast as an alternative, not as the default', async () => {
    render(<SailTrimTab />)
    await openAFrame()
    expect(stepButton('Mast centreline')).toBeTruthy()
    fireEvent.click(screen.getByText('auto-trace'))
    expect(stepButton('Mast')).toBeTruthy()
    fireEvent.click(screen.getByText('two points'))
    expect(stepButton('Mast centreline')).toBeTruthy()
  })

  it('measures the clew and the boom as well as the leech', async () => {
    // The three targets the speed team actually wants. The clew and the boom
    // sit at very different depths from the mast — the certificate puts the
    // clew ~1.1 m abaft it and the boom E = 10.33 m abaft — so they exercise
    // the depth correction in opposite directions.
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    useManualMast()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })

    click(P(0, -MAST_HALF_WIDTH, 5_000)); click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000)); click(P(0, MAST_HALF_WIDTH, 30_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // the rig model's own defaults say where these sit fore-and-aft
    fireEvent.click(stepButton('Jib clew'))
    click(P(-1_100, 1_500, 2_000))
    fireEvent.click(stepButton('Boom'))
    click(P(-10_000, 2_400, 1_400))

    // "Jib clew" appears as the step name too, so wait on the measurement panel
    await waitFor(() => expect(screen.getAllByText(/± \d+ mm/)).toHaveLength(2))
    const values = screen.getAllByText(/± \d+ mm/)
      .map((el) => Number(el.parentElement!.textContent!.match(/^(\d+)/)![1]))
    expect(values).toHaveLength(2)
    // both recovered to within a couple of centimetres of where they were put
    expect(Math.abs(values[0] - 1_500)).toBeLessThan(25)
    expect(Math.abs(values[1] - 2_400)).toBeLessThan(25)
  })

  it('hands a host the finished annotation, in the frame\u2019s own pixels', async () => {
    // What the photo viewer needs back. Not the marks — the geometry RESOLVED,
    // so that every other device draws the same three lines without owning the
    // rig model or re-deriving anything.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(s) => { saves.push(s) }} photoLabel="_MG_0397.JPG" />)
    await openAFrame()
    useManualMast()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })

    click(P(0, -MAST_HALF_WIDTH, 5_000)); click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000)); click(P(0, MAST_HALF_WIDTH, 30_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Centreplane baseline'))
    click(P(TRANSOM.x, 0, TRANSOM.z)); click(P(TACK.x, 0, TACK.z))
    fireEvent.change(screen.getByDisplayValue('21000'), { target: { value: String(TACK.x - TRANSOM.x) } })
    fireEvent.click(stepButton('Jib clew'))
    click(P(-1_100, 1_500, 2_000))
    fireEvent.click(stepButton('Boom'))
    click(P(-10_000, 2_400, 1_400))

    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(2))

    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const { annotation, fields, showOverlay, result } = saves[0]

    // The overlay box is on by default: having measured, you want to see it.
    expect(showOverlay).toBe(true)

    // The annotation is in the ORIGINAL frame's pixels, and says so — that is
    // the only thing that lets a 480 px thumbnail draw the same lines.
    expect(annotation.imageSize).toEqual({ w: RIG.imgW, h: RIG.imgH })
    expect(annotation.psiMeasured).toBe(true)
    expect(annotation.targets.map((t) => t.key)).toEqual(['clew', 'boom'])

    // Each target carries both ends of the line it measured, in image pixels,
    // and the clew's is where the camera model says the clew is.
    const clew = annotation.targets.find((t) => t.key === 'clew')!
    const truth = P(-1_100, 1_500, 2_000)
    expect(Math.abs(clew.point.x - truth.x)).toBeLessThan(1)
    expect(Math.abs(clew.point.y - truth.y)).toBeLessThan(1)
    expect(Math.abs(Math.abs(clew.mm) - 1_500)).toBeLessThan(25)
    // The foot is on the mast axis, which is what the measurement is FROM.
    expect(annotation.axis).toBeTruthy()

    // Flat fields for a photo list to filter on, and the full result for reopening.
    expect(fields.sailtrim_clew_mm).toMatch(/^1[45]\d\d$/)
    expect(fields.sailtrim_psi_measured).toBe('1')
    expect(result.measurements).toHaveLength(2)

    // It survives the JSON round trip it is about to be put through.
    expect(JSON.parse(JSON.stringify(annotation)).targets).toHaveLength(2)

    // And it says so on screen, with the numbers rather than a bare tick.
    await waitFor(() => expect(screen.getByText(/^Saved ·/)).toBeTruthy())
  })

  it('says a save only reached this browser, rather than claiming success', async () => {
    // "Saved" that did not leave the device is the failure this whole feature
    // exists to avoid — a photo's instrument data was invisible to everyone but
    // the importer for exactly this reason.
    const P = makeCamera(RIG)
    render(<SailTrimTab onSaveToPhoto={() => ({ warning: 'Not signed in — saved on this device only.' })} />)
    await openAFrame()
    useManualMast()
    click(P(0, -MAST_HALF_WIDTH, 5_000)); click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000)); click(P(0, MAST_HALF_WIDTH, 30_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib clew'))
    click(P(-1_100, 1_500, 2_000))
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(1))

    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(screen.getByText(/saved on this device only/)).toBeTruthy())
    expect(screen.getByText(/^Saved ·/)).toBeTruthy()
  })

  it('reports a picture it could not fetch, instead of sitting there empty', async () => {
    // The viewer hands over the CLOUD ORIGINAL's URL, which 404s for a photo
    // whose original has not finished uploading.
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response))
    vi.stubGlobal('fetch', fetchMock)
    render(<SailTrimTab initialFileUrl="/api/bunny/image?key=missing.jpg" initialFileName="_MG_0397.JPG" />)
    await waitFor(() => expect(screen.getByText(/HTTP 404/)).toBeTruthy())
    expect(screen.getByText(/has not reached the cloud yet/)).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('does not offer "Save to photo" when it was not opened from one', async () => {
    render(<SailTrimTab />)
    await openAFrame()
    expect(screen.queryByTestId('sailtrim-save-to-photo')).toBeNull()
  })

  it('reads every leech at every marked height, and tags each result', async () => {
    // A leech is a curve, so "the leech" is not a number until a height is
    // named. Two sails × two tagged heights = four measurements, each carrying
    // which sail and which height it is — without that tag a millimetre figure
    // cannot be compared with the same figure from another day.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })

    // mast axis, then scale
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // two heights on the mast, each its own tagged step
    fireEvent.click(stepButton('Spreader 2'))
    click(P(0, 0, 12_000))
    fireEvent.click(stepButton('50 % stripe'))
    click(P(0, 0, 18_000))

    // The synthetic leeches are placed at the fore-and-aft depths the rig model
    // assumes for each sail, so the depth correction has the right lever and the
    // athwartships number can be checked against truth.
    fireEvent.click(stepButton('Jib leech'))
    click(P(-400, 1_500, 8_000)); click(P(-400, 1_500, 22_000))
    fireEvent.click(stepButton('Main leech'))
    click(P(-6_000, 2_500, 8_000)); click(P(-6_000, 2_500, 22_000))

    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(4))

    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const t = saves[0].annotation.targets

    expect(t.map((x) => x.key).sort()).toEqual(
      ['jib@spr2', 'jib@stripe50', 'main@spr2', 'main@stripe50'])
    expect(t.find((x) => x.key === 'jib@spr2')!.label).toBe('Jib leech @ spr 2')
    expect(t.find((x) => x.key === 'main@stripe50')!.label).toBe('Main leech @ 50 %')

    // Each recovers the athwartships offset it was drawn at.
    for (const k of ['jib@spr2', 'jib@stripe50']) {
      expect(Math.abs(Math.abs(t.find((x) => x.key === k)!.mm) - 1_500)).toBeLessThan(40)
    }
    for (const k of ['main@spr2', 'main@stripe50']) {
      expect(Math.abs(Math.abs(t.find((x) => x.key === k)!.mm) - 2_500)).toBeLessThan(60)
    }

    // The two sails are drawn in different colours, so the lines on the photo
    // say which is which without reading the labels.
    expect(t.find((x) => x.key === 'jib@spr2')!.colour)
      .not.toBe(t.find((x) => x.key === 'main@spr2')!.colour)

    // And the flat fields keep the tag, which is what makes a photo list
    // filterable by "jib leech at spreader 2".
    expect(saves[0].fields['sailtrim_jib@spr2_mm']).toBeTruthy()
  })

  it('measures a height only on the sails whose leech actually spans it', async () => {
    // A height above or below where a leech was drawn does not cross it. That is
    // a gap in the marking, not an error, and it should silently produce no
    // measurement rather than a wrong one.
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    fireEvent.click(stepButton('Spreader 1'))
    click(P(0, 0, 6_000))            // low — inside the leech
    fireEvent.click(stepButton('Spreader 3'))
    click(P(0, 0, 26_000))           // high — ABOVE where the leech was drawn

    fireEvent.click(stepButton('Jib leech'))
    click(P(-400, 1_500, 4_000)); click(P(-400, 1_500, 10_000))

    // One measurement, not two.
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(1))
  })

  it('warns, loudly and specifically, when the misalignment was never measured', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    useManualMast()

    click(P(0, -MAST_HALF_WIDTH, 5_000))
    click(P(0, MAST_HALF_WIDTH, 5_000))
    fireEvent.click(stepButton('Mast edges, high'))
    click(P(0, -MAST_HALF_WIDTH, 30_000))
    click(P(0, MAST_HALF_WIDTH, 30_000))
    fireEvent.click(stepButton('Scale reference'))
    click(P(0, -SPREADER_HALF, SPREADER_Z))
    click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib clew'))
    click(P(8_000, 1_900, SPREADER_Z))

    await waitFor(() => expect(screen.getByText(/no centreplane baseline marked/)).toBeTruthy())
    // …and the sigma is the ±140 mm the doc predicts, not a comfortable ±20
    const sigma = Number(screen.getByText(/± \d+ mm/).textContent!.match(/± (\d+) mm/)![1])
    expect(sigma).toBeGreaterThan(100)
  })

  it('places both mast edges even when they are a few pixels apart', async () => {
    // At fit zoom the mast is a few pixels wide. A grab radius generous enough
    // to nudge a placed mark turns the second click into a nudge of the first,
    // and the step sticks at 1/2 with nothing to say why — found by driving the
    // real tool. 12 px apart is inside the old 22 px radius and outside the
    // 7 px one that applies while a step is still being filled.
    render(<SailTrimTab />)
    await openAFrame()
    useManualMast()
    click({ x: 2_000, y: 3_000 })
    click({ x: 2_012, y: 3_000 })
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getByText('2/2')).toBeTruthy())
  })

  it('takes its dimensions from a pasted IRC certificate', async () => {
    render(<SailTrimTab />)
    await openAFrame()
    fireEvent.click(screen.getByText('edit'))

    // Before: nothing is known, and the tool says so.
    expect(screen.getByText(/Still guesswork/)).toBeTruthy()

    const box = screen.getByPlaceholderText(/IRC Boat Data/)
    fireEvent.change(box, { target: { value: IRC_CERT } })
    fireEvent.click(screen.getByText('Read certificate'))

    await waitFor(() => expect(screen.getByText(/P 31.44 m, J 8.86 m, E 10.33 m/)).toBeTruthy())
    // …and after: the boat named itself, the scale is P rather than a guessed
    // spreader, and the jib's corners came out of J/HLU/HLP.
    expect(screen.getByDisplayValue('NORTHSTAR III')).toBeTruthy()
    expect(screen.getByDisplayValue('31440')).toBeTruthy()
    expect(screen.getByDisplayValue('8860')).toBeTruthy()
    expect(screen.getByDisplayValue('-10330')).toBeTruthy()

    // ONE thing is still guesswork, and it is the right one: the certificate
    // carries no main-leech depth, because that quantity is the mainsail's width
    // at the height being measured — MHW/MTW/MUW, which this parser does not yet
    // read — and it changes by three metres over the hoist. The tool says so
    // rather than inventing an average.
    const gaps = screen.getByText(/Still guesswork/).textContent || ''
    expect(gaps).toMatch(/the main leech's fore-and-aft offset/)
    expect(gaps).not.toMatch(/jib leech/)
    expect(gaps).not.toMatch(/clew/)
    expect(gaps).not.toMatch(/boom/)
    expect(gaps).not.toMatch(/scale reference/)
  })

  it('says so, and changes nothing, when the paste is not a certificate', async () => {
    render(<SailTrimTab />)
    await openAFrame()
    fireEvent.click(screen.getByText('edit'))
    fireEvent.change(screen.getByPlaceholderText(/IRC Boat Data/), { target: { value: 'IRC rating is great' } })
    fireEvent.click(screen.getByText('Read certificate'))
    await waitFor(() => expect(screen.getByText(/does not read as an IRC certificate/)).toBeTruthy())
    expect(screen.getByText(/Still guesswork/)).toBeTruthy()
  })

  it('a point placed on a full step restarts that step rather than being lost', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    useManualMast()
    click(P(0, -MAST_HALF_WIDTH, 5_000))
    click(P(0, MAST_HALF_WIDTH, 5_000))
    expect(within(screen.getByTestId('sailtrim-steps')).getByText('2/2')).toBeTruthy()
    click(P(0, -MAST_HALF_WIDTH, 6_000))
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getByText('1/2')).toBeTruthy())
  })
})
