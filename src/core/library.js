/**
 * The document library — many documents per app, each remembered exactly as
 * you left it, with a linear save history and an optional link to a file on
 * the device.  This is the iA Writer model: a list of files behind a back
 * arrow, no branches.
 *
 * One RECORD per document (see `makeRecord`):
 *
 *   {
 *     id,          // 'd_…' (random, stable for the document's lifetime)
 *     app,         // which app owns it: a dslType — 'markdown' | 'mermaid' |
 *                  //   'abcjs' | 'slides' | 'upub' | 'udraft'.  Every PWA on
 *                  //   the origin shares ONE IndexedDB, so each lists its own.
 *     title,       // mirrors data.title (kept on the record for cheap lists)
 *     excerpt,     // first non-empty body lines (list preview; see excerptOf)
 *     data,        // the WHOLE unifile data object: history (branches/commits,
 *                  //   kept in the file format for round-tripping), the working
 *                  //   text (`currentContent`) — i.e. the UNSAVED state too —,
 *                  //   comments, assets.  Written on every edit (debounced), so
 *                  //   closing the app loses nothing.
 *     createdAt, updatedAt,
 *     savedAt,     // when the document was last written OUT to the device
 *     savedKey,    // `stateKey(data)` of what was written → "unsaved changes
 *                  //   since" is one string compare (see isSavedToDevice)
 *     handle,      // FileSystemFileHandle (Chromium only; structured-cloneable,
 *                  //   so it persists in IndexedDB) or null
 *     fileName,    // the device file's name (also shown in the list)
 *   }
 *
 * The persistence model has three layers, each strictly local (nothing here
 * ever touches the network):
 *   1. the library record — every keystroke (debounced) → the "unsaved state"
 *      of every document survives a close / crash / reload;
 *   2. the save history — `Save` commits a snapshot into data.commits (one
 *      linear line on `main`; the VCS is reused, its branching is not);
 *   3. the device file — `Save to device` writes the `.unifile.json` out of the
 *      browser sandbox: silently through a linked File System Access handle
 *      where that API exists (Chromium), else the OS share sheet (iOS → "Save
 *      to Files"), else a download.  See `core/storage.js` for the pickers.
 *
 * This module is DOM-free: the `Library` class takes a `store` adapter
 * ({ getAll, get, put, delete } — the IndexedDB one lives in storage.js) and a
 * `prefs` adapter for the per-app "current document" pointer, so the whole
 * thing is unit-tested in Node (`test/library.test.mjs`).
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A new document id. */
export function newId(rand = Math.random) {
  const n = Math.floor(rand() * 0xffffffff).toString(36) + Math.floor(rand() * 0xffffffff).toString(36);
  return 'd_' + n;
}

/**
 * FNV-1a over a string → 8 hex chars.  Not cryptographic — it only has to tell
 * "the text changed since the last device write" apart from "it didn't".
 */
export function quickHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Fingerprint of a document's state: its head commit + its working text (+ the
 * title).  Two states with the same key would write identical files.
 */
export function stateKey(data) {
  if (!data) return '';
  const head = data.branches?.[data.currentBranch ?? 'main']?.head ?? '';
  const content = data.currentContent ?? '';
  return `${head}:${content.length}:${quickHash(content)}:${quickHash(String(data.title ?? ''))}`;
}

/**
 * The first lines of the body for the list preview — the leading front matter
 * block and blank lines are skipped, a `#!shebang` too.
 */
export function excerptOf(content, maxLen = 120) {
  const text = String(content ?? '');
  let lines = text.split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) lines = lines.slice(end + 1);
  }
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#!')) continue;
    out.push(t);
    if (out.join(' ').length >= maxLen) break;
  }
  const s = out.join(' ');
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/** Whether an object looks like a unifile data file (`.unifile.json` / quine data). */
export function isUnifileData(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && (obj.commits !== undefined || obj.currentContent !== undefined || obj.branches !== undefined);
}

