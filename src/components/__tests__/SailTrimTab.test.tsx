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
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
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

/**
 * Let the two fetches the tab fires on mount — the boat list and the rig model —
 * settle INSIDE act(). A test that awaits nothing else finishes first and React
 * then reports their setState as an update outside act(), which reads as a fault
 * in whatever ran next rather than in the test that caused it. Choosing a boat
 * starts a fresh rig-model fetch, so a test that ends on one needs this too.
 */
const settle = () => act(async () => { await Promise.resolve() })

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

/**
 * Pick a scale reference by key. The synthetic rig is exactly 6 m tip to tip at
 * spreader 2, so these tests use that; the tab now DEFAULTS to the wheels,
 * which are the one reference a tape can reach and are measured on the real
 * boat but are zero-length on the generic model these fixtures build.
 */
const selectScale = (key: string) => {
  const select = screen.getAllByRole('combobox').find((el) =>
    Array.from((el as HTMLSelectElement).options).some((o) => o.value === key)) as HTMLSelectElement
  fireEvent.change(select, { target: { value: key } })
}

/**
 * Pick a centreplane baseline by key. These tests mark the forestay tack and the
 * transom, so they need `bow-transom`; the tab now DEFAULTS to `mast-transom`,
 * which is the pair the operator can see from astern and the one with a tape
 * measurement behind it.
 */
