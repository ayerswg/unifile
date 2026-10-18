/**
 * Main application controller
 *
 * Bootstraps all components, wires up event handlers, and coordinates
 * the commit → save → quine cycle.
 */

import { state, PANELS, VIEW_MODES, SPLIT_ORIENTATIONS } from './state.js';
import { VCS } from '../core/vcs.js';
import {
  loadEmbeddedData,
  captureTemplate,
  loadUserPrefs,
  saveUserPrefs,
  IS_QUINE,
  saveDraft,
  loadDraft,
  clearDraft,
  requestPersistentStorage,
  idbLibraryStore,
  loadFromIDB,
} from '../core/storage.js';
import {
  Library, localPrefs, emptyData, isSavedToDevice, nextVersion, isValidApiName, suggestApiName,
  versionFileName, LAST_VERSION,
} from '../core/library.js';
import {
  saveVersionToDevice, pickDocumentFromDevice, adoptDeviceDocument, dataFromPickedFile,
} from '../core/device-file.js';
import { pruneAssets } from '../core/assets.js';
import { isEncrypted, decryptData } from '../core/crypto.js';
import { getDSL } from '../dsl/registry.js';
import { parseGlobalFrontMatter, serializeGlobalFrontMatter } from '../core/front-matter.js';

import { initTheme } from './theme.js';
import { TopBar } from './topbar.js';
import { Editor } from './editor.js';
import { Preview } from './preview.js';
import { DslFooter } from './dsl-footer.js';
import { PianoRoll } from './piano-roll.js';
import { mountSiteNav } from './site-nav.js';
import { checkForUpdate, initServiceWorker } from './update-check.js';
import { PaneSwitch } from './pane-switch.js';
import { ActionFab } from './action-fab.js';
import { DiffView, DiffBar, DiffPanes } from './diff-view.js';
import { BlameView } from './blame-view.js';
import { migrateCommentThreads } from './comments.js';
import { ExportDialog } from './export-dialog.js';
import { SettingsPanel } from './settings-panel.js';
import { LibraryPane } from './library-pane.js';

export class App {
  constructor() {
    this._components = {};
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  async init() {
    // 0. Apply stored colour theme immediately (before any rendering)
    initTheme();

    // 1. Capture template BEFORE rendering any UI
    if (IS_QUINE) captureTemplate();

    // 2. Load the document.
    //    Quine: the data embedded in this very file.
    //    PWA:   the document library (core/library.js) — the last-opened record,
    //           migrating the pre-library single document on first launch.
    let data;
    try {
      data = loadEmbeddedData();
    } catch (e) {
      this._fatalError('Failed to load document data: ' + e.message);
      return;
    }

    if (isEncrypted(data)) {
      data = await this._promptDecrypt(data);
      if (!data) return; // user cancelled
    }

    if (!IS_QUINE) {
      const app = data.dslType ?? 'markdown';
      state.library = new Library(idbLibraryStore(), { app, prefs: localPrefs() });
      let rec = null;
      try {
        rec = await state.library.resolveCurrent();
        if (!rec) {
          // First launch on the library: adopt the old single document (and the
          // crash-recovery draft that used to carry its unsaved text).
          let legacy = null;
          try { legacy = await loadFromIDB('default'); } catch { /* none */ }
          rec = await state.library.migrateLegacy({ data: legacy, draftContent: loadDraft()?.content ?? null });
          if (rec) clearDraft();
        }
        if (!rec) rec = await state.library.create(emptyData(app, { version: data.version }));
      } catch (e) {
        console.warn('[library] unavailable, running on the embedded document:', e);
        state.library = null;
      }
      if (rec) {
        data = rec.data;
        state.docId = rec.id;
        state.library.currentId = rec.id;
        state.deviceFile = _deviceFileOf(rec);
      }
    }

    // 3. Load user preferences
    const prefs = loadUserPrefs();
    state.user = { name: prefs.name ?? '', email: prefs.email ?? '' };

    // 4. Initialise the history (one linear line; a detached head from an
    //    older file is reattached, its working text kept — see library.js)
    const vcs = new VCS(data);
    vcs.detachedHead = null;
    const currentContent = (!IS_QUINE && typeof data.currentContent === 'string')
      ? data.currentContent : vcs.headContent;

    // 5. Update state — on small screens split view is impractical; default to preview
    let viewMode = prefs.viewMode ?? VIEW_MODES.SPLIT;
    if (_isMobile() && viewMode === VIEW_MODES.SPLIT) viewMode = VIEW_MODES.PREVIEW;
    // Split layout (desktop): side by side, or stacked with the text below.
    const splitOrientation = Object.values(SPLIT_ORIENTATIONS).includes(prefs.splitOrientation)
      ? prefs.splitOrientation : SPLIT_ORIENTATIONS.VERTICAL;

    const { meta: fmMeta } = parseGlobalFrontMatter(currentContent);
    state.update({
      data,
      vcs,
      currentContent,
      isDirty: currentContent !== vcs.headContent,
      viewMode,
      splitOrientation,
      dsl: this._getDsl(data.dslType),
      primaryModel:   fmMeta.model  ?? 'flow',
      secondaryModel: fmMeta.model2 ?? null,
    });

    // 5b. Quine only: restore the crash-recovery draft if the user left unsaved
    //     changes (a quine can't rewrite itself; the PWA's library record holds
    //     the working text itself — see _persistSoon).
    if (IS_QUINE) {
      const draft = loadDraft();
      if (draft && draft.content !== currentContent) {
        state.update({ currentContent: draft.content, isDirty: true });
      }
    }

    // 5c. Remember every edit: the library record (PWA) or the draft (quine),
    //     debounced.  Title changes, comments and assets persist the same way.
    state.on('content-change', () => this._persistSoon());
    state.on('comments-change', () => this._persistSoon());
    state.on('assets-change', () => this._persistSoon(0));
    state.on('change', () => {
      if (state.docId && state.title !== this._persistedTitle) this._persistSoon();
    });
    this._persistedTitle = state.title;
    // Flush a pending write when the page is hidden / closed (iOS kills PWAs
    // without warning; a 1 s debounce would lose the last keystrokes).
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._persistNow(); });
    window.addEventListener('pagehide', () => this._persistNow());

