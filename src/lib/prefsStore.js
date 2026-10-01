// prefsStore.js — this machine's long-lived choices, in their OWN database.
//
// WHY NOT ssa-db. It was in ssa-db, for one evening, and it stopped every video
// from playing.
//
// Half a dozen files open `ssa-db` versionless — SailScanTab, PhotosTab,
// AdminTab, photoStore, the admin backfill panel. None of them listens for
// `versionchange`, so none of them closes when an upgrade is needed. The moment
// localStore names a HIGHER version, IndexedDB blocks the upgrade until every
// other connection closes, and openDb() then never resolves: no error, no
// rejection, just a promise that hangs. Every read behind it — the videos, the
// day log, the photos — silently waits for ever.
//
// CLAUDE.md warns that localStore owns ssa-db's version. The safe reading is
// stronger than "do not name a version elsewhere": do not make ssa-db's version
// move at all for something that has nothing to do with a day's data. A
// separate database has its own version, its own upgrade, and no other
// connections to be blocked by.
//
// A FileSystemDirectoryHandle is structured-cloneable, which is why this is
// IndexedDB and not localStorage — localStorage could not hold one.

const DB_NAME = 'ssa-prefs'
const DB_VER = 1
const STORE = 'prefs'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = (e) => {
      const db = e.target.result
      // If a later version ever arrives, get out of its way rather than
      // becoming the connection that blocks it — the mistake above, one level
      // down.
      db.onversionchange = () => { try { db.close() } catch { /* already gone */ } }
      resolve(db)
    }
    req.onerror = (e) => reject(e.target.error)
    req.onblocked = () => reject(new Error('ssa-prefs upgrade blocked'))
  })
}

export async function getPref(key) {
  try {
    const db = await openDb()
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      r.onsuccess = () => res(r.result ? r.result.value : null)
      r.onerror = () => rej(r.error)
    })
  } catch { return null }
}

export async function setPref(key, value) {
  try {
    const db = await openDb()
    await new Promise((res, rej) => {
      const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, value })
      r.onsuccess = () => res()
      r.onerror = () => rej(r.error)
    })
    return true
  } catch { return false }
}

export const WATCH_FOLDER_PREF = 'watchFolder'

// The day's drone footage, for reviewing off the card. A SEPARATE key from the
// watch folder on purpose: one is the encoder's outbox (~/clips) and the other
// is the SSD, and the two are never the same folder — sharing a key would make
// pointing at one silently re-point the other.
export const FOOTAGE_FOLDER_PREF = 'footageFolder'
