// Tiny IndexedDB layer for the scan library.
const DB_NAME = 'scan-library';
const STORE = 'scans';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  }));
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export function putScan(rec) { return tx('readwrite', (s) => req2p(s.put(rec))); }
export function getScan(id) { return tx('readonly', (s) => req2p(s.get(id))); }
export function deleteScan(id) { return tx('readwrite', (s) => req2p(s.delete(id))); }

/** All scans, newest first, without the heavy blobs unless asked. */
export async function listScans() {
  const all = await tx('readonly', (s) => req2p(s.getAll()));
  return all.sort((a, b) => b.created - a.created);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* best effort */ }
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) { /* ignore */ }
  return null;
}