    // 5d. The file-level verbs (title dropdown, hamburger menu, shortcuts):
    //     Save (the next version written to the device + its snapshot in
    //     history), Save as a new major version, Open from device, the library.
    state.on('save-document',    (o) => this.saveDocument(o && typeof o === 'object' && ('major' in o || 'message' in o) ? o : {}));
    state.on('save-major',       () => this.saveDocument({ major: true }));
    state.on('open-from-device', () => this._openFromDevice());
    state.on('new-document',     () => this._newDocument());
    state.on('restore-version',  (hash) => this._restoreVersion(hash));
    state.on('open-library',     () => this._showLibrary(true));
    state.on('close-library',    () => this._showLibrary(false));

    // 5e. Commit diff view: toggle `data-diff` on the shell so CSS swaps the
    //     panes for the read-only diff overlay + its bottom picker bar.
    state.on('diff-change', (diff) => {
      const r = document.getElementById('unifile-app');
      if (diff) r?.setAttribute('data-diff', '1'); else r?.removeAttribute('data-diff');
    });

    // 6. Render the shell
    this._buildShell();

    // 6b. Site-nav bar — only renders when viewed in a browser tab on the web
    //     (hidden for installed PWAs and file:// downloads); see site-nav.js.
    mountSiteNav(document.getElementById('uf-site-nav'));

    // 10. Mount components
    this._mountComponents();

    // 10b. Bind model-related handlers (needs editor component from step 10)
    this._bindModelHandlers();

    // 10b-ii. Wire the mobile far-left commit-log pane + horizontal pane nav.
    this._setupMobilePanes();

    // 10c. Mirror persistence state into the history list.
    this._refreshPersistenceBanner();

    // 11. Global keyboard shortcuts
    this._bindGlobalKeys();

    // 12. PWA: register service worker + request durable storage so the OS is
    //     less likely to evict IndexedDB (best-effort; the real backstop is a
    //     user-exported .unifile.json — see the backup nudge below).
    //     The worker is kept fresh (update on launch + foreground; on the dev
    //     channel the page reloads onto a new worker — see update-check.js), so
    //     an update-driven reload flushes the 2 s-debounced draft first.
    if (!IS_QUINE && 'serviceWorker' in navigator) {
      initServiceWorker({
        beforeReload: () => this._persistNow()
      });
      requestPersistentStorage();
    }

    // 13. Offer an upgrade if a newer build has been published (non-blocking;
    //     on the dev channel a newer commit is applied automatically).
    checkForUpdate();
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  _buildShell() {
    const root = document.getElementById('unifile-app');
    root.innerHTML = `
      ${this._paneSwitchHtml()}
      <div id="uf-site-nav"></div>
      <div id="uf-topbar"></div>
      <div id="uf-main">
        <div id="uf-library" aria-label="Documents"></div>
        <div id="uf-commit-log" aria-label="Save history"></div>
        <div id="uf-editor-wrap"></div>
        <div id="uf-divider" class="pane-divider">
          <button class="divider-btn divider-to-preview" title="Preview only" aria-label="Preview only">
            ${_chevronRight2()}
          </button>
          <button class="divider-btn divider-orient" title="Stack panes (preview above, text below)" aria-label="Stack panes (preview above, text below)">
            ${_splitIcon(SPLIT_ORIENTATIONS.HORIZONTAL)}
          </button>
          <div class="divider-grip" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span>
          </div>
          <button class="divider-btn divider-to-editor" title="Editor only" aria-label="Editor only">
            ${_chevronRight2()}
          </button>
          <button class="divider-btn divider-to-split" title="Split view" aria-label="Split view">
            ${_chevronRight()}
          </button>
        </div>
        <div id="uf-preview-wrap"></div>
        <div id="uf-diff" aria-label="Commit diff"></div>
        <div id="uf-diff-mid" aria-label="Diff — middle (target)"></div>
        <div id="uf-diff-right" aria-label="Diff — right (source)"></div>
      </div>
      <div id="uf-bottom">
        <div id="uf-piano-roll"></div>
        <div id="uf-transport"></div>
        <div id="uf-diff-bar"></div>
      </div>
      <div id="uf-panels">
        <div id="uf-blame-panel"    style="display:none"></div>
        <div id="uf-export-panel"   style="display:none"></div>
        <div id="uf-settings-panel" style="display:none"></div>
      </div>
    `;

    this._initDivider();
    this._setupLayoutListeners();
  }

  // ---------------------------------------------------------------------------
  // Component mounting
  // ---------------------------------------------------------------------------

