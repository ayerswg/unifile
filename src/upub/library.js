/**
 * The document library for the uPub-style shells ({write} and {draft}) — the
 * same core as the standard app (core/library.js + core/device-file.js) behind
 * the same three moves: the `‹` back button opens the list, Save snapshots
 * into history, Save to device writes the `.unifile.json` you keep.
 *
 * `ShellLibrary` wraps a shell app instance.  The shell provides:
 *   shell._currentData()           the data object (history + working text)
 *   shell._loadDocument(data)      replace the open document (title, text,
 *                                  history, view state) — no persistence
 *   shell._openSheet / _closeSheet / _toast
 *   shell.title, shell.vcs, shell.content, shell.isDirty
 * and calls:
 *   lib.boot(embedded, legacyId)   on launch → { data } to load
 *   lib.persist(data)              from the shell's debounced autosave
 *   lib.openSheet()                the `‹` button / menu
 *   lib.saveToDevice() / openFromDevice() / newDocument()
 *
 * In a quine there is no library (`lib.enabled` is false): the sheet entry
 * points hide, and the device/new verbs fall back to the single-document
 * behaviours (download / replace).
 */

import { IS_QUINE, idbLibraryStore, loadFromIDB, loadDraft, clearDraft } from '../core/storage.js';
import { Library, localPrefs, emptyData, isSavedToDevice } from '../core/library.js';
import {
  saveDocumentToDevice, writeLinkedFile, pickDocumentFromDevice, adoptDeviceDocument,
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
    if (!r || (!r.savedAt && !r.handle && !r.fileName)) return null;
    return { fileName: r.fileName ?? null, savedAt: r.savedAt ?? null, saved: isSavedToDevice(r), linked: !!r.handle,
             savedHead: r.savedKey ? (r.savedKey.split(':')[0] || null) : null };
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

  /** After a Save: a linked device file follows the history. */
  async afterSave(data) {
    if (!this.library || !this.docId) return;
    const rec = await writeLinkedFile({ library: this.library, docId: this.docId, data, request: true });
    if (rec) this.record = rec;
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async open(id) {
    if (!this.library || !id) return;
    if (id === this.docId) return;
    await this.shell._persistNow();
    const rec = await this.library.get(id);
    if (!rec) return;
    this._setRecord(rec);
    this.shell._loadDocument(rec.data);
  }

  async newDocument() {
    const data = emptyData(this.app, { version: this.version });
    if (!this.library) {
      if (!confirm('Start a new document? The current document and its history will be replaced.')) return;
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
    const where = rec.fileName ? ` The file on your device (${rec.fileName}) is not touched.` : '';
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

  async saveToDevice() {
    const { result, record, error } = await saveDocumentToDevice({
      library: this.library, docId: this.docId, data: this.shell._currentData(), title: this.shell.title,
    });
    if (record) this.record = record;
    if (result === 'failed') this.shell._toast('Could not write the file: ' + (error?.message ?? error));
    else if (result === 'linked') this.shell._toast(`Saved to ${record?.fileName ?? 'the device'}`);
    else if (result === 'shared') this.shell._toast('Saved');
    else if (result === 'downloaded') this.shell._toast('Downloaded');
    return result;
  }

  async openFromDevice() {
    let picked;
    try { picked = await pickDocumentFromDevice({ library: this.library }); }
    catch (e) { this.shell._toast(e?.message ?? String(e)); return; }
    if (!picked) return;
    if (!this.library) {
      if (!confirm(`Replace the current document with “${picked.data.title || 'Untitled'}” (including its history)?`)) return;
      this.shell._loadDocument(picked.data);
      this.shell._persistNow();
      return;
    }
    await this.shell._persistNow();
    const rec = await adoptDeviceDocument(this.library, picked);
    this._setRecord(rec);
    this.shell._loadDocument(rec.data);
    this.shell._toast(`Opened ${rec.fileName ?? rec.title}`);
  }

  // ── The sheet ─────────────────────────────────────────────────────────────

  /** The list of this app's documents, as a tall bottom sheet. */
  async openSheet() {
    if (!this.library) return;
    await this.shell._persistNow();
    const records = await this.library.list();
    const rows = records.map(r => {
      let saves = 0, unsaved = false;
      try {
        const vcs = new VCS(r.data);
        saves = vcs.log().length;
        unsaved = (r.data.currentContent ?? '') !== vcs.headContent;
      } catch { /* list anyway */ }
      const dev = isSavedToDevice(r) ? `<span class="wr-lib-dev saved">✓ ${esc(r.fileName || 'on device')}</span>`
        : r.fileName ? `<span class="wr-lib-dev stale">${esc(r.fileName)} · changed</span>`
        : `<span class="wr-lib-dev">not on device</span>`;
      return `
        <div class="wr-lib-item${r.id === this.docId ? ' current' : ''}" data-id="${esc(r.id)}">
          <button class="wr-lib-open" data-act="open" data-id="${esc(r.id)}">
            <span class="wr-lib-title">${esc(r.title || 'Untitled')}${unsaved ? ' <span class="wr-menu-dot"></span>' : ''}</span>
            <span class="wr-lib-excerpt">${esc(r.excerpt || '')}</span>
            <span class="wr-lib-meta">${esc(_ago(r.updatedAt))} · ${saves} ${saves === 1 ? 'save' : 'saves'} · ${dev}</span>
          </button>
          <button class="wr-lib-more" data-act="more" data-id="${esc(r.id)}" aria-label="More">⋯</button>
        </div>`;
    }).join('');

    const modal = this.shell._openSheet(`
      <div class="wr-sheet-head wr-lib-head">
        <span>Documents</span>
        <button class="wr-primary wr-lib-new" data-act="new">+ New</button>
      </div>
      <div class="wr-sheet-body wr-lib">
        ${rows || '<div class="wr-clean">No documents yet.</div>'}
        <div class="wr-lib-foot">
          <button class="wr-lib-link" data-act="open-device">Open from device…</button>
          <p>Documents stay in this app on this device, exactly as you leave them.
             <b>Save to device</b> writes a <code>.unifile.json</code> you keep — text and full history, nothing online.</p>
        </div>
      </div>`, 'tall');

    modal.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const { act, id } = btn.dataset;
      if (act === 'open')        { this.shell._closeSheet(); await this.open(id); }
      else if (act === 'new')    { this.shell._closeSheet(); await this.newDocument(); }
      else if (act === 'open-device') { this.shell._closeSheet(); await this.openFromDevice(); }
      else if (act === 'more')   this._itemMenu(modal, btn, id);
    });
  }

  _itemMenu(modal, anchor, id) {
    modal.querySelector('.wr-lib-menu')?.remove();
    const item = anchor.closest('.wr-lib-item');
    const menu = document.createElement('div');
    menu.className = 'wr-lib-menu';
    menu.innerHTML = `
      <button data-m="rename">Rename…</button>
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
        const next = (window.prompt('Document title:', rec?.title ?? '') ?? '').trim();
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
