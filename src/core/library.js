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
 *     apiName,     // mirrors data.apiName — the document's NAME, fixed at
 *                  //   genesis, carried by the saved files' names only:
 *                  //   `<apiName>-<version>.uni` (see versionFileName)
 *     version,     // mirrors data.savedVersion — the last version written to
 *                  //   the device ('A00' … 'Z99'), null before the first save
 *     data,        // the WHOLE unifile data object: history (branches/commits,
 *                  //   kept in the file format for round-tripping), the working
 *                  //   text (`currentContent`) — i.e. the UNSAVED state too —,
 *                  //   comments, assets.  Written on every edit (debounced), so
 *                  //   closing the app loses nothing.
 *     createdAt, updatedAt,
 *     savedAt,     // when the document was last written OUT to the device
 *     savedKey,    // `stateKey(data)` of what was written → "unsaved changes
 *                  //   since" is one string compare (see isSavedToDevice)
 *     handle,      // FileSystemDirectoryHandle — the folder the versions are
 *                  //   written into (Chromium only; structured-cloneable, so
 *                  //   it persists in IndexedDB) or null
 *     fileName,    // the last device file's name (also shown in the list)
 *   }
 *
 * The persistence model has two layers, each strictly local (nothing here
 * ever touches the network):
 *   1. the library record — every keystroke (debounced) → the "unsaved state"
 *      of every document survives a close / crash / reload.  This is NOT a
 *      save the user performs; it is the app remembering.
 *   2. SAVE = the device.  There is one save verb: it writes the text — just
 *      the DSL, nothing else — out of the browser sandbox as
 *      `<apiName>-<version>.uni`, one new file per save, the version counting
 *      up (`A00`, `A01`, … a major bump → `B00`), and records the same
 *      snapshot in data.commits tagged with that version (one linear line on
 *      `main`; the VCS is reused for history/diff/restore, its branching is
 *      not).  Where the File System Access API exists (Chromium) the folder
 *      is picked once and later versions land in it silently; elsewhere the
 *      OS share sheet (iOS → "Save to Files"), else a download.  See
 *      `core/device-file.js` + `core/storage.js`.
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
    apiName: d.apiName ?? null,
    version: d.savedVersion ?? null,
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

// ---------------------------------------------------------------------------
// Names, versions and file names
//
// A document's NAME (`apiName`) is fixed at genesis and lives in the file
// names only: every save writes `<apiName>-<version>.uni`, plain text.  The
// version is `<major letter><minor 2 digits>` — A00, A01, … A99, B00 … Z99 —
// always three characters, so there is a hard ceiling (Z99).
// ---------------------------------------------------------------------------

export const API_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*$/;
export const API_NAME_MAX = 64;
export const VERSION_RE = /^[A-Z][0-9]{2}$/;
export const FIRST_VERSION = 'A00';
export const LAST_VERSION = 'Z99';
export const DEVICE_FILE_EXT = '.uni';

/**
 * Whether a string can be a document name: letters, digits, `_`, `.` and
 * single `-` separators, no leading/trailing dash, ≤ 64 chars.  The trailing
 * `-<version>` of the file name must stay unambiguous, which is why a name
 * can't end in a dash.
 */
export function isValidApiName(s) {
  const n = String(s ?? '');
  return n.length > 0 && n.length <= API_NAME_MAX && API_NAME_RE.test(n);
}

/**
 * Turn free text into a valid name (spaces → `-`, the rest dropped); '' when
 * nothing usable is left.
 */
export function suggestApiName(s) {
  const n = String(s ?? '').trim().replace(/[\s]+/g, '-').replace(/[^A-Za-z0-9_.-]+/g, '')
    .replace(/-{2,}/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, API_NAME_MAX).replace(/-+$/g, '');
  return isValidApiName(n) ? n : '';
}

/** 'B07' → { major: 1, minor: 7 }; null for anything else. */
export function parseVersion(v) {
  if (!VERSION_RE.test(String(v ?? ''))) return null;
  return { major: v.charCodeAt(0) - 65, minor: Number(v.slice(1)) };
}

/** { major: 1, minor: 7 } → 'B07'. */
export function formatVersion({ major, minor }) {
  return String.fromCharCode(65 + major) + String(minor).padStart(2, '0');
}

/**
 * The version the next save gets: `A00` for a document never saved, else the
 * next minor (`A03` → `A04`), or with `major` the next letter (`A03` → `B00`).
 * Null when the scheme is exhausted (`Z99` has no successor; `Z..` has no
 * next major).  Versions only ever move forward.
 */
export function nextVersion(current, { major = false } = {}) {
  const cur = parseVersion(current);
  if (!cur) return FIRST_VERSION;
  if (major) return cur.major >= 25 ? null : formatVersion({ major: cur.major + 1, minor: 0 });
  if (cur.minor >= 99) return cur.major >= 25 ? null : formatVersion({ major: cur.major + 1, minor: 0 });
  return formatVersion({ major: cur.major, minor: cur.minor + 1 });
}

/** Version order: A00 < A01 < B00 … (`cmpVersion('B00', 'A99') > 0`). */
export function cmpVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return (x.major - y.major) || (x.minor - y.minor);
}

/** The device file a save writes: `<apiName>-<version>.uni`. */
export function versionFileName(apiName, version) {
  return `${apiName}-${version}${DEVICE_FILE_EXT}`;
}