  _mountComponents() {
    const handlers = this._makeHandlers();

    this._components.topbar = new TopBar(
      document.getElementById('uf-topbar'), handlers
    );

    this._components.editor = new Editor(
      document.getElementById('uf-editor-wrap')
    );

    // Migrate any comment threads that still use the old lineNum format.
    // Must run after the editor is built so we have a CM6 doc reference.
    const editorDoc = this._components.editor.getDoc();
    if (editorDoc) migrateCommentThreads(editorDoc);

    this._components.preview = new Preview(
      document.getElementById('uf-preview-wrap')
    );

    // Append footer bars after editor/preview have mounted their content.
    // Editor uses EditorView({ parent }) which appends the CM DOM, so footer
    // ends up below it in the flex column. Preview uses innerHTML which runs
    // during Preview._build(), so appending afterwards is safe too.
    const editorFooterEl = document.createElement('div');
    editorFooterEl.id = 'uf-editor-footer';
    document.getElementById('uf-editor-wrap').appendChild(editorFooterEl);

    // Phone editing verbs (play/pause, align, undo…) live on the floating
    // action button (action-fab.js, mounted below) — no per-verb FABs.

    // The DSL transport is a global bottom bar (sticks to the screen bottom and
    // is visible in both the editor and preview panes), not a per-pane footer.
    this._components.dslFooter = new DslFooter(document.getElementById('uf-transport'));
    // Piano roll — the transport's expandable DAW-style edit surface (it
    // replaces the transport bar while open; see piano-roll.js).
    this._components.pianoRoll = new PianoRoll(document.getElementById('uf-piano-roll'));
    // Mobile pane switcher — the whole top chrome on phones (segments = tabs +
    // context + dropdown menus). Owns branch switching, the DSL/tools menu and
    // exports; replaces the mobile top bar, hamburger and commit-pane bottom bar.
    const shellCtx = { handlers, editor: this._components.editor };
    this._components.paneSwitch = new PaneSwitch(
      document.getElementById('uf-pane-switch'), shellCtx
    );
    // Phone action button: tap = primary action, hold = every action in a grid,
    // drag = snap to a corner (see action-fab.js). CSS hides it on desktop.
    this._components.actionFab = new ActionFab(document.getElementById('unifile-app'), shellCtx);
    // Read-only commit diff view + its bottom-bar picker (desktop two-column).
    this._components.diffView = new DiffView(document.getElementById('uf-diff'));
    // Mobile single-column diff panes (middle = target, right = source).
    this._components.diffPanes = new DiffPanes(
      document.getElementById('uf-diff-mid'),
      document.getElementById('uf-diff-right')
    );
    this._components.diffBar  = new DiffBar(document.getElementById('uf-diff-bar'), {
      onRestore: (hash) => this._restoreVersion(hash),
    });
    // The document library — the list behind the back arrow (phone pane /
    // desktop drawer).  Quines have no library; the element stays empty.
    this._components.library = new LibraryPane(document.getElementById('uf-library'), {
      open:           (id, hit) => this._openRecord(id, hit),
      create:         ()   => this._newDocument(),
      remove:         (id) => this._removeRecord(id),
      duplicate:      (id) => this._duplicateRecord(id),
      rename:         (id, title) => this._renameRecord(id, title),
      openFromDevice: ()   => this._openFromDevice(),
      close:          ()   => this._showLibrary(false),
    });

    this._components.blame = new BlameView(
      document.getElementById('uf-blame-panel')
    );

    this._components.export = new ExportDialog(
      document.getElementById('uf-export-panel'),
      { renderPreview: handlers.renderPreview, print: handlers.print, exportSlidesPptx: handlers.exportSlidesPptx }
    );

    this._components.settings = new SettingsPanel(
      document.getElementById('uf-settings-panel')
    );

    // Blame, Export, Import are surfaced via the topbar's ⋯ tools dropdown
  }

  // ---------------------------------------------------------------------------
  // Handler factory
  // ---------------------------------------------------------------------------

  _makeHandlers() {
    return {
      /**
       * Save handler — the next version written to the device and the same
       * snapshot in history.  Reached from the Save pill / Cmd+S (no message)
       * and the pending node in the history list (message + major switch).
       */
      onSave: ({ message, major } = {}) => this.saveDocument({ message, major }),

      renderPreview: async () => {
        const preview = this._components.preview;
        if (!preview) return '';
        return preview.renderToString(state.currentContent, state.data?.dslType);
      },

      print: () => {
        this._components.preview?.print();
      },

      exportSlidesPptx: async () => {
        return this._components.preview?.exportSlidesPptx();
      },

      onNewDocument:  () => this._newDocument(),
    };
  }

  // ---------------------------------------------------------------------------
  // Saving — two layers, both on the device (see core/library.js):
  //   remember → every edit lands in the library record (debounced); the app
  //              remembering, not a save
  //   SAVE     → the one save verb: the text written to the device as
  //              `<name>-<version>.uni` (A00, A01 … a major bump → B00) and the
  //              same snapshot tagged in history.  The device write comes
  //              first: a cancelled save burns no version, leaves no snapshot.
  // ---------------------------------------------------------------------------

  /** Whether there is anything to save (see state.needsSave). */
  get needsSave() { return state.needsSave; }

  /**
   * Save: the next version to the device (+ its snapshot in history).
   * @param {object} [o]
   * @param {string}  [o.message]  an optional note on this version
   * @param {boolean} [o.major]    bump the letter (A07 → B00) instead of the number
   */
  async saveDocument({ message = '', major = false } = {}) {
    if (this._saving) return 'busy';
    if (!this.needsSave && !major) return 'clean';
    this._saving = true;
    try {
      const apiName = await this._ensureApiName();
      if (!apiName) return 'cancelled';
      const version = nextVersion(state.data?.savedVersion, { major });
      if (!version) {
        window.alert(`This document is at ${LAST_VERSION}, the last version the scheme allows. Duplicate it to keep going.`);
        return 'exhausted';
      }
      const text = state.currentContent;
      const { result, fileName, handle, error } = await saveVersionToDevice({
        library: state.library, docId: state.docId, text, apiName, version, mark: false,
      });
      if (result === 'failed') { window.alert('Could not write the file: ' + (error?.message ?? error)); return result; }
      if (result === 'cancelled') return result;

      // The file is on the device: now the matching snapshot in history.
      const prefs = loadUserPrefs();
      await state.vcs.commit({
        content: text,
        message: message || '',
        author: (prefs.name || '').trim() || 'anonymous',
        email: (prefs.email || '').trim() || '',
        tag: version,
      });
      state.update({ data: { ...state.data, ...state.vcs.serialize(), apiName, savedVersion: version }, isDirty: false });
      clearDraft();
      if (state.library && state.docId) {
        await this._persistNow();
        const rec = await state.library.markSaved(state.docId, { fileName, version, ...(handle ? { handle } : {}) });
        this._setDeviceFile(_deviceFileOf(rec));
      } else {
        // A quine has no record: the save is remembered on the data object.
        this._setDeviceFile({ fileName, savedAt: Date.now(), savedHead: state.headHash, saved: true, linked: false, version });
      }
      this._refreshPersistenceBanner();
      state.emit('saved', { version, fileName, result });
      return result;
    } finally {
      this._saving = false;
    }
  }

  /**
   * The document's name — fixed at genesis, carried by its file names
   * (`<name>-<version>.uni`).  A document created before names existed (or
   * migrated) is asked once, at its first save.  Null when the user declines.
   */
  async _ensureApiName() {
    if (state.data?.apiName) return state.data.apiName;
    const apiName = await this._promptApiName(suggestApiName(state.title), { title: state.title, exceptId: state.docId });
    if (!apiName) return null;
    // A document still called "Untitled" takes its name as its title too.
    const title = (!state.title || state.title === 'Untitled') ? apiName : state.title;
    state.update({ data: { ...state.data, apiName, title } });
    await this._persistNow();
    return apiName;
  }

