'use client';
// src/components/SailScanTab.tsx
// ─────────────────────────────────────────────────────────────────────────────
// SailScan v1 — manual trim-stripe digitisation + spline analysis.
//
// Mobile-first. Reuses the touch / zoom / pan / long-press / blob-URL
// patterns established in SquashShotsApp:
//   - Camera capture → JPEG blob via canvas.toBlob (preserves full resolution)
//   - File picker uses createObjectURL (no big data-URL strings)
//   - Crosshairs and lines sized in screen pixels (px() helper) so they look
//     identical regardless of source-image resolution
//   - Long-press to place point (1.5s, 20px tolerance)
//   - Pinch zoom dampened to 40%, wheel zoom 0.97/1.03, pan 1.5× snappier
//
// The user marks each trim stripe by long-pressing in this order:
//   1) luff endpoint, 2) leech endpoint, 3+) midpoint(s) along the curve.
// A natural cubic spline is fit through the points (in chord-relative space)
// and per-stripe metrics + inter-stripe twist are computed.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { computeStripeMetrics, splinePolyline, computeTwist } from '../lib/sailscan';
import {
  ensureOpenCV, getCV, applyClahe, structureTensor,
  horizontalOnlyEdges, colorizeOrientation, matToCanvas, imageToMat,
  detectStripeFromTap,
} from '../lib/sailscan-cv';
import { getYachtPrefs, setYachtPref } from '../lib/yacht-prefs';

type Step = 'select' | 'live' | 'preview' | 'mark' | 'results';
interface P { x: number; y: number; }
interface Stripe { luff: P | null; leech: P | null; mid: P[]; }

type DragTarget =
  | { stripeIdx: number; role: 'luff' | 'leech' }
  | { stripeIdx: number; role: 'mid'; midIdx: number };

const STRIPE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#a855f7'];
const ENDPOINT_LUFF_COLOR = '#3b82f6';
const ENDPOINT_LEECH_COLOR = '#ef4444';
const MID_COLOR = '#fbbf24';

const newStripe = (): Stripe => ({ luff: null, leech: null, mid: [] });