/**
 * A fresh, empty data object for `app`.  `currentBranch`/`branches`/`commits`
 * keep the historical file shape so every `.unifile.json` ever written still
 * loads — but there is only ever one line of history now (`main`).
 */
export function emptyData(app, { title = 'Untitled', version = null, extra = {} } = {}) {
  return {
    ...(version ? { version } : {}),
    title,
    dslType: app,
    currentBranch: 'main',
    branches: { main: { name: 'main', head: null } },
    commits: {},
    comments: {},
    commentThreads: {},
    password: null,
    currentContent: '',
    ...extra,
  };
}

/**
 * Normalise a loaded data object for the linear-history world: a detached
 * head (an old file left viewing a historical save) is simply reattached —
 * the working text is preserved as-is, so nothing is lost; a missing branch
 * map is seeded.  Extra branches from old files are left in place (the file
 * format keeps them; the UI shows `currentBranch`'s line only).
 */
export function normaliseData(data, app) {
  const d = { ...data };
  if (!d.branches || !Object.keys(d.branches).length) d.branches = { main: { name: 'main', head: null } };
  if (!d.currentBranch || !d.branches[d.currentBranch]) d.currentBranch = Object.keys(d.branches)[0];
  if (d.detachedHead) d.detachedHead = null;
  d.commits ??= {};
  d.commentThreads ??= {};
  if (app && !d.dslType) d.dslType = app;
  return d;
}

/** Build a record from a data object (new document, import, migration). */
export function makeRecord(app, data, { id = newId(), now = Date.now(), handle = null, fileName = null } = {}) {
  const d = normaliseData(data, app);
  return {
    id,
    app,
    title: String(d.title || 'Untitled'),
    excerpt: excerptOf(d.currentContent),
    data: d,
    createdAt: now,
    updatedAt: now,
    savedAt: null,
    savedKey: null,
    handle,
    fileName,
  };
}

/** Whether the record's current state is what was last written to the device. */
export function isSavedToDevice(rec) {
  return !!rec?.savedKey && rec.savedKey === stateKey(rec.data);
}

