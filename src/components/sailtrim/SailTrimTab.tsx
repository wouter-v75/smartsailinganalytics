'use client';
// src/components/sailtrim/SailTrimTab.tsx
// ─────────────────────────────────────────────────────────────────────────────
// SailTrim — the speed team's three astern measurements, digitised here instead
// of drawn by hand in Rhino. docs/sail-geometry-from-astern-2026-09.md has the
// derivation; what the tool adds over a scaled overlay is:
//
//   • ψ, the camera's off-centreplane angle, measured from the photo and
//     corrected for — up to 140 mm on a clew at 1°
//   • the depth correction — a target forward of the mast is FARTHER from an
//     astern camera and images smaller, so the naive number under-reads by d/R
//   • the horizon, found automatically, which fixes world-horizontal exactly
//     and makes the mast's angle to it a reading of the heel to check the log
//     against. On the six 5 Sept frames that agreed to better than 1.6°.
//   • both candidate definitions, boat-frame and world-horizontal
//   • a sigma on every number, and the Rhino-equivalent beside it
//
// Geometry in src/lib/sailTrim.ts, detection in src/lib/sailTrimCv.ts, the
// dimensions in src/lib/rigModel.ts — all three tested on their own. This file
// is the canvas, the clicks and the form.
//
// MEASURE ON THE ORIGINAL FRAME. A speed-team compilation panel has been
// cropped, upscaled ~2.3× AND rotated ~23° to stand the mast up. The tool says
// so when it sees one, but it is easier not to hand it one.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  mastAxisFromEdges, mastAxisFromPoints, solvePsi, measureTarget, leechTargets,
  mmPerPxFromReference, mmPerPxAtMastFromRef, runChecks, cameraRollDeg, imageHeelDeg,
  toCsv, SAILTRIM_VERSION,
  type Px, type Calibration, type Measurement, type Check, type SailTrimResult, type Horizon,
} from '../../lib/sailTrim';
import {
  detectHorizon, traceMastFromSeed, type Pixels, type HorizonResult, type MastTrace,
} from '../../lib/sailTrimCv';
import {
  rigModelFor, loadRigModel, saveRigModel, scaleRelSigma, missingFrom, exportRigModel, importRigModel,
  HEIGHT_TAGS, LEECH_SAILS, heightShort,
  type RigModel, type Provenance,
} from '../../lib/rigModel';
import { parseIrcCertificate, rigModelFromIrc } from '../../lib/ircCertificate';
import {
  buildAnnotation, annotationHeadline, annotationFields, type SailTrimAnnotation,
} from '../../lib/sailTrimOverlay';
import { heicToJpeg, loadExifr, loadJsPdf } from '@/lib/cdnScript';

// ── the marks the operator places ───────────────────────────────────────────
interface StepDef {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  colour: string;
  group: 'calibrate' | 'target';
  optional?: boolean;
}

// The default, and the one the speed team asked for: two marks on the mast's
// centreline and a STRAIGHT line between them, drawn exactly where they put it.
// The traced alternative below follows the mast's EDGE sub-pixel, which is more
// precise when it works and wanders onto a shroud, a halyard or the sail's edge
// when it does not — and a line that has quietly wandered looks just like one
// that has not. Two clicks are cheap; a wrong axis is not, because every
// measurement is taken from it.
const MAST_LINE: StepDef = {
  key: 'mastLine', label: 'Mast centreline', min: 2, max: 2, colour: '#38BDF8', group: 'calibrate',
  hint: 'Two points on the middle of the mast, as far apart up and down as you can see it — low near the gooseneck, high near the top. The axis is the straight line through them, and nothing is inferred.',
};
const MAST_AUTO: StepDef = {
  key: 'mastSeed', label: 'Mast', min: 1, max: 1, colour: '#38BDF8', group: 'calibrate',
  hint: 'One click anywhere on the mast’s edge, roughly. It is traced from there, sub-pixel, up and down as far as the contrast holds — and the trace is drawn, so you can see where it went.',
};
const MAST_MANUAL: StepDef[] = [
  { key: 'mastLow', label: 'Mast edges, low', min: 2, max: 2, colour: '#38BDF8', group: 'calibrate',
    hint: 'Port then starboard edge of the mast, low down. Zoom in first — at fit zoom the mast is two pixels wide.' },
  { key: 'mastHigh', label: 'Mast edges, high', min: 2, max: 2, colour: '#38BDF8', group: 'calibrate',
    hint: 'The same two edges as high as you can still see them. The further apart the two heights, the better the axis.' },
];
const OTHER_STEPS: StepDef[] = [
  { key: 'scale', label: 'Scale reference', min: 2, max: 2, colour: '#FACC15', group: 'calibrate',
    hint: 'The two ends of something whose true length you know AND that lies across the boat — spreader tip to tip. Never a fore-and-aft length: from astern those are foreshortened to nothing.' },
  { key: 'baseline', label: 'Centreplane baseline', min: 2, max: 2, colour: '#F472B6', group: 'calibrate', optional: true,
    hint: 'Two points on the boat’s centreline, as far apart fore-and-aft as possible — forestay tack and transom centre. Aft point first. This is what measures ψ; skipping it costs ±1° of unknown misalignment.' },
  ...HEIGHT_TAGS.map((t): StepDef => ({
    key: `h:${t.key}`, label: t.label, min: 1, max: 1, colour: '#A78BFA',
    group: 'calibrate', optional: true,
    hint: `Where ${t.label.toLowerCase()} meets the mast. Mark as many heights as you want measured — every leech you have drawn is read at every height you have marked, and the tag is what lets today's number be compared with the same number from another day.`,
  })),
  ...LEECH_SAILS.map((sl): StepDef => ({
    key: `leech:${sl.key}`, label: sl.label, min: 2, max: 8, colour: sl.colour,
    group: 'target', optional: true,
    hint: sl.key === 'jib'
      ? 'Points down the JIB\u2019s leech, spanning every height you marked. CHECK WHICH SAIL YOU ARE ON \u2014 the silhouette against the sky is the MAINSAIL\u2019s leech high up and the jib\u2019s lower down, and on the 5 Sept frames the two sit within ~150 mm of each other, so a reading off the wrong one looks perfectly reasonable.'
      : 'Points down the MAINSAIL\u2019s leech, spanning every height you marked. High up this is the outer silhouette against the sky; lower down the jib\u2019s leech crosses in front of it, so follow the roach rather than the outermost edge.',
  })),
  // Optional like the rest: the tool measures whatever is marked, and asking for
  // a clew on a frame somebody opened to read two leech heights is just nagging.
  { key: 'clew', label: 'Jib clew', min: 1, max: 1, colour: '#FB923C', group: 'target', optional: true,
    hint: 'The clew itself. Keep to the same feature every time — the ring centre, say.' },
  { key: 'boom', label: 'Boom', min: 1, max: 1, colour: '#F87171', group: 'target', optional: true,
    hint: 'The point on the boom you are measuring to. Same one every time.' },
];

type Marks = Record<string, Px[]>;

const CLICK_SIGMA_PX = 1.5;
// How close a click has to land to GRAB an existing mark rather than place a
// new one. Two radii, because one is wrong at both ends: a generous radius
// makes nudging easy, but while a step is still being filled it swallows the
// next point.
const NEAR_PX = 22;
const NEAR_PX_WHILE_FILLING = 7;
/** Width the image is decoded to for horizon + mast detection. Plenty: both
 *  are fits over hundreds of samples, and 24 MP of ImageData is 96 MB. */
const CV_WIDTH = 1800;

const fmt = (n: number | null | undefined, dp = 0) =>
  n == null || !Number.isFinite(n) ? '—' : n.toFixed(dp);

interface Kept {
  id: number;
  photo: string;
  boat: string;
  capturedAt: string | null;
  measurements: Measurement[];
  psiMeasured: boolean;
}

/** What a host (the photo viewer) gets back when the operator saves onto a photo. */
export interface SailTrimSave {
  result: SailTrimResult;
  annotation: SailTrimAnnotation;
  /** Flat, filterable headline fields to hang on the photo beside the JSON. */
  fields: Record<string, string>;
  /** Whether the operator asked for the lines to be burned into the picture. */
  showOverlay: boolean;
}

