/**
 * Storage layer for unifile.
 *
 * Quine mode:  data lives in <script id="unifile-data" type="application/json">
 *              saving generates a new HTML file and triggers a download.
 *
 * PWA mode:    data lives in IndexedDB; File System Access API is used
 *              to open/save .html quine files.
 */

/* global UNIFILE_MODE */
const IS_QUINE = (typeof UNIFILE_MODE !== 'undefined' ? UNIFILE_MODE : 'quine') === 'quine';

const USER_PREFS_KEY = 'unifile_user_prefs';
const IDB_DB_NAME = 'unifile';
const IDB_STORE = 'documents';

// ---------------------------------------------------------------------------
// HTML template capture (quine mode)
// ---------------------------------------------------------------------------

/** Snapshot of the page HTML before the app modifies the DOM. */
let _htmlTemplate = null;

/**
 * Capture the current document HTML as the quine template.
 * Must be called before the app renders any UI into the DOM.
 */
export function captureTemplate() {
  _htmlTemplate = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Load unifile data from the embedded <script id="unifile-data"> tag.
 * @returns {object}
 */
export function loadEmbeddedData() {
  const el = document.getElementById('unifile-data');
  if (!el) throw new Error('unifile-data script tag not found');
  try {
    return JSON.parse(el.textContent);
  } catch (e) {
    throw new Error('Failed to parse unifile data: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Quine generation (quine mode)
// ---------------------------------------------------------------------------

/**
 * Generate a new quine HTML string from the captured template.
 * @param {object} newData – updated unifile data
 * @param {string} renderedPreview – HTML string of the rendered DSL content
 * @param {string} title – document title
 * @returns {string} full HTML of new quine
 */
export function generateQuine(newData, renderedPreview, title) {
  if (!_htmlTemplate) throw new Error('HTML template not captured. Call captureTemplate() first.');

  let html = _htmlTemplate;

  // Replace the unifile-data script content
  html = html.replace(
    /(<script[^>]+id="unifile-data"[^>]*>)[\s\S]*?(<\/script>)/,
    `$1\n${JSON.stringify(newData, null, 2)}\n$2`
  );

  // Replace the no-JS preview
  html = html.replace(
    /(<div[^>]+id="noscript-preview"[^>]*>)[\s\S]*?(<\/div>)/,
    `$1\n${renderedPreview}\n$2`
  );

  // Replace <title>
  html = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(title || 'Unifile')}</title>`
  );

  return html;
}

/**
 * Trigger a browser download of a string as a file.
 * @param {string} content
 * @param {string} filename
 * @param {string} [mime='text/html']
 */
export function downloadFile(content, filename, mime = 'text/html') {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// PWA IndexedDB storage
// ---------------------------------------------------------------------------

let _db = null;

async function openIDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save unifile data to IndexedDB (PWA mode).
 * @param {string} docId
 * @param {object} data
 */
export async function saveToIDB(docId, data) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ id: docId, data, updatedAt: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load unifile data from IndexedDB (PWA mode).
 * @param {string} docId
 * @returns {Promise<object|null>}
 */
export async function loadFromIDB(docId) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(docId);
    req.onsuccess = () => resolve(req.result?.data ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List all document IDs in IndexedDB.
 * @returns {Promise<string[]>}
 */
export async function listIDBDocuments() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// File System Access API (PWA – open/save local quine files)
// ---------------------------------------------------------------------------

/**
 * Open a local .html quine file and return its data object.
 * @returns {Promise<{ data: object, fileHandle: FileSystemFileHandle }>}
 */
export async function openLocalQuine() {
  if (!('showOpenFilePicker' in window)) {
    throw new Error('File System Access API not supported in this browser');
  }
  const [fileHandle] = await window.showOpenFilePicker({
    types: [{ description: 'Unifile quines', accept: { 'text/html': ['.html'] } }],
    multiple: false
  });
  const file = await fileHandle.getFile();
  const html = await file.text();

  // Extract unifile-data
  const match = html.match(/<script[^>]+id="unifile-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('This HTML file does not contain unifile data');

  const data = JSON.parse(match[1]);
  return { data, fileHandle, html };
}

/**
 * Save updated quine HTML back to the original file.
 * @param {FileSystemFileHandle} fileHandle
 * @param {string} html
 */
export async function saveToFileHandle(fileHandle, html) {
  const writable = await fileHandle.createWritable();
  await writable.write(html);
  await writable.close();
}

// ---------------------------------------------------------------------------
// User preferences (localStorage)
// ---------------------------------------------------------------------------

/**
 * Load cached user preferences (name, email, etc.).
 * @returns {{ name: string, email: string, viewMode: string }}
 */
export function loadUserPrefs() {
  try {
    const raw = localStorage.getItem(USER_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Save user preferences to localStorage.
 * @param {object} prefs
 */
export function saveUserPrefs(prefs) {
  try {
    const existing = loadUserPrefs();
    localStorage.setItem(USER_PREFS_KEY, JSON.stringify({ ...existing, ...prefs }));
  } catch {
    // localStorage may be unavailable
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { IS_QUINE };
