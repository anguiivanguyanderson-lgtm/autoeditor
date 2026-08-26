// Client-side project storage (IndexedDB). Everything lives in the user's browser
// — nothing is uploaded. Two object stores:
//   - "projects": one record per project (name, timestamps, thumbnail, and the
//     serialisable edit state; NO media bytes).
//   - "media":    the actual image/audio/video Blobs, keyed "<projectId>/<mediaId>".
// Media is stored separately so a big video doesn't get rewritten every autosave.

const DB_NAME = "autoeditor";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_MEDIA = "media";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB not available")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_MEDIA)) db.createObjectStore(STORE_MEDIA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- storage durability ----------------------------------------------------

// Ask the browser not to evict this origin's data under storage pressure.
export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); }
  catch (_) {}
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch (_) {}
  return { usage: 0, quota: 0 };
}

// ---- projects --------------------------------------------------------------

export function newId() {
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Metadata for the projects grid — never pulls media, so it's fast.
export async function listProjects() {
  const all = await tx(STORE_PROJECTS, "readonly", (s) => reqP(s.getAll()));
  return (all || [])
    .map(({ id, name, createdAt, updatedAt, thumb, durationSec, clipCount }) =>
      ({ id, name, createdAt, updatedAt, thumb, durationSec, clipCount }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getProject(id) {
  return tx(STORE_PROJECTS, "readonly", (s) => reqP(s.get(id)));
}

export async function saveProject(record) {
  const rec = { ...record, updatedAt: Date.now() };
  await tx(STORE_PROJECTS, "readwrite", (s) => reqP(s.put(rec)));
  return rec;
}

export async function renameProject(id, name) {
  const rec = await getProject(id);
  if (!rec) return null;
  rec.name = name; rec.updatedAt = Date.now();
  await tx(STORE_PROJECTS, "readwrite", (s) => reqP(s.put(rec)));
  return rec;
}

export async function deleteProject(id) {
  await deleteProjectMedia(id);
  await tx(STORE_PROJECTS, "readwrite", (s) => reqP(s.delete(id)));
}

// ---- media -----------------------------------------------------------------

const mediaKey = (projectId, mediaId) => `${projectId}/${mediaId}`;

export async function putMedia(projectId, mediaId, blob) {
  await tx(STORE_MEDIA, "readwrite", (s) => reqP(s.put(blob, mediaKey(projectId, mediaId))));
}

export async function getMedia(projectId, mediaId) {
  return tx(STORE_MEDIA, "readonly", (s) => reqP(s.get(mediaKey(projectId, mediaId))));
}

export async function deleteMedia(projectId, mediaId) {
  await tx(STORE_MEDIA, "readwrite", (s) => reqP(s.delete(mediaKey(projectId, mediaId))));
}

// All media ids currently stored for a project (the part after "<projectId>/").
export async function listMediaIds(projectId) {
  const prefix = `${projectId}/`;
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  const keys = await tx(STORE_MEDIA, "readonly", (s) => reqP(s.getAllKeys(range)));
  return (keys || []).map((k) => String(k).slice(prefix.length));
}

export async function deleteProjectMedia(projectId) {
  const prefix = `${projectId}/`;
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  await tx(STORE_MEDIA, "readwrite", (s) => reqP(s.delete(range)));
}

// Reconcile stored media with what the project currently needs: write any missing
// blobs, drop any orphaned ones. `wanted` is a Map(mediaId -> Blob). Only blobs
// that aren't already stored are written, so autosave stays cheap for big video.
export async function syncMedia(projectId, wanted) {
  const have = new Set(await listMediaIds(projectId));
  const wantIds = new Set(wanted.keys());
  for (const [id, blob] of wanted) {
    if (!have.has(id) && blob) await putMedia(projectId, id, blob);
  }
  for (const id of have) {
    if (!wantIds.has(id)) await deleteMedia(projectId, id);
  }
}
