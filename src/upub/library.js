/**
 * The document library for the uPub-style shells ({write} and {draft}) — the
 * same core as the standard app (core/library.js + core/device-file.js) behind
 * the same moves: the `‹` back button opens the list (with its search bar),
 * SAVE writes the next version of the text to the device —
 * `<name>-A00.uni`, `<name>-A01.uni`… — and snapshots it into history.
 *
 * `ShellLibrary` wraps a shell app instance.  The shell provides:
 *   shell._currentData()           the data object (history + working text)
 *   shell._loadDocument(data)      replace the open document (title, text,
 *                                  history, view state) — no persistence
 *   shell.commit(message, tag)     the history snapshot (no device write)
 *   shell._openSheet / _closeSheet / _toast / _persistNow
 *   shell.title, shell.vcs, shell.content, shell.isDirty, shell.data, shell.prefs
 *   shell.editor.setSelection(from, to)   (to land on a search hit)
 * and calls:
 *   lib.boot(embedded, legacyId)   on launch → { data } to load
 *   lib.persist(data)              from the shell's debounced autosave
 *   lib.openSheet()                the `‹` button / menu
 *   lib.save({ message, major }) / openFromDevice() / newDocument()
 *   lib.needsSave / lib.nextVersion / lib.device   for the chrome
 *
 * In a quine there is no library (`lib.enabled` is false): the sheet entry
 * points hide, Save downloads the version file and remembers the name /
 * version on the data object, and New replaces the document.
 */