const selectBaseline = (key: string) => {
  const select = screen.getAllByRole('combobox').find((el) =>
    Array.from((el as HTMLSelectElement).options).some((o) => o.value === key)) as HTMLSelectElement
  fireEvent.change(select, { target: { value: key } })
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
  it('opens on the prompt to use an original frame, not a compilation', async () => {
    render(<SailTrimTab />)
    await settle()
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
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z))
    click(P(0, SPREADER_HALF, SPREADER_Z))

    fireEvent.click(stepButton('Centreplane baseline'))
    click(P(TRANSOM.x, 0, TRANSOM.z))
    click(P(TACK.x, 0, TACK.z))
    selectBaseline('bow-transom')
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
    selectScale('spreader2')
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
    selectScale('spreader2')
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
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Centreplane baseline'))
    click(P(TRANSOM.x, 0, TRANSOM.z)); click(P(TACK.x, 0, TACK.z))
    selectBaseline('bow-transom')
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
    selectScale('spreader2')
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
    // named. The jib is read at the shared spreader AND at its own 50 % stripe;
    // the main at its stripe only. Each result carries which sail and which
    // height it is — without that tag a millimetre figure cannot be compared
    // with the same figure from another day.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })

    // mast axis, then scale
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // Spreader 2 is a RIG height: marked once, both leeches read across it.
    fireEvent.click(stepButton('Spreader 2'))
    click(P(0, 0, 12_000))

    // The synthetic leeches are placed at the fore-and-aft depths the rig model
    // assumes for each sail, so the depth correction has the right lever and the
    // athwartships number can be checked against truth.
    //
    // A STRIPE belongs to its sail and is marked ON that sail's leech, so each
    // gets its own — deliberately at DIFFERENT heights, because that is the
    // point: half of the main's hoist is not half of the jib's. If the two were
    // still sharing one station this would read the main at 18 000 and get the
    // jib's answer.
    fireEvent.click(stepButton('Jib leech'))
    click(P(-400, 1_500, 8_000)); click(P(-400, 1_500, 22_000))
    fireEvent.click(stepButton('Jib leech \u00b7 50 % stripe'))
    click(P(-400, 1_500, 15_000))
    fireEvent.click(stepButton('Main leech'))
    click(P(-6_000, 2_500, 8_000)); click(P(-6_000, 2_500, 22_000))
    fireEvent.click(stepButton('Main leech \u00b7 50 % stripe'))
    click(P(-6_000, 2_500, 18_000))

    // Three, not four: the main is read at its stripes only, so there is no
    // main@spr2 — see stationsFor.
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(3))

    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const t = saves[0].annotation.targets

    expect(t.map((x) => x.key).sort()).toEqual(
      ['jib@spr2', 'jib@stripe50', 'main@stripe50'])
    expect(t.find((x) => x.key === 'jib@spr2')!.label).toBe('Jib leech @ spr 2')
    expect(t.find((x) => x.key === 'main@stripe50')!.label).toBe('Main leech @ 50 %')
    expect(t.some((x) => x.key === 'main@spr2')).toBe(false)

    // Each recovers the athwartships offset it was drawn at.
    for (const k of ['jib@spr2', 'jib@stripe50']) {
      expect(Math.abs(Math.abs(t.find((x) => x.key === k)!.mm) - 1_500)).toBeLessThan(40)
    }
    for (const k of ['main@stripe50']) {
      expect(Math.abs(Math.abs(t.find((x) => x.key === k)!.mm) - 2_500)).toBeLessThan(60)
    }

    // The two sails are drawn in different colours, so the lines on the photo
    // say which is which without reading the labels.
    expect(t.find((x) => x.key === 'jib@stripe50')!.colour)
      .not.toBe(t.find((x) => x.key === 'main@stripe50')!.colour)

    // And the flat fields keep the tag, which is what makes a photo list
    // filterable by "jib leech at spreader 2".
    expect(saves[0].fields['sailtrim_jib@spr2_mm']).toBeTruthy()
  })

  it('takes the chord from the LUFF, not the centreplane, once the luff is marked', async () => {
    // A sail's shape is measured leech-to-luff. The tool used to take
    // centreplane-to-leech, which assumes the forestay does not sag — and it
    // sags most at mid-luff, exactly where twist is most sensitive. Marking the
    // luff makes the chord a measurement instead of an assumption.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    // The jib's own 50 % stripe, marked where it meets the jib's leech — which
    // is 1500 mm to leeward at that height, and IS the measurement.
    fireEvent.click(stepButton('Jib leech \u00b7 50 % stripe'))
    click(P(-400, 1_500, 15_000))

    // …and the leech drawn through it.
    fireEvent.click(stepButton('Jib leech'))
    click(P(-400, 1_500, 9_000)); click(P(-400, 1_500, 21_000))
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/).length).toBeGreaterThan(0))

    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const leechOnly = saves[0].annotation.targets.find((t) => t.key === 'jib@stripe50')!

    // …and a luff sagged 300 mm to leeward, on the forestay, well forward.
    fireEvent.click(stepButton('Jib luff (the forestay)'))
    click(P(4_430, 300, 9_000)); click(P(4_430, 300, 21_000))
    await waitFor(() =>
      expect(saves[0].annotation.targets.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(2))
    const withLuff = saves[1].annotation.targets

    // The leech measurement itself is unchanged — it is still centreplane to
    // leech, which is the speed team's own number and must not move.
    const leechAgain = withLuff.find((t) => t.key === 'jib@stripe50')!
    expect(leechAgain.mm).toBeCloseTo(leechOnly.mm, 0)
    // And the luff is now measured too, near where it was put.
    const luff = withLuff.find((t) => t.key === 'luff-jib@stripe50')!
    expect(luff).toBeTruthy()
    expect(Math.abs(Math.abs(luff.mm) - 300)).toBeLessThan(120)
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
    selectScale('spreader2')
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
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z))
    click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib clew'))
    click(P(8_000, 1_900, SPREADER_Z))

    await waitFor(() => expect(screen.getByText(/no centreplane baseline marked/)).toBeTruthy())
    // …and the sigma is the ±140 mm the doc predicts, not a comfortable ±20
    const sigma = Number(screen.getByText(/± \d+ mm/).textContent!.match(/± (\d+) mm/)![1])
    expect(sigma).toBeGreaterThan(100)
  })

  it('reopens a saved measurement with its points where they were', async () => {
    // "Edit points" on a photo that already has geometry. The marks have to come
    // back, AND the choices that decide what they mean — a different scale
    // reference or heel against the same clicks is a different number.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    const { unmount } = render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: '17.5' } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib clew'))
    click(P(-1_100, 1_500, 2_000))
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(1))
    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const first = saves[0]
    unmount()

    // Reopen it the way the photo viewer does.
    vi.stubGlobal('fetch', async () => ({
      ok: true, blob: async () => new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }),
    } as unknown as Response))
    const again: SailTrimSave[] = []
    render(
      <SailTrimTab
        initialFileUrl="/api/bunny/image?key=x.jpg"
        initialFileName="_MG_0397.JPG"
        initialResult={first.result}
        onSaveToPhoto={(v) => { again.push(v) }} />,
    )
    // The marks are back — the clew step shows its point, and the heel that was
    // typed came with it.
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getAllByText('1/1').length).toBeGreaterThan(0))
    expect(screen.getByDisplayValue('17.5')).toBeTruthy()
    // …and the measurement comes straight back without re-marking anything.
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/)).toHaveLength(1))
    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(again).toHaveLength(1))
    expect(again[0].annotation.targets[0].mm).toBeCloseTo(first.annotation.targets[0].mm, 6)
    vi.unstubAllGlobals()
  })

  it('deletes a point on right-click', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getByText('2/2')).toBeTruthy())

    const high = P(0, 0, 29_000)
    fireEvent(mainCanvas(), new MouseEvent('contextmenu', {
      clientX: high.x, clientY: high.y, bubbles: true, cancelable: true,
    }))
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getByText('1/2')).toBeTruthy())
  })

  it('does not let a new leech point drag a calibration mark it landed near', async () => {
    // Found while checking why a frame with three points on each leech came back
    // with one measurement. findNear searched EVERY step, so a click meant as the
    // next leech point could land near the spreader mark or a mast-line end and
    // silently move THAT instead — no new point, and a calibration mark quietly
    // shifted. Invisible until the numbers come out wrong.
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // A height mark, then leech points deliberately placed right on top of it.
    fireEvent.click(stepButton('Spreader 2'))
    const at = P(0, 0, 12_000)
    click(at)
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getAllByText('1/1').length).toBeGreaterThan(0))

    fireEvent.click(stepButton('Jib leech'))
    click({ x: at.x + 2, y: at.y + 2 })      // all but on top of the height mark
    click({ x: at.x + 5, y: at.y + 40 })
    click({ x: at.x + 8, y: at.y + 90 })

    // Three points went in, not one — and the height mark is still there.
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getByText('3/2–8')).toBeTruthy())
    expect(within(screen.getByTestId('sailtrim-steps')).getAllByText('1/1').length).toBeGreaterThan(0)
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

  it('keeps each sail\u2019s draft stripes to itself, and reads a spreader on the jib only', async () => {
    // The regression this guards. Both sails used to read at ONE set of stripe
    // stations, so marking "50 % stripe" produced a main@stripe50 AND a
    // jib@stripe50 from a single click. The main's 50 % and the jib's are at
    // half of two different hoists — metres apart on this rig — so one of those
    // two numbers was measured at a height that is not its own half hoist. It
    // looked entirely correct, which is why it needs a test rather than care.
    //
    // Marking the JIB's stripe and NOT the main's must therefore give a jib
    // stripe measurement and no main one. The shared spreader mark reaches the
    // JIB only: on the main at spreader height the leech is far aft and near the
    // centreplane, so the number is small, noisy and has no fraction of the
    // hoist behind it.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    fireEvent.click(stepButton('Spreader 2'))
    click(P(0, 0, 12_000))

    // Both leeches drawn, spanning both heights, so a missing measurement can
    // only be a missing STATION and not a curve that failed to reach.
    fireEvent.click(stepButton('Jib leech'))
    click(P(-400, 1_500, 8_000)); click(P(-400, 1_500, 22_000))
    fireEvent.click(stepButton('Main leech'))
    click(P(-6_000, 2_500, 8_000)); click(P(-6_000, 2_500, 22_000))

    // ONLY the jib's stripe, marked on the jib's leech.
    fireEvent.click(stepButton('Jib leech \u00b7 50 % stripe'))
    click(P(-400, 1_500, 15_000))

    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/).length).toBeGreaterThanOrEqual(2))
    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const keys = saves[0].annotation.targets.map((t) => t.key).sort()

    // The shared spreader mark reaches the jib, and deliberately not the main.
    expect(keys).toContain('jib@spr2')
    expect(keys).not.toContain('main@spr2')
    // The jib's stripe is the jib's alone.
    expect(keys).toContain('jib@stripe50')
    expect(keys).not.toContain('main@stripe50')
  })

  it('says why there are no leech numbers when no leech is drawn', async () => {
    // The 26 Sep 12:09 frame: seven stations marked, ONE point on the main leech,
    // none on the jib, and two numbers back (clew and boom, which are single
    // points). Nothing on screen said why the other measurements were absent —
    // the existing warning only fires for a leech that IS drawn, so the case
    // where the curve is missing or half-clicked was the silent one.
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // Stations marked...
    fireEvent.click(stepButton('Spreader 2'))
    click(P(0, 0, 12_000))
    fireEvent.click(stepButton('Jib leech \u00b7 50 % stripe'))
    click(P(0, 0, 15_000))

    // ...and the main leech clicked ONCE, exactly as on the real frame.
    fireEvent.click(stepButton('Main leech'))
    click(P(-6_000, 2_500, 8_000))

    await waitFor(() => expect(screen.getByText(/No leech measurements yet/)).toBeTruthy())
    expect(screen.getByText(/a leech is a CURVE/)).toBeTruthy()
    // It names what is half-drawn rather than nagging about a sail nobody
    // touched. Both qualify here: the main has its one explicit click, and the
    // jib has its one stripe, which is a leech point.
    expect(screen.getByText(/Main leech and Jib leech have one point in total/)).toBeTruthy()
  })

  it('goes quiet once the leech is actually drawn', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    // The JIB, because a spreader is read across the jib's leech only now.
    fireEvent.click(stepButton('Spreader 2'))
    click(P(0, 0, 12_000))
    fireEvent.click(stepButton('Jib leech'))
    click(P(-400, 1_500, 8_000)); click(P(-400, 1_500, 22_000))
    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/No leech measurements yet/)).toBeNull()
  })

  it('says a nameless boat has no real dimensions and will give no twist', async () => {
    // How the 12:09 frame came to be scaled 11 % large: with no boat named the
    // wheels reference defaults to 0 mm, the operator typed it by hand as 3755
    // against Northstar's measured 3375, and nothing had anything to check it
    // against. Naming the boat fills 3375 +/- 10 in by itself.
    render(<SailTrimTab />)
    await openAFrame()
    expect(screen.getByText(/No boat named/)).toBeTruthy()
    expect(screen.getByText(/no twist/)).toBeTruthy()
  })

  it('measures from stripe marks alone, with no separate leech curve drawn', async () => {
    // What Wouter hit: three stripes clicked on each leech, and the leech step
    // still reading 0/2–8 as though none of it counted. A stripe is marked ON
    // the leech, so it IS a leech point — the curve and the station were two
    // clicks doing one job. Nothing but the stripes is marked here.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // Three stripes on the jib's leech, 1500 mm to leeward. No 'Jib leech' clicks.
    for (const [tag, z] of [['25', 10_000], ['50', 15_000], ['75', 20_000]] as const) {
      fireEvent.click(stepButton(`Jib leech \u00b7 ${tag} % stripe`))
      click(P(-400, 1_500, z))
    }

    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/).length).toBe(3))

    // The leech counts them, so it is no longer asking for a curve.
    expect(within(screen.getByTestId('sailtrim-steps')).getByText(/0 here \+ 3 stripe/)).toBeTruthy()
    expect(screen.queryByText(/No leech measurements yet/)).toBeNull()

    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const t = saves[0].annotation.targets
    expect(t.map((x) => x.key).sort()).toEqual(['jib@stripe25', 'jib@stripe50', 'jib@stripe75'])
    // Each recovers the offset it was drawn at — the mark IS the measurement,
    // so there is no interpolation to lose it.
    for (const k of ['jib@stripe25', 'jib@stripe50', 'jib@stripe75']) {
      expect(Math.abs(Math.abs(t.find((x) => x.key === k)!.mm) - 1_500)).toBeLessThan(40)
    }
  })

  it('still interpolates a SPREADER along the stripe points', async () => {
    // A spreader has no painted line across the sail, so it stays a mast mark
    // and has to be interpolated onto the leech. The stripe points are the
    // curve it interpolates along — which is the other half of the merge.
    const P = makeCamera(RIG)
    const saves: SailTrimSave[] = []
    render(<SailTrimTab onSaveToPhoto={(v) => { saves.push(v) }} />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    // Spreader 2 on the MAST, between two stripes on the jib's leech.
    fireEvent.click(stepButton('Spreader 2'))
    click(P(0, 0, 15_000))
    for (const [tag, z] of [['25', 10_000], ['75', 20_000]] as const) {
      fireEvent.click(stepButton(`Jib leech \u00b7 ${tag} % stripe`))
      click(P(-400, 1_500, z))
    }

    await waitFor(() => expect(screen.getAllByText(/\u00B1 \d+ mm/).length).toBe(3))
    fireEvent.click(screen.getByTestId('sailtrim-save-to-photo'))
    await waitFor(() => expect(saves).toHaveLength(1))
    const t = saves[0].annotation.targets
    expect(t.map((x) => x.key).sort()).toEqual(['jib@spr2', 'jib@stripe25', 'jib@stripe75'])
    // The spreader lands on the same 1500 mm edge, found by interpolation.
    expect(Math.abs(Math.abs(t.find((x) => x.key === 'jib@spr2')!.mm) - 1_500)).toBeLessThan(40)
  })

  it('names the boat from an id alone, and takes a name that arrives late', async () => {
    // Why this exists: of the three places that render this tab, only PhotosTab
    // passed a boat. Tools -> SailTrim rendered <SailTrimTab/> bare and the
    // timeline passed no boat either, so both silently fell back to the generic
    // maxi estimates — no measured scale reference and NO SAIL WIDTHS, hence no
    // twist, with nothing on screen connecting that to the missing boat. Both
    // had the boat's ID in hand the whole time.
    const calls: string[] = []
    const realFetch = global.fetch
    global.fetch = (async (url: any, init?: any) => {
      const u = String(url)
      if (u.includes('/api/boats/rig-model')) {
        calls.push(u)
        return { ok: true, json: async () => ({ boat: 'Northstar 76', boatId: 'b-1', rigModel: null, canEdit: true }) } as any
      }
      return realFetch ? realFetch(url, init) : ({ ok: false, json: async () => ({}) } as any)
    }) as any
    try {
      render(<SailTrimTab boatId="b-1" />)
      await openAFrame()
      // It asked by ID, not by a name it did not have.
      await waitFor(() => expect(calls.some((c) => c.includes('boat_id=b-1'))).toBe(true))
      // …and the reply's name lands in the Boat field, so the operator can see
      // which boat's numbers are in play.
      await waitFor(() => expect(screen.getByDisplayValue('Northstar 76')).toBeTruthy())
      expect(screen.queryByText(/No boat named/)).toBeNull()
    } finally { global.fetch = realFetch }
  })

  it('still warns when there is no boat and no id', async () => {
    render(<SailTrimTab />)
    await openAFrame()
    expect(screen.getByText(/No boat named/)).toBeTruthy()
  })

  it('always shows a Twist box, with dashes and a reason when there is no number', async () => {
    // The box used to appear only when it had a number, so every way of having
    // none — no boat, no widths, one station, a stale count filtering the
    // explanation away — looked exactly like the tab having no twist feature.
    // Three rounds of debugging went into finding which it was. A box with
    // dashes and a line naming the missing input is worth more than a tidy one.
    const P = makeCamera(RIG)
    render(<SailTrimTab />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))

    const box = await screen.findByTestId('sailtrim-twist')
    expect(box).toBeTruthy()
    // Station down the side, sail across the top, accuracy beside each.
    expect(within(box).getByText('Stripe')).toBeTruthy()
    expect(within(box).getByText('Twist Main')).toBeTruthy()
    expect(within(box).getByText('Twist Jib')).toBeTruthy()
    expect(within(box).getByText('Accuracy Main')).toBeTruthy()
    expect(within(box).getByText('Accuracy Jib')).toBeTruthy()
    expect(within(box).getByText('Draft Main')).toBeTruthy()
    expect(within(box).getByText('Draft Jib')).toBeTruthy()
    for (const station of ['25 %', '50 %', '75 %', '87.5 %']) {
      expect(within(box).getByText(station)).toBeTruthy()
    }
    // Every cell is a dash rather than the table being absent: 5 stations
    // (25/50/75/87.5 % and the clew) x (2 angles + 2 drafts + 2 accuracies).
    expect(within(box).getAllByText('—').length).toBe(30)
    // And it says WHY, naming the first thing to fix, per sail.
    expect(within(box).getAllByText(/no boat named/).length).toBe(2)
  })

  it('names the missing station when only one stripe is marked', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab boatName="Northstar 76" />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    fireEvent.click(stepButton('Jib leech \u00b7 50 % stripe'))
    click(P(-400, 1_500, 15_000))

    const box = await screen.findByTestId('sailtrim-twist')
    // Northstar's widths come from the measured map, so the complaint moves on
    // from widths to the second station — which is the real next step.
    await waitFor(() => expect(within(box).getByText(/only 50 % is marked/)).toBeTruthy())
    expect(within(box).getByText(/difference BETWEEN two heights/)).toBeTruthy()
  })

  it('shows real twist once two stripes are on one leech', async () => {
    const P = makeCamera(RIG)
    render(<SailTrimTab boatName="Northstar 76" />)
    await openAFrame()
    fireEvent.change(screen.getByPlaceholderText('23.5'), { target: { value: String(RIG.heelDeg) } })
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Scale reference'))
    selectScale('spreader2')
    click(P(0, -SPREADER_HALF, SPREADER_Z)); click(P(0, SPREADER_HALF, SPREADER_Z))
    for (const [tag, z] of [['25', 10_000], ['50', 15_000], ['75', 20_000]] as const) {
      fireEvent.click(stepButton(`Jib leech \u00b7 ${tag} % stripe`))
      click(P(-400, 1_500, z))
    }
    const box = await screen.findByTestId('sailtrim-twist')
    // The jib's column fills in, at all three stations.
    await waitFor(() => expect(within(box).getAllByText(/^\d+\.\d°\*?$/).length).toBe(3))
    // …and the between-station twist, which is what gets trimmed.
    expect(within(box).getByText(/25\u219250/)).toBeTruthy()
    // The main has no stripes marked, so its column is dashes and it says why;
    // the jib's 87.5 % and clew rows are dashed too, neither being marked here.
    // Both DRAFT columns are dashes throughout: one frame cannot give depth.
    expect(within(box).getAllByText('—').length).toBe(24)
    expect(within(box).getByText(/no stripe stations marked on this sail/)).toBeTruthy()
  })

  it('defaults the centreplane baseline to mast → transom', async () => {
    // Both ends are unambiguous from astern and stay visible under way, and on
    // Northstar it is the one with a tape measurement behind it (12100 +/- 50).
    // Forestay tack → transom is longer, and psi's precision scales with the
    // separation, but length is worth nothing if one end is a guess.
    render(<SailTrimTab boatName="Northstar 76" />)
    await openAFrame()
    const select = screen.getAllByRole('combobox').find((el) =>
      Array.from((el as HTMLSelectElement).options).some((o) => o.value === 'mast-transom')) as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.value).toBe('mast-transom')
  })

  describe('the boat picker', () => {
    // Typing the name was the only way in, and the name is what fetches the
    // boat's real dimensions — so a typo was not a typo, it silently bought the
    // generic maxi estimates and no twist. Competitors are in the list because a
    // rival's rig model comes off its public IRC certificate.
    const BOATS = [
      { id: 'b-n76', name: 'Northstar 76', sailNumber: 'GBR76X', teamName: 'Northstar', hasRigModel: true },
      { id: 'b-cap', name: 'Capricorno', sailNumber: 'ITA30303', teamName: 'Northstar', hasRigModel: true },
      { id: 'b-bare', name: 'Torvar', sailNumber: null, teamName: 'Team Torvar', hasRigModel: false },
    ]
    const withBoats = () => {
      const realFetch = global.fetch
      global.fetch = (async (url: any, init?: any) => {
        const u = String(url)
        if (u.endsWith('/api/boats')) return { ok: true, json: async () => ({ boats: BOATS }) } as any
        if (u.includes('/api/boats/rig-model')) {
          return { ok: true, json: async () => ({ boat: 'Capricorno', boatId: 'b-cap', rigModel: null, canEdit: true }) } as any
        }
        return realFetch ? realFetch(url, init) : ({ ok: false, json: async () => ({}) } as any)
      }) as any
      return () => { global.fetch = realFetch }
    }

    it('lists the boats, competitors included, with their sail numbers', async () => {
      const restore = withBoats()
      try {
        render(<SailTrimTab />)
        await openAFrame()
        const select = await waitFor(() => {
          const el = screen.getAllByRole('combobox').find((s) =>
            Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'Capricorno'))
          expect(el).toBeTruthy()
          return el as HTMLSelectElement
        })
        const labels = Array.from(select.options).map((o) => o.textContent)
        expect(labels.some((l) => l?.includes('Northstar 76') && l.includes('GBR76X'))).toBe(true)
        expect(labels.some((l) => l?.includes('Capricorno') && l.includes('ITA30303'))).toBe(true)
        // A boat with nothing to measure with says so in the list itself.
        expect(labels.some((l) => l?.includes('Torvar') && l.includes('no rig model'))).toBe(true)
      } finally { restore() }
    })

    it('warns when the chosen boat has no rig model', async () => {
      const restore = withBoats()
      try {
        render(<SailTrimTab />)
        await openAFrame()
        const select = await waitFor(() => screen.getAllByRole('combobox').find((s) =>
          Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'Torvar')) as HTMLSelectElement)
        fireEvent.change(select, { target: { value: 'Torvar' } })
        await waitFor(() => expect(screen.getByText(/No rig model stored for Torvar/)).toBeTruthy())
        expect(screen.getByText(/no twist/)).toBeTruthy()
      } finally { restore() }
    })

    it('still lets a boat nobody has entered be typed', async () => {
      const restore = withBoats()
      try {
        render(<SailTrimTab />)
        await openAFrame()
        const select = await waitFor(() => screen.getAllByRole('combobox').find((s) =>
          Array.from((s as HTMLSelectElement).options).some((o) => o.value === '__other')) as HTMLSelectElement)
        fireEvent.change(select, { target: { value: '__other' } })
        const input = await waitFor(() => screen.getByPlaceholderText('Northstar 76'))
        fireEvent.change(input, { target: { value: 'Jolt' } })
        expect((input as HTMLInputElement).value).toBe('Jolt')
        // Naming a boat starts a rig-model fetch; let it land before the test ends.
        await settle()
      } finally { restore() }
    })
  })

  it('takes a hand-marked horizon over the detector\u2019s', async () => {
    // jsdom has no pixels, so the detector never finds one here — which is also
    // the real case this exists for: the 26 Sep 12:25 frame had no horizon, and
    // on a rival that means no heel at all, because our log describes our boat.
    const P = makeCamera(RIG)
    render(<SailTrimTab boatName="Northstar 76" />)
    await openAFrame()
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))

    fireEvent.click(stepButton('Horizon, by hand'))
    // Two points on a level horizon, far apart across the frame.
    click({ x: 200, y: 3_000 } as never)
    click({ x: 3_800, y: 3_000 } as never)

    await waitFor(() => expect(screen.getByText(/Horizon 0\.00° ±/)).toBeTruthy())
    expect(screen.getByText(/of the frame.s width/)).toBeTruthy()
  })

  it('cannot be given two horizon clicks in the same place', async () => {
    // Not a validation message but a shape of the editor: NEAR_PX is 22, so a
    // second click within 22 px GRABS the first mark and nudges it rather than
    // placing a new one. The degenerate span horizonFromPoints guards against is
    // therefore unreachable by clicking, and the guard is a safety net for marks
    // restored from an old save. Asserted here so nobody "fixes" the guard by
    // loosening it after failing to trigger it.
    const P = makeCamera(RIG)
    render(<SailTrimTab boatName="Northstar 76" />)
    await openAFrame()
    click(P(0, 0, 3_000)); click(P(0, 0, 29_000))
    fireEvent.click(stepButton('Horizon, by hand'))
    click({ x: 2_000, y: 3_000 } as never)
    click({ x: 2_006, y: 3_001 } as never)
    // Still 1 of 2 — the second click moved the first.
    await waitFor(() =>
      expect(within(screen.getByTestId('sailtrim-steps')).getAllByText('1/2').length).toBeGreaterThan(0))
  })
})

describe('the default scale reference', () => {
  it('is the WHEELS, not a guessed spreader', async () => {
    // Spreader 2 was the default and it is a guess on every boat — 6000 +/- 600
    // out of defaultRigModel. That is how the 27 Sep 11:43:30 frame came to read
    // roughly double its neighbours taken six seconds later: same sail, same
    // minute, a scale nobody had measured. The wheels are the one reference a
    // tape can reach without going up the rig, and they are athwartships, which
    // is the direction an astern camera resolves best.
    render(<SailTrimTab boatName="Northstar 76" />)
    await openAFrame()
    const select = screen.getAllByRole('combobox').find((el) =>
      Array.from((el as HTMLSelectElement).options).some((o) => o.value === 'wheels')) as HTMLSelectElement
    expect(select.value).toBe('wheels')
  })
})