/** Newest first. */
export function sortRecords(records) {
  return [...records].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** A filesystem-friendly name for a document title. */
export function fileSlug(title) {
  return (String(title || 'untitled').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled');
}

/** The device filename a document is written as. */
export function deviceFileName(title) {
  return fileSlug(title) + '.unifile.json';
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LibraryStore
 * @property {() => Promise<object[]>} getAll
 * @property {(id: string) => Promise<object|undefined>} get
 * @property {(rec: object) => Promise<void>} put
 * @property {(id: string) => Promise<void>} delete
 */

export class Library {
  /**
   * @param {LibraryStore} store
   * @param {object} opts
   * @param {string} opts.app          the owning app (dslType)
   * @param {{get:(k)=>string|null, set:(k,v)=>void, remove:(k)=>void}} [opts.prefs]
   *        where the "current document" pointer lives (localStorage in the app)
   * @param {() => number} [opts.now]
   */
  constructor(store, { app, prefs = memoryPrefs(), now = Date.now } = {}) {
    this.store = store;
    this.app = app;
    this.prefs = prefs;
    this.now = now;
  }

  get _currentKey() { return `unifile_lib_current:${this.app}`; }

  /** The id of the document to open on launch (last opened), or null. */
  get currentId() { return this.prefs.get(this._currentKey); }
  set currentId(id) { if (id) this.prefs.set(this._currentKey, id); else this.prefs.remove(this._currentKey); }

  /** This app's documents, newest first. */
  async list() {
    const all = await this.store.getAll();
    return sortRecords(all.filter(r => r.app === this.app));
  }

  /** One record by id (any app), or null. */
  async get(id) {
    if (!id) return null;
    return (await this.store.get(id)) ?? null;
  }

  /** Create a document from a data object (empty by default) and store it. */
  async create(data = emptyData(this.app), opts = {}) {
    const rec = makeRecord(this.app, data, { now: this.now(), ...opts });
    await this.store.put(rec);
    return rec;
  }

  /**
   * Persist a document's state.  `patch` may carry `data` (the whole data
   * object — title/excerpt are derived from it), `handle`, `fileName`,
   * `savedAt`, `savedKey`.  Returns the stored record.
   */
  async save(id, patch) {
    const prev = await this.get(id);
    if (!prev) throw new Error(`No document ${id}`);
    const next = { ...prev, ...patch };
    if (patch.data) {
      next.data = normaliseData(patch.data, this.app);
      next.title = String(next.data.title || 'Untitled');
      next.excerpt = excerptOf(next.data.currentContent);
    }
    if (patch.title !== undefined && !patch.data) {
      next.title = String(patch.title || 'Untitled');
      next.data = { ...next.data, title: next.title };
    }
    if (patch.updatedAt === undefined) next.updatedAt = this.now();
    await this.store.put(next);
    return next;
  }

  /** Mark the record as written to the device in its current state. */
  async markSaved(id, { handle, fileName } = {}) {
    const rec = await this.get(id);
    if (!rec) return null;
    return this.save(id, {
      savedAt: this.now(),
      savedKey: stateKey(rec.data),
      updatedAt: rec.updatedAt,            // a device write is not an edit
      ...(handle !== undefined ? { handle } : {}),
      ...(fileName !== undefined ? { fileName } : {}),
    });
  }

  /** Duplicate a document (history included) under "<title> copy". */
  async duplicate(id) {
    const rec = await this.get(id);
    if (!rec) return null;
    const data = JSON.parse(JSON.stringify(rec.data));
    data.title = `${rec.title} copy`;
    return this.create(data);
  }

  async remove(id) {
    await this.store.delete(id);
    if (this.currentId === id) this.currentId = null;
  }

  /**
   * The document to open on launch: the remembered current one, else the most
   * recently edited, else null (the app then creates a fresh one).
   */
  async resolveCurrent() {
    const cur = await this.get(this.currentId);
    if (cur && cur.app === this.app) return cur;
    const [first] = await this.list();
    return first ?? null;
  }

  /**
   * One-time migration from the single-document world: the legacy record this
   * app kept under `legacyId` in the old `documents` store (plus, for the
   * standard shell, a localStorage draft of the text that was newer than the
   * stored commits) becomes the first library document.  No-op once the
   * library has any document for this app.
   *
   * @param {{ data: object|null, draftContent?: string|null }} legacy
   * @returns {Promise<object|null>} the migrated record, if one was created
   */
  async migrateLegacy({ data, draftContent = null }) {
    if ((await this.list()).length) return null;
    if (!isUnifileData(data)) return null;
    const d = { ...data };
    if (draftContent != null && draftContent !== d.currentContent) d.currentContent = draftContent;
    if (d.currentContent === undefined) d.currentContent = '';
    const rec = await this.create(d);
    this.currentId = rec.id;
    return rec;
  }
}

/** In-memory prefs adapter (tests, or when localStorage is unavailable). */
export function memoryPrefs() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

/** localStorage-backed prefs adapter that degrades to memory when blocked. */
export function localPrefs() {
  const mem = memoryPrefs();
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return mem.get(k); } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { mem.set(k, v); } },
    remove: (k) => { try { localStorage.removeItem(k); } catch { mem.remove(k); } },
  };
}

/** In-memory store adapter (tests). */
export function memoryStore(initial = []) {
  const m = new Map(initial.map(r => [r.id, r]));
  const clone = (r) => (r === undefined ? undefined : JSON.parse(JSON.stringify(r)));
  return {
    async getAll() { return [...m.values()].map(clone); },
    async get(id) { return clone(m.get(id)); },
    async put(rec) { m.set(rec.id, clone(rec)); },
    async delete(id) { m.delete(id); },
  };
}
