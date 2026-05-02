'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

type Step = 'camera' | 'points' | 'crop' | 'squash' | 'export';

interface Point {
  x: number;
  y: number;
}

interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function SquashShotsApp() {
  const [step, setStep] = useState<Step>('camera');
  const [imageSrc, setImageSrc] = useState<string>('');
  const [rotatedImageSrc, setRotatedImageSrc] = useState<string>('');
  const [croppedImageSrc, setCroppedImageSrc] = useState<string>('');
  const [squashedImageSrc, setSquashedImageSrc] = useState<string>('');

  const [points, setPoints] = useState<Point[]>([]);
  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [initialPan, setInitialPan] = useState({ x: 0, y: 0 });
  const [initialDistance, setInitialDistance] = useState(0);
  const [initialZoom, setInitialZoom] = useState(1);

  // Long-press state
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [longPressActive, setLongPressActive] = useState(false);
  const longPressCoords = useRef<Point | null>(null);
  const touchMoved = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const MOVE_THRESHOLD = 15; // px of movement allowed during long-press

  // Timestamp for saving to photo database
  const [photoTimestamp, setPhotoTimestamp] = useState<string>('');
  const [showTimestampInput, setShowTimestampInput] = useState(false);

  // Crop state
  const [cropBox, setCropBox] = useState<CropBox | null>(null);
  const [cropDragging, setCropDragging] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPan, setCropPan] = useState({ x: 0, y: 0 });
  const [cropIsPanning, setCropIsPanning] = useState(false);
  const [cropPanStart, setCropPanStart] = useState({ x: 0, y: 0 });
  const [cropInitialPan, setCropInitialPan] = useState({ x: 0, y: 0 });
  const [cropInitialDistance, setCropInitialDistance] = useState(0);
  const [cropInitialZoom, setCropInitialZoom] = useState(1);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement>(null);
  const squashCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize camera
  useEffect(() => {
    if (step === 'camera') {
      startCamera();
    }
    return () => {
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      }
    };
  }, [step]);

  const startCamera = async () => {
    try {
      const constraints = {
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'environment'
        }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Camera access denied:', err);
    }
  };

  const captureImage = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;

    ctx.drawImage(videoRef.current, 0, 0);
    const dataUrl = canvasRef.current.toDataURL('image/jpeg', 0.95);
    setImageSrc(dataUrl);

    const stream = videoRef.current.srcObject as MediaStream;
    stream?.getTracks().forEach(track => track.stop());

    setStep('points');
  };

  // Handle file upload (album or file browser)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setImageSrc(dataUrl);
      // Stop camera if running
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      }
      setStep('points');
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  // ─── POINTS STEP: Touch handlers with long-press ─────────────────────────────

  const getCanvasCoords = (clientX: number, clientY: number): Point => {
    const canvas = pointsCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((clientX - rect.left) * scaleX - pan.x * zoom) / zoom,
      y: ((clientY - rect.top) * scaleY - pan.y * zoom) / zoom
    };
  };

  const findNearPoint = (coords: Point): number | null => {
    const threshold = 40 / zoom; // touch target radius in image space
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - coords.x;
      const dy = points[i].y - coords.y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) return i;
    }
    return null;
  };

  const handlePointsTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    touchMoved.current = false;
    touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };

    if (e.touches.length === 2) {
      // Pinch zoom start
      clearLongPress();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.sqrt(
        Math.pow(t2.clientX - t1.clientX, 2) + Math.pow(t2.clientY - t1.clientY, 2)
      );
      setInitialDistance(distance);
      setInitialZoom(zoom);
      setIsPanning(false);
      return;
    }

    if (e.touches.length === 1) {
      const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);

      // Check if touching an existing point (drag it)
      const nearIdx = findNearPoint(coords);
      if (nearIdx !== null) {
        setDraggingPoint(nearIdx);
        return;
      }

      // Start pan
      setIsPanning(true);
      setPanStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      setInitialPan(pan);

      // Start long-press timer for point placement
      if (points.length < 2) {
        longPressCoords.current = coords;
        longPressTimer.current = setTimeout(() => {
          if (!touchMoved.current) {
            setLongPressActive(true);
            // Double vibration: short pulse, pause, longer confirmation pulse
            navigator.vibrate?.([50, 80, 150]);
            // Place point
            setPoints(prev => [...prev, longPressCoords.current!]);
            setLongPressActive(false);
          }
        }, 1500);
      }
    }
  };

  const handlePointsTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();

    // Only cancel long-press if finger moved beyond threshold
    if (!touchMoved.current && touchStartPos.current && e.touches.length === 1) {
      const dx = e.touches[0].clientX - touchStartPos.current.x;
      const dy = e.touches[0].clientY - touchStartPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        touchMoved.current = true;
        clearLongPress();
      }
    }

    if (e.touches.length === 2 && initialDistance > 0) {
      // Pinch zoom
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.sqrt(
        Math.pow(t2.clientX - t1.clientX, 2) + Math.pow(t2.clientY - t1.clientY, 2)
      );
      const ratio = distance / initialDistance;
      setZoom(Math.max(0.5, Math.min(8, initialZoom * ratio)));
      return;
    }

    if (e.touches.length === 1) {
      if (draggingPoint !== null) {
        // Drag existing point
        const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
        setPoints(prev => prev.map((p, i) => i === draggingPoint ? coords : p));
        return;
      }

      if (isPanning) {
        const dx = (e.touches[0].clientX - panStart.x) / zoom;
        const dy = (e.touches[0].clientY - panStart.y) / zoom;
        setPan({ x: initialPan.x + dx, y: initialPan.y + dy });
      }
    }
  };

  const handlePointsTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    clearLongPress();
    setIsPanning(false);
    setInitialDistance(0);
    setDraggingPoint(null);
  };

  // Mouse support for desktop
  const handlePointsMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    const nearIdx = findNearPoint(coords);
    if (nearIdx !== null) {
      setDraggingPoint(nearIdx);
      return;
    }
    setIsPanning(true);
    setPanStart({ x: e.clientX, y: e.clientY });
    setInitialPan(pan);

    // Double-click to place point on desktop
    if (e.detail === 2 && points.length < 2) {
      setPoints(prev => [...prev, coords]);
    }
  };

  const handlePointsMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingPoint !== null) {
      const coords = getCanvasCoords(e.clientX, e.clientY);
      setPoints(prev => prev.map((p, i) => i === draggingPoint ? coords : p));
    } else if (isPanning) {
      const dx = (e.clientX - panStart.x) / zoom;
      const dy = (e.clientY - panStart.y) / zoom;
      setPan({ x: initialPan.x + dx, y: initialPan.y + dy });
    }
  };

  const handlePointsMouseUp = () => {
    setIsPanning(false);
    setDraggingPoint(null);
  };

  const handlePointsWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(prev => Math.max(0.5, Math.min(8, prev * delta)));
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setLongPressActive(false);
  };

  const removeLastPoint = () => {
    setPoints(prev => prev.slice(0, -1));
  };

  // Draw points overlay
  useEffect(() => {
    if (!pointsCanvasRef.current || !imageSrc) return;

    const img = new Image();
    img.onload = () => {
      const canvas = pointsCanvasRef.current!;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = img.width;
      canvas.height = img.height;

      ctx.save();
      ctx.translate(pan.x * zoom, pan.y * zoom);
      ctx.scale(zoom, zoom);
      ctx.drawImage(img, 0, 0);

      // Draw points as crosshairs with number label
      points.forEach((point, idx) => {
        const size = 60 / zoom;       // crosshair arm length (bigger)
        const lw = 4 / zoom;          // line width
        const gap = 10 / zoom;        // gap around center
        const color = idx === 0 ? '#3b82f6' : '#ef4444';

        // Outer crosshair lines (black outline for contrast)
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (lw + 5 / zoom);
        ctx.beginPath();
        ctx.moveTo(point.x - size, point.y);
        ctx.lineTo(point.x + size, point.y);
        ctx.moveTo(point.x, point.y - size);
        ctx.lineTo(point.x, point.y + size);
        ctx.stroke();

        // Crosshair lines (colored, with gap in center)
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(point.x - size, point.y);
        ctx.lineTo(point.x - gap, point.y);
        ctx.moveTo(point.x + gap, point.y);
        ctx.lineTo(point.x + size, point.y);
        ctx.moveTo(point.x, point.y - size);
        ctx.lineTo(point.x, point.y - gap);
        ctx.moveTo(point.x, point.y + gap);
        ctx.lineTo(point.x, point.y + size);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8 / zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2.5 / zoom;
        ctx.stroke();

        // Number label (top-right of crosshair)
        const labelX = point.x + size * 0.6;
        const labelY = point.y - size * 0.6;
        const labelR = 18 / zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(labelX, labelY, labelR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2.5 / zoom;
        ctx.stroke();
        ctx.fillStyle = 'white';
        ctx.font = `bold ${22 / zoom}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${idx + 1}`, labelX, labelY);
      });

      // Draw dashed line connecting points
      if (points.length === 2) {
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
        ctx.lineWidth = 3 / zoom;
        ctx.setLineDash([10 / zoom, 6 / zoom]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw white outline for visibility on dark backgrounds
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 5 / zoom;
        ctx.setLineDash([10 / zoom, 6 / zoom]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Redraw blue on top
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
        ctx.lineWidth = 3 / zoom;
        ctx.setLineDash([10 / zoom, 6 / zoom]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
    };
    img.src = imageSrc;
  }, [imageSrc, points, zoom, pan]);

  const rotateImage = async () => {
    if (points.length !== 2 || !imageSrc || !canvasRef.current) return;

    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d')!;

      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      let angle = Math.atan2(dy, dx);

      // Normalize angle to [-PI/2, PI/2] to avoid flipping image upside down
      // We only want a small rotation to straighten the horizon line
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;

      // Calculate rotated canvas size to avoid clipping
      const absAngle = Math.abs(angle);
      const newW = Math.ceil(img.width * Math.cos(absAngle) + img.height * Math.sin(absAngle));
      const newH = Math.ceil(img.width * Math.sin(absAngle) + img.height * Math.cos(absAngle));

      canvas.width = newW;
      canvas.height = newH;

      ctx.translate(newW / 2, newH / 2);
      ctx.rotate(-angle);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      const rotated = canvas.toDataURL('image/jpeg', 0.95);
      setRotatedImageSrc(rotated);
      setPoints([]);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setCropZoom(1);
      setCropPan({ x: 0, y: 0 });
      setCropBox(null);
      setStep('crop');
    };
    img.src = imageSrc;
  };

  // ─── CROP STEP ────────────────────────────────────────────────────────────────

  // Initialize crop box when entering crop step
  useEffect(() => {
    if (!rotatedImageSrc || step !== 'crop') return;
    const img = new Image();
    img.onload = () => {
      // Smaller centered crop box (60% of image)
      const boxW = img.width * 0.6;
      const boxH = img.height * 0.6;
      setCropBox({
        x: (img.width - boxW) / 2,
        y: (img.height - boxH) / 2,
        width: boxW,
        height: boxH
      });
    };
    img.src = rotatedImageSrc;
  }, [rotatedImageSrc, step]);

  // Draw crop overlay
  useEffect(() => {
    if (!cropCanvasRef.current || !rotatedImageSrc || !cropBox) return;

    const img = new Image();
    img.onload = () => {
      const canvas = cropCanvasRef.current!;
      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext('2d')!;

      ctx.save();
      ctx.translate(cropPan.x * cropZoom, cropPan.y * cropZoom);
      ctx.scale(cropZoom, cropZoom);
      ctx.drawImage(img, 0, 0);

      // Dark overlay outside crop
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, 0, img.width, img.height);

      // Clear crop area
      ctx.clearRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
      ctx.drawImage(img, cropBox.x, cropBox.y, cropBox.width, cropBox.height, cropBox.x, cropBox.y, cropBox.width, cropBox.height);

      // Crop border
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 3 / cropZoom;
      ctx.strokeRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);

      // Corner handles (large for touch)
      const handleSize = 20 / cropZoom;
      const handles = [
        { x: cropBox.x, y: cropBox.y },
        { x: cropBox.x + cropBox.width, y: cropBox.y },
        { x: cropBox.x, y: cropBox.y + cropBox.height },
        { x: cropBox.x + cropBox.width, y: cropBox.y + cropBox.height }
      ];
      handles.forEach(handle => {
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, handleSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2 / cropZoom;
        ctx.stroke();
      });

      ctx.restore();
    };
    img.src = rotatedImageSrc;
  }, [rotatedImageSrc, cropBox, cropZoom, cropPan]);

  const getCropCanvasCoords = (clientX: number, clientY: number): Point => {
    const canvas = cropCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((clientX - rect.left) * scaleX - cropPan.x * cropZoom) / cropZoom,
      y: ((clientY - rect.top) * scaleY - cropPan.y * cropZoom) / cropZoom
    };
  };

  const handleCropTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!cropBox) return;

    if (e.touches.length === 2) {
      // Pinch zoom
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.sqrt(
        Math.pow(t2.clientX - t1.clientX, 2) + Math.pow(t2.clientY - t1.clientY, 2)
      );
      setCropInitialDistance(distance);
      setCropInitialZoom(cropZoom);
      setCropIsPanning(false);
      setCropDragging(null);
      return;
    }

    if (e.touches.length === 1) {
      const coords = getCropCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);

      // Check corner handles
      const handleThreshold = 40 / cropZoom;
      const corners = [
        { name: 'tl', x: cropBox.x, y: cropBox.y },
        { name: 'tr', x: cropBox.x + cropBox.width, y: cropBox.y },
        { name: 'bl', x: cropBox.x, y: cropBox.y + cropBox.height },
        { name: 'br', x: cropBox.x + cropBox.width, y: cropBox.y + cropBox.height }
      ];

      for (const corner of corners) {
        const dx = coords.x - corner.x;
        const dy = coords.y - corner.y;
        if (Math.sqrt(dx * dx + dy * dy) < handleThreshold) {
          setCropDragging(corner.name);
          return;
        }
      }

      // Check if inside crop box (move crop)
      if (coords.x > cropBox.x && coords.x < cropBox.x + cropBox.width &&
          coords.y > cropBox.y && coords.y < cropBox.y + cropBox.height) {
        setCropDragging('move');
        setCropPanStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
        return;
      }

      // Otherwise, pan the image
      setCropIsPanning(true);
      setCropPanStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      setCropInitialPan(cropPan);
    }
  };

  const handleCropTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!cropBox) return;

    if (e.touches.length === 2 && cropInitialDistance > 0) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.sqrt(
        Math.pow(t2.clientX - t1.clientX, 2) + Math.pow(t2.clientY - t1.clientY, 2)
      );
      const ratio = distance / cropInitialDistance;
      setCropZoom(Math.max(0.5, Math.min(5, cropInitialZoom * ratio)));
      return;
    }

    if (e.touches.length === 1) {
      const coords = getCropCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);

      if (cropDragging && cropDragging !== 'move') {
        // Resize crop box
        let newBox = { ...cropBox };
        const minSize = 80;

        switch (cropDragging) {
          case 'tl':
            newBox.width = cropBox.width + (cropBox.x - coords.x);
            newBox.height = cropBox.height + (cropBox.y - coords.y);
            if (newBox.width >= minSize) newBox.x = coords.x;
            else newBox.width = cropBox.width;
            if (newBox.height >= minSize) newBox.y = coords.y;
            else newBox.height = cropBox.height;
            break;
          case 'tr':
            newBox.width = Math.max(minSize, coords.x - cropBox.x);
            newBox.height = cropBox.height + (cropBox.y - coords.y);
            if (newBox.height >= minSize) newBox.y = coords.y;
            else newBox.height = cropBox.height;
            break;
          case 'bl':
            newBox.width = cropBox.width + (cropBox.x - coords.x);
            if (newBox.width >= minSize) newBox.x = coords.x;
            else newBox.width = cropBox.width;
            newBox.height = Math.max(minSize, coords.y - cropBox.y);
            break;
          case 'br':
            newBox.width = Math.max(minSize, coords.x - cropBox.x);
            newBox.height = Math.max(minSize, coords.y - cropBox.y);
            break;
        }
        setCropBox(newBox);
      } else if (cropDragging === 'move') {
        // Move crop box
        const canvas = cropCanvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const dx = ((e.touches[0].clientX - cropPanStart.x) * scaleX) / cropZoom;
        const dy = ((e.touches[0].clientY - cropPanStart.y) * (canvas.height / rect.height)) / cropZoom;
        setCropBox(prev => prev ? { ...prev, x: prev.x + dx, y: prev.y + dy } : prev);
        setCropPanStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      } else if (cropIsPanning) {
        // Pan image
        const dx = (e.touches[0].clientX - cropPanStart.x) / cropZoom;
        const dy = (e.touches[0].clientY - cropPanStart.y) / cropZoom;
        setCropPan({ x: cropInitialPan.x + dx, y: cropInitialPan.y + dy });
      }
    }
  };

  const handleCropTouchEnd = () => {
    setCropDragging(null);
    setCropIsPanning(false);
    setCropInitialDistance(0);
  };

  const applyCrop = () => {
    if (!rotatedImageSrc || !cropBox) return;

    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      canvas.width = cropBox.width;
      canvas.height = cropBox.height;

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, -cropBox.x, -cropBox.y);

      const cropped = canvas.toDataURL('image/jpeg', 0.95);
      setCroppedImageSrc(cropped);
      setStep('squash');
    };
    img.src = rotatedImageSrc;
  };

  // ─── SQUASH STEP ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!squashCanvasRef.current || !croppedImageSrc) return;

    const img = new Image();
    img.onload = () => {
      const canvas = squashCanvasRef.current!;
      const squashFactor = 10;

      canvas.width = img.width;
      canvas.height = Math.round(img.height / squashFactor);

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, canvas.width, canvas.height);

      const squashed = canvas.toDataURL('image/jpeg', 0.95);
      setSquashedImageSrc(squashed);
    };
    img.src = croppedImageSrc;
  }, [croppedImageSrc]);

  const downloadImage = () => {
    if (!squashedImageSrc) return;

    const link = document.createElement('a');
    link.href = squashedImageSrc;
    link.download = `squash-shot-${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Extract timestamp from original image EXIF when loaded
  const [exifTimestamp, setExifTimestamp] = useState<number | null>(null);

  const loadExifr = (): Promise<any> => {
    return new Promise((resolve, reject) => {
      if ((window as any).exifr) { resolve((window as any).exifr); return; }
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/exifr@7.1.3/dist/full.umd.js';
      s.onload = () => resolve((window as any).exifr);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  };

  const extractTimestamp = useCallback(async (dataUrl: string) => {
    try {
      // Convert data URL to blob for EXIF parsing
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const exifr = await loadExifr();
      if (exifr) {
        const data = await exifr.parse(blob, { tiff: true, exif: true });
        const dt = data?.DateTimeOriginal || data?.DateTime;
        if (dt instanceof Date) {
          setExifTimestamp(dt.getTime());
          const iso = dt.toISOString().slice(0, 16);
          setPhotoTimestamp(iso);
          return;
        }
      }
    } catch {}
    setExifTimestamp(null);
    // Default to now
    setPhotoTimestamp(new Date().toISOString().slice(0, 16));
  }, []);

  // Extract EXIF when image is first loaded
  useEffect(() => {
    if (imageSrc) extractTimestamp(imageSrc);
  }, [imageSrc, extractTimestamp]);

  const saveToPhotoDatabase = async () => {
    if (!squashedImageSrc) return;

    try {
      // Convert squashed image to blob
      const res = await fetch(squashedImageSrc);
      const blob = await res.blob();

      // Determine timestamp
      const ts = photoTimestamp ? new Date(photoTimestamp).getTime() : Date.now();
      const date = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD

      // Store blob in IndexedDB
      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const DB_NAME = 'ssa-db';
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 4);
        req.onupgradeneeded = (e: any) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        };
        req.onsuccess = (e: any) => resolve(e.target.result);
        req.onerror = (e: any) => reject(e.target.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const req = tx.objectStore('photos').put({ id, blob });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      // Add metadata to localStorage
      const lsKey = `ssa:photos-meta:${date}`;
      const existing = JSON.parse(localStorage.getItem(lsKey) || '[]');
      const photo = {
        id,
        name: `squash-shot-${id.slice(2, 12)}.jpg`,
        size: blob.size,
        utc: ts,
        lat: null,
        lon: null,
        sessionDate: date,
        cloudSynced: false,
        addedAt: Date.now()
      };
      existing.push(photo);
      localStorage.setItem(lsKey, JSON.stringify(existing));

      navigator.vibrate?.([50, 50, 100]);
      alert(`Saved to Photos (${date})`);
    } catch (err: any) {
      alert(`Error saving: ${err.message}`);
    }
  };

  const resetAll = () => {
    setStep('camera');
    setImageSrc('');
    setRotatedImageSrc('');
    setCroppedImageSrc('');
    setSquashedImageSrc('');
    setPoints([]);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setCropBox(null);
    setCropZoom(1);
    setCropPan({ x: 0, y: 0 });
    setDraggingPoint(null);
    setExifTimestamp(null);
    setPhotoTimestamp('');
    setShowTimestampInput(false);
  };

  return (
    <div className="absolute inset-0 bg-black flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-b from-slate-900 to-transparent px-4 py-3 flex justify-between items-center text-sm z-10">
        <div className="flex items-center gap-2">
          {step !== 'camera' && (
            <button
              onClick={() => {
                if (step === 'points') { setStep('camera'); setPoints([]); setZoom(1); setPan({ x: 0, y: 0 }); }
                else if (step === 'crop') { setStep('points'); setCropBox(null); setCropZoom(1); setCropPan({ x: 0, y: 0 }); }
                else if (step === 'squash') { setStep('crop'); setCroppedImageSrc(''); setSquashedImageSrc(''); }
              }}
              className="text-white bg-slate-700/60 rounded-full w-8 h-8 flex items-center justify-center active:scale-90 transition-transform"
            >
              ←
            </button>
          )}
          <h1 className="font-bold text-white">Squash Shots</h1>
        </div>
        <div className="text-slate-400">
          {step === 'camera' && 'Select image'}
          {step === 'points' && `${points.length}/2 points`}
          {step === 'crop' && 'Crop'}
          {step === 'squash' && 'Result'}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileUpload}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── Camera / Upload Step ── */}
        {step === 'camera' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-6">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="max-w-full max-h-[50vh] rounded-lg bg-black object-cover"
            />
            <button
              onClick={captureImage}
              className="w-full px-6 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-base rounded-lg active:scale-95 transition-transform"
            >
              📸 Capture from Camera
            </button>
            <div className="flex gap-3 w-full">
              <button
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.setAttribute('capture', '');
                    fileInputRef.current.accept = 'image/*';
                    fileInputRef.current.click();
                  }
                }}
                className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white font-semibold text-sm rounded-lg active:scale-95 transition-transform"
              >
                🖼️ Photo Album
              </button>
              <button
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.removeAttribute('capture');
                    fileInputRef.current.accept = 'image/*,.jpg,.jpeg,.png,.heic,.heif';
                    fileInputRef.current.click();
                  }
                }}
                className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white font-semibold text-sm rounded-lg active:scale-95 transition-transform"
              >
                📁 Browse Files
              </button>
            </div>
          </div>
        )}

        {/* ── Points Selection Step ── */}
        {step === 'points' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black relative overflow-hidden">
              <canvas
                ref={pointsCanvasRef}
                onTouchStart={handlePointsTouchStart}
                onTouchMove={handlePointsTouchMove}
                onTouchEnd={handlePointsTouchEnd}
                onMouseDown={handlePointsMouseDown}
                onMouseMove={handlePointsMouseMove}
                onMouseUp={handlePointsMouseUp}
                onMouseLeave={handlePointsMouseUp}
                onWheel={handlePointsWheel}
                className="w-full h-full"
                style={{ maxWidth: '100%', maxHeight: '100%', touchAction: 'none', cursor: draggingPoint !== null ? 'grabbing' : 'crosshair' }}
              />
            </div>

            {/* Bottom control panel */}
            <div className="flex-shrink-0 bg-gradient-to-t from-slate-900 via-slate-900/95 to-transparent px-4 py-4 space-y-3">
              <div className="text-center space-y-1">
                <p className="text-white font-bold text-sm">
                  {points.length === 0 && '👆 Long-press to place point 1'}
                  {points.length === 1 && '👆 Long-press to place point 2'}
                  {points.length === 2 && '✓ Two points set — confirm or adjust'}
                </p>
                <p className="text-slate-500 text-xs">
                  {points.length < 2
                    ? 'Hold 1.5s to place • Drag points to move • Pinch to zoom'
                    : 'Drag points to adjust • Double-click on desktop'}
                </p>
              </div>

              {points.length === 2 && (
                <button
                  onClick={rotateImage}
                  className="w-full px-6 py-4 bg-green-600 hover:bg-green-700 text-white font-bold text-lg rounded-lg active:scale-95 transition-transform shadow-lg shadow-green-900/50"
                >
                  ✓ Confirm &amp; Next →
                </button>
              )}
              {points.length > 0 && points.length < 2 && (
                <button
                  onClick={removeLastPoint}
                  className="w-full px-4 py-3 bg-red-600/60 text-white font-semibold text-sm rounded-lg active:scale-95 transition-transform"
                >
                  ✕ Remove Point
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Crop Step ── */}
        {step === 'crop' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black overflow-hidden">
              <canvas
                ref={cropCanvasRef}
                onTouchStart={handleCropTouchStart}
                onTouchMove={handleCropTouchMove}
                onTouchEnd={handleCropTouchEnd}
                className="w-full h-full"
                style={{ maxWidth: '100%', maxHeight: '100%', touchAction: 'none' }}
              />
            </div>

            <div className="flex-shrink-0 bg-gradient-to-t from-slate-900 via-slate-900/95 to-transparent px-4 py-4 space-y-3">
              <p className="text-slate-400 text-center text-xs">
                Drag corners to resize • Drag inside to move • Pinch to zoom image
              </p>
              <button
                onClick={applyCrop}
                className="w-full px-6 py-4 bg-green-600 hover:bg-green-700 text-white font-bold text-lg rounded-lg active:scale-95 transition-transform shadow-lg shadow-green-900/50"
              >
                ✓ Crop &amp; Squash →
              </button>
            </div>
          </div>
        )}

        {/* ── Squash Result Step ── */}
        {step === 'squash' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 flex items-center justify-center bg-black overflow-auto p-4">
              {squashedImageSrc && (
                <img
                  src={squashedImageSrc}
                  alt="Squashed"
                  className="max-w-full max-h-full object-contain rounded"
                />
              )}
            </div>

            <div className="flex-shrink-0 bg-gradient-to-t from-slate-900 via-slate-900/95 to-transparent px-4 py-4 space-y-3">
              <p className="text-slate-400 text-center text-xs">
                Height reduced 10×
              </p>

              {/* Timestamp section */}
              <div className="bg-slate-800/60 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-xs font-medium">
                    {exifTimestamp ? '📅 EXIF timestamp found' : '⚠️ No timestamp in image'}
                  </span>
                  <button
                    onClick={() => setShowTimestampInput(!showTimestampInput)}
                    className="text-xs text-blue-400 underline"
                  >
                    {showTimestampInput ? 'Hide' : 'Edit'}
                  </button>
                </div>
                {showTimestampInput && (
                  <input
                    type="datetime-local"
                    value={photoTimestamp}
                    onChange={(e) => setPhotoTimestamp(e.target.value)}
                    className="w-full bg-slate-700 text-white text-sm rounded px-3 py-2 border border-slate-600"
                  />
                )}
                {!showTimestampInput && photoTimestamp && (
                  <p className="text-slate-400 text-xs">
                    {new Date(photoTimestamp).toLocaleString()}
                  </p>
                )}
              </div>

              {/* Action buttons */}
              <button
                onClick={saveToPhotoDatabase}
                className="w-full px-6 py-4 bg-green-600 hover:bg-green-700 text-white font-bold text-lg rounded-lg active:scale-95 transition-transform shadow-lg shadow-green-900/50"
              >
                💾 Save to Photo Database
              </button>
              <div className="flex gap-2">
                <button
                  onClick={downloadImage}
                  className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-lg active:scale-95 transition-transform"
                >
                  ⬇ Download
                </button>
                <button
                  onClick={resetAll}
                  className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm rounded-lg active:scale-95 transition-transform"
                >
                  ↺ New
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hidden canvases */}
      <canvas ref={canvasRef} className="hidden" />
      <canvas ref={squashCanvasRef} className="hidden" />
    </div>
  );
}
