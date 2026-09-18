
// Phase 2 — pending originals upload state. When the originals queue creates
// a Bunny Stream video object but the (resumable) TUS upload doesn't finish,
// we keep its GUID keyed by local video id. A later run reuses the same
// Stream video so tus-js-client resumes the upload instead of restarting it.
// Cleared once the upload completes.
const PENDING_ORIG_KEY = "ssa:pendingOrigStream";

function getPendingOrigStreams() { try { const v=localStorage.getItem(PENDING_ORIG_KEY); return v?JSON.parse(v):{};} catch{return{};} }

function getPendingOrigStream(videoId) { return getPendingOrigStreams()[videoId] || null; }

function setPendingOrigStream(videoId, streamId) { try { const o=getPendingOrigStreams(); o[videoId]=streamId; localStorage.setItem(PENDING_ORIG_KEY,JSON.stringify(o));} catch{} }

function clearPendingOrigStream(videoId) { try { const o=getPendingOrigStreams(); delete o[videoId]; localStorage.setItem(PENDING_ORIG_KEY,JSON.stringify(o));} catch{} }

export { PENDING_ORIG_KEY, getPendingOrigStreams, getPendingOrigStream, setPendingOrigStream, clearPendingOrigStream };