/**
 * Local video library. Video bytes live in a separate IndexedDB store so a
 * library listing never loads every movie into memory. Poster thumbnails are
 * intentionally part of metadata (Blob or data URL, as supplied by the app).
 *
 * Public records: { id, createdAt, updatedAt, ...metadata, poster? }.
 * saveMedia accepts video bytes as `blob`, `file`, or `videoBlob` and returns
 * metadata. getMedia returns metadata plus `blob`. Missing IDs return null.
 * All write promises resolve only after their transaction has committed.
 */

const DB_NAME = 'movies-r-sap-library';
const DB_VERSION = 1;
const METADATA = 'media';
const FILES = 'files';
let databasePromise = null;

function storageError(error, fallback = 'Your library could not be saved.') {
  if (error?.isMediaStorageError) return error;
  let message = fallback;
  if (error?.name === 'QuotaExceededError') {
    message = 'Your browser storage is full. Remove a movie or free up device space, then try again.';
  } else if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') {
    message = 'Local storage is unavailable. Open this app in a normal browser window and allow site storage.';
  } else if (error?.name === 'DataCloneError') {
    message = 'This movie contains metadata that cannot be stored. Try importing the file again.';
  } else if (error?.name === 'AbortError') {
    message = 'The library operation was interrupted. Please try again.';
  }
  const wrapped = new Error(message, { cause: error });
  wrapped.name = error?.name || 'MediaStorageError';
  wrapped.isMediaStorageError = true;
  return wrapped;
}

export function initStore() {
  if (databasePromise) return databasePromise;
  const promise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(storageError(null, 'This browser does not support a local movie library. Try a current version of Chrome, Edge, Firefox, or Safari.'));
      return;
    }
    let request;
    let settled = false;
    const fail = (error, message) => {
      if (settled) return;
      settled = true;
      reject(storageError(error, message));
    };
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      fail(error, 'The local movie library could not be opened.');
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(METADATA)) db.createObjectStore(METADATA, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'id' });
    };
    request.onerror = () => fail(request.error, 'The local movie library could not be opened.');
    request.onblocked = () => fail(null, 'Close other tabs of this app, then try opening your library again.');
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        if (databasePromise === promise) databasePromise = null;
      };
      db.onclose = () => {
        if (databasePromise === promise) databasePromise = null;
      };
      resolve(db);
    };
  });
  databasePromise = promise;
  // A failed open can be retried after a browser setting/tab has changed.
  promise.catch(() => {
    if (databasePromise === promise) databasePromise = null;
  });
  return promise;
}

async function transact(stores, mode, work) {
  const db = await initStore();
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let failure = null;
    try {
      transaction = db.transaction(stores, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = (event) => {
        failure ||= event.target?.error || transaction.error;
      };
      transaction.onabort = () => reject(storageError(failure || transaction.error, 'The library operation could not be completed. Please try again.'));
      work(transaction, (value) => { result = value; }, (error) => {
        failure = error;
        try { transaction.abort(); } catch { reject(storageError(error)); }
      });
    } catch (error) {
      if (transaction) {
        failure = error;
        try { transaction.abort(); } catch { reject(storageError(error)); }
      } else {
        if (error?.name === 'InvalidStateError') databasePromise = null;
        reject(storageError(error, 'The library operation could not be started. Please try again.'));
      }
    }
  });
}

function validateId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('A movie ID is required.');
  return id;
}

function videoFrom(record) {
  const value = record.blob ?? record.file ?? record.videoBlob;
  if (value !== undefined && value !== null && !(value instanceof Blob)) {
    throw new TypeError('The video must be a File or Blob.');
  }
  return value ?? null;
}