  /**
   * Ask for a document name until it is valid and free (or cancelled).
   * Letters, digits, `_`, `.` and `-`; it becomes the file name's stem.
   * `exceptId` = the document being named (its own record doesn't clash);
   * a NEW document excepts nothing.
   */
  async _promptApiName(suggested = '', { title, exceptId = null } = {}) {
    let hint = '';
    for (;;) {
      const raw = window.prompt(
        `${hint}Name this document${title && title !== 'Untitled' ? ` (“${title}”)` : ''}.\n` +
        `It names its files — ${versionFileName(suggested || 'name', 'A00')} — and can't be changed later.\n` +
        `Letters, digits, _ . and - only.`, suggested);
      if (raw == null) return null;
      const name = raw.trim();
      if (!isValidApiName(name)) { hint = `“${name}” isn't a valid name. `; suggested = suggestApiName(name) || suggested; continue; }
      if (state.library && !(await state.library.isApiNameFree(name, { exceptId }))) {
        hint = `“${name}” is already a document here. `; suggested = name; continue;
      }
      return name;
    }
  }

  /** Debounced persist of the whole document state (library record or draft). */
  _persistSoon(delay = 1000) {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._persistNow(), delay);
  }

  async _persistNow() {
    clearTimeout(this._persistTimer);
    if (IS_QUINE || !state.library || !state.docId) {
      if (state.isDirty) saveDraft(state.currentContent, state.headHash);
      // No record to compare against: the device holds the last save until
      // the text moves off it.
      const dev = state.deviceFile;
      if (dev) this._setDeviceFile({ ...dev, saved: !state.isDirty && state.headHash === dev.savedHead });
      return;
    }
    const docId = state.docId;
    const data = this._currentDataObject();
    this._persistedTitle = state.title;
    try {
      const rec = await state.library.save(docId, { data });
      if (state.docId === docId) this._setDeviceFile(_deviceFileOf(rec));
    } catch (e) {
      console.warn('[library] persist failed:', e);
    }
  }

  /**
   * Mirror a record's device-file link into state; `device-change` lets the
   * top bar's pill and the library list repaint when the saved/stale flag or
   * the file name moves (the generic `change` would re-render everything).
   */
  _setDeviceFile(next) {
    const prev = state.deviceFile;
    state.deviceFile = next;
    const key = (d) => d ? `${d.saved}|${d.linked}|${d.fileName}|${d.savedHead}|${d.version}` : '';
    if (key(prev) !== key(next)) state.emit('device-change', next);
  }

  /**
   * Open from device: a `<name>-<version>.uni` (or an older `.unifile.json`)
   * picked from the device becomes a new library document, named after the
   * file and starting at its version.  In a quine it replaces the document.
   */
  async _openFromDevice() {
    let picked;
    try {
      picked = await pickDocumentFromDevice({ library: state.library });
    } catch (e) {
      window.alert(e?.message ?? String(e));
      return;
    }
    if (!picked) return;
    const prefs = loadUserPrefs();
    const identity = { author: (prefs.name || '').trim() || 'anonymous', email: (prefs.email || '').trim() || '' };
    if (!state.library) {
      if (this.needsSave && state.currentContent && !confirm('Open this file and discard your unsaved changes?')) return;
      this._loadDataObject(await dataFromPickedFile(state.data?.dslType ?? 'markdown', picked, identity));
      const d = state.data;
      this._setDeviceFile(d.savedVersion ? { fileName: picked.fileName, savedAt: Date.now(), savedHead: state.headHash, saved: true, linked: false, version: d.savedVersion } : null);
      return;
    }
    await this._persistNow();
    const rec = await adoptDeviceDocument(state.library, picked, identity);
    await this._openRecord(rec.id);
  }

  // ---------------------------------------------------------------------------
  // The library — many documents per app
  // ---------------------------------------------------------------------------

  /**
   * Show / hide the document list (phone: a pane; desktop: a collapsible
   * sidebar on the left — it stays open while you work, and whether it was
   * open is remembered).
   */
  _showLibrary(open) {
    if (!state.library) return;
    const root = document.getElementById('unifile-app');
    if (_isMobile()) {
      state.emit('mobile-goto-pane', open ? 'library' : 'editor');
      return;
    }
    root.toggleAttribute('data-library', open);
    try { localStorage.setItem('uf_library_open', open ? '1' : '0'); } catch { /* private mode */ }
    if (open) this._components.library?.refresh();
    state.emit('library-change', { open });
    requestAnimationFrame(() => this._components.editor?.refresh());
  }

  /**
   * Switch the open document to a library record; with `hit` ({from, to},
   * a search hit) the editor lands on that text.  On desktop the sidebar
   * stays open (it is a panel, not a drawer); phones go to the editor.
   */
  async _openRecord(id, hit = null) {
    if (!state.library || !id) return;
    if (id !== state.docId) {
      await this._persistNow();                      // the outgoing document's last edits
      const rec = await state.library.get(id);
      if (!rec) return;
      state.closeDiff?.();
      state.docId = rec.id;
      state.library.currentId = rec.id;
      this._setDeviceFile(_deviceFileOf(rec));
      this._loadDataObject(rec.data);
    }
    if (_isMobile()) this._showLibrary(false);
    if (hit) this._components.editor?.goTo(hit.from, hit.to);
    else if (!_isMobile()) this._components.editor?.focus?.();
  }

  /**
   * A fresh, empty document in the library (quine: replaces the document).
   * Its name is asked for here, at genesis — it is fixed for good and names
   * every file the document is saved as.
   */
  async _newDocument() {
    if (!state.library && this.needsSave && state.currentContent
        && !confirm('Start a new document? Unsaved changes will be lost.')) return;
    const apiName = await this._promptApiName('');
    if (!apiName) return;
    const data = emptyData(state.data?.dslType ?? 'markdown', {
      title: apiName,
      version: state.data?.version,
      // Keep the user's configured extension slots (e.g. abc soundfont).
      extra: {
        apiName,
        ...(state.data?.pluginExtensions ? { pluginExtensions: { ...state.data.pluginExtensions } } : {}),
      },
    });
    if (!state.library) {
      state.closeDiff?.();
      this._loadDataObject(data);
      this._setDeviceFile(null);
      return;
    }
    await this._persistNow();
    const rec = await state.library.create(data);
    await this._openRecord(rec.id);
    state.emit('mobile-goto-pane', 'editor');
    this._components.editor?.focus?.();
  }

  async _removeRecord(id) {
    if (!state.library) return;
    const rec = await state.library.get(id);
    if (!rec) return;
    const where = rec.fileName ? ` The files on your device (${rec.apiName ? rec.apiName + '-…' : rec.fileName}) are not touched.` : '';
    if (!confirm(`Delete “${rec.title}” and its history from this app?${where}`)) return;
    await state.library.remove(id);
    if (id === state.docId) {
      state.docId = null;
      const next = await state.library.resolveCurrent();
      if (next) await this._openRecord(next.id);
      else await this._newDocument();
    }
    this._components.library?.refresh();
  }

  async _duplicateRecord(id) {
    if (!state.library) return;
    if (id === state.docId) await this._persistNow();
    const copy = await state.library.duplicate(id);
    if (copy) await this._openRecord(copy.id);
  }

  async _renameRecord(id, title) {
    if (!state.library) return;
    const t = String(title ?? '').trim();
    if (!t) return;
    if (id === state.docId) {
      state.update({ data: { ...state.data, title: t } });
      await this._persistNow();
    } else {
      await state.library.save(id, { title: t });
    }
    this._components.library?.refresh();
  }

  /**
   * Restore a saved version: its text becomes the working text (unsaved, so
   * the editor shows it as a change on top of the current head — Save keeps
   * it).  No detached head, no branch: history stays one line.
   */
  _restoreVersion(hash) {
    if (!hash || hash === 'WORKING' || !state.vcs?.commits?.[hash]) return;
    const content = state.vcs.getContentAt(hash);
    state.closeDiff?.();
    state.update({ currentContent: content, isDirty: content !== state.vcs.headContent });
    state.emit('checkout', { hash: state.headHash, content });
    state.emit('mobile-goto-pane', 'editor');
    this._persistSoon(0);
  }

  // ---------------------------------------------------------------------------
  // Layout management — keeps divider in sync with view mode
  // ---------------------------------------------------------------------------

  _setupLayoutListeners() {
    const syncDivider = (mode) => {
      const divider = document.getElementById('uf-divider');
      if (!divider) return;
      divider.dataset.mode = mode;
    };

    state.on('view-mode-change', syncDivider);
    syncDivider(state.viewMode);

    // Split orientation → `#unifile-app[data-split-orientation]` drives the
    // stacked layout in CSS; the divider's toggle shows the OTHER layout (what a
    // click gives you). Persisted as a user preference.
    const syncOrientation = (orientation) => {
      const root = document.getElementById('unifile-app');
      if (root) root.dataset.splitOrientation = orientation;
      const btn = document.querySelector('#uf-divider .divider-orient');
      if (btn) {
        const stacked = orientation === SPLIT_ORIENTATIONS.HORIZONTAL;
        const label = stacked ? 'Side by side (text left, preview right)'
                              : 'Stack panes (preview above, text below)';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = _splitIcon(stacked ? SPLIT_ORIENTATIONS.VERTICAL : SPLIT_ORIENTATIONS.HORIZONTAL);
      }
    };
    state.on('split-orientation-change', (orientation) => {
      syncOrientation(orientation);
      saveUserPrefs({ splitOrientation: orientation });
    });
    syncOrientation(state.splitOrientation);
  }

  // ---------------------------------------------------------------------------
  // Mobile panes — on phone-width screens #uf-main becomes a horizontal
  // scroll-snap strip: [commit log] · [editor] · [preview].  (PWAs can't use
  // edge-swipe navigation, so the user scrolls/pulls horizontally between panes.)
  // The CSS handles the layout; here we feed the commit-log pane and centre the
  // editor pane on entry so the strip opens on the document, not the history.
  // ---------------------------------------------------------------------------

  /**
   * Pin `--app-height` to the real *visible* viewport height in pixels.
   *
   * iOS PWAs make every CSS viewport unit unreliable for full-screen height:
   * `100vh` includes Safari chrome, `100dvh` hits the iOS 26 regression that
   * leaves a gap at the bottom, and `-webkit-fill-available` resolves short in
   * standalone.  So we measure in JS and write it to a custom property the shell
   * height reads (see app.css #unifile-app) — the canonical "viewport units on
   * mobile" fix.
   *
   * We use `visualViewport.height` (not `window.innerHeight`): with no keyboard
   * it equals the full screen in a standalone PWA, but when the soft keyboard
   * opens it shrinks to the area ABOVE the keyboard.  Since the document can't
   * scroll (see _lockWindowScroll), sizing the app to that visible area is what
   * lets the editor pane shrink so CodeMirror can keep the caret in view instead
   * of hiding it behind the keyboard.  Fall back to innerHeight where there's no
   * visualViewport.  Re-measured on resize / orientation change + a few delayed
   * ticks after launch (iOS reports a stale size for a beat while chrome settles).
   */
  _trackViewportHeight() {
    if (this._viewportTracked) return;
    this._viewportTracked = true;
    const set = () => {
      const vv = window.visualViewport;
      const h = Math.round(vv?.height ?? window.innerHeight);
      const top = Math.round(vv?.offsetTop ?? 0);
      const root = document.documentElement.style;
      root.setProperty('--app-height', `${h}px`);
      root.setProperty('--app-vv-top', `${top}px`);
      // "Soft keyboard is up" = the visual viewport is >100px shorter than the
      // tallest one seen at this window width (keyed by width so rotation gets
      // its own baseline).  Drives the hide-the-top-bar-while-typing chrome.
      const w = window.innerWidth;
      this._vvBase ||= {};
      this._vvBase[w] = Math.max(this._vvBase[w] || 0, h);
      const kbOpen = this._vvBase[w] - h > 100;
      if (kbOpen !== this._kbOpen) { this._kbOpen = kbOpen; this._updateEditingChrome?.(); }
    };
    set();
    window.addEventListener('resize', set);
    window.addEventListener('orientationchange', () => { set(); setTimeout(set, 300); });
    window.visualViewport?.addEventListener('resize', set);
    window.visualViewport?.addEventListener('scroll', set);
    window.addEventListener('pageshow', set);            // bfcache restore (iOS)
    // iOS reports a stale size for ~a frame after launch / keyboard transitions.
    [50, 200, 500].forEach(ms => setTimeout(set, ms));
  }

  /**
   * Keep the document/window pinned at (0,0).
   *
   * On iOS, when the soft keyboard is up and you scroll (or an inner scroller
   * overscrolls), Safari scrolls the whole *document* to reveal the focused
   * line — and it sticks, shifting our in-flow top/bottom bars off-screen (the
   * top bar slides up under the status bar).  The document itself must never
   * scroll; only the inner panes (.cm-scroller / preview / commit log) do.  We
   * snap any document scroll back to the origin.  `overscroll-behavior` (CSS)
   * stops the chaining in the first place; this is the belt-and-suspenders.
   */
  _lockWindowScroll() {
    if (this._scrollLocked) return;
    this._scrollLocked = true;
    const reset = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      const se = document.scrollingElement;
      if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
    };
    window.addEventListener('scroll', reset, { passive: true });
    window.visualViewport?.addEventListener('scroll', reset);
    window.visualViewport?.addEventListener('resize', reset);
    // When a field blurs / the keyboard dismisses, settle back to the top.
    document.addEventListener('focusout', () => setTimeout(reset, 50));
  }


  /**
   * The mobile pane switcher container.  The PaneSwitch component (pane-switch.js)
   * fills it with the three context-carrying segments, their sliding thumb and
   * the dropdown menus — it is the entire top chrome on phones.
   */
  _paneSwitchHtml() {
    return `<div id="uf-pane-switch" role="tablist" aria-label="Switch pane"></div>`;
  }

  /**
   * Hide the phone top bar while typing so the keyboard-shortened viewport goes
   * to the text (`data-editing` on the shell → CSS).  Mirrors uPub's rule:
   * editor focused AND the soft keyboard genuinely open (visual-viewport
   * heuristic in _trackViewportHeight; focus alone where there's no
   * visualViewport) AND a coarse pointer — an iPad with a hardware keyboard
   * keeps its bar.  The bar returns when the keyboard is dismissed (iOS's own
   * accessory-bar ✓ blurs the editor).  The action button stays put.
   */
  _bindEditingChrome(root) {
    this._updateEditingChrome = () => {
      const focused = !!this._components.editor?.hasFocus();
      const kb = window.visualViewport ? !!this._kbOpen : true;
      const editing = _isMobile() && focused && kb && window.matchMedia('(pointer: coarse)').matches;
      root.toggleAttribute('data-editing', editing);
    };
    state.on('editor-focus', () => this._updateEditingChrome());
    document.addEventListener('focusin', () => this._updateEditingChrome());
    document.addEventListener('focusout', () => setTimeout(() => this._updateEditingChrome(), 50));
    _mql.addEventListener('change', () => this._updateEditingChrome());
    this._updateEditingChrome();
  }

  _setupMobilePanes() {
    this._trackViewportHeight();
    this._lockWindowScroll();

    const logPane = document.getElementById('uf-commit-log');
    if (logPane && this._components.topbar?.mountCommitLog) {
      this._components.topbar.mountCommitLog(logPane);
    }

    const root = document.getElementById('unifile-app');
    const VALID = ['library', 'history', 'editor', 'render'];

    // Show a single pane by setting `data-mobile-pane` — CSS displays only that
    // pane.  Revealing the editor from display:none needs a CM6 re-measure (it
    // can't lay out while hidden).  The PaneSwitch component owns the segment
    // UI + menus; we just drive the active-pane state here.
    const setPane = (pane) => {
      if (!VALID.includes(pane)) pane = 'editor';
      if (pane === 'library' && !state.library) pane = 'editor';   // quines have no library
      if (!_isMobile()) { root.removeAttribute('data-mobile-pane'); return; }
      root.setAttribute('data-mobile-pane', pane);
      this._components.paneSwitch?.setActive(pane);
      if (pane === 'editor') requestAnimationFrame(() => this._components.editor?.refresh());
      if (pane === 'library') this._components.library?.refresh();
    };

    // Programmatic pane jumps (segment taps go via the PaneSwitch component,
    // which emits this; dirty dot / other callers use it too).
    state.on('mobile-goto-pane', (pane) => setPane(pane));

    // The bottom bar is an in-flow flex child at the end of the `100dvh`
    // #unifile-app column (see app.css), so it sits flush at the true visible
    // bottom with no JS — no visualViewport pinning needed.

    this._bindEditingChrome(root);

    // Desktop: the document list is a collapsible sidebar — reopen it if it
    // was open last time.
    let libOpen = false;
    try { libOpen = localStorage.getItem('uf_library_open') === '1'; } catch { /* private mode */ }
    if (!_isMobile() && libOpen) this._showLibrary(true);

    // Open on the editor; re-assert a valid pane whenever we (re)enter mobile.
    if (_isMobile()) setPane('editor'); else root.removeAttribute('data-mobile-pane');
    _mql.addEventListener('change', (e) => {
      if (e.matches) setPane(root.getAttribute('data-mobile-pane') || 'editor');
      else root.removeAttribute('data-mobile-pane');
    });
  }

  // ---------------------------------------------------------------------------
  // The data object
  // ---------------------------------------------------------------------------

  /** Build the canonical data object (state.data merged with the live VCS state). */
  _currentDataObject() {
    const vcsData = state.vcs?.serialize?.() ?? {};
    const data = {
      ...state.data,
      ...vcsData,
      currentContent: state.currentContent,
      dslType: state.data?.dslType,
    };
    // Document assets (images referenced by name from the text) are not
    // versioned: drop the ones nothing mentions any more — the serialized
    // history counts as a mention, so an image an old commit shows survives.
    if (data.assets && Object.keys(data.assets).length) {
      data.assets = pruneAssets(data.assets, [state.currentContent, JSON.stringify(vcsData)]);
      if (data.assets !== state.data?.assets) state.data.assets = data.assets;
    }
    return data;
  }

  /** Replace the in-memory document with a data object (mirrors init). */
  _loadDataObject(data) {
    const vcs = new VCS(data);
    vcs.detachedHead = null;                       // one line of history
    const currentContent = data.currentContent ?? vcs.headContent;
    const { meta: fmMeta } = parseGlobalFrontMatter(currentContent);
    clearDraft();
    state.clearVoiceSelections?.();
    state.update({
      data,
      vcs,
      currentContent,
      isDirty: currentContent !== vcs.headContent,
      dsl: this._getDsl(data.dslType),
      primaryModel:   fmMeta.model  ?? 'flow',
      secondaryModel: fmMeta.model2 ?? null,
    });
    this._persistedTitle = state.title;
    this._components.editor?.setValue(currentContent);
    state.emit('checkout', { hash: vcs.headHash, content: currentContent });
    state.emit('document-change', { docId: state.docId });
    state.emit('change');
    this._refreshPersistenceBanner();
  }

  // ---------------------------------------------------------------------------
  // Persistence signalling — passive markers, no banners:
  //   • unsaved work → the dirty dot + the pending node at the top of the
  //     history list (topbar.js);
  //   • the device   → the "on device" marker on the save the device file
  //     carries (state.deviceFile.savedHead) + the status line in the library.
  // ---------------------------------------------------------------------------

  /** Kept as a stable hook; there is no banner to render anymore. */
  _refreshPersistenceBanner() {
    document.getElementById('uf-draft-banner')?.remove();
    this._components?.topbar?._refreshCommitLog?.();
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  _getDsl(dslType) {
    try { return getDSL(dslType); }
    catch { return null; }
  }

  // ---------------------------------------------------------------------------
  // Model handlers
  // ---------------------------------------------------------------------------

  _bindModelHandlers() {
    // Keep primaryModel/secondaryModel in sync whenever the document changes.
    state.on('content-change', ({ content }) => {
      const { meta } = parseGlobalFrontMatter(content);
      const primaryModel   = meta.model  ?? 'flow';
      const secondaryModel = meta.model2 ?? null;
      if (primaryModel !== state.primaryModel || secondaryModel !== state.secondaryModel) {
        state.update({ primaryModel, secondaryModel });
      }
    });

    // Topbar model picker → patch the document's front matter.
    state.on('model-set', ({ slot, modelId }) => {
      const content = state.currentContent;
      const { meta, bodyFrom } = parseGlobalFrontMatter(content);

      if (slot === 'primary') {
        if (!modelId || modelId === 'flow') delete meta.model;
        else meta.model = modelId;
      } else {
        if (!modelId) delete meta.model2;
        else meta.model2 = modelId;
      }

      const newContent = serializeGlobalFrontMatter(meta) + content.slice(bodyFrom);
      this._components.editor?.setValue(newContent);
    });
  }

  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+B → blame
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault();
        if (state.activePanel === PANELS.BLAME) state.closePanel();
        else state.openPanel(PANELS.BLAME);
      }
      // Ctrl+S outside the editor (CodeMirror binds its own) → save
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        state.emit('save-document');
      }
      // Ctrl+Shift+S → save as a new major version (A07 → B00)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        state.emit('save-major');
      }
      // Ctrl+Shift+O → open from device
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') {
        e.preventDefault();
        state.emit('open-from-device');
      }
      // Ctrl+Shift+L → the library
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        const root = document.getElementById('unifile-app');
        const open = root?.hasAttribute('data-library') || root?.getAttribute('data-mobile-pane') === 'library';
        state.emit(open ? 'close-library' : 'open-library');
      }
      // Ctrl+Shift+E → export
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        if (state.activePanel === PANELS.EXPORT) state.closePanel();
        else state.openPanel(PANELS.EXPORT);
      }
      // Ctrl+Shift+, → settings
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === ',') {
        e.preventDefault();
        if (state.activePanel === PANELS.SETTINGS) state.closePanel();
        else state.openPanel(PANELS.SETTINGS);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Pane divider (drag to resize)
  // ---------------------------------------------------------------------------

  _initDivider() {
    const divider = document.getElementById('uf-divider');
    const main    = document.getElementById('uf-main');
    if (!divider || !main) return;

    let dragging = false, didDrag = false, startPos = 0, startFirst = 50;

    // Stacked ("horizontal") split: the drag axis is Y and the FIRST pane (the
    // one before the divider) is the preview; side by side it's X / the editor.
    const stacked = () => state.splitOrientation === SPLIT_ORIENTATIONS.HORIZONTAL;
    const panes = () => {
      const editorWrap  = document.getElementById('uf-editor-wrap');
      const previewWrap = document.getElementById('uf-preview-wrap');
      return stacked() ? [previewWrap, editorWrap] : [editorWrap, previewWrap];
    };
    const axisPos  = (e) => stacked() ? e.clientY : e.clientX;
    const axisSize = (el) => stacked() ? el.clientHeight : el.clientWidth;

    // On mobile, "go to split" instead toggles between the two single-pane modes.
    const _mobilePaneToggle = () => state.setViewMode(
      state.viewMode === VIEW_MODES.PREVIEW ? VIEW_MODES.EDITOR : VIEW_MODES.PREVIEW
    );

    // ── Button clicks (to-preview / to-editor / to-split / orientation) ──────
    divider.addEventListener('click', (e) => {
      const btn = e.target.closest('.divider-btn');
      if (!btn) return;

      if (btn.classList.contains('divider-to-preview')) {
        state.setViewMode(VIEW_MODES.PREVIEW);
      } else if (btn.classList.contains('divider-to-editor')) {
        state.setViewMode(VIEW_MODES.EDITOR);
      } else if (btn.classList.contains('divider-to-split')) {
        // On mobile, never enter SPLIT — toggle between EDITOR ↔ PREVIEW instead
        if (_isMobile()) _mobilePaneToggle(); else state.setViewMode(VIEW_MODES.SPLIT);
      } else if (btn.classList.contains('divider-orient')) {
        state.toggleSplitOrientation();
      }
    });

    // ── Drag-to-resize (SPLIT + desktop only) / background-click ────────────
    divider.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.divider-btn')) return; // buttons use click handler

      dragging = true;
      didDrag  = false;
      startPos = axisPos(e);

      // Pre-capture the first pane's share for the drag calculation
      if (state.viewMode === VIEW_MODES.SPLIT && !_isMobile()) {
        const [first] = panes();
        const total = axisSize(main);
        if (first && total) startFirst = (axisSize(first) / total) * 100;
        document.body.style.userSelect = 'none';
      }
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const d = axisPos(e) - startPos;
      if (Math.abs(d) > 4) didDrag = true;
      if (!didDrag) return;

      // Drag-to-resize only in SPLIT mode on non-mobile
      if (state.viewMode !== VIEW_MODES.SPLIT || _isMobile()) return;

      document.body.style.cursor = stacked() ? 'row-resize' : 'col-resize';
      const total    = axisSize(main);
      const pct      = (d / total) * 100;
      const newFirst = Math.max(15, Math.min(85, startFirst + pct));

      const [first, second] = panes();
      if (first)  first.style.flex  = `0 0 ${newFirst}%`;
      if (second) second.style.flex = `0 0 ${100 - newFirst}%`;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';

      if (!didDrag) {
        // Background click (not on a named button).
        // In non-split modes, clicking the bar background is also a trigger:
        //   • desktop → go to SPLIT
        //   • mobile  → toggle EDITOR ↔ PREVIEW
        if (state.viewMode !== VIEW_MODES.SPLIT) {
          if (_isMobile()) _mobilePaneToggle(); else state.setViewMode(VIEW_MODES.SPLIT);
        }
        // In SPLIT mode, clicking the background (grip area) does nothing.
      }
      didDrag = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Error states
  // ---------------------------------------------------------------------------

  _fatalError(msg) {
    const root = document.getElementById('unifile-app') ?? document.body;
    root.innerHTML = `
      <div style="padding:2rem;color:#f38ba8;font-family:monospace">
        <h2>Unifile failed to load</h2>
        <pre>${escHtml(msg)}</pre>
      </div>
    `;
  }

  async _promptDecrypt(data) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,.8);
        display:flex;align-items:center;justify-content:center;z-index:9999
      `;
      overlay.innerHTML = `
        <div style="background:#1e1e2e;padding:2rem;border-radius:8px;min-width:320px">
          <h2 style="color:#cdd6f4;margin:0 0 1rem">This document is password protected</h2>
          <input id="dp-pw" type="password" placeholder="Enter password"
            style="width:100%;padding:.5rem;background:#313244;border:1px solid #45475a;
                   color:#cdd6f4;border-radius:4px;font-size:1rem;box-sizing:border-box">
          <p id="dp-err" style="color:#f38ba8;display:none;margin:.5rem 0 0"></p>
          <div style="display:flex;gap:.5rem;margin-top:1rem;justify-content:flex-end">
            <button id="dp-cancel" style="padding:.4rem .8rem;background:#313244;
              border:none;color:#cdd6f4;border-radius:4px;cursor:pointer">Cancel</button>
            <button id="dp-ok" style="padding:.4rem .8rem;background:#89b4fa;
              border:none;color:#1e1e2e;border-radius:4px;cursor:pointer;font-weight:600">Unlock</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const pw = overlay.querySelector('#dp-pw');
      const errEl = overlay.querySelector('#dp-err');
      pw.focus();

      overlay.querySelector('#dp-cancel').addEventListener('click', () => {
        overlay.remove(); resolve(null);
      });

      const tryDecrypt = async () => {
        const password = pw.value;
        try {
          const decrypted = await decryptData(data, password);
          overlay.remove();
          resolve(decrypted);
        } catch {
          errEl.textContent = 'Incorrect password. Try again.';
          errEl.style.display = '';
          pw.select();
        }
      };

      overlay.querySelector('#dp-ok').addEventListener('click', tryDecrypt);
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryDecrypt(); });
    });
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Mobile breakpoint helper
// The MediaQueryList is created once; .matches is read on demand.
// ---------------------------------------------------------------------------

