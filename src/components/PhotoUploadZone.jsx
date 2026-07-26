// src/components/PhotoUploadZone.jsx
// Drag-drop / select photos in the Upload tab. Imports them (EXIF-date bucketed),
// uploads the thumbnail immediately, and pushes the full original only on a good
// (WiFi) connection — deferring it otherwise. Mirrors the video proxy/original
// flow. View/gallery stays in the Photos tab.

import React, { useState, useRef, useCallback } from "react";
import { importFiles, syncPhoto, connectionIsGood } from "../lib/photoStore";

const C = { bg:"#071624", panel:"#0d2236", border:"#1E3A5A", accent:"#06B6D4", head:"#E2E8F0", text:"#94A3B8", dim:"#64748B", good:"#10B981", warn:"#F59E0B" };

export default function PhotoUploadZone({ cloudStatus }) {
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [items, setItems] = useState([]); // {id,name,size,sessionDate,thumbSynced,originalSynced,error}
  const [busy, setBusy] = useState(false);
  const cloudOk = !!cloudStatus?.available;

  const patch = useCallback((id, fields) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...fields } : it))), []);

  const ingest = useCallback(async (files) => {
    setBusy(true);
    try {
      const photos = await importFiles(files);
      if (!photos.length) { setBusy(false); return; }
      setItems((prev) => [...photos.map((p) => ({ id: p.id, name: p.name, size: p.size, sessionDate: p.sessionDate, thumbSynced: false, originalSynced: false, error: null })), ...prev]);
      if (!cloudOk) { setBusy(false); return; }
      // Thumb immediately; original only on a good connection (else deferred).
      for (const p of photos) {
        try {
          const updated = await syncPhoto(p);
          patch(p.id, { thumbSynced: updated.thumbSynced, originalSynced: updated.originalSynced });
        } catch (e) { patch(p.id, { error: e.message }); }
      }
    } finally { setBusy(false); }
  }, [cloudOk, patch]);

  // Force-upload any originals still pending (e.g. user is on cellular but wants
  // them up now).
  const pushOriginals = useCallback(async () => {
    setBusy(true);
    try {
      const pending = items.filter((it) => it.thumbSynced && !it.originalSynced && !it.error);
      for (const it of pending) {
        try {
          // Rebuild a minimal photo ref from current per-date metadata is unnecessary;
          // syncPhoto only needs id+sessionDate+flags to push the original.
          const updated = await syncPhoto({ id: it.id, sessionDate: it.sessionDate, thumbSynced: true, originalSynced: false }, { force: true });
          patch(it.id, { originalSynced: updated.originalSynced });
        } catch (e) { patch(it.id, { error: e.message }); }
      }
    } finally { setBusy(false); }
  }, [items, patch]);

  const pendingOriginals = items.filter((it) => it.thumbSynced && !it.originalSynced && !it.error).length;
  const good = connectionIsGood();

  const fmtMB = (b) => (b / 1024 / 1024).toFixed(1);

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.head }}>📷 Photos</span>
        <span style={{ fontSize: 10, color: good ? C.good : C.warn }}>{good ? "WiFi — originals upload now" : "cellular — originals wait for WiFi"}</span>
      </div>

      <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple style={{ display: "none" }}
        onChange={(e) => { ingest(e.target.files); e.currentTarget.value = ""; }} />

      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); ingest(e.dataTransfer.files); }}
        style={{ border: `1.5px dashed ${dragOver ? C.accent : C.border}`, borderRadius: 8, padding: "18px 12px", textAlign: "center", cursor: "pointer", background: dragOver ? "#0F2A45" : "transparent" }}>
        <div style={{ fontSize: 12, color: C.text }}>{busy ? "Working…" : "Drop photos or click to select"}</div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>JPEG / PNG / HEIC · dated by EXIF · thumbnail now, original on WiFi</div>
      </div>

      {!cloudOk && (
        <div style={{ fontSize: 10, color: C.warn, marginTop: 6 }}>Cloud unavailable — photos saved locally; they’ll sync when the cloud is reachable.</div>
      )}

      {items.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: C.text, borderBottom: `1px solid ${C.border}`, padding: "3px 2px" }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
              <span style={{ color: C.dim }}>{fmtMB(it.size)} MB</span>
              <span style={{ color: C.dim }}>{it.sessionDate}</span>
              {it.error ? <span style={{ color: "#EF4444" }}>✕ {it.error.slice(0, 18)}</span>
                : <span style={{ color: it.originalSynced ? C.good : it.thumbSynced ? C.warn : C.dim }}>
                    {it.originalSynced ? "✓ original" : it.thumbSynced ? "thumb ✓ · original ⏳" : "…"}
                  </span>}
            </div>
          ))}
        </div>
      )}

      {pendingOriginals > 0 && (
        <button onClick={pushOriginals} disabled={busy}
          style={{ marginTop: 8, background: C.accent, border: "none", borderRadius: 7, color: "#001018", fontWeight: 700, fontSize: 11, padding: "6px 12px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}>
          Push {pendingOriginals} original{pendingOriginals > 1 ? "s" : ""} now
        </button>
      )}
    </div>
  );
}