function cleanMetadata(record) {
  const { blob, file, videoBlob, ...metadata } = record;
  return metadata;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `movie-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listMedia() {
  return transact([METADATA], 'readonly', (tx, done) => {
    const request = tx.objectStore(METADATA).getAll();
    request.onsuccess = () => {
      const records = request.result;
      records.sort((a, b) => (Number(b.createdAt) || Date.parse(b.createdAt) || 0) - (Number(a.createdAt) || Date.parse(a.createdAt) || 0));
      done(records);
    };
  });
}

export async function saveMedia(record) {
  if (!record || typeof record !== 'object') throw new TypeError('A movie record is required.');
  const blob = videoFrom(record);
  if (!blob) throw new TypeError('Choose a video file to add to your library.');
  const now = Date.now();
  const id = record.id === undefined ? makeId() : validateId(record.id);
  const metadata = {
    ...cleanMetadata(record),
    id,
    fileName: record.fileName || blob.name || 'video',
    size: blob.size,
    mimeType: blob.type || record.mimeType || '',
    createdAt: record.createdAt ?? now,
    updatedAt: now,
  };
  return transact([METADATA, FILES], 'readwrite', (tx, done) => {
    tx.objectStore(METADATA).put(metadata);
    tx.objectStore(FILES).put({ id, blob });
    done(metadata);
  });
}

export async function getMedia(id) {
  validateId(id);
  return transact([METADATA, FILES], 'readonly', (tx, done, fail) => {
    let metadata;
    let file;
    let pending = 2;
    const finish = () => {
      if (--pending) return;
      if (!metadata) {
        done(null);
      } else if (!file?.blob) {
        fail(storageError(null, 'The video file is missing from local storage. Remove this entry and import the original file again.'));
      } else {
        done({ ...metadata, blob: file.blob });
      }
    };
    const metadataRequest = tx.objectStore(METADATA).get(id);
    metadataRequest.onsuccess = () => { metadata = metadataRequest.result; finish(); };
    const fileRequest = tx.objectStore(FILES).get(id);
    fileRequest.onsuccess = () => { file = fileRequest.result; finish(); };
  });
}

export async function updateMedia(id, updates) {
  validateId(id);
  if (!updates || typeof updates !== 'object') throw new TypeError('Movie updates are required.');
  const blob = videoFrom(updates);
  const stores = blob ? [METADATA, FILES] : [METADATA];
  return transact(stores, 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore(METADATA);
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        const current = request.result;
        if (!current) { done(null); return; }
        const metadata = {
          ...current,
          ...cleanMetadata(updates),
          id,
          createdAt: current.createdAt,
          updatedAt: Date.now(),
        };
        if (blob) {
          metadata.size = blob.size;
          metadata.mimeType = blob.type || updates.mimeType || current.mimeType || '';
          metadata.fileName = updates.fileName || blob.name || current.fileName;
          tx.objectStore(FILES).put({ id, blob });
        }
        store.put(metadata);
        done(metadata);
      } catch (error) {
        fail(error);
      }
    };
  });
}

export async function deleteMedia(id) {
  validateId(id);
  return transact([METADATA, FILES], 'readwrite', (tx, done) => {
    tx.objectStore(METADATA).delete(id);
    tx.objectStore(FILES).delete(id);
    done(true);
  });
}

export async function storageEstimate() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.estimate) return { supported: false, usage: null, quota: null, available: null, persisted: false };
  try {
    const estimate = await storage.estimate();
    const persisted = storage.persisted ? await storage.persisted().catch(() => false) : false;
    const usage = Number.isFinite(estimate.usage) ? estimate.usage : null;
    const quota = Number.isFinite(estimate.quota) ? estimate.quota : null;
    return { supported: true, usage, quota, available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null, persisted };
  } catch {
    return { supported: false, usage: null, quota: null, available: null, persisted: false };
  }
}

export async function requestPersistence() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) return false;
  try {
    if (storage.persisted && await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

/**
 * File-source adapter contract for a later NAS/media-server implementation.
 * A source provides: id, label, capabilities, list(), get(id), open(id), and
 * optional save(record), update(id, updates), remove(id).
 * list/get return metadata. open returns { blob?, url?, mimeType, fileName };
 * the player owns and revokes any object URL it creates from a returned Blob.
 * Remote adapters must implement real discovery/auth and HTTP range playback.
 * No server is configured or connected by this module.
 */
export const FILE_SOURCE_INTERFACE = Object.freeze({
  version: 1,
  required: Object.freeze(['id', 'label', 'capabilities', 'list', 'get', 'open']),
  optional: Object.freeze(['save', 'update', 'remove']),
});

export const localFileSource = Object.freeze({
  id: 'local',
  label: 'On this device',
  capabilities: Object.freeze({ upload: true, edit: true, remove: true, server: false }),
  list: listMedia,
  async get(id) {
    validateId(id);
    return transact([METADATA], 'readonly', (tx, done) => {
      const request = tx.objectStore(METADATA).get(id);
      request.onsuccess = () => done(request.result || null);
    });
  },
  async open(id) {
    const media = await getMedia(id);
    if (!media) return null;
    return { blob: media.blob, mimeType: media.mimeType, fileName: media.fileName };
  },
  save: saveMedia,
  update: updateMedia,
  remove: deleteMedia,
});