/**
 * The inverse: 'report-B03.uni' → { apiName: 'report', version: 'B03' }.
 * A `.uni` / `.txt` / extension-less file without the `-<version>` suffix
 * yields its stem as the name and `version: null`; anything else null.
 */
export function parseVersionFileName(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop();
  const m = /^(.+?)(?:-([A-Z][0-9]{2}))?(\.uni|\.txt)?$/i.exec(base);
  if (!m) return null;
  const apiName = m[1], version = m[2] ? m[2].toUpperCase() : null;
  if (!isValidApiName(apiName)) return null;
  return { apiName, version };
}

/** The device filename a document is written as (kept for older callers). */
export function deviceFileName(apiName, version = FIRST_VERSION) {
  return versionFileName(suggestApiName(apiName) || 'untitled', version);
}

// ---------------------------------------------------------------------------
// Search — the list's search bar: file names AND contents
// ---------------------------------------------------------------------------

/**
 * Case-insensitive search over the records: the name, title and file name
 * match as a whole; the text yields HITS — each the line around a match,
 * trimmed to `ctx` characters each side, with the match offsets (document
 * coordinates, for a jump) and where the match sits in the snippet.  Records
 * are ranked name/title matches first, then by hit count, then newest.
 * An empty query returns every record with no hits.
 *
 * @returns {Array<{ record, nameMatch: boolean, hits: Array<{ from, to, line, snippet, matchStart, matchEnd }> }>}
 */
export function searchRecords(records, query, { maxHits = 3, ctx = 40 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return records.map(record => ({ record, nameMatch: false, hits: [] }));
  const out = [];
  for (const record of records) {
    const nameMatch = [record.apiName, record.title, record.fileName]
      .some(v => v && String(v).toLowerCase().includes(q));
    const text = String(record.data?.currentContent ?? '');
    const lower = text.toLowerCase();
    const hits = [];
    let i = lower.indexOf(q);
    let lastLine = -1;
    while (i >= 0 && hits.length < maxHits) {
      const ls = text.lastIndexOf('\n', i - 1) + 1;
      let le = text.indexOf('\n', i); if (le < 0) le = text.length;
      const line = text.slice(0, ls).split('\n').length;
      if (line !== lastLine) {                      // one hit per line
        const s = Math.max(ls, i - ctx), e = Math.min(le, i + q.length + ctx);
        const snippet = (s > ls ? '…' : '') + text.slice(s, e) + (e < le ? '…' : '');
        const matchStart = (s > ls ? 1 : 0) + (i - s);
        hits.push({ from: i, to: i + q.length, line, snippet, matchStart, matchEnd: matchStart + q.length });
        lastLine = line;
      }
      i = lower.indexOf(q, le);
    }
    if (nameMatch || hits.length) out.push({ record, nameMatch, hits });
  }
  return out.sort((a, b) => (b.nameMatch - a.nameMatch) || (b.hits.length - a.hits.length)
    || ((b.record.updatedAt ?? 0) - (a.record.updatedAt ?? 0)));
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
      // The name is fixed at genesis: once set it never moves.
      next.data.apiName = prev.apiName ?? next.data.apiName ?? null;
      next.apiName = next.data.apiName;
      next.data.savedVersion = next.data.savedVersion ?? prev.version ?? null;
      next.version = next.data.savedVersion;
    }
    if (patch.title !== undefined && !patch.data) {
      next.title = String(patch.title || 'Untitled');
      next.data = { ...next.data, title: next.title };
    }
    if (patch.updatedAt === undefined) next.updatedAt = this.now();
    await this.store.put(next);
    return next;
  }

  /**
   * Mark the record as written to the device in its current state — after a
   * save, with the `version` that file carries (and, on Chromium, the folder
   * `handle` it went into).
   */
  async markSaved(id, { handle, fileName, version } = {}) {
    const rec = await this.get(id);
    if (!rec) return null;
    const data = version ? { ...rec.data, savedVersion: version } : rec.data;
    return this.save(id, {
      ...(version ? { data } : {}),
      savedAt: this.now(),
      savedKey: stateKey(data),
      updatedAt: rec.updatedAt,            // a device write is not an edit
      ...(version ? { version } : {}),
      ...(handle !== undefined ? { handle } : {}),
      ...(fileName !== undefined ? { fileName } : {}),
    });
  }

  /**
   * Give a document its name — allowed exactly once (genesis, or the first
   * save of a document created before names existed).  Throws on an invalid
   * name or when the document already has one.
   */
  async setApiName(id, apiName) {
    const rec = await this.get(id);
    if (!rec) throw new Error(`No document ${id}`);
    if (rec.apiName) throw new Error('This document already has a name.');
    if (!isValidApiName(apiName)) throw new Error('Invalid document name.');
    return this.save(id, { data: { ...rec.data, apiName }, updatedAt: rec.updatedAt });
  }

  /** Whether a name is free among this app's documents (names must be unique: they are file names). */
  async isApiNameFree(apiName, { exceptId = null } = {}) {
    const want = String(apiName).toLowerCase();
    return !(await this.list()).some(r => r.id !== exceptId && String(r.apiName ?? '').toLowerCase() === want);
  }

  /** Duplicate a document (history included) under "<title> copy". */
  async duplicate(id) {
    const rec = await this.get(id);
    if (!rec) return null;
    const data = JSON.parse(JSON.stringify(rec.data));
    data.title = `${rec.title} copy`;
    // A copy is a new document: it gets its own name at its first save and
    // starts its own version line (the history is kept).
    delete data.apiName;
    delete data.savedVersion;
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
