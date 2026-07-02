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

/**
 * Trigger a browser download of a Blob directly (binary-safe).
 * Use this instead of downloadFile() when the content is binary (e.g. DOCX).
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Save a text file OUT of the browser sandbox using the native share sheet when
 * available, falling back to a plain download.
 *
 * This is the durable-backup path, and it exists mainly for iOS: there is no
 * File System Access API on iOS Safari, and `<a download>` blobs land awkwardly
 * in Downloads.  `navigator.share({ files })` opens the OS share sheet, whose
 * "Save to Files" → iCloud Drive target puts the bytes somewhere the user
 * controls and iOS actually backs up — i.e. outside the evictable web sandbox.
 * Must be called from a user gesture (a button tap).
 *
 * @param {string} content   File contents (text)
 * @param {string} filename  Suggested filename
 * @param {string} [mime='application/json']
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 *   'shared'     – handed to the OS share sheet (user may still cancel the
 *                  target picker, but the data left the app's control path)
 *   'downloaded' – fell back to a browser download (desktop / no share support)
 *   'cancelled'  – user dismissed the share sheet before choosing a target
 */
export async function shareOrDownloadFile(content, filename, mime = 'application/json') {
  try {
    if (typeof navigator !== 'undefined' && navigator.canShare && typeof File !== 'undefined') {
      const file = new File([content], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    }
  } catch (e) {
    // AbortError = user backed out of the share sheet; don't also download.
    if (e && e.name === 'AbortError') return 'cancelled';
    // Any other share failure (rare) → fall through to a plain download.
  }
  downloadFile(content, filename, mime);
  return 'downloaded';
}

/**
 * Best-effort request for durable ("persistent") storage so the browser is less
 * likely to evict IndexedDB under storage pressure.  Safe to call repeatedly.
 * On iOS this is granted more readily for installed (Home Screen) PWAs, but is
 * never a hard guarantee — it only reduces the eviction risk; the real backstop
 * is a user-exported .unifile.json (see shareOrDownloadFile).
 * @returns {Promise<boolean>} whether storage is now persisted
 */
export async function requestPersistentStorage() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not supported / blocked */ }
  return false;
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
// Draft auto-save (crash recovery)
// ---------------------------------------------------------------------------

// Key includes the page URL so each quine file gets its own draft slot,
// supporting multiple open unifile tabs without collisions.
const DRAFT_KEY_PREFIX = 'unifile_draft:';

function _draftKey() {
  return DRAFT_KEY_PREFIX + location.href;
}

/**
 * Persist the current editor content as a recoverable draft.
 * Called on every content-change (debounced by the caller).
 * Silently swallows storage errors (quota exceeded, private browsing, etc.).
 *
 * @param {string} content   Current editor content
 * @param {string} headHash  Current VCS head hash (to detect stale drafts)
 */
export function saveDraft(content, headHash) {
  try {
    localStorage.setItem(_draftKey(), JSON.stringify({ content, headHash, savedAt: Date.now() }));
  } catch { /* storage full or unavailable */ }
}

/**
 * Load the previously saved draft for this file.
 * @returns {{ content: string, headHash: string, savedAt: number } | null}
 */
export function loadDraft() {
  try {
    const raw = localStorage.getItem(_draftKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Remove the draft for this file (called after a successful commit or save).
 */
export function clearDraft() {
  try { localStorage.removeItem(_draftKey()); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Backup watermark (which committed state was last exported to durable storage)
// ---------------------------------------------------------------------------

// Records the head hash that was last written OUT of the browser (via
// shareOrDownloadFile).  The app compares it against the current head to know
// whether committed work still lives only in the evictable sandbox, so it can
// nudge the user to back up — without nagging once they already have.
const BACKUP_KEY_PREFIX = 'unifile_backup:';

function _backupKey(scope) {
  return BACKUP_KEY_PREFIX + (scope || location.href);
}

/**
 * Record that `headHash` has been exported to durable storage.
 * @param {string} scope     Per-document key (PWA docId, else the page URL)
 * @param {string} headHash  The committed head that was backed up
 */
export function markBackedUp(scope, headHash) {
  try {
    localStorage.setItem(_backupKey(scope), JSON.stringify({ headHash, at: Date.now() }));
  } catch { /* storage full or unavailable */ }
}

/**
 * Load the last backup watermark for a document.
 * @param {string} scope
 * @returns {{ headHash: string, at: number } | null}
 */
export function loadBackupMark(scope) {
  try {
    const raw = localStorage.getItem(_backupKey(scope));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
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