// Mobile = a narrow (portrait) viewport OR a short landscape touch screen (a
// phone turned sideways is wider than 640px but only ~400px tall — we still
// want the single-pane + switcher layout, just with the switcher on the right).
const _mql = window.matchMedia(
  '(max-width: 640px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)'
);
/** Returns true when the viewport is in phone/narrow mode (portrait or landscape). */
const _isMobile = () => _mql.matches;

// ---------------------------------------------------------------------------
// Divider icon helpers
// ---------------------------------------------------------------------------

/** Single right-pointing chevron — used for divider-to-split in PREVIEW mode.
 *  CSS flips it (scaleX(-1)) when data-mode="editor". */
/** The device-file link of a library record, as `state.deviceFile` carries it. */
function _deviceFileOf(rec) {
  if (!rec) return null;
  if (!rec.savedAt && !rec.handle && !rec.fileName) return null;
  return {
    fileName:  rec.fileName ?? null,
    savedAt:   rec.savedAt ?? null,
    savedHead: rec.savedKey ? (rec.savedKey.split(':')[0] || null) : null,
    saved:     isSavedToDevice(rec),
    linked:    rec.handle?.kind === 'directory',
    version:   rec.version ?? null,
  };
}

function _chevronRight() {
  return `<svg width="8" height="12" viewBox="0 0 8 12" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
    <polyline points="1,1 7,6 1,11"/>
  </svg>`;
}

/** Double right-pointing chevrons — used for divider-to-editor (go to editor-only). */
/** Split-layout glyph: a pane split side by side (vertical) or stacked (horizontal). */
function _splitIcon(orientation) {
  const stacked = orientation === SPLIT_ORIENTATIONS.HORIZONTAL;
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" rx="1.5"/>
    ${stacked ? '<line x1="1" y1="6" x2="11" y2="6"/>' : '<line x1="6" y1="1" x2="6" y2="11"/>'}
  </svg>`;
}

function _chevronRight2() {
  return `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
    <polyline points="1,1 5,6 1,11"/>
    <polyline points="5,1 9,6 5,11"/>
  </svg>`;
}

