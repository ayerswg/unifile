/**
 * Plugin extension slot storage
 *
 * Manages per-slot configuration for DSL plugins that declare extensionSlots.
 *
 * Two storage tiers:
 *   metadata  – stored in state.data.pluginExtensions (serialised with document)
 *   blobs     – stored in IndexedDB under the 'plugin-ext-blobs' store
 *               (binary files too large for JSON; keyed by "dslId::slotId")
 *
 * Metadata structure (state.data.pluginExtensions):
 * {
 *   [dslId]: {
 *     [slotId]: {
 *       type:     'text' | 'file',
 *       value:    string,   // text slot value
 *       filename: string,   // file slot: original filename
 *       size:     number,   // file slot: size in bytes
 *       mime:     string,   // file slot: MIME type
 *     }
 *   }
 * }
 */

import { state } from './state.js';

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

// Use a dedicated database so there is no version conflict with storage.js's
// 'unifile' database (which manages the documents store at version 1).
const IDB_NAME  = 'unifile-ext';
const IDB_STORE = 'blobs';

let _db = null;

async function _openIDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function _idbGet(key) {
  const db = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror  = () => reject(req.error);
  });
}

async function _idbPut(key, value) {
  const db = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function _idbDelete(key) {
  const db = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/** @returns {object} the full pluginExtensions object from state.data */
function _allMeta() {
  return state.data?.pluginExtensions ?? {};
}

/** Read metadata for one slot (or null if not set). */
export function getExtensionMeta(dslId, slotId) {
  return _allMeta()[dslId]?.[slotId] ?? null;
}

/** Write metadata for one slot and mark document dirty. */
function _setExtensionMeta(dslId, slotId, meta) {
  const data = state.data;
  if (!data) return;
  data.pluginExtensions ??= {};
  data.pluginExtensions[dslId] ??= {};
  if (meta === null) {
    delete data.pluginExtensions[dslId][slotId];
    if (Object.keys(data.pluginExtensions[dslId]).length === 0) {
      delete data.pluginExtensions[dslId];
    }
  } else {
    data.pluginExtensions[dslId][slotId] = meta;
  }
  state.update({ data, isDirty: true });
}

// ---------------------------------------------------------------------------
// Text slot API
// ---------------------------------------------------------------------------

/**
 * Set the value of a text-type extension slot.
 * @param {string} dslId
 * @param {string} slotId
 * @param {string} value
 */
export function setTextExtension(dslId, slotId, value) {
  if (!value || !value.trim()) {
    _setExtensionMeta(dslId, slotId, null);
  } else {
    _setExtensionMeta(dslId, slotId, { type: 'text', value: value.trim() });
  }
}

/**
 * Get the text value of a text-type extension slot (or null).
 * @param {string} dslId
 * @param {string} slotId
 * @returns {string|null}
 */
export function getTextExtension(dslId, slotId) {
  const meta = getExtensionMeta(dslId, slotId);
  return (meta?.type === 'text') ? (meta.value ?? null) : null;
}

// ---------------------------------------------------------------------------
// File slot API
// ---------------------------------------------------------------------------

/**
 * Save a file into the extension blob store and record its metadata.
 * @param {string} dslId
 * @param {string} slotId
 * @param {File|Blob} file
 * @param {string} [filename]  – override filename (required if `file` is a Blob)
 */
export async function saveFileExtension(dslId, slotId, file, filename) {
  const name = filename ?? file.name ?? `${slotId}-file`;
  const key  = `${dslId}::${slotId}`;
  await _idbPut(key, file);
  _setExtensionMeta(dslId, slotId, {
    type:     'file',
    filename: name,
    size:     file.size,
    mime:     file.type || 'application/octet-stream',
  });
}

/**
 * Load the stored Blob for a file-type extension slot.
 * @param {string} dslId
 * @param {string} slotId
 * @returns {Promise<Blob|null>}
 */
export async function loadFileExtension(dslId, slotId) {
  const meta = getExtensionMeta(dslId, slotId);
  if (meta?.type !== 'file') return null;
  return _idbGet(`${dslId}::${slotId}`);
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/**
 * Remove all data for one extension slot (metadata + blob if any).
 * @param {string} dslId
 * @param {string} slotId
 */
export async function clearExtension(dslId, slotId) {
  await _idbDelete(`${dslId}::${slotId}`);
  _setExtensionMeta(dslId, slotId, null);
}

/**
 * Remove all extension data for a DSL (called when the plugin is removed).
 * @param {string} dslId
 * @param {string[]} slotIds  – slot IDs declared by the plugin
 */
export async function clearAllExtensions(dslId, slotIds) {
  for (const slotId of (slotIds ?? [])) {
    await _idbDelete(`${dslId}::${slotId}`);
  }
  const data = state.data;
  if (data?.pluginExtensions?.[dslId]) {
    delete data.pluginExtensions[dslId];
    state.update({ data, isDirty: true });
  }
}