export default function SailTrimTab(
  {
    boatName = '', initialFileUrl = '', initialFileName = '',
    onSaveToPhoto, photoLabel = '',
  }: {
    boatName?: string;
    initialFileUrl?: string;
    /** The photo's own name — `initialFileUrl` is an API path with no filename in it. */
    initialFileName?: string;
    /** Present when the tool is measuring a photo that belongs to something:
     *  adds "Save to photo", which is the only way the numbers reach anyone else.
     *  Returning a `warning` means it saved but did not fully share — worth
     *  saying, because "saved" that only reached this browser is the failure
     *  mode this whole feature exists to avoid. */
    onSaveToPhoto?: (save: SailTrimSave) => void | Promise<void | { warning?: string }>;
    photoLabel?: string;
  } = {},
) {
  // ── image ─────────────────────────────────────────────────────────────────
  const [imageSrc, setImageSrc] = useState('');
  const [fileName, setFileName] = useState('');
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [exifNote, setExifNote] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadingFrame, setLoadingFrame] = useState(false);
  const cachedImage = useRef<HTMLImageElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // ── marks ─────────────────────────────────────────────────────────────────
  const [marks, setMarks] = useState<Marks>({});
  const [activeStep, setActiveStep] = useState(0);
  const [mastMode, setMastMode] = useState<'line' | 'auto' | 'manual'>('line');

  // ── detection ─────────────────────────────────────────────────────────────
  const cvPixels = useRef<{ px: Pixels; scale: number } | null>(null);
  const [horizon, setHorizon] = useState<HorizonResult | null>(null);
  const [horizonNote, setHorizonNote] = useState('');
  const [mastTrace, setMastTrace] = useState<MastTrace | null>(null);
  const [traceNote, setTraceNote] = useState('');

  // ── the numbers only the boat knows ───────────────────────────────────────
  const [boat, setBoat] = useState(boatName);
  const [rig, setRig] = useState<RigModel>(() => rigModelFor(boatName));
  const [rigOpen, setRigOpen] = useState(false);
  const [certText, setCertText] = useState('');
  const [certNote, setCertNote] = useState('');
  const [scaleKey, setScaleKey] = useState('spreader2');
  const [baselineKey, setBaselineKey] = useState('bow-transom');
  const [heelDeg, setHeelDeg] = useState<string>('');
  const [focalMm, setFocalMm] = useState<string>('');
  const [defn, setDefn] = useState<'boat' | 'world'>('boat');
  const [kept, setKept] = useState<Kept[]>([]);

  const scaleRef = rig.scaleRefs.find((s) => s.key === scaleKey) ?? rig.scaleRefs[0];
  const baseRef = rig.baselines.find((b) => b.key === baselineKey) ?? rig.baselines[0];

  // Follow the boat name to its stored model — but KEEP the current one when
  // there is nothing stored, renaming it instead. Reloading unconditionally
  // threw away a model the moment its boat was named, which is exactly what
  // happens after reading a certificate (it names the boat), and what happens
  // in any browser where localStorage is blocked and the save silently did
  // nothing.
  useEffect(() => {
    const stored = loadRigModel(boat);
    setRig((cur) => stored ?? (cur.boat === boat ? cur : { ...cur, boat }));
  }, [boat]);

  // ── canvas / view ─────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Px>({ x: 0, y: 0 });
  const dragRef = useRef<
    | { kind: 'pan'; startClient: Px; startPan: Px }
    | { kind: 'point'; step: string; idx: number }
    | null
  >(null);
  const downRef = useRef<{ client: Px; moved: boolean } | null>(null);
  const [hover, setHover] = useState<Px | null>(null);

  const steps: StepDef[] = useMemo(
    () => [
      ...(mastMode === 'line' ? [MAST_LINE] : mastMode === 'auto' ? [MAST_AUTO] : MAST_MANUAL),
      ...OTHER_STEPS,
    ],
    [mastMode],
  );

  // ── load ──────────────────────────────────────────────────────────────────
  const openFile = async (file: File) => {
    setExifNote('');
    setHorizon(null); setHorizonNote(''); setMastTrace(null); setTraceNote('');
    cvPixels.current = null;
    let display = file;
    try { display = await heicToJpeg(file); } catch { /* not HEIC; carry on */ }
    const url = URL.createObjectURL(display);
    setImageSrc((old) => { if (old) URL.revokeObjectURL(old); return url; });
    setFileName(file.name);
    setMarks({});
    setActiveStep(0);
    setZoom(1);
    setPan({ x: 0, y: 0 });

    try {
      const exifr = await loadExifr();
      const d = await exifr.parse(file, { tiff: true, exif: true, ifd0: true });
      const dt = d?.DateTimeOriginal || d?.DateTime;
      // EXIF stamps carry no zone and are venue-LOCAL wall clock — shown as
      // written, never converted here.
      setCapturedAt(dt instanceof Date ? dt.toISOString().slice(0, 19).replace('T', ' ') : null);
      if (d?.FocalLength) {
        setFocalMm(String(Math.round(d.FocalLength)));
        setExifNote(`${d.Model || 'camera'} · ${Math.round(d.FocalLength)} mm${d.LensModel ? ` · ${d.LensModel}` : ''}`);
      } else {
        setExifNote('No focal length in this file — it has been re-exported and the EXIF stripped. Enter it by hand, or the depth correction cannot be applied.');
      }
    } catch {
      setExifNote('Could not read EXIF.');
    }
  };

  // A frame handed in by URL rather than by the file picker — the /dev harness,
  // and the "Sail geometry" button in the photo viewer.
  //
  // It says when it fails. The photo the viewer hands over is the cloud
  // ORIGINAL, and for a photo whose original has not finished uploading that URL
  // 404s — which used to leave the tool sitting there empty with the file picker
  // showing, as though nothing had been asked of it.
  useEffect(() => {
    if (!initialFileUrl) return;
    let cancelled = false;
    setLoadError('');
    setLoadingFrame(true);
    (async () => {
      try {
        const r = await fetch(initialFileUrl);
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(`Could not load the picture (HTTP ${r.status}). If this photo's full-resolution original has not reached the cloud yet, there is nothing to measure on — open the frame from disk instead.`);
          return;
        }
        const blob = await r.blob();
        // `initialFileUrl` is an API path with the key in a query string, so the
        // last path segment is not a filename. The host passes the real one.
        const name = initialFileName || initialFileUrl.split('/').pop() || 'frame.jpg';
        await openFile(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      } catch (e) {
        if (!cancelled) setLoadError(`Could not load the picture: ${(e as Error)?.message || 'network error'}. The file picker still works.`);
      } finally {
        if (!cancelled) setLoadingFrame(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFileUrl, initialFileName]);

  /** One downscaled copy serves both detectors. */
  const decodeForCv = useCallback((img: HTMLImageElement) => {
    try {
      const w = Math.min(CV_WIDTH, img.naturalWidth);
      const hh = Math.max(1, Math.round((img.naturalHeight * w) / img.naturalWidth));
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) { setHorizonNote('No 2D canvas — horizon detection is off.'); return; }
      ctx.drawImage(img, 0, 0, w, hh);
      const px = ctx.getImageData(0, 0, w, hh) as unknown as Pixels;
      cvPixels.current = { px, scale: img.naturalWidth / w };
      const found = detectHorizon(px);
      if (!found) {
        setHorizon(null);
        setHorizonNote('No sea horizon found — it may be out of frame or behind land. World-horizontal falls back to the logged heel.');
        return;
      }
      const s = cvPixels.current.scale;
      // Back to full-resolution pixels: a uniform scale leaves the slope alone.
      setHorizon({
        ...found,
        intercept: found.intercept * s,
        points: found.points.map((p) => ({ x: p.x * s, y: p.y * s })),
      });
      setHorizonNote('');
    } catch {
      setHorizonNote('Could not read the image pixels — horizon detection is off for this frame.');
    }
  }, []);

  useEffect(() => {
    if (!imageSrc) { cachedImage.current = null; setImgSize(null); return; }
    const img = new Image();
    img.onload = () => {
      cachedImage.current = img;
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      fitToView(img.naturalWidth, img.naturalHeight);
      decodeForCv(img);
    };
    img.src = imageSrc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc]);

  const retryHorizon = () => {
    const img = cachedImage.current;
    if (img) decodeForCv(img);
  };

  const runTrace = (seed: Px) => {
    const cv = cvPixels.current;
    if (!cv) { setTraceNote('No pixels to trace — mark the mast edges by hand instead.'); return; }
    const t = traceMastFromSeed(cv.px, { x: seed.x / cv.scale, y: seed.y / cv.scale });
    if (!t) {
      setMastTrace(null);
      setTraceNote('Nothing to follow there. Click on the mast’s edge against the sky, or switch to marking the edges by hand.');
      return;
    }
    const s = cv.scale;
    const up = mastAxisFromPoints(
      { x: t.axis.low.x * s, y: t.axis.low.y * s },
      { x: t.axis.high.x * s, y: t.axis.high.y * s },
    );
    if (!up) { setTraceNote('The trace came back degenerate.'); return; }
    // Everything comes back in FULL-RESOLUTION pixels — span and scatter alike.
    // Reporting one in detection pixels and the other in image pixels made the
    // mast bend look four times tighter than it is.
    setMastTrace({
      ...t, axis: up,
      points: t.points.map((p) => ({ x: p.x * s, y: p.y * s })),
      spanPx: t.spanPx * s,
      rms: t.rms * s,
    });
    setTraceNote('');
  };

  const fitToView = (w: number, hh: number) => {
    const c = canvasRef.current;
    if (!c) return;
    const z = Math.min(c.width / w, c.height / hh);
    setZoom(z);
    setPan({ x: (c.width / z - w) / 2, y: (c.height / z - hh) / 2 });
  };

  // ── coordinates (same idiom as SailScanTab) ──────────────────────────────
  const toImage = useCallback((clientX: number, clientY: number): Px => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width, sy = c.height / rect.height;
    return {
      x: ((clientX - rect.left) * sx - pan.x * zoom) / zoom,
      y: ((clientY - rect.top) * sy - pan.y * zoom) / zoom,
    };
  }, [pan, zoom]);

  const imageScale = () => {
    const c = canvasRef.current;
    if (!c) return 1;
    return c.width / (c.getBoundingClientRect().width || 1);
  };

  const findNear = (p: Px): { step: string; idx: number } | null => {
    const active = steps[activeStep];
    const filling = active ? (marks[active.key] || []).length < active.max : false;
    const threshold = ((filling ? NEAR_PX_WHILE_FILLING : NEAR_PX) * imageScale()) / zoom;
    let best: { step: string; idx: number } | null = null;
    let bestD = threshold;
    for (const s of steps) {
      (marks[s.key] || []).forEach((m, i) => {
        const d = Math.hypot(m.x - p.x, m.y - p.y);
        if (d < bestD) { bestD = d; best = { step: s.key, idx: i }; }
      });
    }
    return best;
  };

  // ── pointer handling ─────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imgSize) return;
    // Capture keeps a drag alive if the pointer leaves the canvas. `?.` only
    // guards the method being absent — it still THROWS on a pointer id the
    // browser has no active pointer for, which aborts the handler and silently
    // eats the click. Never happens to a hand on a trackpad; happens every
    // time to a synthetic event, which is how it was found.
    try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    downRef.current = { client: { x: e.clientX, y: e.clientY }, moved: false };
    const p = toImage(e.clientX, e.clientY);
    const near = findNear(p);
    dragRef.current = near
      ? { kind: 'point', ...near }
      : { kind: 'pan', startClient: { x: e.clientX, y: e.clientY }, startPan: pan };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imgSize) return;
    setHover(toImage(e.clientX, e.clientY));
    const down = downRef.current;
    const drag = dragRef.current;
    if (!down || !drag) return;
    const moved = Math.hypot(e.clientX - down.client.x, e.clientY - down.client.y) > 3;
    if (moved) down.moved = true;
    if (!down.moved) return;

    if (drag.kind === 'pan') {
      const s = imageScale();
      setPan({
        x: drag.startPan.x + ((e.clientX - drag.startClient.x) * s) / zoom,
        y: drag.startPan.y + ((e.clientY - drag.startClient.y) * s) / zoom,
      });
    } else {
      const p = toImage(e.clientX, e.clientY);
      setMarks((prev) => ({
        ...prev,
        [drag.step]: (prev[drag.step] || []).map((m, i) => (i === drag.idx ? p : m)),
      }));
      if (drag.step === 'mastSeed') runTrace(p);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const down = downRef.current;
    const wasDrag = dragRef.current;
    downRef.current = null;
    dragRef.current = null;
    if (!down || down.moved || !imgSize) return;
    if (wasDrag?.kind === 'point') return;  // a tap on an existing point selects, not places
    placePoint(toImage(e.clientX, e.clientY));
  };

  const placePoint = (p: Px) => {
    const step = steps[activeStep];
    if (!step) return;
    setMarks((prev) => {
      const cur = prev[step.key] || [];
      // A full fixed-size step restarts rather than silently ignoring the click.
      const next = cur.length >= step.max ? [p] : [...cur, p];
      return { ...prev, [step.key]: next };
    });
    if (step.key === 'mastSeed') runTrace(p);
  };

  const clearStep = (key: string) => {
    setMarks((prev) => ({ ...prev, [key]: [] }));
    if (key === 'mastSeed') { setMastTrace(null); setTraceNote(''); }
  };
  const undoPoint = (key: string) =>
    setMarks((prev) => ({ ...prev, [key]: (prev[key] || []).slice(0, -1) }));

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!imgSize) return;
    const before = toImage(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.02, Math.min(40, zoom * factor));
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width, sy = c.height / rect.height;
    // keep the point under the cursor pinned
    setPan({
      x: ((e.clientX - rect.left) * sx) / next - before.x,
      y: ((e.clientY - rect.top) * sy) / next - before.y,
    });
    setZoom(next);
  };

  /** Zoom by a factor while holding the middle of the view still. */
  const zoomAboutCentre = (factor: number) => {
    const c = canvasRef.current;
    if (!c) return;
    const next = Math.max(0.02, Math.min(40, zoom * factor));
    const cx = c.width / 2, cy = c.height / 2;
    const before = { x: cx / zoom - pan.x, y: cy / zoom - pan.y };
    setPan({ x: cx / next - before.x, y: cy / next - before.y });
    setZoom(next);
  };

  // ── the calibration ──────────────────────────────────────────────────────
  const calibration = useMemo((): { cal: Calibration | null; why: string } => {
    let axis = null;
    if (mastMode === 'line') {
      const line = marks.mastLine || [];
      if (line.length < 2) return { cal: null, why: 'Mark two points on the mast’s centreline.' };
      axis = mastAxisFromPoints(line[0], line[1]);
      if (!axis) return { cal: null, why: 'The two mast marks are the same point.' };
    } else if (mastMode === 'auto') {
      axis = mastTrace?.axis ?? null;
      if (!axis) return { cal: null, why: traceNote || 'Click once on the mast.' };
    } else {
      const low = marks.mastLow || [], high = marks.mastHigh || [];
      if (low.length < 2 || high.length < 2) return { cal: null, why: 'Mark the mast edges at two heights.' };
      axis = mastAxisFromEdges([{ port: low[0], stbd: low[1] }, { port: high[0], stbd: high[1] }]);
      if (!axis) return { cal: null, why: 'The two mast heights are the same point.' };
    }

    const sc = marks.scale || [];
    if (sc.length < 2) return { cal: null, why: 'Mark a scale reference.' };
    const mmPerPxAtRef = mmPerPxFromReference(sc[0], sc[1], scaleRef?.mm ?? 0);
    if (!mmPerPxAtRef) {
      return { cal: null, why: 'The scale reference needs a true length in the rig model, and two points apart.' };
    }

    const heel = heelDeg.trim() === '' ? null : Number(heelDeg);
    const focal = focalMm.trim() === '' ? 0 : Number(focalMm);
    const sensor = {
      widthMm: rig.sensorWidthMm,
      focalLengthMm: focal,
      imageLongEdgePx: imgSize ? Math.max(imgSize.w, imgSize.h) : 0,
    };
    // A reference that is not in the mast plane measures a different scale from
    // the mast's. The wheels are ~10 m abaft it and image larger; taken as the
    // mast's scale that reads every measurement low by depth/range. Referred
    // back here, once, so nothing downstream has to know where the ruler was.
    const refDepthMm = scaleRef?.depthMm ?? 0;
    const referred = mmPerPxAtMastFromRef(mmPerPxAtRef, refDepthMm, sensor);
    const mmPerPxAtMast = referred.mmPerPxAtMast;
    const rangeMm = imgSize ? referred.rangeMm : null;
    const scaleDepthUncorrected = refDepthMm !== 0 && !referred.corrected;

    const hz: Horizon | null = horizon ? { tiltDeg: horizon.tiltDeg, rms: horizon.rms, samples: horizon.samples } : null;
    const heelForPsi = imageHeelDeg(axis, hz) ?? (heel != null && Number.isFinite(heel) ? heel : null);
    const base = marks.baseline || [];
    const psi = solvePsi(
      base.length >= 2 && (baseRef?.mm ?? 0) > 0
        ? { aft: base[0], fwd: base[1], separationMm: baseRef.mm }
        : null,
      axis.across, mmPerPxAtMast, heelForPsi,
      { clickSigmaPx: CLICK_SIGMA_PX },
    );

    return {
      cal: {
        axis, mmPerPxAtMast,
        // An uncorrected off-mast reference is a SYSTEMATIC error, not noise,
        // and the honest thing is to widen the scale sigma until somebody
        // supplies a focal length. depth/range with a 150 m guess at the range.
        scaleRelSigma: scaleRelSigma(scaleRef)
          + (scaleDepthUncorrected ? Math.abs(refDepthMm) / 150_000 : 0),
        rangeMm, psi, scaleDepthUncorrected, scaleRefDepthMm: refDepthMm,
        heelDeg: heel != null && Number.isFinite(heel) ? heel : null,
        heelSigmaDeg: 0.5, clickSigmaPx: CLICK_SIGMA_PX, horizon: hz,
      },
      why: '',
    };
  }, [mastMode, mastTrace, traceNote, marks, scaleRef, baseRef, heelDeg, focalMm, rig.sensorWidthMm, imgSize, horizon]);

  // ── the measurements ─────────────────────────────────────────────────────
  /**
   * Every leech, read at every marked height.
   *
   * A leech is a curve, so "the leech" is not a number until a height is named.
   * Each tagged mark on the mast crosses each sail's polyline once, and the
   * crossing is the target — which is why the tag travels with the measurement:
   * a millimetre figure with no height against it cannot be compared with the
   * same figure from another day, and comparing is the only thing anybody wants
   * to do with it.
   */
  const leechCrossings = useCallback((): {
    key: string; label: string; point: Px; sail: string; tag: string;
  }[] => {
    const cal = calibration.cal;
    if (!cal) return [];
    const out: { key: string; label: string; point: Px; sail: string; tag: string }[] = [];
    for (const sl of LEECH_SAILS) {
      const poly = marks[`leech:${sl.key}`] || [];
      if (poly.length < 2) continue;
      for (const t of HEIGHT_TAGS) {
        const at = (marks[`h:${t.key}`] || [])[0];
        if (!at) continue;
        const pts = leechTargets(poly, cal.axis, at, cal.heelDeg, cal.horizon);
        const point = defn === 'boat' ? pts.boatFrame : pts.worldHorizontal;
        // A height above or below where the leech was drawn simply does not
        // cross it. That is a gap in the marking, not an error — skip it.
        if (!point) continue;
        out.push({
          key: `${sl.key}@${t.key}`,
          label: `${sl.label} @ ${heightShort(t.key)}`,
          point, sail: sl.key, tag: t.key,
        });
      }
    }
    return out;
  }, [calibration, marks, defn]);

  /** Where a measurement's target sits on the picture, by its key. */
  const pointForKey = useCallback((key: string): Px | null => {
    if (key === 'clew' || key === 'boom') return (marks[key] || [])[0] ?? null;
    return leechCrossings().find((c) => c.key === key)?.point ?? null;
  }, [marks, leechCrossings]);

  /** Which STEP a measurement came from, for its colour. */
  const stepKeyFor = (key: string) =>
    key.includes('@') ? `leech:${key.split('@')[0]}` : key;

  const measurements = useMemo((): Measurement[] => {
    const cal = calibration.cal;
    if (!cal) return [];
    const out: Measurement[] = [];
    for (const c of leechCrossings()) {
      const d = c.sail === 'main' ? rig.depths.mainLeech : rig.depths.leech;
      out.push(measureTarget(cal, {
        key: c.key, label: c.label, point: c.point,
        depthMm: d.mm, depthSigmaMm: d.sigmaMm,
      }));
    }
    for (const key of ['clew', 'boom'] as const) {
      const p = (marks[key] || [])[0];
      if (p) {
        out.push(measureTarget(cal, {
          key, label: key === 'clew' ? 'Jib clew' : 'Boom', point: p,
          depthMm: rig.depths[key].mm, depthSigmaMm: rig.depths[key].sigmaMm,
        }));
      }
    }
    return out;
  }, [calibration, marks, rig.depths, leechCrossings]);

  const checks: Check[] = useMemo(
    () => (calibration.cal ? runChecks(calibration.cal) : []),
    [calibration],
  );
  const gaps = useMemo(() => missingFrom(rig), [rig]);

  // ── draw ──────────────────────────────────────────────────────────────────
  const footOnAxis = useCallback((p: Px): Px | null => {
    const cal = calibration.cal;
    if (!cal) return null;
    const v = { x: p.x - cal.axis.low.x, y: p.y - cal.axis.low.y };
    const t = v.x * cal.axis.up.x + v.y * cal.axis.up.y;
    return { x: cal.axis.low.x + t * cal.axis.up.x, y: cal.axis.low.y + t * cal.axis.up.y };
  }, [calibration]);

  /** Paint the scene into any context — the live canvas, or an offscreen one
   *  for the report. `uiScale` sizes the crosses and labels in device pixels so
   *  they look the same whatever the target's resolution. */
  const paint = useCallback((
    ctx: CanvasRenderingContext2D, W: number, H: number, z: number, p0: Px, uiScale: number,
  ) => {
    ctx.fillStyle = '#04121F';
    ctx.fillRect(0, 0, W, H);
    const img = cachedImage.current;
    if (!img) return;
    const zoom = z, pan = p0;

    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(pan.x, pan.y);
    ctx.drawImage(img, 0, 0);
    ctx.restore();

    const px = (n: number) => n * uiScale;
    const toScreen = (p: Px): Px => ({ x: (p.x + pan.x) * zoom, y: (p.y + pan.y) * zoom });

    if (horizon && imgSize) {
      const a = toScreen({ x: 0, y: horizon.intercept });
      const b = toScreen({ x: imgSize.w, y: horizon.slope * imgSize.w + horizon.intercept });
      ctx.strokeStyle = 'rgba(250,204,21,0.45)';
      ctx.lineWidth = px(1.2);
      ctx.setLineDash([px(14), px(10)]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    if (mastMode === 'auto' && mastTrace) {
      ctx.strokeStyle = 'rgba(56,189,248,0.9)';
      ctx.lineWidth = px(1.4);
      ctx.beginPath();
      mastTrace.points.forEach((p, i) => {
        const q = toScreen(p);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.stroke();
    }

    // In 'line' mode the axis is exactly the straight line through the two marks
    // — nothing is drawn that the operator did not place.
    const axis = calibration.cal?.axis ?? (mastMode === 'auto' ? mastTrace?.axis ?? null : null);
    if (axis) {
      const a = toScreen(axis.low), b = toScreen(axis.high);
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      ctx.strokeStyle = 'rgba(56,189,248,0.5)';
      ctx.lineWidth = px(1.2);
      ctx.setLineDash([px(10), px(8)]);
      ctx.beginPath();
      ctx.moveTo(a.x - (dx / L) * 6000, a.y - (dy / L) * 6000);
      ctx.lineTo(b.x + (dx / L) * 6000, b.y + (dy / L) * 6000);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── where the rig model says to look ──────────────────────────────────
    // Faint, dashed, labelled "≈" — a PREDICTION from the certificate, never a
    // mark. It exists because of a mistake: marking the outer silhouette at
    // spreader-2 height and calling it the jib leech, when the silhouette up
    // there is the mainsail's. The two sit within ~150 mm of each other on
    // these frames, so the number looked right. A line saying "the clew is
    // about this high" is what catches that.
    if (calibration.cal) {
      const cal0 = calibration.cal;
      const across = cal0.axis.across;
      const guide = (through: Px, label: string) => {
        const q = toScreen(through);
        const half = 4000;
        ctx.strokeStyle = 'rgba(167,139,250,0.40)';
        ctx.lineWidth = px(1);
        ctx.setLineDash([px(5), px(7)]);
        ctx.beginPath();
        ctx.moveTo(q.x - across.x * half, q.y - across.y * half);
        ctx.lineTo(q.x + across.x * half, q.y + across.y * half);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(167,139,250,0.85)';
        ctx.font = `600 ${px(11)}px system-ui, sans-serif`;
        ctx.fillText(label, q.x + across.x * px(70) + px(6), q.y + across.y * px(70) - px(4));
      };
      // P's lower black band is the mainsail's tack — the boom's height.
      const sc = marks.scale || [];
      if (scaleKey === 'P' && sc.length === 2) {
        const lower = sc[0].y > sc[1].y ? sc[0] : sc[1];
        guide(lower, 'boom / main tack height');
      }
      // The jib's clew sits clewHeightMm above ITS OWN tack — which is the
      // forward point of the centreplane baseline, when that is marked.
      const base = marks.baseline || [];
      if (base.length >= 2 && rig.clewHeightMm) {
        const up = rig.clewHeightMm / cal0.mmPerPxAtMast;
        const tack = base[1];
        guide({ x: tack.x + cal0.axis.up.x * up, y: tack.y + cal0.axis.up.y * up }, 'jib clew \u2248 this height');
      }
    }

    const cal = calibration.cal;
    if (cal) {
      for (const m of measurements) {
        const step = steps.find((s) => s.key === stepKeyFor(m.key));
        const pt = pointForKey(m.key);
        if (!pt) continue;
        const foot = footOnAxis(pt);
        if (!foot) continue;
        const P = toScreen(pt), F = toScreen(foot);
        ctx.strokeStyle = step?.colour || '#fff';
        ctx.lineWidth = px(1.6);
        ctx.beginPath(); ctx.moveTo(F.x, F.y); ctx.lineTo(P.x, P.y); ctx.stroke();
        ctx.fillStyle = step?.colour || '#fff';
        ctx.font = `700 ${px(13)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        const value = defn === 'world' ? m.worldHorizontalMm : m.boatFrameMm;
        ctx.fillText(`${Math.round(Math.abs(value))}`, (P.x + F.x) / 2, (P.y + F.y) / 2 - px(6));
        ctx.textAlign = 'left';
      }
    }

    for (const s of steps) {
      const pts = marks[s.key] || [];
      if (!pts.length) continue;
      const active = steps[activeStep]?.key === s.key;
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = px(active ? 2.2 : 1.4);
      if (pts.length > 1) {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const q = toScreen(p);
          if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        });
        ctx.stroke();
      }
      for (const p of pts) {
        const q = toScreen(p);
        const r = px(active ? 7 : 5);
        ctx.beginPath(); ctx.moveTo(q.x - r * 1.9, q.y); ctx.lineTo(q.x + r * 1.9, q.y);
        ctx.moveTo(q.x, q.y - r * 1.9); ctx.lineTo(q.x, q.y + r * 1.9); ctx.stroke();
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }, [marks, activeStep, calibration, measurements, defn, horizon, mastTrace, mastMode, imgSize, steps, pointForKey, footOnAxis, scaleKey, rig.clewHeightMm]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    paint(ctx, c.width, c.height, zoom, pan, imageScale());
  }, [paint, zoom, pan]);

  useEffect(() => { draw(); }, [draw]);

  // ── the loupe: mandatory at 6 mm per pixel ───────────────────────────────
  useEffect(() => {
    const l = loupeRef.current;
    const ctx = l?.getContext('2d');
    const img = cachedImage.current;
    if (!l || !ctx || !img || !hover) return;
    const SRC = 44;   // source pixels across the loupe ⇒ ~4× at 176 px
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#04121F';
    ctx.fillRect(0, 0, l.width, l.height);
    ctx.drawImage(img, hover.x - SRC / 2, hover.y - SRC / 2, SRC, SRC, 0, 0, l.width, l.height);
    ctx.strokeStyle = 'rgba(248,113,113,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.width / 2, 0); ctx.lineTo(l.width / 2, l.height);
    ctx.moveTo(0, l.height / 2); ctx.lineTo(l.width, l.height / 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(0.5, 0.5, l.width - 1, l.height - 1);
  }, [hover]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      draw();
    });
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── export ────────────────────────────────────────────────────────────────
  const result = (): SailTrimResult => {
    const cal = calibration.cal;
    return {
      photo: fileName,
      capturedAt,
      boat,
      measurements,
      calibration: {
        mmPerPxAtMast: cal?.mmPerPxAtMast ?? 0,
        rangeMm: cal?.rangeMm ?? null,
        psiDeg: cal?.psi.deg ?? 0,
        psiSigmaDeg: cal?.psi.sigmaDeg ?? 0,
        psiMeasured: cal?.psi.measured ?? false,
        heelDeg: cal?.heelDeg ?? null,
        imageHeelDeg: cal ? imageHeelDeg(cal.axis, cal.horizon) : null,
        mastTiltDeg: cal?.axis.tiltDeg ?? 0,
        cameraRollDeg: cal ? (cal.horizon ? cal.horizon.tiltDeg : cameraRollDeg(cal.axis, cal.heelDeg)) : null,
        horizonTiltDeg: horizon?.tiltDeg ?? null,
        horizonRmsPx: horizon?.rms ?? null,
        horizontalFrom: horizon
          ? 'horizon'
          : (cal && cameraRollDeg(cal.axis, cal.heelDeg) != null ? 'heel' : 'assumed-level'),
      },
      checks,
      marks: { marks, mastMode, defn, focalMm, rig },
      algorithmVersion: SAILTRIM_VERSION,
    };
  };

  /**
   * The annotation: the finished geometry resolved to pixels and millimetres.
   *
   * Built here, where the rig model and the heel are, and never re-derived
   * downstream — see src/lib/sailTrimOverlay.ts for why.
   */
  const annotation = (): SailTrimAnnotation | null => {
    const cal = calibration.cal;
    if (!cal || !imgSize || !measurements.length) return null;
    return buildAnnotation({
      version: SAILTRIM_VERSION,
      imageSize: imgSize,
      defn,
      axis: { low: cal.axis.low, high: cal.axis.high },
      measurements,
      points: Object.fromEntries(measurements.map((m) => [m.key, pointForKey(m.key)])),
      colours: Object.fromEntries(
        measurements.map((m) => [m.key, steps.find((st) => st.key === stepKeyFor(m.key))?.colour || '#38BDF8']),
      ),
      psiDeg: cal.psi.deg,
      psiMeasured: cal.psi.measured,
      heelDeg: imageHeelDeg(cal.axis, cal.horizon) ?? cal.heelDeg,
    });
  };

  const [showOverlay, setShowOverlay] = useState(true);
  const [saveState, setSaveState] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const [saveMsg, setSaveMsg] = useState('');
  const [saveWarn, setSaveWarn] = useState('');

  const saveToPhoto = async () => {
    if (!onSaveToPhoto) return;
    const ann = annotation();
    if (!ann) return;
    setSaveState('saving'); setSaveMsg(''); setSaveWarn('');
    try {
      const r = await onSaveToPhoto({
        result: result(), annotation: ann, fields: annotationFields(ann), showOverlay,
      });
      setSaveState('saved');
      setSaveMsg(annotationHeadline(ann));
      setSaveWarn(r && typeof r === 'object' && r.warning ? r.warning : '');
    } catch (e) {
      setSaveState('error');
      setSaveMsg((e as Error)?.message || 'Save failed');
    }
  };

  const download = (text: string, name: string, type: string) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };
  const base = () => (fileName.replace(/\.[^.]+$/, '') || 'sailtrim');

  /**
   * A one-page report. SSA hands things over as PDF — nobody reads a CSV at a
   * speed-team meeting — and this one is built to be argued with: the frame
   * with the marks on it, the numbers both ways round, the Rhino-equivalent
   * beside them, and an explicit list of everything the measurement is still
   * assuming.
   */
  const exportPdf = async () => {
    const cal = calibration.cal;
    const img = cachedImage.current;
    if (!cal || !img || !imgSize) return;

    // Redraw the whole frame, fitted, into an offscreen canvas — the report
    // should not depend on where the operator happened to be zoomed.
    const W = 1500, H = Math.round((imgSize.h * W) / imgSize.w);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');
    if (!octx) return;
    const z = Math.min(W / imgSize.w, H / imgSize.h);
    paint(octx, W, H, z, { x: (W / z - imgSize.w) / 2, y: (H / z - imgSize.h) / 2 }, W / 760);
    const pic = off.toDataURL('image/jpeg', 0.85);

    const jsPDF = await loadJsPdf();
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    // jsPDF's built-in fonts are WinAnsi: ψ, em dashes and curly quotes are not
    // in them, and a missing glyph does not fall back — it comes out as a
    // different letter entirely (ψ printed as "È"). Everything written to the
    // page goes through here.
    const safe = (t: string) => t
      .replace(/ψ/g, 'psi').replace(/[–—]/g, '-')
      .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
      .replace(/≈/g, '~').replace(/×/g, 'x').replace(/⇒/g, '=>');
    const PW = 210, PH = 297, M = 12;
    let y = 16;
    const need = (mm: number) => { if (y + mm > PH - M) { doc.addPage(); y = M + 4; } };
    const line = (t: string, size = 9, colour = 90) => {
      need(6); doc.setFontSize(size); doc.setTextColor(colour); doc.text(safe(t), M, y); y += size * 0.52 + 1.6;
    };

    doc.setFontSize(16); doc.setTextColor(20); doc.setFont('helvetica', 'bold');
    doc.text(safe(`SailTrim — ${boat || 'unnamed boat'}`), M, y); y += 7;
    doc.setFont('helvetica', 'normal');
    line([fileName, capturedAt || '', `${imgSize.w}×${imgSize.h}`].filter(Boolean).join('   ·   '), 10);
    y += 2;

    // Fit the frame inside the box preserving its aspect. Clamping the HEIGHT
    // while keeping the full column width - which is what this did - stretches a
    // portrait frame sideways: 186 mm wide against a 120 mm cap is a 2:3 photo
    // drawn at 3:2. Scale both sides by the same factor and centre the result.
    const boxW = PW - 2 * M, boxH = 150;
    const picScale = Math.min(boxW / W, boxH / H);
    const picW = W * picScale, picH = H * picScale;
    need(picH + 4);
    doc.addImage(pic, 'JPEG', M + (boxW - picW) / 2, y, picW, picH); y += picH + 7;

    // ── the numbers ──────────────────────────────────────────────────────────
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20);
    need(8); doc.text('Measurements (mm)', M, y); y += 6;
    const cols = ['', 'across the mast', 'horizontal', 'Rhino-equivalent'];
    const cw = [52, 44, 44, 44];
    const row = (cells: string[], bold = false) => {
      need(6);
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(9); doc.setTextColor(bold ? 20 : 45);
      let x = M;
      cells.forEach((c, i) => { doc.text(safe(c), x, y); x += cw[i]; });
      y += 5.2;
    };
    row(cols, true);
    for (const m of measurements) {
      row([
        m.label,
        `${Math.abs(m.boatFrameMm).toFixed(0)} ± ${m.boatFrameSigmaMm.toFixed(0)}`,
        `${Math.abs(m.worldHorizontalMm).toFixed(0)} ± ${m.worldHorizontalSigmaMm.toFixed(0)}`,
        `${Math.abs(m.naiveMm).toFixed(0)}  (${((Math.abs(m.naiveMm) / Math.abs(m.boatFrameMm) - 1) * 100).toFixed(1)}%)`,
      ]);
    }
    y += 3;
    line('The 6 Sept compilation panels are rotated to stand the mast up, so the speed team\u2019s', 8, 110);
    line('existing numbers are the across-the-mast column. The Rhino-equivalent column is what', 8, 110);
    line('the old method gives on this same frame: image-horizontal, mast-plane scale, \u03c8 = 0.', 8, 110);
    y += 3;

    // ── how the camera was standing ──────────────────────────────────────────
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20);
    need(8); doc.text('Camera', M, y); y += 6;
    doc.setFont('helvetica', 'normal');
    line(`scale ${cal.mmPerPxAtMast.toFixed(2)} mm/px at the mast`
      + (cal.rangeMm ? `  ·  range ${(cal.rangeMm / 1000).toFixed(0)} m` : '  ·  range unknown (no focal length)'));
    line(cal.psi.measured
      ? `\u03c8 ${cal.psi.deg.toFixed(2)}\u00b0 \u00b1 ${cal.psi.sigmaDeg.toFixed(2)}\u00b0, measured from the centreplane baseline and corrected for`
      : '\u03c8 not measured \u2014 assumed 0 \u00b1 1\u00b0, and a degree of \u03c8 is \u00b117 mm for every metre a target sits from the mast');
    const ih = imageHeelDeg(cal.axis, cal.horizon);
    line(horizon
      ? `horizon ${horizon.tiltDeg.toFixed(2)}\u00b0 (${horizon.samples} columns, rms ${horizon.rms.toFixed(1)} px)`
        + (ih != null ? `  ·  heel from the photo ${Math.abs(ih).toFixed(2)}\u00b0` : '')
        + (cal.heelDeg != null ? `, logged ${Math.abs(cal.heelDeg).toFixed(1)}\u00b0` : '')
      : 'no horizon found \u2014 world-horizontal falls back to the logged heel');

    // ── what it is still assuming ────────────────────────────────────────────
    const failed = checks.filter((c) => !c.ok);
    if (gaps.length || failed.length) {
      y += 3;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20);
      need(8); doc.text('Read this before quoting the numbers', M, y); y += 6;
      doc.setFont('helvetica', 'normal');
      for (const g of gaps) for (const t of doc.splitTextToSize(safe(`\u2022 ${g}`), PW - 2 * M) as string[]) line(t, 9, 60);
      for (const c of failed) for (const t of doc.splitTextToSize(safe(`\u2022 ${c.label}: ${c.detail}`), PW - 2 * M) as string[]) line(t, 9, 60);
    }

    need(10);
    doc.setFontSize(7.5); doc.setTextColor(140);
    doc.text(safe(`${SAILTRIM_VERSION}  ·  geometry per docs/sail-geometry-from-astern-2026-09.md`), M, PH - 8);
    doc.save(`${base()}.sailtrim.pdf`);
  };

  const keepFrame = () => {
    if (!measurements.length) return;
    setKept((k) => [...k, {
      id: Date.now(), photo: fileName, boat, capturedAt, measurements,
      psiMeasured: calibration.cal?.psi.measured ?? false,
    }]);
  };

  // ── rig model editing ────────────────────────────────────────────────────
  type Patch = Partial<{ mm: number; sigmaMm: number; source: Provenance; depthMm: number }>;
  const setScaleField = (key: string, patch: Patch) => {
    setRig((m) => {
      const next = { ...m, scaleRefs: m.scaleRefs.map((s) => (s.key === key ? { ...s, ...patch } : s)) };
      saveRigModel(next); return next;
    });
  };
  const setBaselineField = (key: string, patch: Patch) => {
    setRig((m) => {
      const next = { ...m, baselines: m.baselines.map((b) => (b.key === key ? { ...b, ...patch } : b)) };
      saveRigModel(next); return next;
    });
  };
  const setDepthField = (key: keyof RigModel['depths'], patch: Patch) => {
    setRig((m) => {
      const next = { ...m, depths: { ...m.depths, [key]: { ...m.depths[key], ...patch } } };
      saveRigModel(next); return next;
    });
  };

  // ── styles ────────────────────────────────────────────────────────────────
  const panel: React.CSSProperties = { background: '#0B2136', border: '1px solid #1E3A5A', borderRadius: 8, padding: 12, marginBottom: 10 };
  const hdr: React.CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: 0.6, color: '#7DD3FC', textTransform: 'uppercase', marginBottom: 8 };
  const inp: React.CSSProperties = { background: '#04121F', border: '1px solid #1E3A5A', borderRadius: 5, color: '#E2E8F0', padding: '5px 7px', fontSize: 13, width: '100%' };
  const lbl: React.CSSProperties = { fontSize: 11, color: '#94A3B8', display: 'block', marginBottom: 3 };
  const btn = (primary = false): React.CSSProperties => ({
    background: primary ? '#0EA5E9' : '#123253', color: primary ? '#03121F' : '#CBD5E1',
    border: '1px solid #1E3A5A', borderRadius: 6, padding: '6px 11px',
    fontSize: 12, fontWeight: 700, cursor: 'pointer',
  });
  const srcPill = (s: Provenance): React.CSSProperties => ({
    fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4,
    padding: '2px 5px', borderRadius: 4, whiteSpace: 'nowrap',
    background: s === 'estimate' ? '#422006' : '#052E16',
    color: s === 'estimate' ? '#FCD34D' : '#4ADE80',
  });

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: '#030F1A', color: '#E2E8F0', fontFamily: 'system-ui, sans-serif' }}>

      {/* ── canvas ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { downRef.current = null; dragRef.current = null; setHover(null); }}
          onWheel={onWheel}
          style={{ width: '100%', height: '100%', display: 'block', cursor: imgSize ? 'crosshair' : 'default', touchAction: 'none' }}
        />
        {!imageSrc && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, pointerEvents: 'none' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Open an astern frame</div>
            <div style={{ fontSize: 12, color: '#64748B', maxWidth: 440, textAlign: 'center', lineHeight: 1.55 }}>
              The <b>original</b> camera file. A speed-team compilation panel has been
              cropped, upscaled and — as the 6 Sept set shows — rotated to stand the
              mast up, which silently changes what &ldquo;horizontal&rdquo; means.
            </div>
          </div>
        )}
        {imgSize && (
          <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
            <button style={btn()} onClick={() => fitToView(imgSize.w, imgSize.h)}>Fit</button>
            <button style={btn()} onClick={() => zoomAboutCentre(2)}>+</button>
            <button style={btn()} onClick={() => zoomAboutCentre(0.5)}>−</button>
            <span style={{ fontSize: 11, color: '#64748B' }}>
              {imgSize.w}×{imgSize.h} · {(zoom * 100).toFixed(0)}%
              {calibration.cal ? ` · ${calibration.cal.mmPerPxAtMast.toFixed(2)} mm/px` : ''}
            </span>
          </div>
        )}
        {imageSrc && (
          <canvas
            ref={loupeRef} width={176} height={176}
            style={{ position: 'absolute', right: 10, top: 10, width: 176, height: 176, borderRadius: 6, border: '1px solid #1E3A5A', pointerEvents: 'none', background: '#04121F' }}
          />
        )}
      </div>

      {/* ── side panel ──────────────────────────────────────────────────── */}
      <div style={{ width: 400, flexShrink: 0, overflowY: 'auto', borderLeft: '1px solid #1E3A5A', padding: 12, background: '#061A2B' }}>

        <div style={panel}>
          <div style={hdr}>Photo</div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
          <button style={btn(true)} onClick={() => fileRef.current?.click()}>Open frame…</button>
          {loadingFrame && !imgSize && (
            <div style={{ fontSize: 11, color: '#7DD3FC', marginTop: 7 }}>Fetching the full-resolution original…</div>
          )}
          {loadError && (
            <div style={{ fontSize: 11, color: '#FCA5A5', marginTop: 7, lineHeight: 1.45 }}>{loadError}</div>
          )}
          {fileName && <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 7, wordBreak: 'break-all' }}>{fileName}{capturedAt ? ` · ${capturedAt}` : ''}</div>}
          {exifNote && <div style={{ fontSize: 11, color: focalMm ? '#64748B' : '#FCD34D', marginTop: 5, lineHeight: 1.45 }}>{exifNote}</div>}
          {imgSize && (
            <div style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5, color: horizon ? '#4ADE80' : '#FCD34D' }}>
              {horizon
                ? `Horizon at ${horizon.tiltDeg.toFixed(2)}° — ${horizon.samples} columns, rms ${horizon.rms.toFixed(1)} px. World-horizontal is measured, not assumed.`
                : (horizonNote || 'Looking for the horizon…')}
              {!horizon && <> <button style={{ ...btn(), padding: '3px 8px' }} onClick={retryHorizon}>Retry</button></>}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <label style={lbl}>Boat</label>
            <input style={inp} value={boat} onChange={(e) => setBoat(e.target.value)} placeholder="Northstar 76" />
          </div>
        </div>

        {/* steps */}
        <div style={panel} data-testid="sailtrim-steps">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{ ...hdr, flex: 1 }}>Marks</div>
            <div style={{ display: 'flex', gap: 3 }}>
              {([
                ['line', 'two points'],
                ['manual', 'edges'],
                ['auto', 'auto-trace'],
              ] as const).map(([mode, text]) => (
                <button key={mode} style={{ ...btn(mastMode === mode), padding: '3px 7px', fontSize: 10 }}
                  onClick={() => { setMastMode(mode); setActiveStep(0); }}>
                  {text}
                </button>
              ))}
            </div>
          </div>
          {steps.map((s, i) => {
            const pts = marks[s.key] || [];
            const done = pts.length >= s.min;
            const active = i === activeStep;
            const firstOfGroup = i === 0 || steps[i - 1].group !== s.group;
            return (
              <div key={s.key} style={{ marginBottom: 5 }}>
                {firstOfGroup && (
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: '#475569', textTransform: 'uppercase', margin: i === 0 ? '0 0 5px' : '11px 0 5px' }}>
                    {s.group === 'calibrate' ? 'Calibrate the frame' : 'Measure'}
                  </div>
                )}
                <div
                  onClick={() => setActiveStep(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    background: active ? '#123253' : 'transparent', borderRadius: 5,
                    padding: '5px 7px', border: `1px solid ${active ? '#1E3A5A' : 'transparent'}`,
                  }}
                >
                  <span style={{ width: 9, height: 9, borderRadius: 9, background: done ? s.colour : 'transparent', border: `2px solid ${s.colour}`, flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: active ? 800 : 600, color: done ? '#E2E8F0' : '#94A3B8' }}>{s.label}</span>
                  {s.optional && !done && <span style={{ fontSize: 10, color: '#64748B' }}>optional</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748B' }}>{pts.length}/{s.max === s.min ? s.max : `${s.min}–${s.max}`}</span>
                </div>
                {active && (
                  <div style={{ padding: '6px 7px 2px 24px' }}>
                    <div style={{ fontSize: 11.5, color: '#94A3B8', lineHeight: 1.5 }}>{s.hint}</div>
                    {s.key === 'mastSeed' && mastTrace && (
                      <div style={{ fontSize: 11, color: '#4ADE80', marginTop: 5, lineHeight: 1.5 }}>
                        Traced {(100 * mastTrace.spanPx / (imgSize?.h || 1)).toFixed(0)}% of the frame&rsquo;s height;
                        {' '}scatter {mastTrace.rms.toFixed(0)} px about a straight line, which is mast bend.
                      </div>
                    )}
                    {s.key === 'mastSeed' && traceNote && (
                      <div style={{ fontSize: 11, color: '#FCD34D', marginTop: 5, lineHeight: 1.5 }}>{traceNote}</div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button style={btn()} onClick={() => undoPoint(s.key)} disabled={!pts.length}>Undo</button>
                      <button style={btn()} onClick={() => clearStep(s.key)} disabled={!pts.length}>Clear</button>
                      {i < steps.length - 1 && <button style={btn()} onClick={() => setActiveStep(i + 1)}>Next →</button>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: '#64748B', marginTop: 6, lineHeight: 1.5 }}>
            Click to place · drag a cross to nudge it · drag elsewhere to pan · wheel to zoom.
          </div>
        </div>

        {/* what the boat contributes */}
        <div style={panel}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{ ...hdr, flex: 1 }}>Rig model — {boat || 'no boat'}</div>
            <button style={{ ...btn(), padding: '3px 8px', fontSize: 10.5 }} onClick={() => setRigOpen((v) => !v)}>
              {rigOpen ? 'done' : 'edit'}
            </button>
          </div>
          {gaps.length > 0 && (
            <div style={{ fontSize: 11, color: '#FCD34D', lineHeight: 1.55, marginBottom: 8 }}>
              Still guesswork: {gaps.join('; ')}. Every measurement below inherits that
              as uncertainty, and says so.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lbl}>Scale reference</label>
              <select style={inp} value={scaleKey} onChange={(e) => setScaleKey(e.target.value)}>
                {rig.scaleRefs.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>True length (mm)</label>
              <input style={inp} type="number" value={scaleRef?.mm ?? 0}
                onChange={(e) => setScaleField(scaleKey, { mm: Number(e.target.value), source: 'designer' })} />
            </div>
            <div>
              <label style={lbl}>± (mm)</label>
              <input style={inp} type="number" value={scaleRef?.sigmaMm ?? 0}
                onChange={(e) => setScaleField(scaleKey, { sigmaMm: Number(e.target.value) })} />
            </div>
            {/* Only shown for a reference that is not in the mast plane — for a
                spreader it is 0 and asking about it would be noise. The wheels
                are the case it exists for. */}
            {(scaleRef?.depthMm ?? 0) !== 0 && (
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={lbl}>…and how far abaft the mast (mm, forward positive)</label>
                <input style={inp} type="number" value={scaleRef?.depthMm ?? 0}
                  onChange={(e) => setScaleField(scaleKey, { depthMm: Number(e.target.value) })} />
                <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 4, lineHeight: 1.45 }}>
                  This reference is off the mast plane, so it images at a different
                  scale from the mast — abaft is nearer the camera and larger. The
                  tool refers it back, which needs the focal length; without one the
                  bias goes straight into every measurement, and the checks say so.
                </div>
              </div>
            )}
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={srcPill(scaleRef?.source ?? 'estimate')}>{scaleRef?.source ?? 'estimate'}</span>
              <span style={{ fontSize: 10.5, color: '#64748B' }}>
                {scaleRef?.source === 'estimate'
                  ? 'typing a length marks it as the designer’s'
                  : `scale known to ${(100 * scaleRelSigma(scaleRef)).toFixed(2)} %`}
              </span>
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lbl}>Centreplane baseline</label>
              <select style={inp} value={baselineKey} onChange={(e) => setBaselineKey(e.target.value)}>
                {rig.baselines.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Fore–aft apart (mm)</label>
              <input style={inp} type="number" value={baseRef?.mm ?? 0}
                onChange={(e) => setBaselineField(baselineKey, { mm: Number(e.target.value), source: 'designer' })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <span style={srcPill(baseRef?.source ?? 'estimate')}>{baseRef?.source ?? 'estimate'}</span>
            </div>

            <div>
              <label style={lbl}>Heel (°, from the log)</label>
              <input style={inp} type="number" step="0.1" value={heelDeg} onChange={(e) => setHeelDeg(e.target.value)} placeholder="23.5" />
            </div>
            <div>
              <label style={lbl}>Focal length (mm)</label>
              <input style={inp} type="number" value={focalMm} onChange={(e) => setFocalMm(e.target.value)} placeholder="254" />
            </div>
          </div>

          {rigOpen && (
            <div style={{ marginTop: 10, borderTop: '1px solid #123253', paddingTop: 9 }}>
              <div style={{ fontSize: 11, color: '#64748B', marginBottom: 8, lineHeight: 1.55 }}>
                Fore-and-aft offsets from the mast, forward positive — so the boom is
                negative. These set the depth correction and how much ψ costs.
              </div>
              {(['leech', 'mainLeech', 'clew', 'boom'] as const).map((k) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '68px 1fr 1fr 66px', gap: 6, alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ fontSize: 11.5, color: '#94A3B8' }}>
                    {k === 'leech' ? 'jib leech' : k === 'mainLeech' ? 'main leech' : k}
                  </span>
                  <input style={inp} type="number" value={rig.depths[k].mm}
                    onChange={(e) => setDepthField(k, { mm: Number(e.target.value), source: 'designer' })} />
                  <input style={inp} type="number" value={rig.depths[k].sigmaMm}
                    onChange={(e) => setDepthField(k, { sigmaMm: Number(e.target.value) })} />
                  <span style={srcPill(rig.depths[k].source)}>{rig.depths[k].source}</span>
                </div>
              ))}
              <div style={{ fontSize: 10.5, color: '#64748B', marginBottom: 9 }}>value · ± (mm)</div>
              {/* The fleet's dimensions already exist, measured and endorsed,
                  on an IRC certificate — yours and every rival's. P is the one
                  that matters: the mast lies in the image plane seen from
                  astern, so the mainsail hoist sets the scale over a 31 m
                  baseline instead of a spreader's 6 m. */}
              <div style={{ marginBottom: 9 }}>
                <label style={lbl}>Paste an IRC certificate (select all in the PDF, copy, paste here)</label>
                <textarea
                  style={{ ...inp, height: 62, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
                  value={certText}
                  onChange={(e) => setCertText(e.target.value)}
                  placeholder="IRC Boat Data … J 8.86 … E 10.33 … P 31.44"
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 5, alignItems: 'center' }}>
                  <button style={btn(true)} disabled={!certText.trim()} onClick={() => {
                    const cert = parseIrcCertificate(certText);
                    if (!cert) { setCertNote('That does not read as an IRC certificate — nothing changed.'); return; }
                    const m = rigModelFromIrc(cert);
                    const withBoat = { ...m, boat: m.boat || boat };
                    setRig(withBoat); saveRigModel(withBoat);
                    if (withBoat.boat && withBoat.boat !== boat) setBoat(withBoat.boat);
                    setScaleKey('P'); setBaselineKey('tack-mast');
                    setCertNote(`${cert.name || 'boat'} — P ${cert.rig.p} m, J ${cert.rig.j} m, E ${cert.rig.e} m. Scale set to P.`);
                    setCertText('');
                  }}>Read certificate</button>
                  {certNote && <span style={{ fontSize: 10.5, color: certNote.startsWith('That does not') ? '#FCD34D' : '#4ADE80', lineHeight: 1.4 }}>{certNote}</span>}
                </div>
                <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 5, lineHeight: 1.5 }}>
                  Or run <code>npm run irc:rigmodel -- &lt;folder of PDFs&gt; --out models</code> and
                  import the JSON below — that also does the whole fleet at once.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btn()} onClick={() => download(exportRigModel(rig), `${(boat || 'rig').replace(/\W+/g, '-')}.rigmodel.json`, 'application/json')}>Export model</button>
                <button style={btn()} onClick={() => importRef.current?.click()}>Import…</button>
                <input ref={importRef} type="file" accept="application/json" style={{ display: 'none' }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0]; e.target.value = '';
                    if (!f) return;
                    const m = importRigModel(await f.text());
                    if (m) { const withBoat = { ...m, boat: m.boat || boat }; setRig(withBoat); saveRigModel(withBoat); }
                  }} />
              </div>
            </div>
          )}
        </div>

        {/* results */}
        <div style={panel}>
          <div style={hdr}>Measurements</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
            {(['boat', 'world'] as const).map((d) => (
              <button key={d} onClick={() => setDefn(d)}
                style={{ ...btn(defn === d), flex: 1, fontSize: 11 }}>
                {d === 'boat' ? 'Across the mast' : 'Horizontal'}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#64748B', marginBottom: 9, lineHeight: 1.5 }}>
            {defn === 'boat'
              ? 'Perpendicular to the mast — the boat-frame athwartships distance, and what the speed team’s own numbers turn out to be. Independent of heel and of camera roll.'
              : 'Horizontal in the real world. Equals the across-the-mast number ÷ cos(heel) — 8.6 % more at 23° of heel.'}
          </div>

          {!calibration.cal && <div style={{ fontSize: 12, color: '#FCD34D' }}>{calibration.why}</div>}

          {measurements.map((m) => {
            const primary = defn === 'boat' ? m.boatFrameMm : m.worldHorizontalMm;
            const sigma = defn === 'boat' ? m.boatFrameSigmaMm : m.worldHorizontalSigmaMm;
            const other = defn === 'boat' ? m.worldHorizontalMm : m.boatFrameMm;
            return (
              <div key={m.key} style={{ borderTop: '1px solid #123253', padding: '8px 0' }}>
                <div style={{ fontSize: 12, color: '#94A3B8' }}>{m.label}</div>
                <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: -0.5 }}>
                  {fmt(Math.abs(primary))}<span style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}> ± {fmt(sigma)} mm</span>
                </div>
                <div style={{ fontSize: 11, color: '#64748B', marginTop: 3, lineHeight: 1.6 }}>
                  {defn === 'boat' ? 'horizontal' : 'across the mast'} {fmt(Math.abs(other))} ·
                  {' '}Rhino-equivalent {fmt(Math.abs(m.naiveMm))}
                  {' '}({m.naiveMm && primary ? `${((Math.abs(m.naiveMm) / Math.abs(primary) - 1) * 100).toFixed(1)}%` : '—'})
                </div>
              </div>
            );
          })}
          {measurements.length > 0 && (
            <button style={{ ...btn(true), marginTop: 9 }} onClick={keepFrame}>Keep this frame</button>
          )}
        </div>

        {/* the A/B the speed team actually does */}
        {kept.length > 0 && (
          <div style={panel}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ ...hdr, flex: 1 }}>Kept frames</div>
              <button style={{ ...btn(), padding: '3px 8px', fontSize: 10.5 }} onClick={() => setKept([])}>clear</button>
            </div>
            <div style={{ fontSize: 11, color: '#64748B', marginBottom: 8, lineHeight: 1.5 }}>
              Two boats, or one boat twice. The gap is what gets acted on, so it is shown
              with the two sigmas combined — the honest test of whether the difference is
              real.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ color: '#7DD3FC', textAlign: 'left' }}>
                  <th style={{ padding: '3px 2px', fontWeight: 700 }}>frame</th>
                  <th style={{ padding: '3px 2px', fontWeight: 700 }}>leech</th>
                  <th style={{ padding: '3px 2px', fontWeight: 700 }}>clew</th>
                  <th style={{ padding: '3px 2px', fontWeight: 700 }}>boom</th>
                </tr>
              </thead>
              <tbody>
                {kept.map((k) => (
                  <tr key={k.id} style={{ borderTop: '1px solid #123253' }}>
                    <td style={{ padding: '4px 2px', color: '#94A3B8' }}>
                      {k.boat || k.photo.slice(0, 14)}
                      {!k.psiMeasured && <span title="ψ was not measured on this frame" style={{ color: '#FCD34D' }}> !</span>}
                    </td>
                    {(['leechSpr2', 'clew', 'boom'] as const).map((key) => {
                      const m = k.measurements.find((x) => x.key === key);
                      const v = m ? (defn === 'boat' ? m.boatFrameMm : m.worldHorizontalMm) : null;
                      return <td key={key} style={{ padding: '4px 2px' }}>{v == null ? '—' : fmt(Math.abs(v))}</td>;
                    })}
                  </tr>
                ))}
                {kept.length >= 2 && (() => {
                  const a = kept[kept.length - 2], b = kept[kept.length - 1];
                  return (
                    <tr style={{ borderTop: '2px solid #1E3A5A', fontWeight: 700 }}>
                      <td style={{ padding: '5px 2px', color: '#7DD3FC' }}>Δ last two</td>
                      {(['leechSpr2', 'clew', 'boom'] as const).map((key) => {
                        const ma = a.measurements.find((x) => x.key === key);
                        const mb = b.measurements.find((x) => x.key === key);
                        if (!ma || !mb) return <td key={key} style={{ padding: '5px 2px' }}>—</td>;
                        const va = defn === 'boat' ? ma.boatFrameMm : ma.worldHorizontalMm;
                        const vb = defn === 'boat' ? mb.boatFrameMm : mb.worldHorizontalMm;
                        const sa = defn === 'boat' ? ma.boatFrameSigmaMm : ma.worldHorizontalSigmaMm;
                        const sb = defn === 'boat' ? mb.boatFrameSigmaMm : mb.worldHorizontalSigmaMm;
                        const d = Math.abs(vb) - Math.abs(va);
                        const s = Math.hypot(sa, sb);
                        return (
                          <td key={key} style={{ padding: '5px 2px', color: Math.abs(d) > s ? '#4ADE80' : '#FCD34D' }}>
                            {d > 0 ? '+' : ''}{fmt(d)} ± {fmt(s)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })()}
              </tbody>
            </table>
            {kept.length >= 2 && (
              <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 7, lineHeight: 1.5 }}>
                Green: the gap is bigger than the combined uncertainty. Amber: the two are
                not distinguishable by this measurement on these frames.
              </div>
            )}
          </div>
        )}

        {/* checks */}
        {checks.length > 0 && (
          <div style={panel}>
            <div style={hdr}>Checks</div>
            {checks.map((c) => (
              <div key={c.key} style={{ display: 'flex', gap: 7, marginBottom: 7, alignItems: 'flex-start' }}>
                <span style={{ color: c.ok ? '#4ADE80' : '#FCD34D', fontSize: 12, lineHeight: 1.4 }}>{c.ok ? '✓' : '!'}</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: c.ok ? '#CBD5E1' : '#FCD34D' }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: '#64748B', lineHeight: 1.5 }}>{c.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* save back onto the photo this was opened from */}
        {onSaveToPhoto && (
          <div style={{ ...panel, borderColor: '#38BDF850' }}>
            <div style={hdr}>Save to photo</div>
            <div style={{ fontSize: 11, color: '#94A3B8', lineHeight: 1.5, marginBottom: 8 }}>
              Writes these measurements onto{photoLabel ? ` ${photoLabel}` : ' the photo'} so
              they travel with it — every teammate, the gallery and the timeline see them,
              not just this browser.
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, color: '#CBD5E1', cursor: 'pointer', marginBottom: 9, lineHeight: 1.45 }}>
              <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)}
                style={{ marginTop: 2, accentColor: '#38BDF8' }} />
              <span>
                Draw the lines on the picture
                <span style={{ color: '#64748B' }}> — the three measurements and the mast axis,
                  burned in beside the instrument overlay. Can be turned off again on the photo.</span>
              </span>
            </label>
            <button data-testid="sailtrim-save-to-photo" style={btn(true)}
              disabled={!measurements.length || saveState === 'saving'} onClick={saveToPhoto}>
              {saveState === 'saving' ? 'Saving…' : 'Save to photo'}
            </button>
            {saveState === 'saved' && (
              <div style={{ fontSize: 11, color: '#4ADE80', marginTop: 7, lineHeight: 1.45 }}>Saved · {saveMsg}</div>
            )}
            {saveState === 'saved' && saveWarn && (
              <div style={{ fontSize: 11, color: '#FCD34D', marginTop: 5, lineHeight: 1.45 }}>{saveWarn}</div>
            )}
            {saveState === 'error' && (
              <div style={{ fontSize: 11, color: '#FCA5A5', marginTop: 7, lineHeight: 1.45 }}>{saveMsg}</div>
            )}
            {!measurements.length && (
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 7 }}>
                Nothing to save yet — mark the mast, a scale reference and at least one target.
              </div>
            )}
          </div>
        )}

        {/* export */}
        <div style={{ ...panel, marginBottom: 24 }}>
          <div style={hdr}>Export</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={btn()} disabled={!measurements.length}
              onClick={() => download(JSON.stringify(result(), null, 2), `${base()}.sailtrim.json`, 'application/json')}>
              JSON
            </button>
            <button style={btn()} disabled={!measurements.length}
              onClick={() => download(toCsv(result()), `${base()}.sailtrim.csv`, 'text/csv')}>
              CSV
            </button>
            <button style={btn(true)} disabled={!measurements.length} onClick={exportPdf}>
              PDF
            </button>
            <button style={btn()} disabled={kept.length === 0}
              onClick={() => download(
                kept.map((k, i) => {
                  const csv = toCsv({ ...result(), photo: k.photo, boat: k.boat, capturedAt: k.capturedAt, measurements: k.measurements });
                  return i === 0 ? csv : csv.split('\n').slice(1).join('\n');
                }).join('\n'),
                'sailtrim-session.csv', 'text/csv')}>
              Session CSV
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#64748B', marginTop: 7, lineHeight: 1.5 }}>
            The JSON carries every mark and the rig model that was in force, so a
            measurement can be reopened and argued with — and so these become the
            training labels for the automatic detector.
          </div>
        </div>
      </div>
    </div>
  );
}