export default function SailScanTab() {
  const [step, setStep] = useState<Step>('select');
  const [previewSrc, setPreviewSrc] = useState<string>('');
  const [imageSrc, setImageSrc] = useState<string>('');
  const [stripes, setStripes] = useState<Stripe[]>([newStripe()]);
  const [activeIdx, setActiveIdx] = useState(0);

  // ── pan / zoom ────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<P>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<P>({ x: 0, y: 0 });
  const [initialPan, setInitialPan] = useState<P>({ x: 0, y: 0 });
  const [initialDist, setInitialDist] = useState(0);
  const [initialZoom, setInitialZoom] = useState(1);

  // ── drag state ────────────────────────────────────────────────────────────
  const [dragging, setDragging] = useState<DragTarget | null>(null);

  // ── long-press state (for placing new points) ─────────────────────────────
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressCoords = useRef<P | null>(null);
  const touchMoved = useRef(false);
  const touchStartPos = useRef<P | null>(null);
  const MOVE_THRESHOLD = 20;

  // ── camera ────────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);

  // ── canvas / overlay ──────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cachedImage = useRef<HTMLImageElement | null>(null);
  const cachedImageSrc = useRef<string>('');

  // ── file inputs ───────────────────────────────────────────────────────────
  const fileAlbumRef = useRef<HTMLInputElement>(null);
  const fileBrowserRef = useRef<HTMLInputElement>(null);
  const [activeButton, setActiveButton] = useState<string | null>(null);
  // Original File handle, kept so we can extract EXIF later (object URLs lose it)
  const originalFile = useRef<File | null>(null);

  // ── v2 Phase A: CV debug pane state ──────────────────────────────────────
  type DebugView = 'off' | 'clahe' | 'orientation' | 'edges';
  const [debugView,       setDebugView]       = useState<DebugView>('off');
  const [debugProcessing, setDebugProcessing] = useState(false);
  const [debugError,      setDebugError]      = useState<string>('');
  // Offscreen canvas — receives the CV-pipeline output. Not in the DOM; its
  // sole job is to be a bitmap source for drawScene, which then renders it
  // into the marking canvas with the same pan/zoom transform as the photo.
  const debugCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Bumped after each successful debug paint so drawScene re-runs.
  const [debugVersion, setDebugVersion] = useState(0);

  // ── v2 Phase B: tap-the-luff auto-detect state ───────────────────────────
  // When autoDetectMode is on, a single tap on the marking canvas is treated
  // as a "luff seed" — we run colour-segmentation around the tap, find the
  // connected component, sample a centerline, and push the resulting
  // {luff, leech, mid[]} into the active stripe. Manual long-press flow
  // continues to work when autoDetectMode is off.
  const [autoDetectMode, setAutoDetectMode] = useState(false);
  const [autoDetecting,  setAutoDetecting]  = useState(false);
  const [autoDetectMsg,  setAutoDetectMsg]  = useState<string>('');
  // The yacht-prefs key uses the boat name from xmlData.meta.boat when we
  // wire it through; for Phase B we use 'default' so the colour learned from
  // the user's first tap persists across scans on the same device.
  const yachtKey: string | null = null;

  // ── timestamp + save-to-Photos state ─────────────────────────────────────
  const [photoTimestamp, setPhotoTimestamp] = useState<string>('');     // datetime-local string
  const [exifTimestamp,  setExifTimestamp]  = useState<number | null>(null);
  const [timezone,       setTimezone]       = useState<string>('UTC');
  const [showTimestampInput, setShowTimestampInput] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMsg,    setSaveMsg]    = useState<string>('');

  // ── camera lifecycle ──────────────────────────────────────────────────────
  const stopCamera = () => {
    if (cameraStream.current) {
      cameraStream.current.getTracks().forEach(t => t.stop());
      cameraStream.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };
  useEffect(() => () => stopCamera(), []);
  useEffect(() => {
    if (step === 'live' && videoRef.current && cameraStream.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = cameraStream.current;
    }
  }, [step]);

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 4032 }, height: { ideal: 3024 }, facingMode: 'environment' },
      });
      cameraStream.current = stream;
      setStep('live');
    } catch {
      alert('Camera access denied. Please allow camera access in your browser settings.');
    }
  };

  const takePicture = () => {
    if (!videoRef.current || !captureCanvasRef.current) return;
    const ctx = captureCanvasRef.current.getContext('2d');
    if (!ctx) return;
    captureCanvasRef.current.width = videoRef.current.videoWidth;
    captureCanvasRef.current.height = videoRef.current.videoHeight;
    ctx.drawImage(videoRef.current, 0, 0);
    captureCanvasRef.current.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      setPreviewSrc(url);
      setStep('preview');
    }, 'image/jpeg', 1.0);
    stopCamera();
  };

  const usePicture = () => {
    originalFile.current = null;          // camera capture has no EXIF
    setImageSrc(previewSrc);
    setPreviewSrc('');
    setStripes([newStripe()]);
    setActiveIdx(0);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setStep('mark');
  };

  const retakePicture = () => {
    if (previewSrc) URL.revokeObjectURL(previewSrc);
    setPreviewSrc('');
    openCamera();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setActiveButton(null); return; }
    originalFile.current = file;          // keep for EXIF later
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    stopCamera();
    setStripes([newStripe()]);
    setActiveIdx(0);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setActiveButton(null);
    setStep('mark');
    e.target.value = '';
  };

  // ── coordinate helpers (canvas-pixel ↔ image-pixel) ──────────────────────
  const getCanvasCoords = (clientX: number, clientY: number): P => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width, sy = c.height / rect.height;
    return {
      x: ((clientX - rect.left) * sx - pan.x * zoom) / zoom,
      y: ((clientY - rect.top)  * sy - pan.y * zoom) / zoom,
    };
  };
  const getImageScale = (): number => {
    if (!canvasRef.current) return 1;
    const rect = canvasRef.current.getBoundingClientRect();
    return canvasRef.current.width / (rect.width || 1);
  };

  // ── find the nearest existing point across ALL stripes ───────────────────
  const findNearPoint = (coords: P): DragTarget | null => {
    const scale = getImageScale();
    const threshold = (50 * scale) / zoom;
    let best: DragTarget | null = null;
    let bestDist = threshold;
    stripes.forEach((s, si) => {
      const checkPt = (pt: P | null, role: 'luff' | 'leech', midIdx?: number) => {
        if (!pt) return;
        const d = Math.hypot(pt.x - coords.x, pt.y - coords.y);
        if (d < bestDist) {
          bestDist = d;
          if (role === 'luff' || role === 'leech') {
            best = { stripeIdx: si, role };
          }
        }
      };
      checkPt(s.luff, 'luff');
      checkPt(s.leech, 'leech');
      s.mid.forEach((mp, mi) => {
        const d = Math.hypot(mp.x - coords.x, mp.y - coords.y);
        if (d < bestDist) {
          bestDist = d;
          best = { stripeIdx: si, role: 'mid', midIdx: mi };
        }
      });
    });
    return best;
  };

  const placePoint = (coords: P) => {
    setStripes(prev => prev.map((s, i) => {
      if (i !== activeIdx) return s;
      if (!s.luff) return { ...s, luff: coords };
      if (!s.leech) return { ...s, leech: coords };
      return { ...s, mid: [...s.mid, coords] };
    }));
  };

  // ── Phase B: run auto-detection on a tap ─────────────────────────────────
  // tapCoords are in *image-pixel* space (same coordinate system that
  // getCanvasCoords returns and that all stripe points use).
  const runAutoDetect = async (tapCoords: P) => {
    if (!cachedImage.current) {
      setAutoDetectMsg('Image not ready yet — wait a moment and tap again.');
      return;
    }
    setAutoDetecting(true);
    setAutoDetectMsg('');
    const dlog = (...a: any[]) => console.log('[SailScan:detect]', ...a);
    try {
      await ensureOpenCV();
      const cv = getCV();
      const img = cachedImage.current;
      const prefs = getYachtPrefs(yachtKey);
      dlog('tap', tapCoords, 'storedHsv', prefs.stripeHsv);

      let result;
      let usedHint = false;
      try {
        // First pass: use the per-yacht stored colour if we have one.
        result = detectStripeFromTap(cv, img, tapCoords, {
          hsvHint: prefs.stripeHsv,
        });
        usedHint = !!prefs.stripeHsv;
        dlog('first pass', { confidence: result.confidence, usedHint });
      } catch (firstErr: any) {
        // If the stored colour was stale (background error), forget it and
        // resample fresh from the tap. This makes auto-detect self-healing
        // across yacht / lighting changes.
        const msg = firstErr?.message || String(firstErr);
        if (msg.toLowerCase().includes('background') && prefs.stripeHsv) {
          dlog('first pass background, retrying without hint');
          setYachtPref(yachtKey, 'stripeHsv', undefined);
          result = detectStripeFromTap(cv, img, tapCoords, {});
          dlog('retry pass', { confidence: result.confidence });
        } else {
          throw firstErr;
        }
      }

      // Always (re)persist the colour we ended up using — this keeps the
      // stored hint matching the most recent successful tap.
      setYachtPref(yachtKey, 'stripeHsv', result.hsvSample);
      dlog('saved hsv', result.hsvSample);

      // Apply to the active stripe (replace whatever was there). The user's
      // tap is kept as the LUFF; the farthest pixel in the component is the
      // LEECH; midpoints sample the centerline in between.
      setStripes(prev => prev.map((s, i) => i === activeIdx
        ? { luff: result.luff, leech: result.leech, mid: result.midpoints }
        : s,
      ));

      const pct = (result.confidence * 100).toFixed(0);
      const reused = usedHint && prefs.stripeHsv ? ' (reused colour)' : ' (learned colour)';
      if (result.confidence < 0.15) {
        setAutoDetectMsg(`Low confidence (${pct}%)${reused}. Drag the points to refine, or undo and tap again.`);
      } else {
        setAutoDetectMsg(`Detected · ${result.midpoints.length} midpoints · ${pct}% confidence${reused}.`);
      }
    } catch (err: any) {
      const msg = err?.message || 'Auto-detect failed.';
      console.error('[SailScan:detect]', msg, err);
      setAutoDetectMsg(msg);
    } finally {
      setAutoDetecting(false);
    }
  };

  const movePoint = (target: DragTarget, coords: P) => {
    setStripes(prev => prev.map((s, i) => {
      if (i !== target.stripeIdx) return s;
      if (target.role === 'luff')  return { ...s, luff:  coords };
      if (target.role === 'leech') return { ...s, leech: coords };
      if (target.role === 'mid') {
        const mid = s.mid.slice();
        mid[target.midIdx] = coords;
        return { ...s, mid };
      }
      return s;
    }));
  };

  // ── touch handlers ───────────────────────────────────────────────────────
  const clearLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    touchMoved.current = false;
    touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };

    if (e.touches.length === 2) {
      clearLongPress();
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      setInitialDist(dist);
      setInitialZoom(zoom);
      setIsPanning(false);
      return;
    }

    if (e.touches.length === 1) {
      const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
      const near = findNearPoint(coords);
      if (near) { setDragging(near); return; }

      // Start panning
      setIsPanning(true);
      setPanStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      setInitialPan(pan);

      // In auto-detect mode, a stationary tap (no movement) triggers detection
      // on touchEnd. We don't arm the long-press timer; touchend will do it.
      if (autoDetectMode) return;

      // Arm long-press for placing a new point (manual mode)
      longPressCoords.current = coords;
      longPressTimer.current = setTimeout(() => {
        if (!touchMoved.current) {
          navigator.vibrate?.([50, 80, 150]);
          placePoint(longPressCoords.current!);
        }
      }, 1500);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!touchMoved.current && touchStartPos.current && e.touches.length === 1) {
      const dx = e.touches[0].clientX - touchStartPos.current.x;
      const dy = e.touches[0].clientY - touchStartPos.current.y;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD) { touchMoved.current = true; clearLongPress(); }
    }

    if (e.touches.length === 2 && initialDist > 0) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = dist / initialDist;
      const dampened = 1 + (ratio - 1) * 0.4;
      setZoom(Math.max(0.5, Math.min(8, initialZoom * dampened)));
      return;
    }

    if (e.touches.length === 1) {
      if (dragging) {
        const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
        movePoint(dragging, coords);
        return;
      }
      if (isPanning && touchMoved.current) {
        // 1:1 pan — finger motion translates the image by exactly the same
        // distance on screen. We compute the image-to-screen pixel ratio
        // from the canvas's current display size; previous hard-coded
        // multipliers were way off on large iPhone photos.
        const c = canvasRef.current;
        if (c) {
          const r = c.getBoundingClientRect();
          const sx = c.width / (r.width  || 1);
          const sy = c.height / (r.height || 1);
          const dx = (e.touches[0].clientX - panStart.x) * sx / zoom;
          const dy = (e.touches[0].clientY - panStart.y) * sy / zoom;
          setPan({ x: initialPan.x + dx, y: initialPan.y + dy });
        }
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    clearLongPress();
    setIsPanning(false);
    setInitialDist(0);

    // Auto-detect on a stationary tap (only when not dragging an existing
    // point and the finger didn't move beyond the tap threshold).
    if (autoDetectMode && !dragging && !touchMoved.current && touchStartPos.current && !autoDetecting) {
      const coords = getCanvasCoords(touchStartPos.current.x, touchStartPos.current.y);
      runAutoDetect(coords);
    }
    setDragging(null);
  };

  // ── mouse handlers (desktop) ─────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    const near = findNearPoint(coords);
    if (near) { setDragging(near); return; }
    setIsPanning(true);
    setPanStart({ x: e.clientX, y: e.clientY });
    setInitialPan(pan);
    // Desktop: a single click is reserved for pan/drag. Double-click does
    // the work — places a point in manual mode, runs auto-detect when
    // Auto-detect mode is on.
    if (e.detail === 2) {
      if (autoDetectMode && !autoDetecting) {
        runAutoDetect(coords);
      } else {
        placePoint(coords);
      }
    }
  };
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragging) {
      movePoint(dragging, getCanvasCoords(e.clientX, e.clientY));
    } else if (isPanning) {
      // 1:1 pan: cursor motion = exactly that many image pixels translated
      const c = canvasRef.current;
      if (c) {
        const r = c.getBoundingClientRect();
        const sx = c.width / (r.width  || 1);
        const sy = c.height / (r.height || 1);
        const dx = (e.clientX - panStart.x) * sx / zoom;
        const dy = (e.clientY - panStart.y) * sy / zoom;
        setPan({ x: initialPan.x + dx, y: initialPan.y + dy });
      }
    }
  };
  const handleMouseUp = () => { setIsPanning(false); setDragging(null); };
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.97 : 1.03;
    setZoom(prev => Math.max(0.5, Math.min(8, prev * delta)));
  };

  // ── stripe management ────────────────────────────────────────────────────
  const addStripe = () => {
    setStripes(prev => [...prev, newStripe()]);
    setActiveIdx(stripes.length);
  };
  const removeActiveStripe = () => {
    if (stripes.length <= 1) {
      setStripes([newStripe()]);
      setActiveIdx(0);
      return;
    }
    setStripes(prev => prev.filter((_, i) => i !== activeIdx));
    setActiveIdx(i => Math.max(0, Math.min(i, stripes.length - 2)));
  };
  const resetActiveStripe = () => {
    setStripes(prev => prev.map((s, i) => i === activeIdx ? newStripe() : s));
  };
  const undoLastPoint = () => {
    setStripes(prev => prev.map((s, i) => {
      if (i !== activeIdx) return s;
      if (s.mid.length > 0) return { ...s, mid: s.mid.slice(0, -1) };
      if (s.leech) return { ...s, leech: null };
      if (s.luff) return { ...s, luff: null };
      return s;
    }));
  };

  // ── canvas rendering: photo + all stripes ────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current || !imageSrc || step !== 'mark') return;
    const draw = (img: HTMLImageElement) => drawScene(img, /*forResults*/false);
    if (cachedImage.current && cachedImageSrc.current === imageSrc) {
      draw(cachedImage.current);
    } else {
      const im = new Image();
      im.onload = () => { cachedImage.current = im; cachedImageSrc.current = imageSrc; draw(im); };
      im.src = imageSrc;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc, stripes, activeIdx, zoom, pan, step, debugView, debugVersion]);

  useEffect(() => {
    if (!canvasRef.current || !imageSrc || step !== 'results') return;
    const draw = (img: HTMLImageElement) => drawScene(img, /*forResults*/true);
    if (cachedImage.current && cachedImageSrc.current === imageSrc) {
      draw(cachedImage.current);
    } else {
      const im = new Image();
      im.onload = () => { cachedImage.current = im; cachedImageSrc.current = imageSrc; draw(im); };
      im.src = imageSrc;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc, stripes, step]);

  const drawScene = (img: HTMLImageElement, forResults: boolean) => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = img.width;
    canvas.height = img.height;

    // Results mode shows the full image without any user pan/zoom
    const drawZoom = forResults ? 1 : zoom;
    const drawPan  = forResults ? { x: 0, y: 0 } : pan;

    ctx.save();
    ctx.translate(drawPan.x * drawZoom, drawPan.y * drawZoom);
    ctx.scale(drawZoom, drawZoom);
    // Source: original photo, OR the CV-pipeline result if a debug view is
    // active. Either way the image is drawn into the same transformed
    // coordinate space, so pan/zoom apply uniformly.
    const dbgC = debugCanvasRef.current;
    const showingDebug = !forResults && debugView !== 'off' && dbgC && dbgC.width > 0;
    if (showingDebug) {
      ctx.drawImage(dbgC!, 0, 0, img.width, img.height);
    } else {
      ctx.drawImage(img, 0, 0);
    }

    const rect = canvas.getBoundingClientRect();
    const imgScale = canvas.width / (rect.width || 1);
    const px = (sp: number) => (sp * imgScale) / drawZoom;

    // Draw each stripe
    stripes.forEach((stripe, si) => {
      const isActive = si === activeIdx && !forResults;
      const stripeColor = STRIPE_COLORS[si % STRIPE_COLORS.length];
      const alpha = forResults ? 1 : (isActive ? 1 : 0.45);

      // Chord (dashed) if both endpoints set
      if (stripe.luff && stripe.leech) {
        ctx.globalAlpha = alpha * 0.85;
        ctx.strokeStyle = stripeColor;
        ctx.lineWidth = px(2);
        ctx.setLineDash([px(8), px(6)]);
        ctx.beginPath();
        ctx.moveTo(stripe.luff.x, stripe.luff.y);
        ctx.lineTo(stripe.leech.x, stripe.leech.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Spline (solid) if endpoints + at least 1 mid
      if (stripe.luff && stripe.leech && stripe.mid.length > 0) {
        const poly = splinePolyline(stripe as { luff: P; leech: P; mid: P[] });
        if (poly.length > 1) {
          // White halo
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = px(5);
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x, poly[k].y);
          ctx.stroke();
          // Coloured line
          ctx.strokeStyle = stripeColor;
          ctx.lineWidth = px(2.5);
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x, poly[k].y);
          ctx.stroke();

          // Max-draft tick (perpendicular line from chord to spline)
          const m = computeStripeMetrics(stripe as { luff: P; leech: P; mid: P[] });
          if (m && m.hasCurve) {
            // Find the sample at max draft and draw a tick from the chord up to it
            const luff = stripe.luff!, leech = stripe.leech!;
            const dx = leech.x - luff.x, dy = leech.y - luff.y;
            const t = m.draftPositionPct / 100;
            const chordPt = { x: luff.x + dx * t, y: luff.y + dy * t };
            const len = Math.hypot(dx, dy);
            const ux = dx / len, uy = dy / len;
            const nx = -uy, ny = ux;
            const splinePt = { x: chordPt.x + nx * m.maxDraft * m.draftSign, y: chordPt.y + ny * m.maxDraft * m.draftSign };
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = stripeColor;
            ctx.lineWidth = px(1.5);
            ctx.setLineDash([px(3), px(3)]);
            ctx.beginPath();
            ctx.moveTo(chordPt.x, chordPt.y);
            ctx.lineTo(splinePt.x, splinePt.y);
            ctx.stroke();
            ctx.setLineDash([]);
            // Small dot at max draft
            ctx.fillStyle = stripeColor;
            ctx.beginPath();
            ctx.arc(splinePt.x, splinePt.y, px(4), 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = px(1.5);
            ctx.stroke();
          }
        }
      }

      // Crosshairs at each placed point
      if (!forResults) {
        const drawCrosshair = (pt: P, color: string, label: string) => {
          const size = px(36), lw = px(3), gap = px(6);
          // Black outline for contrast
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth = lw + px(3);
          ctx.beginPath();
          ctx.moveTo(pt.x - size, pt.y); ctx.lineTo(pt.x + size, pt.y);
          ctx.moveTo(pt.x, pt.y - size); ctx.lineTo(pt.x, pt.y + size);
          ctx.stroke();
          // Coloured crosshair with center gap
          ctx.strokeStyle = color;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(pt.x - size, pt.y); ctx.lineTo(pt.x - gap, pt.y);
          ctx.moveTo(pt.x + gap, pt.y); ctx.lineTo(pt.x + size, pt.y);
          ctx.moveTo(pt.x, pt.y - size); ctx.lineTo(pt.x, pt.y - gap);
          ctx.moveTo(pt.x, pt.y + gap); ctx.lineTo(pt.x, pt.y + size);
          ctx.stroke();
          // Center dot
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, px(5), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = px(1.5);
          ctx.stroke();
          // Label badge
          const lx = pt.x + size * 0.6, ly = pt.y - size * 0.6;
          const lr = px(11);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(lx, ly, lr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = px(1.5);
          ctx.stroke();
          ctx.fillStyle = 'white';
          ctx.font = `bold ${px(13)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, lx, ly);
        };
        if (stripe.luff)  drawCrosshair(stripe.luff,  ENDPOINT_LUFF_COLOR,  'L');
        if (stripe.leech) drawCrosshair(stripe.leech, ENDPOINT_LEECH_COLOR, 'E');
        stripe.mid.forEach((mp, mi) => drawCrosshair(mp, MID_COLOR, `${mi + 1}`));
      } else {
        // Results: small dots (no big crosshairs)
        const dot = (pt: P, color: string) => {
          ctx.globalAlpha = 1;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, px(5), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = px(1.5);
          ctx.stroke();
        };
        if (stripe.luff)  dot(stripe.luff,  stripeColor);
        if (stripe.leech) dot(stripe.leech, stripeColor);
      }

      ctx.globalAlpha = 1;
    });
    ctx.restore();
  };

  // ── EXIF timestamp extraction (matches SquashShotsApp) ───────────────────
  const loadExifr = (): Promise<any> => new Promise((resolve, reject) => {
    if ((window as any).exifr) { resolve((window as any).exifr); return; }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/exifr@7.1.3/dist/full.umd.js';
    s.onload = () => resolve((window as any).exifr);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  const extractTimestamp = useCallback(async () => {
    if (!imageSrc) return;
    try {
      const blob = originalFile.current
        ? originalFile.current
        : await fetch(imageSrc).then(r => r.blob());
      const exifr = await loadExifr();
      if (exifr) {
        const data = await exifr.parse(blob, { tiff: true, exif: true });
        const dt = data?.DateTimeOriginal || data?.DateTime;
        if (dt instanceof Date) {
          setExifTimestamp(dt.getTime());
          setPhotoTimestamp(dt.toISOString().slice(0, 16));
          return;
        }
      }
    } catch {}
    setExifTimestamp(null);
    setPhotoTimestamp(new Date().toISOString().slice(0, 16));
  }, [imageSrc]);

  useEffect(() => { if (imageSrc) extractTimestamp(); }, [imageSrc, extractTimestamp]);

  // ── v2 Phase A: CV debug pipeline ────────────────────────────────────────
  // When the user toggles a debug view we lazy-load OpenCV.js, downsample the
  // photo to a max edge of 1024 px (CV's worth doing on a small image; full
  // resolution waits for v2 release), run the requested stage, and paint the
  // result to debugCanvasRef which overlays the marking canvas.
  //
  // pointer-events: none on the debug canvas so the user can still interact
  // with the underlying marking canvas (drag points, pan, etc.).
  useEffect(() => {
    if (debugView === 'off' || !imageSrc || !cachedImage.current) return;
    let cancelled = false;
    setDebugError('');
    setDebugProcessing(true);
    const dlog = (...a: any[]) => console.log('[SailScan:debug]', ...a);
    const t0 = performance.now();
    const tick = (label: string) => dlog(label, '+' + Math.round(performance.now() - t0) + 'ms');

    (async () => {
      try {
        tick('start; debugView=' + debugView);
        // ensureOpenCV resolves with `void` so the cv namespace (which is
        // a thenable) never enters the Promise machinery. Then getCV()
        // synchronously returns the namespace once it's ready.
        await ensureOpenCV();
        if (cancelled) { tick('cancelled after ensureOpenCV'); return; }
        const cv = getCV();
        tick('opencv ready');

        // Downsample for speed — long edge capped at 1024 px.
        const img = cachedImage.current!;
        const MAX = 1024;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        tick(`downsample ${img.width}x${img.height} -> ${w}x${h}`);
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        tmp.getContext('2d')!.drawImage(img, 0, 0, w, h);
        tick('canvas drawn');

        const rgba = imageToMat(cv, tmp);
        tick('rgba mat created (matFromImageData)');
        const gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        rgba.delete();
        tick('gray mat ready');

        let outMat: any;
        if (debugView === 'clahe') {
          outMat = applyClahe(cv, gray);
          tick('clahe done');
        } else if (debugView === 'orientation') {
          const enhanced = applyClahe(cv, gray);
          tick('clahe done');
          const { angle, coherence } = structureTensor(cv, enhanced);
          tick('structure tensor done');
          outMat = colorizeOrientation(cv, angle, coherence);
          tick('colorize done');
          enhanced.delete();
          angle.delete();
          coherence.delete();
        } else { // 'edges'
          outMat = horizontalOnlyEdges(cv, gray);
          tick('horizontal-only edges done');
        }
        gray.delete();

        if (!cancelled) {
          // Lazily create the offscreen canvas; not part of the DOM.
          if (!debugCanvasRef.current) {
            debugCanvasRef.current = document.createElement('canvas');
          }
          matToCanvas(cv, outMat, debugCanvasRef.current);
          tick('painted to offscreen debug canvas');
          // Trigger drawScene to re-render the marking canvas with the new
          // debug bitmap as its source.
          setDebugVersion(v => v + 1);
        }
        outMat.delete();
        if (!cancelled) {
          setDebugProcessing(false);
          tick('pipeline complete');
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error('[SailScan:debug] pipeline error', msg, e);
        if (!cancelled) {
          setDebugError(msg);
          setDebugProcessing(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [debugView, imageSrc]);

  // ── derived metrics for results screen ───────────────────────────────────
  const completedStripes = stripes.filter(s => s.luff && s.leech);
  const stripeMetrics = stripes.map(s => (s.luff && s.leech) ? computeStripeMetrics(s as { luff: P; leech: P; mid: P[] }) : null);
  // A stripe is "fully analysable" only when it has at least one midpoint —
  // chord alone gives no draft/draft-position/entry/exit info.
  const stripesWithCurve = stripes.filter(s => s.luff && s.leech && s.mid.length > 0);
  const activeMetrics = stripeMetrics[activeIdx];

  // Sort stripes top-to-bottom (smaller image-y = higher on sail) for twist computation.
  // We use the chord-midpoint y to order them; ties broken by index.
  const orderedForTwist = stripes
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s.luff && s.leech)
    .map(({ s, idx }) => ({
      idx,
      s,
      midY: ((s.luff!.y + s.leech!.y) / 2),
    }))
    .sort((a, b) => a.midY - b.midY);

  const twistRows: { fromIdx: number; toIdx: number; deg: number }[] = [];
  for (let i = 0; i < orderedForTwist.length - 1; i++) {
    const A = orderedForTwist[i + 1].s;   // upper stripe (numerically larger y? no, sorted ascending)
    const B = orderedForTwist[i].s;       // lower stripe
    // We sorted ascending midY. In image space, top of sail = smaller y. So
    // orderedForTwist[0] = topmost stripe, [last] = bottommost.
    // Twist = upper_chord_angle - lower_chord_angle, with upper = [i] (top),
    //                                                       lower = [i+1] (below).
    // So flip: upper = [i], lower = [i+1]
    const upper = orderedForTwist[i].s;
    const lower = orderedForTwist[i + 1].s;
    const tw = computeTwist(upper, lower);
    if (tw != null) twistRows.push({
      fromIdx: orderedForTwist[i + 1].idx,
      toIdx: orderedForTwist[i].idx,
      deg: tw,
    });
  }

  // ── Save to Photos store (matches SquashShotsApp's flow exactly so the
  //    PhotosTab picks it up without any further wiring) ────────────────────
  const saveToPhotoDatabase = async () => {
    setSaveStatus('saving'); setSaveMsg('');
    try {
      // Render the current annotated canvas (photo + spline overlays + max-draft
      // ticks) to a JPEG blob. We re-draw in results mode (no user pan/zoom)
      // so the saved image always shows the full photo with marks.
      if (!canvasRef.current || !cachedImage.current) throw new Error('No image loaded');
      drawScene(cachedImage.current, /*forResults*/true);
      const blob: Blob = await new Promise((resolve, reject) =>
        canvasRef.current!.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.92)
      );

      // Resolve UTC timestamp from datetime-local + selected offset.
      const tzOffsetMap: Record<string, number> = {
        'UTC': 0, 'UTC+1': -60, 'UTC+2': -120, 'UTC+3': -180, 'UTC+4': -240,
        'UTC+5': -300, 'UTC+6': -360, 'UTC+7': -420, 'UTC+8': -480, 'UTC+9': -540,
        'UTC+10': -600, 'UTC+11': -660, 'UTC+12': -720,
        'UTC-1': 60, 'UTC-2': 120, 'UTC-3': 180, 'UTC-4': 240, 'UTC-5': 300,
        'UTC-6': 360, 'UTC-7': 420, 'UTC-8': 480, 'UTC-9': 540, 'UTC-10': 600,
        'UTC-11': 660, 'UTC-12': 720,
      };
      let ts: number;
      if (photoTimestamp) {
        const offsetMin = tzOffsetMap[timezone] ?? 0;
        ts = new Date(photoTimestamp).getTime() + offsetMin * 60000;
      } else {
        ts = Date.now();
      }
      const date = new Date(ts).toISOString().slice(0, 10);

      // Persist blob to IndexedDB (same db SquashShots uses, so PhotosTab finds it)
      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('ssa-db', 4);
        req.onupgradeneeded = (e: any) => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
        };
        req.onsuccess = (e: any) => resolve(e.target.result);
        req.onerror   = (e: any) => reject(e.target.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const r  = tx.objectStore('photos').put({ id, blob });
        r.onsuccess = () => resolve();
        r.onerror   = () => reject(r.error);
      });

      // Build the SailScan-specific metadata payload.
      // We strip the dense `samples` arrays from each metric (200+ pts each)
      // so the LS entry stays small; spline can be re-derived from points.
      const sailscanPayload = {
        version: 1,
        imageDims: { w: cachedImage.current.width, h: cachedImage.current.height },
        stripes: stripes
          .map((s, i) => {
            if (!s.luff || !s.leech) return null;
            const m = stripeMetrics[i];
            return {
              idx: i,
              luff:  s.luff,
              leech: s.leech,
              mid:   s.mid,
              metrics: m ? {
                hasCurve:          m.hasCurve,
                chordLen:          m.chordLen,
                chordAngleDeg:     m.chordAngleDeg,
                draftPct:          m.draftPct,
                draftPositionPct:  m.draftPositionPct,
                entryAngleDeg:     m.entryAngleDeg,
                exitAngleDeg:      m.exitAngleDeg,
              } : null,
            };
          })
          .filter(Boolean),
        twist: twistRows,
      };
      const avgDraft = stripeMetrics
        .filter(m => m && m.hasCurve)
        .reduce((acc, m, _, arr) => acc + (m!.draftPct / arr.length), 0);
      const maxTwist = twistRows.length
        ? Math.max(...twistRows.map(t => Math.abs(t.deg)))
        : 0;

      // Photo metadata schema matches SquashShotsApp + existing PhotosTab reader.
      // The `sails` and `raceTags` arrays surface in the photo card UI and
      // make these scans filterable from the Photos tab.
      const photo: any = {
        id,
        name: `sailscan-${id.slice(2, 12)}.jpg`,
        size: blob.size,
        utc: ts,
        lat: null,
        lon: null,
        sessionDate: date,
        cloudSynced: false,
        addedAt: Date.now(),
        sails:    ['SailScan'],
        raceTags: ['sailscan'],
        sailscan_n_stripes:           String(stripesWithCurve.length),
        sailscan_avg_draft_pct:       avgDraft.toFixed(2),
        sailscan_max_abs_twist_deg:   maxTwist.toFixed(2),
        sailscan_data:                JSON.stringify(sailscanPayload),
      };

      const lsKey = `ssa:photos-meta:${date}`;
      const existing = JSON.parse(localStorage.getItem(lsKey) || '[]');
      existing.push(photo);
      localStorage.setItem(lsKey, JSON.stringify(existing));

      // Make sure the date appears in the sessions index so PhotosTab routes to it.
      const sessions: any[] = JSON.parse(localStorage.getItem('ssa:sessions') || '[]');
      if (!sessions.find((s: any) => s.date === date)) {
        sessions.push({ date, videoCount: 0, hasLog: false, hasXml: false });
        sessions.sort((a: any, b: any) => b.date.localeCompare(a.date));
        localStorage.setItem('ssa:sessions', JSON.stringify(sessions));
      }

      navigator.vibrate?.([50, 50, 100]);
      setSaveStatus('saved');
      setSaveMsg(`Saved to Photos · ${date} · ${stripesWithCurve.length} stripe${stripesWithCurve.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      setSaveStatus('error');
      setSaveMsg(err?.message || 'Save failed');
    }
  };

  // ── status text in mark mode ─────────────────────────────────────────────
  // Each step has a step number, a short heading, a body, and a colour cue
  // so the next action is unmissable. Crucially, after L+E we point users
  // at midpoints (without midpoints we cannot compute draft/depth/angles)
  // *before* the Compute CTA shows up.
  const active = stripes[activeIdx];
  const stepInfo = (() => {
    if (!active.luff)  return { num: '1/3', title: 'Place the luff endpoint',  body: 'Long-press at the LUFF (mast/forestay) end of the stripe', tone: 'blue'   as const };
    if (!active.leech) return { num: '2/3', title: 'Place the leech endpoint', body: 'Long-press at the LEECH (back) end of the stripe',         tone: 'blue'   as const };
    if (active.mid.length === 0)
                       return { num: '3/3', title: 'Add a midpoint',           body: 'Long-press where the stripe is deepest — needed for draft, depth, entry/exit', tone: 'amber'  as const };
    return            { num: '✓',   title: 'Stripe ready',         body: 'Add more midpoints for accuracy, mark another stripe (+), or Compute', tone: 'green'  as const };
  })();
  const toneBg    = stepInfo.tone === 'amber' ? 'bg-amber-500/15 border-amber-500/50' :
                    stepInfo.tone === 'green' ? 'bg-emerald-500/15 border-emerald-500/50' :
                                                'bg-blue-500/15 border-blue-500/50';
  const toneText  = stepInfo.tone === 'amber' ? 'text-amber-300' :
                    stepInfo.tone === 'green' ? 'text-emerald-300' :
                                                'text-blue-300';

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full w-full bg-slate-900 text-slate-100" style={{ fontFamily: "'Segoe UI',system-ui,sans-serif" }}>

      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-950 border-b border-slate-800 flex-shrink-0">
        {step !== 'select' && (
          <button
            onClick={() => {
              if (step === 'live')      { stopCamera(); setStep('select'); }
              else if (step === 'preview') retakePicture();
              else if (step === 'mark')   { setStep('select'); }
              else if (step === 'results'){ setStep('mark'); }
            }}
            className="text-white bg-slate-700/60 rounded-full w-8 h-8 flex items-center justify-center active:scale-90 transition-transform"
          >←</button>
        )}
        <span className="font-bold">⛵ SailScan</span>
        <div className="flex-1" />
        <span className="text-slate-500 text-xs">
          {step === 'select'  && 'Select image'}
          {step === 'live'    && 'Camera'}
          {step === 'preview' && 'Preview'}
          {step === 'mark'    && `Stripe ${activeIdx + 1} / ${stripes.length}`}
          {step === 'results' && `${completedStripes.length} stripe${completedStripes.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Hidden inputs */}
      <input ref={fileAlbumRef}   type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
      <input ref={fileBrowserRef} type="file" accept=".jpg,.jpeg,.png,.heic,.heif,.webp,.tiff,.bmp" className="hidden" onChange={handleFileUpload} />

      <canvas ref={captureCanvasRef} className="hidden" />

      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── SELECT ─────────────────────────────────────────────────────── */}
        {step === 'select' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-6">
            <div className="text-center mb-4">
              <p className="text-slate-300 text-sm font-semibold mb-1">Photograph your sail from below, looking up.</p>
              <p className="text-slate-500 text-xs">Trim stripes should be clearly visible, ideally horizontal in the image.</p>
            </div>
            <button
              onClick={openCamera}
              className="w-full px-6 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-base rounded-lg active:scale-95 transition-transform"
            >📷 Use Camera</button>
            <div className="flex gap-3 w-full">
              <button
                onClick={() => { setActiveButton('album'); fileAlbumRef.current?.removeAttribute('capture'); fileAlbumRef.current?.click(); }}
                className={`flex-1 px-4 py-3 font-semibold text-sm rounded-lg active:scale-95 transition-all ${
                  activeButton === 'album' ? 'bg-blue-600 text-white ring-2 ring-blue-400' : 'bg-slate-700 hover:bg-slate-600 text-white'
                }`}
              >{activeButton === 'album' ? '⏳ Loading…' : '🖼️ Photo Album'}</button>
              <button
                onClick={() => { setActiveButton('files'); fileBrowserRef.current?.click(); }}
                className={`flex-1 px-4 py-3 font-semibold text-sm rounded-lg active:scale-95 transition-all ${
                  activeButton === 'files' ? 'bg-blue-600 text-white ring-2 ring-blue-400' : 'bg-slate-700 hover:bg-slate-600 text-white'
                }`}
              >{activeButton === 'files' ? '⏳ Loading…' : '📁 Browse Files'}</button>
            </div>
          </div>
        )}

        {/* ── LIVE CAMERA ────────────────────────────────────────────────── */}
        {step === 'live' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black">
              <video
                ref={el => {
                  videoRef.current = el;
                  if (el && cameraStream.current && !el.srcObject) el.srcObject = cameraStream.current;
                }}
                autoPlay playsInline
                className="w-full h-full object-contain"
              />
            </div>
            <div className="flex-shrink-0 px-4 py-4 flex gap-3">
              <button onClick={() => { stopCamera(); setStep('select'); }}
                className="px-4 py-3 bg-slate-700 text-white font-semibold text-sm rounded-lg active:scale-95">← Back</button>
              <button onClick={takePicture}
                className="flex-1 px-6 py-4 bg-red-600 text-white font-bold text-lg rounded-full active:scale-95 shadow-lg">⬤ Take Picture</button>
            </div>
          </div>
        )}

        {/* ── PREVIEW ────────────────────────────────────────────────────── */}
        {step === 'preview' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black">
              {previewSrc && <img src={previewSrc} alt="preview" className="w-full h-full object-contain" />}
            </div>
            <div className="flex-shrink-0 px-4 py-4 flex gap-3">
              <button onClick={retakePicture}
                className="flex-1 px-4 py-3 bg-slate-700 text-white font-bold text-sm rounded-lg active:scale-95">↺ Retake</button>
              <button onClick={usePicture}
                className="flex-1 px-6 py-4 bg-green-600 text-white font-bold text-lg rounded-lg active:scale-95 shadow-lg">✓ Use Picture</button>
            </div>
          </div>
        )}

        {/* ── MARK ───────────────────────────────────────────────────────── */}
        {step === 'mark' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Stripe selector — chips for each stripe + a clearly labelled +Add chip.
                Each chip shows status (○ chord-only / ✓ has curve) so you can see
                at a glance which stripes still need a midpoint. */}
            <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-slate-950/70 border-b border-slate-800 overflow-x-auto">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 flex-shrink-0 pr-1">Stripes</span>
              {stripes.map((s, i) => {
                const c = STRIPE_COLORS[i % STRIPE_COLORS.length];
                const hasChord = !!(s.luff && s.leech);
                const hasCurve = hasChord && s.mid.length > 0;
                const status   = hasCurve ? '✓' : hasChord ? '○' : '·';
                return (
                  <button key={i} onClick={() => setActiveIdx(i)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 flex-shrink-0 active:scale-95 transition-transform ${
                      i === activeIdx ? 'ring-2' : 'opacity-70'
                    }`}
                    style={{
                      background: i === activeIdx ? c : '#1e293b',
                      color: i === activeIdx ? 'white' : '#cbd5e1',
                      ...(i === activeIdx ? { boxShadow: `0 0 0 2px ${c}55` } : {}),
                    }}
                    title={hasCurve ? 'Curve set — full metrics' : hasChord ? 'Chord only — add a midpoint' : 'Empty'}
                  >
                    <span>{status}</span>
                    <span>Stripe {i + 1}</span>
                  </button>
                );
              })}
              <button onClick={addStripe}
                className="px-3 py-1.5 rounded-full text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white active:scale-95 flex-shrink-0">+ Add stripe</button>
            </div>

            {/* Canvas + (optional) CV debug overlay */}
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black relative overflow-hidden">
              <canvas
                ref={canvasRef}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
                className="w-full h-full"
                style={{ maxWidth: '100%', maxHeight: '100%', touchAction: 'none', cursor: dragging ? 'grabbing' : 'crosshair' }}
              />
              {/* Debug result is rendered into the marking canvas itself
                  (via drawScene), so it inherits pan/zoom. No overlay element
                  is needed. */}
              {debugProcessing && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-amber-300 text-xs font-bold pointer-events-none">
                  ⏳ Processing CV pipeline…
                </div>
              )}
              {debugError && (
                <div className="absolute top-2 left-2 right-2 px-3 py-2 bg-red-900/80 text-red-100 text-[11px] rounded">
                  CV error: {debugError}
                </div>
              )}
              {/* Phase B: auto-detect spinner */}
              {autoDetecting && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-amber-300 text-sm font-bold pointer-events-none">
                  🎯 Detecting stripe…
                </div>
              )}
            </div>

            {/* Bottom controls */}
            <div className="flex-shrink-0 bg-gradient-to-t from-slate-950 via-slate-950/95 to-slate-950/70 px-3 py-2.5 space-y-2">

              {/* Phase B: auto-detect toggle */}
              <div className="flex items-center gap-2">
                <button onClick={() => { setAutoDetectMode(v => !v); setAutoDetectMsg(''); }}
                  disabled={autoDetecting}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold active:scale-95 transition-all ${
                    autoDetectMode
                      ? 'bg-amber-500 text-black ring-2 ring-amber-300'
                      : 'bg-slate-700 hover:bg-slate-600 text-white'
                  }`}>
                  {autoDetectMode ? '🎯 Auto-detect ON — tap a stripe' : '🎯 Auto-detect (tap luff to find stripe)'}
                </button>
                {(() => {
                  const prefs = getYachtPrefs(yachtKey);
                  if (!prefs.stripeHsv) return null;
                  return (
                    <button onClick={() => { setYachtPref(yachtKey, 'stripeHsv', undefined); setAutoDetectMsg('Stripe colour cleared — next tap learns a new one.'); }}
                      title="Forget learned stripe colour"
                      className="px-2 py-2 rounded-lg text-xs font-bold bg-slate-800 text-slate-300 active:scale-95">
                      ↺ colour
                    </button>
                  );
                })()}
              </div>
              {autoDetectMsg && (
                <p className={`text-[11px] leading-snug ${autoDetectMsg.startsWith('Detected') ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {autoDetectMsg}
                </p>
              )}

              {/* Big, unmissable step card */}
              <div className={`rounded-lg border px-3 py-2 ${toneBg}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold ${toneText} bg-black/30 rounded px-1.5 py-0.5`}>STEP {stepInfo.num}</span>
                  <span className="text-white text-sm font-bold flex-1">{stepInfo.title}</span>
                </div>
                <p className="text-slate-200 text-xs mt-1 leading-snug">{stepInfo.body}</p>
                <p className="text-slate-500 text-[10px] mt-1">Hold 1.5s to place • Drag to move • Pinch to zoom</p>
              </div>

              {/* Live metric preview for active stripe — appears once we have a curve */}
              {activeMetrics?.hasCurve && (
                <div className="rounded-md bg-slate-900/70 border border-slate-700 px-2 py-1.5 flex items-center gap-3 text-[11px] font-mono">
                  <span className="text-slate-500">live:</span>
                  <span className="text-slate-200">draft <b className="text-emerald-300">{activeMetrics.draftPct.toFixed(1)}%</b></span>
                  <span className="text-slate-200">@ <b className="text-emerald-300">{activeMetrics.draftPositionPct.toFixed(0)}%</b></span>
                  <span className="text-slate-200">entry <b className="text-emerald-300">{activeMetrics.entryAngleDeg.toFixed(0)}°</b></span>
                  <span className="text-slate-200">exit <b className="text-emerald-300">{activeMetrics.exitAngleDeg.toFixed(0)}°</b></span>
                </div>
              )}

              {/* Undo / reset / delete row */}
              <div className="flex gap-2">
                <button onClick={undoLastPoint}
                  className="flex-1 px-3 py-2 bg-slate-700 text-white text-xs font-semibold rounded-lg active:scale-95 disabled:opacity-40"
                  disabled={!active.luff && !active.leech && active.mid.length === 0}>
                  ↶ Undo
                </button>
                <button onClick={resetActiveStripe}
                  className="flex-1 px-3 py-2 bg-slate-700 text-white text-xs font-semibold rounded-lg active:scale-95 disabled:opacity-40"
                  disabled={!active.luff && !active.leech && active.mid.length === 0}>
                  ⟲ Reset
                </button>
                <button onClick={removeActiveStripe}
                  className="flex-1 px-3 py-2 bg-red-700/60 text-white text-xs font-semibold rounded-lg active:scale-95">
                  ✕ Delete
                </button>
              </div>

              {/* Big "+ Add another stripe" CTA — appears once current stripe has a curve */}
              {active.luff && active.leech && active.mid.length > 0 && (
                <button onClick={addStripe}
                  className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-lg active:scale-95 shadow-lg">
                  + Add another stripe
                </button>
              )}

              {/* Compute CTA — only enabled when at least one stripe has a curve */}
              <button onClick={() => setStep('results')}
                disabled={stripesWithCurve.length === 0}
                className="w-full px-6 py-3 bg-green-600 hover:bg-green-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-bold text-base rounded-lg active:scale-95 shadow-lg">
                {stripesWithCurve.length === 0
                  ? '✓ Compute (add a midpoint first)'
                  : `✓ Compute · ${stripesWithCurve.length} stripe${stripesWithCurve.length === 1 ? '' : 's'}`}
              </button>

              {/* ── v2 Phase A debug pane: visualise CV pipeline stages ─── */}
              <div className="border-t border-slate-800 pt-2">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-slate-500 uppercase tracking-wider mr-1">CV debug</span>
                  {(['off','clahe','orientation','edges'] as DebugView[]).map(v => (
                    <button key={v} onClick={() => setDebugView(v)}
                      className={`px-2 py-1 rounded font-mono ${
                        debugView === v
                          ? 'bg-amber-500 text-black font-bold'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}>
                      {v}
                    </button>
                  ))}
                </div>
                {debugView !== 'off' && (
                  <p className="text-[10px] text-slate-500 mt-1 leading-snug">
                    {debugView === 'clahe'       && 'CLAHE-normalised gray (exposure equalisation)'}
                    {debugView === 'orientation' && 'Per-pixel orientation (hue) × coherence (saturation). Horizontal=red, vertical=cyan.'}
                    {debugView === 'edges'       && 'Canny edges after masking out near-vertical pixels. Stripes should remain; luff/leech should drop out.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── RESULTS ────────────────────────────────────────────────────── */}
        {step === 'results' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-shrink-0 bg-black flex items-center justify-center overflow-hidden" style={{ height: '40%' }}>
              <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-900">
              <h2 className="text-base font-bold text-slate-200">Per-stripe metrics</h2>
              {stripes.map((s, i) => {
                const m = stripeMetrics[i];
                const c = STRIPE_COLORS[i % STRIPE_COLORS.length];
                if (!m) return (
                  <div key={i} className="rounded-lg p-3 border border-slate-800 bg-slate-800/40 text-xs text-slate-400">
                    Stripe {i + 1}: incomplete (need both luff and leech endpoints).
                  </div>
                );
                return (
                  <div key={i} className="rounded-lg p-3 border" style={{ borderColor: `${c}55`, background: `${c}15` }}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: c }}></span>
                      <span className="font-bold text-sm">Stripe {i + 1}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wider" style={{ color: c }}>
                        {m.hasCurve ? `${s.mid.length} mid${s.mid.length === 1 ? '' : 's'}` : 'chord only'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Metric label="Draft depth"     value={m.hasCurve ? `${m.draftPct.toFixed(2)}%` : '—'} />
                      <Metric label="Draft position"  value={m.hasCurve ? `${m.draftPositionPct.toFixed(0)}%` : '—'} />
                      <Metric label="Entry angle"     value={m.hasCurve ? `${m.entryAngleDeg.toFixed(1)}°` : '—'} />
                      <Metric label="Exit angle"      value={m.hasCurve ? `${m.exitAngleDeg.toFixed(1)}°` : '—'} />
                      <Metric label="Chord (px)"      value={m.chordLen.toFixed(0)} />
                      <Metric label="Chord angle"     value={`${m.chordAngleDeg.toFixed(1)}°`} />
                    </div>
                  </div>
                );
              })}

              {twistRows.length > 0 && (
                <>
                  <h2 className="text-base font-bold text-slate-200 mt-4">Twist between stripes</h2>
                  {twistRows.map((tr, i) => (
                    <div key={i} className="rounded-lg p-3 border border-slate-700 bg-slate-800/40 flex items-center justify-between text-xs">
                      <span className="text-slate-300">
                        <span className="font-bold" style={{ color: STRIPE_COLORS[tr.toIdx % STRIPE_COLORS.length] }}>Stripe {tr.toIdx + 1}</span>
                        <span className="text-slate-500"> (upper) vs </span>
                        <span className="font-bold" style={{ color: STRIPE_COLORS[tr.fromIdx % STRIPE_COLORS.length] }}>Stripe {tr.fromIdx + 1}</span>
                        <span className="text-slate-500"> (lower)</span>
                      </span>
                      <span className="font-mono text-sm font-bold text-slate-100">{tr.deg.toFixed(1)}°</span>
                    </div>
                  ))}
                </>
              )}

              {/* Suggest adding more stripes when there's only one — twist isn't
                  meaningful with a single stripe, so users will usually want at
                  least 2-3 (head, middle, foot). */}
              {stripesWithCurve.length < 2 && (
                <div className="rounded-lg p-3 border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs">
                  Mark at least 2 stripes (top &amp; bottom of sail) to compare twist between them.
                </div>
              )}

              {/* ── Save to Photos: timestamp + tag + stripe data ──────────── */}
              <div className="rounded-lg p-3 border border-slate-700 bg-slate-800/40 space-y-2 mt-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-xs font-bold">💾 Save to Photos</span>
                  <button onClick={() => setShowTimestampInput(!showTimestampInput)}
                    className="text-xs text-blue-400 underline">
                    {showTimestampInput ? 'Hide' : 'Edit time'}
                  </button>
                </div>
                <p className="text-slate-400 text-[11px]">
                  {exifTimestamp ? '📅 EXIF timestamp found' : '⚠️ No EXIF — check or edit'}
                  {photoTimestamp && <> · {new Date(photoTimestamp).toLocaleString()} ({timezone})</>}
                </p>
                {showTimestampInput && (
                  <div className="space-y-2">
                    <input type="datetime-local"
                      value={photoTimestamp}
                      onChange={e => setPhotoTimestamp(e.target.value)}
                      className="w-full bg-slate-700 text-white text-sm rounded px-3 py-2 border border-slate-600" />
                    <select value={timezone}
                      onChange={e => setTimezone(e.target.value)}
                      className="w-full bg-slate-700 text-white text-sm rounded px-3 py-2 border border-slate-600">
                      {['UTC-12','UTC-11','UTC-10','UTC-9','UTC-8','UTC-7','UTC-6','UTC-5','UTC-4','UTC-3','UTC-2','UTC-1','UTC','UTC+1','UTC+2','UTC+3','UTC+4','UTC+5','UTC+6','UTC+7','UTC+8','UTC+9','UTC+10','UTC+11','UTC+12'].map(tz =>
                        <option key={tz} value={tz}>{tz}</option>)}
                    </select>
                  </div>
                )}
                <p className="text-slate-500 text-[10px] leading-snug">
                  Tag <span className="font-mono text-slate-400">sailscan</span> · {stripesWithCurve.length} analysed stripe{stripesWithCurve.length === 1 ? '' : 's'} · per-stripe metrics + raw points stored in metadata.
                  Logfile/event data is linked automatically by timestamp when viewed in Photos.
                </p>
                <button onClick={saveToPhotoDatabase}
                  disabled={saveStatus === 'saving' || stripesWithCurve.length === 0}
                  className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-bold rounded-lg active:scale-95 shadow">
                  {saveStatus === 'saving' ? '⏳ Saving…'
                    : saveStatus === 'saved'  ? '✓ Saved — save again?'
                    : saveStatus === 'error'  ? '⚠ Retry save'
                    : '💾 Save to Photos'}
                </button>
                {saveMsg && (
                  <p className={`text-[11px] ${saveStatus === 'error' ? 'text-red-400' : 'text-emerald-300'}`}>
                    {saveMsg}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <button onClick={() => { addStripe(); setStep('mark'); }}
                  className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg active:scale-95 shadow">
                  + Mark another stripe
                </button>
                <div className="flex gap-2">
                  <button onClick={() => setStep('mark')}
                    className="flex-1 px-4 py-2.5 bg-slate-700 text-white text-sm font-semibold rounded-lg active:scale-95">
                    ← Adjust marks
                  </button>
                  <button onClick={() => {
                    if (imageSrc) URL.revokeObjectURL(imageSrc);
                    setImageSrc('');
                    setStripes([newStripe()]);
                    setActiveIdx(0);
                    setSaveStatus('idle');
                    setSaveMsg('');
                    setExifTimestamp(null);
                    setPhotoTimestamp('');
                    setStep('select');
                  }}
                    className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg active:scale-95">
                    🆕 New Scan
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/60 rounded p-2 border border-slate-800">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-mono font-bold text-slate-100 mt-0.5">{value}</div>
    </div>
  );
}
