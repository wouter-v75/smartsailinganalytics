
// Connection quality, for network-aware auto-sync. `good` (wifi/ethernet/4g,
// not Save-Data) gates the HEAVY push (videos); `online` gates the light pull.
// Falls back to "usable" when the Network Information API is unavailable (iOS).
function connInfo() {
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  const c = typeof navigator !== "undefined" ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection) : null;
  if (!c) return { online, good: online, metered: false };
  const type = c.type; const eff = c.effectiveType; const saveData = !!c.saveData;
  const good = online && !saveData && (type === "wifi" || type === "ethernet" || (!type && eff === "4g") || eff === "4g");
  const metered = type === "cellular" || saveData;
  return { online, good, metered, type, eff };
}

// Is this link actually Wi-Fi (or ethernet)?
//
// Deliberately stricter than connInfo().good, which counts "4g" as good — that's a
// cellular data plan, and video is the one payload big enough to burn it. Phone clips
// are smaller than a GoPro's, but a session is still hundreds of MB.
//
// When the Network Information API isn't available (iOS Safari, Firefox) we CANNOT
// prove the link is unmetered, so we return false and leave it to the manual Upload
// button. Failing closed costs a tap; failing open costs the user's data.
function onWifi() {
  if (typeof navigator === "undefined") return false;
  if (navigator.onLine === false) return false;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c || c.saveData) return false;
  return c.type === "wifi" || c.type === "ethernet";
}

export { connInfo, onWifi };