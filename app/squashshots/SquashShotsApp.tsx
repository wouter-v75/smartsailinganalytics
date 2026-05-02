'use client';

import React, { useState, useRef, useEffect } from 'react';

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
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [initialPan, setInitialPan] = useState({ x: 0, y: 0 });
  const [initialDistance, setInitialDistance] = useState(0);
  const [cropBox, setCropBox] = useState<CropBox | null>(null);
  const [cropDragging, setCropDragging] = useState<string | null>(null);
  const [crosshairPos, setCrosshairPos] = useState<Point | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement>(null);
  const squashCanvasRef = useRef<HTMLCanvasElement>(null);

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
      alert('Camera access required');
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
    stream.getTracks().forEach(track => track.stop());

    setStep('points');
  };

  // Touch handlers for point selection
  const getTouchCoords = (touch: Touch, rect: DOMRect) => {
    return {
      x: (touch.clientX - rect.left - pan.x * zoom) / zoom,
      y: (touch.clientY - rect.top - pan.y * zoom) / zoom
    };
  };

  const handlePointsTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const rect = pointsCanvasRef.current!.getBoundingClientRect();

    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.sqrt(
        Math.pow(t2.clientX - t1.clientX, 2) + Math.pow(t2.clientY - t1.clientY, 2)
      );
      setInitialDistance(distance);
    } else if (e.touches.length === 1) {
      setIsPanning(true);
      setPanStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      setInitialPan(pan);
      
      const coords = getTouchCoords(e.touches[0], rect);
      setCrosshairPos(coords);
    }
  };

  const handlePointsTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 0) return;

    const rect = pointsCanvasRef.current!.getBoundingClientRect();

    if (e.touches.length === 2 && initialDistance > 0) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.sqrt(
        Math.pow(t2.clientX - t1.clientX, 2) + Math.pow(t2.clientY - t1.clientY, 2)
      );
      const ratio = distance / initialDistance;
      setZoom(prev => Math.max(1, Math.min(5, prev * ratio)));
      setInitialDistance(distance);
    } else if (e.touches.length === 1 && isPanning) {
      const dx = (e.touches[0].clientX - panStart.x) / zoom;
      const dy = (e.touches[0].clientY - panStart.y) / zoom;
      setPan({ x: initialPan.x + dx, y: initialPan.y + dy });
      
      const coords = getTouchCoords(e.touches[0], rect);
      setCrosshairPos(coords);
    }
  };

  const handlePointsTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const rect = pointsCanvasRef.current!.getBoundingClientRect();

    if (e.touches.length === 0 && e.changedTouches.length > 0) {
      const lastTouch = e.changedTouches[0];
      const coords = getTouchCoords(lastTouch, rect);
      
      if (points.length < 2) {
        setPoints([...points, coords]);
        navigator.vibrate?.(50);
      }
    }

    setIsPanning(false);
    setInitialDistance(0);
    setCrosshairPos(null);
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

      // Draw points with large touch targets
      points.forEach((point, idx) => {
        ctx.fillStyle = idx === 0 ? '#3b82f6' : '#ef4444';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        ctx.fillStyle = 'white';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${idx + 1}`, point.x, point.y);
      });

      // Draw line connecting points
      if (points.length === 2) {
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw crosshair
      if (crosshairPos && points.length < 2) {
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        
        const size = 40;
        ctx.beginPath();
        ctx.moveTo(crosshairPos.x - size, crosshairPos.y);
        ctx.lineTo(crosshairPos.x + size, crosshairPos.y);
        ctx.moveTo(crosshairPos.x, crosshairPos.y - size);
        ctx.lineTo(crosshairPos.x, crosshairPos.y + size);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(crosshairPos.x, crosshairPos.y, 50, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    };
    img.src = imageSrc;
  }, [imageSrc, points, zoom, pan, crosshairPos]);

  const rotateImage = async () => {
    if (points.length !== 2 || !imageSrc || !canvasRef.current) return;

    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d')!;

      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const angle = Math.atan2(dy, dx);

      canvas.width = img.width;
      canvas.height = img.height;

      ctx.translate(img.width / 2, img.height / 2);
      ctx.rotate(-angle);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      const rotated = canvas.toDataURL('image/jpeg', 0.95);
      setRotatedImageSrc(rotated);
      setPoints([]);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setStep('crop');
    };
    img.src = imageSrc;
  };

  // Draw crop overlay
  useEffect(() => {
    if (!cropCanvasRef.current || !rotatedImageSrc) return;

    const img = new Image();
    img.onload = () => {
      const canvas = cropCanvasRef.current!;
      canvas.width = img.width;
      canvas.height = img.height;

      if (!cropBox) {
        setCropBox({
          x: img.width * 0.05,
          y: img.height * 0.05,
          width: img.width * 0.9,
          height: img.height * 0.9
        });
        return;
      }

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(0, 0, img.width, img.height);
      ctx.clearRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);

      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 4;
      ctx.strokeRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);

      // Draw large touch-friendly handles
      const handleSize = 24;
      const handles = [
        { x: cropBox.x, y: cropBox.y },
        { x: cropBox.x + cropBox.width, y: cropBox.y },
        { x: cropBox.x, y: cropBox.y + cropBox.height },
        { x: cropBox.x + cropBox.width, y: cropBox.y + cropBox.height }
      ];

      handles.forEach(handle => {
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.strokeRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
      });
    };
    img.src = rotatedImageSrc;
  }, [rotatedImageSrc, cropBox]);

  // Touch handlers for crop
  const handleCropTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!cropBox) return;

    const rect = cropCanvasRef.current!.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    const y = e.touches[0].clientY - rect.top;

    const handleSize = 32;
    const corners = [
      { name: 'tl', x: cropBox.x, y: cropBox.y },
      { name: 'tr', x: cropBox.x + cropBox.width, y: cropBox.y },
      { name: 'bl', x: cropBox.x, y: cropBox.y + cropBox.height },
      { name: 'br', x: cropBox.x + cropBox.width, y: cropBox.y + cropBox.height }
    ];

    for (const corner of corners) {
      if (Math.abs(x - corner.x) < handleSize && Math.abs(y - corner.y) < handleSize) {
        setCropDragging(corner.name);
        return;
      }
    }

    if (x > cropBox.x && x < cropBox.x + cropBox.width &&
        y > cropBox.y && y < cropBox.y + cropBox.height) {
      setCropDragging('move');
    }
  };

  const handleCropTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!cropDragging || !cropBox) return;

    const rect = cropCanvasRef.current!.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    const y = e.touches[0].clientY - rect.top;

    let newBox = { ...cropBox };
    const minSize = 80;

    switch (cropDragging) {
      case 'tl':
        newBox.x = Math.min(x, cropBox.x + cropBox.width - minSize);
        newBox.y = Math.min(y, cropBox.y + cropBox.height - minSize);
        newBox.width = cropBox.width - (newBox.x - cropBox.x);
        newBox.height = cropBox.height - (newBox.y - cropBox.y);
        break;
      case 'tr':
        newBox.width = Math.max(minSize, x - cropBox.x);
        newBox.y = Math.min(y, cropBox.y + cropBox.height - minSize);
        newBox.height = cropBox.height - (newBox.y - cropBox.y);
        break;
      case 'bl':
        newBox.x = Math.min(x, cropBox.x + cropBox.width - minSize);
        newBox.height = Math.max(minSize, y - cropBox.y);
        newBox.width = cropBox.width - (newBox.x - cropBox.x);
        break;
      case 'br':
        newBox.width = Math.max(minSize, x - cropBox.x);
        newBox.height = Math.max(minSize, y - cropBox.y);
        break;
      case 'move':
        const dx = x - (cropBox.x + cropBox.width / 2);
        const dy = y - (cropBox.y + cropBox.height / 2);
        newBox.x = cropBox.x + dx;
        newBox.y = cropBox.y + dy;
        break;
    }

    setCropBox(newBox);
  };

  const handleCropTouchEnd = () => {
    setCropDragging(null);
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

  // Squash step
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
  };

  return (
    <div className="fixed inset-0 bg-black flex flex-col overflow-hidden">
      {/* Header - minimal */}
      <div className="bg-gradient-to-b from-slate-900 to-transparent px-4 py-3 flex justify-between items-center text-sm">
        <h1 className="font-bold text-white">Squash Shots</h1>
        <div className="text-slate-400">
          {step === 'points' && `${points.length}/2`}
        </div>
      </div>

      {/* Main content - full screen */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Camera Step */}
        {step === 'camera' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="max-w-full max-h-[65vh] rounded-lg bg-black object-cover"
            />
            <button
              onClick={captureImage}
              className="px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg rounded-lg active:scale-95 transition-transform touch-none"
            >
              📸 Tap to Capture
            </button>
          </div>
        )}

        {/* Points Selection Step */}
        {step === 'points' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 flex items-center justify-center bg-black relative">
              <canvas
                ref={pointsCanvasRef}
                onTouchStart={handlePointsTouchStart}
                onTouchMove={handlePointsTouchMove}
                onTouchEnd={handlePointsTouchEnd}
                className="w-full h-full"
                style={{ maxWidth: '100%', maxHeight: '100%', touchAction: 'none' }}
              />
            </div>

            {/* Bottom control panel */}
            <div className="bg-gradient-to-t from-slate-900 via-slate-900 to-transparent px-4 py-6 space-y-4">
              <div className="text-center space-y-2">
                <p className="text-white font-bold text-base">
                  {points.length === 0 && '👆 Tap first point'}
                  {points.length === 1 && '👆 Tap second point'}
                  {points.length === 2 && '✓ Ready to rotate'}
                </p>
                {points.length < 2 && (
                  <p className="text-slate-400 text-xs">
                    Pinch to zoom • Drag to pan
                  </p>
                )}
              </div>

              {points.length === 2 && (
                <button
                  onClick={rotateImage}
                  className="w-full px-6 py-4 bg-green-600 hover:bg-green-700 text-white font-bold text-base rounded-lg active:scale-95 transition-transform touch-none"
                >
                  ↻ Rotate
                </button>
              )}
            </div>
          </div>
        )}

        {/* Crop Step */}
        {step === 'crop' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 flex items-center justify-center bg-black">
              <canvas
                ref={cropCanvasRef}
                onTouchStart={handleCropTouchStart}
                onTouchMove={handleCropTouchMove}
                onTouchEnd={handleCropTouchEnd}
                className="w-full h-full"
                style={{ maxWidth: '100%', maxHeight: '100%', touchAction: 'none' }}
              />
            </div>

            <div className="bg-gradient-to-t from-slate-900 via-slate-900 to-transparent px-4 py-6">
              <p className="text-white text-center font-semibold text-sm mb-4">
                Drag corners to crop
              </p>
              <button
                onClick={applyCrop}
                className="w-full px-6 py-4 bg-green-600 hover:bg-green-700 text-white font-bold text-base rounded-lg active:scale-95 transition-transform touch-none"
              >
                ✓ Apply Crop
              </button>
            </div>
          </div>
        )}

        {/* Squash Step */}
        {step === 'squash' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 flex items-center justify-center bg-black overflow-auto">
              {squashedImageSrc && (
                <img 
                  src={squashedImageSrc} 
                  alt="Squashed" 
                  className="max-w-full max-h-full object-contain"
                />
              )}
            </div>

            <div className="bg-gradient-to-t from-slate-900 via-slate-900 to-transparent px-4 py-6 space-y-3">
              <p className="text-slate-400 text-center text-xs">
                Height reduced 10×
              </p>
              <div className="flex gap-2">
                <button
                  onClick={downloadImage}
                  className="flex-1 px-6 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-base rounded-lg active:scale-95 transition-transform touch-none"
                >
                  ⬇ Download
                </button>
                <button
                  onClick={resetAll}
                  className="flex-1 px-6 py-4 bg-slate-700 hover:bg-slate-600 text-white font-bold text-base rounded-lg active:scale-95 transition-transform touch-none"
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