import { IS_QUINE, idbLibraryStore, loadFromIDB, loadDraft, clearDraft } from '../core/storage.js';
import {
  Library, localPrefs, emptyData, isSavedToDevice, nextVersion, isValidApiName, suggestApiName,
  versionFileName, searchRecords, LAST_VERSION,
} from '../core/library.js';
import {
  saveVersionToDevice, pickDocumentFromDevice, adoptDeviceDocument, dataFromPickedFile,
} from '../core/device-file.js';
import { VCS } from '../core/vcs.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class ShellLibrary {
  /**
   * @param {object} shell       the app instance (see the module comment)
   * @param {object} opts
   * @param {string} opts.app     dslType: 'upub' | 'udraft'
   * @param {string} opts.version build version stamped into new documents
   */
  constructor(shell, { app, version }) {
    this.shell = shell;
    this.app = app;
    this.version = version;
    this.library = IS_QUINE ? null : new Library(idbLibraryStore(), { app, prefs: localPrefs() });
    this.docId = null;
    this.record = null;
    this._saving = false;
    this._quineDevice = null;    // a quine's last save (no record to keep it on)
  }

  get enabled() { return !!this.library; }

  /**
   * Pick the document to open on launch.  PWA: the remembered / newest record,
   * migrating the pre-library single document (`legacyId` in the old store)
   * once; a fresh install gets an empty record whose text the shell seeds.
   * Quine: the embedded data.
   */
  async boot(embedded, legacyId) {
    if (!this.library) return { data: embedded };
    let rec = null;
    try {
      rec = await this.library.resolveCurrent();
      if (!rec) {
        let legacy = null;
        try { legacy = await loadFromIDB(legacyId); } catch { /* none */ }
        rec = await this.library.migrateLegacy({ data: legacy });
        if (rec) clearDraft();
      }
      if (!rec) rec = await this.library.create(emptyData(this.app, { version: this.version }));
    } catch (e) {
      console.warn('[library] unavailable:', e);
      this.library = null;
      return { data: embedded };
    }
    this._setRecord(rec);
    return { data: rec.data };
  }

  _setRecord(rec) {
    this.record = rec;
    this.docId = rec?.id ?? null;
    if (this.library && rec) this.library.currentId = rec.id;
  }

  /** The device-file state of the open document (for the header / menu). */
  get device() {
    const r = this.record;
    if (!r) {
      const q = this._quineDevice;
      return q ? { ...q, saved: !this.shell.isDirty && this.shell.vcs?.headHash === q.savedHead } : null;
    }
    if (!r.savedAt && !r.handle && !r.fileName) return null;
    return { fileName: r.fileName ?? null, savedAt: r.savedAt ?? null, saved: isSavedToDevice(r), linked: r.handle?.kind === 'directory',
             savedHead: r.savedKey ? (r.savedKey.split(':')[0] || null) : null, version: r.version ?? null };
  }

  /** The document's name (fixed at genesis) and last saved version. */
  get apiName() { return this.shell.data?.apiName ?? null; }
  get savedVersion() { return this.shell.data?.savedVersion ?? null; }
  /** The version the next save writes ('A00' first; null when the scheme is exhausted). */
  get nextVersion() { return nextVersion(this.savedVersion); }
  get nextMajor() { return this.savedVersion ? nextVersion(this.savedVersion, { major: true }) : null; }

  /** Whether a Save has something to write (text moved, never saved, or the device copy is behind). */
  get needsSave() {
    if (this.shell.isDirty) return true;
    if (!this.savedVersion) return true;
    const dev = this.device;
    return dev ? !dev.saved : false;
  }

  /** Persist the open document's state (the shell's autosave). */
  async persist(data) {
    if (!this.library || !this.docId) return;
    const id = this.docId;
    try {
      const rec = await this.library.save(id, { data });
      if (this.docId === id) this.record = rec;
    } catch (e) {
      console.warn('[library] persist failed:', e);
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  /**
   * SAVE: the next version of the text to the device (`<name>-<version>.uni`)
   * and the matching snapshot in history.  The device write comes first — a
   * cancelled save burns no version and leaves no snapshot.
   * @param {{ message?: string, major?: boolean }} [o]
   */
  async save({ message = '', major = false } = {}) {
    if (this._saving) return 'busy';
    if (!this.needsSave && !major) return 'clean';
    this._saving = true;
    try {
      const apiName = await this._ensureApiName();
      if (!apiName) return 'cancelled';
      const version = nextVersion(this.savedVersion, { major });
      if (!version) { this.shell._toast(`At ${LAST_VERSION} — the last version. Duplicate the document to keep going.`); return 'exhausted'; }
      const text = this.shell.content;
      const { result, fileName, handle, error } = await saveVersionToDevice({
        library: this.library, docId: this.docId, text, apiName, version, mark: false,
      });
      if (result === 'failed') { this.shell._toast('Could not write the file: ' + (error?.message ?? error)); return result; }
      if (result === 'cancelled') return result;
      await this.shell.commit(message, version);
      this.shell.data.apiName = apiName;
      this.shell.data.savedVersion = version;
      if (this.library && this.docId) {
        await this.shell._persistNow();
        this.record = await this.library.markSaved(this.docId, { fileName, version, ...(handle ? { handle } : {}) });
      } else {
        this._quineDevice = { fileName, savedAt: Date.now(), savedHead: this.shell.vcs.headHash, linked: false, version };
        await this.shell._persistNow();
      }
      this.shell._refreshDirty?.();
      this.shell._toast(result === 'linked' ? `Saved ${fileName}` : result === 'downloaded' ? `Downloaded ${fileName}` : `Saved ${version}`);
      return result;
    } finally {
      this._saving = false;
    }
  }

  /** The document's name, asked once at the first save when genesis didn't set it. */
  async _ensureApiName() {
    if (this.apiName) return this.apiName;
    const apiName = await this.promptApiName(suggestApiName(this.shell.title), { title: this.shell.title, exceptId: this.docId });
    if (!apiName) return null;
    this.shell.data.apiName = apiName;
    // A document still called "Untitled" takes its name as its title too.
    if (!this.shell.title || this.shell.title === 'Untitled') this.shell._setTitle(apiName);
    await this.shell._persistNow();
    return apiName;
  }

  /**
   * Ask for a document name until it is valid and free (or cancelled).
   * `exceptId` = the document being named (its own record doesn't clash); a
   * NEW document excepts nothing.
   */
  async promptApiName(suggested = '', { title, exceptId = null } = {}) {
    let hint = '';
    for (;;) {
      const raw = window.prompt(
        `${hint}Name this document${title && title !== 'Untitled' ? ` (“${title}”)` : ''}.\n` +
        `It names its files — ${versionFileName(suggested || 'name', 'A00')} — and can't be changed later.\n` +
        `Letters, digits, _ . and - only.`, suggested);
      if (raw == null) return null;
      const name = raw.trim();
      if (!isValidApiName(name)) { hint = `“${name}” isn't a valid name. `; suggested = suggestApiName(name) || suggested; continue; }
      if (this.library && !(await this.library.isApiNameFree(name, { exceptId }))) {
        hint = `“${name}” is already a document here. `; suggested = name; continue;
      }
      return name;
    }
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  /** Open a record; with `hit` ({from, to}) the editor lands on that text. */
  async open(id, hit = null) {
    if (!this.library || !id) return;
    if (id !== this.docId) {
      await this.shell._persistNow();
      const rec = await this.library.get(id);
      if (!rec) return;
      this._setRecord(rec);
      this.shell._loadDocument(rec.data);
    }
    if (hit) this._goTo(hit);
  }

  _goTo({ from, to }) {
    const ed = this.shell.editor;
    if (!ed?.setSelection) return;
    try {
      ed.setSelection(from, to);
      const r = ed.domRange?.(from, to);
      const el = r?.startContainer?.nodeType === 3 ? r.startContainer.parentElement : r?.startContainer;
      el?.scrollIntoView?.({ block: 'center' });
    } catch { /* a stale offset */ }
  }

  /** A new document — named here, at genesis (the name is fixed for good). */
  async newDocument() {
    if (!this.library && this.needsSave && this.shell.content
        && !confirm('Start a new document? The current document and its history will be replaced.')) return;
    const apiName = await this.promptApiName('');
    if (!apiName) return;
    const data = emptyData(this.app, { version: this.version, title: apiName, extra: { apiName } });
    if (!this.library) {
      this._quineDevice = null;
      this.shell._loadDocument(data);
      this.shell._persistNow();
      return;
    }
    await this.shell._persistNow();
    const rec = await this.library.create(data);
    this._setRecord(rec);
    this.shell._loadDocument(rec.data);
  }

  async remove(id) {
    if (!this.library) return;
    const rec = await this.library.get(id);
    if (!rec) return;
    const where = rec.fileName ? ` The files on your device (${rec.apiName ? rec.apiName + '-…' : rec.fileName}) are not touched.` : '';
    if (!confirm(`Delete “${rec.title}” and its history from this app?${where}`)) return;
    await this.library.remove(id);
    if (id === this.docId) {
      this.docId = null; this.record = null;
      const next = await this.library.resolveCurrent();
      if (next) { this._setRecord(next); this.shell._loadDocument(next.data); }
      else await this.newDocument();
    }
  }

  async duplicate(id) {
    if (!this.library) return;
    if (id === this.docId) await this.shell._persistNow();
    const copy = await this.library.duplicate(id);
    if (copy) { this._setRecord(copy); this.shell._loadDocument(copy.data); }
  }

  async rename(id, title) {
    if (!this.library) return;
    const t = String(title ?? '').trim();
    if (!t) return;
    if (id === this.docId) { this.shell._setTitle(t); await this.shell._persistNow(); }
    else await this.library.save(id, { title: t });
  }

  // ── Device files ──────────────────────────────────────────────────────────

  async openFromDevice() {
    let picked;
    try { picked = await pickDocumentFromDevice({ library: this.library }); }
    catch (e) { this.shell._toast(e?.message ?? String(e)); return; }
    if (!picked) return;
    const prefs = this.shell.prefs ?? {};
    const identity = { author: (prefs.name || '').trim() || 'anonymous', email: (prefs.email || '').trim() || '' };
    if (!this.library) {
      if (!confirm(`Replace the current document with “${picked.fileName}”?`)) return;
      const data = await dataFromPickedFile(this.app, picked, identity);
      this.shell._loadDocument(data);
      this._quineDevice = data.savedVersion
        ? { fileName: picked.fileName, savedAt: Date.now(), savedHead: this.shell.vcs.headHash, linked: false, version: data.savedVersion }
        : null;
      this.shell._persistNow();
      return;
    }
    await this.shell._persistNow();
    const rec = await adoptDeviceDocument(this.library, picked, identity);
    this._setRecord(rec);
    this.shell._loadDocument(rec.data);
    this.shell._toast(`Opened ${rec.fileName ?? rec.title}`);
  }

  // ── The sheet ─────────────────────────────────────────────────────────────

  /** The flat list of this app's documents, with its search bar, as a tall bottom sheet. */
  async openSheet() {
    if (!this.library) return;
    await this.shell._persistNow();
    const records = await this.library.list();
    const modal = this.shell._openSheet(`
      <div class="wr-sheet-head wr-lib-head">
        <span>Documents</span>
        <button class="wr-primary wr-lib-new" data-act="new">+ New</button>
      </div>
      <div class="wr-lib-search">
        <input type="search" class="wr-lib-search-input" placeholder="Search names and text…"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search documents">
      </div>
      <div class="wr-sheet-body wr-lib">
        <div class="wr-lib-list"></div>
        <div class="wr-lib-foot">
          <button class="wr-lib-link" data-act="open-device">Open from device…</button>
          <p>Documents stay in this app on this device, exactly as you leave them.
             <b>Save</b> writes the text to the device as <code>name-A00.uni</code>, <code>name-A01.uni</code>… — one file per version.</p>
        </div>
      </div>`, 'tall');

    const listEl = modal.querySelector('.wr-lib-list');
    const render = (q = '') => { listEl.innerHTML = this._renderList(records, q); };
    render();
    const input = modal.querySelector('.wr-lib-search-input');
    input?.addEventListener('input', () => render(input.value));

    modal.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const { act, id } = btn.dataset;
      if (act === 'open') {
        const hit = btn.dataset.from != null ? { from: +btn.dataset.from, to: +btn.dataset.to } : null;
        this.shell._closeSheet(); await this.open(id, hit);
      }
      else if (act === 'new')    { this.shell._closeSheet(); await this.newDocument(); }
      else if (act === 'open-device') { this.shell._closeSheet(); await this.openFromDevice(); }
      else if (act === 'more')   this._itemMenu(modal, btn, id);
    });
  }

  _renderList(records, q) {
    const results = searchRecords(records, q);
    if (!results.length) return `<div class="wr-clean">${q.trim() ? `Nothing matches “${esc(q.trim())}”.` : 'No documents yet.'}</div>`;
    return results.map(({ record: r, hits }) => {
      let versions = 0, unsaved = false;
      try {
        const vcs = new VCS(r.data);
        versions = vcs.log().length;
        unsaved = (r.data.currentContent ?? '') !== vcs.headContent || !isSavedToDevice(r);
      } catch { /* list anyway */ }
      const file = r.fileName
        ? `<span class="wr-lib-dev ${isSavedToDevice(r) ? 'saved' : 'stale'}">${esc(r.fileName)}</span>`
        : `<span class="wr-lib-dev">${r.apiName ? esc(r.apiName) + ' · ' : ''}not saved yet</span>`;
      const hitRows = hits.map(h => `
        <button class="wr-lib-hit" data-act="open" data-id="${esc(r.id)}" data-from="${h.from}" data-to="${h.to}">
          <span class="wr-lib-hit-line">${h.line}</span>
          <span class="wr-lib-hit-text">${esc(h.snippet.slice(0, h.matchStart))}<mark>${esc(h.snippet.slice(h.matchStart, h.matchEnd))}</mark>${esc(h.snippet.slice(h.matchEnd))}</span>
        </button>`).join('');
      return `
        <div class="wr-lib-item${r.id === this.docId ? ' current' : ''}" data-id="${esc(r.id)}">
          <button class="wr-lib-open" data-act="open" data-id="${esc(r.id)}">
            <span class="wr-lib-title">${esc(r.title || 'Untitled')}${unsaved ? ' <span class="wr-menu-dot"></span>' : ''}</span>
            ${file}
            ${hits.length ? '' : `<span class="wr-lib-excerpt">${esc(r.excerpt || '')}</span>`}
            <span class="wr-lib-meta">${esc(_ago(r.updatedAt))} · ${versions} ${versions === 1 ? 'version' : 'versions'}</span>
          </button>
          <button class="wr-lib-more" data-act="more" data-id="${esc(r.id)}" aria-label="More">⋯</button>
          ${hitRows ? `<div class="wr-lib-hits">${hitRows}</div>` : ''}
        </div>`;
    }).join('');
  }

  _itemMenu(modal, anchor, id) {
    modal.querySelector('.wr-lib-menu')?.remove();
    const item = anchor.closest('.wr-lib-item');
    const menu = document.createElement('div');
    menu.className = 'wr-lib-menu';
    menu.innerHTML = `
      <button data-m="rename">Rename title…</button>
      <button data-m="duplicate">Duplicate</button>
      <button data-m="remove" class="danger">Delete…</button>`;
    item.appendChild(menu);
    menu.addEventListener('click', async (e) => {
      const m = e.target.closest('button')?.dataset.m;
      if (!m) return;
      e.stopPropagation();
      menu.remove();
      if (m === 'rename') {
        const rec = await this.library.get(id);
        const next = (window.prompt('Document title (the file name stays as it is):', rec?.title ?? '') ?? '').trim();
        if (next && next !== rec?.title) await this.rename(id, next);
        this.openSheet();
      } else if (m === 'duplicate') { this.shell._closeSheet(); await this.duplicate(id); }
      else if (m === 'remove') { await this.remove(id); this.openSheet(); }
    });
  }
}

function _ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Re-exported for the shells' first-run seeding check. */
export { loadDraft };
