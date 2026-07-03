/**
 * Main application controller
 *
 * Bootstraps all components, wires up event handlers, and coordinates
 * the commit → save → quine cycle.
 */

import { state, PANELS, VIEW_MODES } from './state.js';
import { VCS } from '../core/vcs.js';
import {
  loadEmbeddedData,
  captureTemplate,
  generateQuine,
  loadUserPrefs,
  IS_QUINE,
  saveDraft,
  loadDraft,
  clearDraft,
  shareOrDownloadFile,
  requestPersistentStorage,
  markBackedUp,
  loadBackupMark,
} from '../core/storage.js';
import { isEncrypted, decryptData } from '../core/crypto.js';
import { getDSL } from '../dsl/registry.js';
import { parseGlobalFrontMatter, serializeGlobalFrontMatter } from '../core/front-matter.js';

import { initTheme } from './theme.js';
import { TopBar } from './topbar.js';
import { Editor } from './editor.js';
import { Preview } from './preview.js';
import { DslFooter } from './dsl-footer.js';
import { mountSiteNav } from './site-nav.js';
import { checkForUpdate } from './update-check.js';
import { CommitBar } from './commit-bar.js';
import { DiffView, DiffBar } from './diff-view.js';
import { CommitDialog } from './commit-dialog.js';
import { BlameView } from './blame-view.js';
import { MergeDialog } from './merge-dialog.js';
import { migrateCommentThreads } from './comments.js';
import { ExportDialog } from './export-dialog.js';
import { SettingsPanel } from './settings-panel.js';

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

    // 2. Load and possibly decrypt data
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

    // 3. Load user preferences
    const prefs = loadUserPrefs();
    state.user = { name: prefs.name ?? '', email: prefs.email ?? '' };

    // 4. Initialise VCS
    const vcs = new VCS(data);
    const currentContent = vcs.headContent;

    // 5. Update state — on small screens split view is impractical; default to preview
    let viewMode = prefs.viewMode ?? VIEW_MODES.SPLIT;
    if (_isMobile() && viewMode === VIEW_MODES.SPLIT) viewMode = VIEW_MODES.PREVIEW;

    const { meta: fmMeta } = parseGlobalFrontMatter(currentContent);
    state.update({
      data,
      vcs,
      currentContent,
      isDirty: false,
      viewMode,
      dsl: this._getDsl(data.dslType),
      primaryModel:   fmMeta.model  ?? 'flow',
      secondaryModel: fmMeta.model2 ?? null,
    });

    // 5b. Restore draft if the user left unsaved changes (crash / accidental close)
    const draft = loadDraft();
    if (draft && draft.content !== currentContent) {
      // Restore the draft as the live content; the committed head is unchanged.
      state.update({ currentContent: draft.content, isDirty: true });
      // Show the recovery banner once components are mounted (deferred below).
      this._pendingDraftSavedAt = draft.savedAt;
    }

    // 5c. Auto-save draft on every content-change (debounced 2 s).
    let _draftTimer = null;
    state.on('content-change', ({ content }) => {
      clearTimeout(_draftTimer);
      _draftTimer = setTimeout(() => saveDraft(content, state.headHash), 2000);
    });

    // 5d. Local data file: save/open the document + full history as a small
    //     plain-text `.unifile.json` (deltas + content, no app/soundfont).
    state.on('save-data-file', () => this._saveDataFile());
    state.on('open-data-file', () => this._openDataFile());

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

    // 10c. Show the persistence banner if we recovered unsaved content, or if
    //      committed work is sitting un-backed-up in the local sandbox.
    if (this._pendingDraftSavedAt) {
      this._draftSavedAt = this._pendingDraftSavedAt;
      this._pendingDraftSavedAt = null;
    }
    this._refreshPersistenceBanner();

    // 11. Global keyboard shortcuts
    this._bindGlobalKeys();

    // 12. PWA: register service worker + request durable storage so the OS is
    //     less likely to evict IndexedDB (best-effort; the real backstop is a
    //     user-exported .unifile.json — see the backup nudge below).
    if (!IS_QUINE && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(console.warn);
      requestPersistentStorage();
    }

    // 13. Offer an upgrade if a newer release has been published (non-blocking).
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
        <div id="uf-commit-log" aria-label="Commit history"></div>
        <div id="uf-editor-wrap"></div>
        <div id="uf-divider" class="pane-divider">
          <button class="divider-btn divider-to-preview" title="Preview only" aria-label="Preview only">
            ${_chevronRight2()}
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
      </div>
      <div id="uf-bottom">
        <div id="uf-transport"></div>
        <div id="uf-commit-bar"></div>
        <div id="uf-diff-bar"></div>
      </div>
      <div id="uf-panels">
        <div id="uf-commit-panel"   style="display:none"></div>
        <div id="uf-blame-panel"    style="display:none"></div>
        <div id="uf-merge-panel"    style="display:none"></div>
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

    // The DSL transport is a global bottom bar (sticks to the screen bottom and
    // is visible in both the editor and preview panes), not a per-pane footer.
    this._components.dslFooter = new DslFooter(document.getElementById('uf-transport'));
    // Mobile commit bar — the bottom bar shown on the commit (left) pane.
    this._components.commitBar = new CommitBar(
      document.getElementById('uf-commit-bar'), { onCommit: handlers.onCommit }
    );
    // Read-only commit diff view + its bottom-bar picker.
    this._components.diffView = new DiffView(document.getElementById('uf-diff'));
    this._components.diffBar  = new DiffBar(document.getElementById('uf-diff-bar'));

    this._components.commit = new CommitDialog(
      document.getElementById('uf-commit-panel'),
      { onCommit: handlers.onCommit }
    );

    this._components.blame = new BlameView(
      document.getElementById('uf-blame-panel')
    );

    this._components.merge = new MergeDialog(
      document.getElementById('uf-merge-panel'),
      { onMerge: handlers.onMerge }
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
       * Commit handler — handles both normal commits and detached HEAD commits.
       * When detached, `branchName` is required; the VCS creates the branch
       * automatically before committing (history of other branches is untouched).
       */
      onCommit: async ({ author, email, message, tag, branchName }) => {
        const hash = await state.vcs.commit({
          content: state.currentContent,
          message,
          author,
          email,
          tag,
          branchName   // undefined for normal commits; provided when detached
        });

        // Sync data from VCS (includes any newly-created branch)
        const newData = {
          ...state.data,
          ...state.vcs.serialize()
        };

        state.update({
          data: newData,
          isDirty: false
        });

        // Draft is now committed — drop the crash-recovery copy.
        clearDraft();
        this._draftSavedAt = null;

        // Auto-save quine
        await this._saveQuine(newData);

        // Committed, but still only in the local (evictable) sandbox — surface
        // the quiet "back up" nudge for this new head.
        this._refreshPersistenceBanner();
      },

      onMerge: async ({ importedData, branchName, strategy }) => {
        const { commonAncestor, importedHead } = state.vcs.importFrom(importedData, branchName);

        let mergeContent = state.currentContent;

        if (strategy === 'theirs') {
          const importedVcs = new VCS(importedData);
          mergeContent = importedVcs.headContent;
        }

        if (strategy !== 'import-only') {
          // Create a merge commit
          const prefs = loadUserPrefs();
          await state.vcs.commit({
            content: mergeContent,
            message: `Merge ${branchName}`,
            author: prefs.name || 'Unifile',
            email: prefs.email || '',
            tag: null
          });
        }

        const newData = { ...state.data, ...state.vcs.serialize() };
        state.update({ data: newData, currentContent: mergeContent, isDirty: false });
        await this._saveQuine(newData);
      },

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

      // Export the document + history as a .unifile.json; returns the outcome so
      // the "new document" modal can confirm a backup happened before discarding.
      onSaveDataFile: () => this._saveDataFile(),

      // Discard the current document and start a fresh, empty one. The confirm +
      // backup prompts live in the New-document modal (topbar.js); this only runs
      // once the user has accepted that unbacked-up work will be lost.
      onNewDocument: () => this._newDocument(),
    };
  }

  // ---------------------------------------------------------------------------
  // New document
  // ---------------------------------------------------------------------------

  /**
   * Replace the entire in-memory document — content, branches, commits and
   * comments — with a blank one seeded from this build's default DSL. Configured
   * extension slots are preserved so the user keeps their setup. Mirrors
   * _loadDataObject (the opened-file path).
   */
  _newDocument() {
    const data = {
      version: state.data?.version,
      title: 'Untitled Document',
      dslType: state.data?.dslType ?? 'markdown',
      currentBranch: 'main',
      branches: { main: { name: 'main', head: null } },
      commits: {},
      comments: {},
      commentThreads: {},
      password: null,
      currentContent: '',
      // Keep the user's configured extension slots (e.g. abc soundfont).
      ...(state.data?.pluginExtensions ? { pluginExtensions: { ...state.data.pluginExtensions } } : {}),
    };

    // Clear any diff/detached/draft state left over from the old document.
    state.closeDiff?.();
    this._draftSavedAt = null;
    this._nudgeDismissedForHash = null;

    this._loadDataObject(data);
    this._refreshPersistenceBanner();
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
   * Markup for the mobile pane switcher — a thick segmented slider with an icon
   * per pane (commit · code · render).  A sliding `.ps-thumb` sits behind the
   * active button (driven purely by `data-mobile-pane` in CSS).  The render
   * icon is DSL-specific (a music note for ABC) and refreshed on DSL change.
   * Portrait: a horizontal bar under the top bar.  Landscape: a vertical rail
   * pinned to the far right (see the landscape media query in app.css).
   */
  _paneSwitchHtml() {
    return `
      <div id="uf-pane-switch" role="tablist" aria-label="Switch pane">
        <span class="ps-thumb" aria-hidden="true"></span>
        <button type="button" class="ps-btn" data-pane="commit" role="tab" aria-selected="false"
          aria-label="Commit history" title="Commits">${_iconCommitPane()}</button>
        <button type="button" class="ps-btn" data-pane="editor" role="tab" aria-selected="true"
          aria-label="Code editor" title="Code">${_iconCodePane()}</button>
        <button type="button" class="ps-btn ps-btn-render" data-pane="render" role="tab" aria-selected="false"
          aria-label="Preview" title="Preview">${this._paneRenderIcon()}</button>
      </div>`;
  }

  /** Icon for the render pane, chosen by the active DSL (ABC → music note). */
  _paneRenderIcon() {
    return _paneRenderIconFor(state.activeDslId ?? state.data?.dslType ?? 'markdown');
  }

  _setupMobilePanes() {
    this._trackViewportHeight();
    this._lockWindowScroll();

    const logPane = document.getElementById('uf-commit-log');
    if (logPane && this._components.topbar?.mountCommitLog) {
      this._components.topbar.mountCommitLog(logPane);
    }

    const root = document.getElementById('unifile-app');
    const VALID = ['commit', 'editor', 'render'];

    // Show a single pane by setting `data-mobile-pane` — CSS displays only that
    // pane (no horizontal scroll-snap strip; the old pull-between-panes gesture
    // was unreliable).  Reveal the editor from display:none needs a CM6
    // re-measure (it can't lay out while hidden).
    const setPane = (pane) => {
      if (!VALID.includes(pane)) pane = 'editor';
      if (!_isMobile()) { root.removeAttribute('data-mobile-pane'); return; }
      root.setAttribute('data-mobile-pane', pane);
      document.querySelectorAll('#uf-pane-switch .ps-btn').forEach(b =>
        b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
      if (pane === 'editor') requestAnimationFrame(() => this._components.editor?.refresh());
    };

    // Tap a switcher button → jump straight to that pane.
    document.getElementById('uf-pane-switch')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.ps-btn');
      if (btn) setPane(btn.dataset.pane);
    });

    // Programmatic pane jumps (e.g. topbar status chip → commit pane).
    state.on('mobile-goto-pane', (pane) => setPane(pane));

    // Keep the render-pane icon in sync with the active DSL (music note ↔ eye).
    const syncRenderIcon = () => {
      const btn = document.querySelector('#uf-pane-switch .ps-btn-render');
      if (btn) btn.innerHTML = this._paneRenderIcon();
    };
    state.on('change', syncRenderIcon);
    state.on('active-section-change', syncRenderIcon);

    // The bottom bar is an in-flow flex child at the end of the `100dvh`
    // #unifile-app column (see app.css), so it sits flush at the true visible
    // bottom with no JS — no visualViewport pinning needed.

    // Open on the editor; re-assert a valid pane whenever we (re)enter mobile.
    if (_isMobile()) setPane('editor'); else root.removeAttribute('data-mobile-pane');
    _mql.addEventListener('change', (e) => {
      if (e.matches) setPane(root.getAttribute('data-mobile-pane') || 'editor');
      else root.removeAttribute('data-mobile-pane');
    });
  }

  // ---------------------------------------------------------------------------
  // Local data file (.unifile.json) — document + full history as plain text
  // ---------------------------------------------------------------------------

  /** Build the canonical data object (state.data merged with the live VCS state). */
  _currentDataObject() {
    return {
      ...state.data,
      ...(state.vcs?.serialize?.() ?? {}),
      currentContent: state.currentContent,
      dslType: state.data?.dslType,
    };
  }

  /** Per-document key for the backup watermark (PWA docId, else the page URL). */
  _backupScope() {
    return state.docId ?? location.href;
  }

  /**
   * Export the document + full commit history as a small plain-text
   * `.unifile.json`, out of the browser sandbox.  On iOS this opens the share
   * sheet ("Save to Files" → iCloud Drive); elsewhere it downloads.  On success
   * we record the backed-up head so the persistence nudge can stand down.
   *
   * The filename carries the short head hash + date so successive snapshots in
   * the Files app don't clobber each other and form a natural version trail.
   * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
   */
  async _saveDataFile() {
    const data = this._currentDataObject();
    const base = (state.title || 'untitled').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
    const hash = state.headHash ? '.' + state.headHash.slice(0, 7) : '';
    const date = _localDateStamp();
    const filename = `${base}${hash}.${date}.unifile.json`;
    const result = await shareOrDownloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
    // 'cancelled' = the user backed out of the share sheet without choosing a
    // target, so the data never actually left — don't mark it backed up.
    if (result !== 'cancelled' && !state.isDirty && state.headHash) {
      markBackedUp(this._backupScope(), state.headHash);
      this._refreshPersistenceBanner();
    }
    return result;
  }

  /** Prompt for a `.unifile.json`, then load it (replaces the current document). */
  _openDataFile() {
    if (state.isDirty && !confirm('You have uncommitted changes. Open another file and discard them?')) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.unifile.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || (data.commits === undefined && data.currentContent === undefined)) {
          alert('That doesn’t look like a unifile data file.');
          return;
        }
        this._loadDataObject(data);
      } catch (e) {
        alert('Could not read that file: ' + (e?.message ?? e));
      }
    });
    input.click();
  }

  /** Replace the in-memory document with a loaded data object (mirrors init). */
  _loadDataObject(data) {
    const vcs = new VCS(data);
    const currentContent = data.currentContent ?? vcs.headContent;
    const { meta: fmMeta } = parseGlobalFrontMatter(currentContent);
    clearDraft();
    state.update({
      data,
      vcs,
      currentContent,
      isDirty: false,
      dsl: this._getDsl(data.dslType),
      primaryModel:   fmMeta.model  ?? 'flow',
      secondaryModel: fmMeta.model2 ?? null,
    });
    this._components.editor?.setValue(currentContent);
    state.emit('checkout', { hash: vcs.headHash, content: currentContent });
    state.emit('change');
    this._saveQuine(this._currentDataObject());  // persist (IDB / file handle)
  }

  // ---------------------------------------------------------------------------
  // Save / quine generation
  // ---------------------------------------------------------------------------

  async _saveQuine(newData) {
    if (!IS_QUINE) {
      // PWA: save to IndexedDB and optionally to file handle
      const { saveToIDB, saveToFileHandle } = await import('../core/storage.js');
      const docId = state.docId ?? 'default';
      await saveToIDB(docId, newData);
      if (state.fileHandle) {
        try {
          const preview = await this._components.preview?.renderToString(
            state.currentContent, newData.dslType
          ) ?? '';
          const html = generateQuine(newData, preview, state.title);
          await saveToFileHandle(state.fileHandle, html);
        } catch (e) {
          console.warn('Could not write to file handle:', e);
        }
      }
      return;
    }

    // Quine: auto-save to browser storage as backup; main save is manual (export)
  }

  // ---------------------------------------------------------------------------
  // Persistence banner
  //
  // A single quiet bar under the topbar whose whole job is to make sure the user
  // never *unknowingly* leaves work living only in the evictable browser
  // sandbox.  Two situations surface it, and in both the prominent action moves
  // the work toward durable storage (commit → back up) rather than throwing it
  // away:
  //   • 'draft' – an unsaved draft was recovered on load (crash / accidental
  //               close).  Primary: Commit…  Secondary (quiet): Discard.
  //   • 'nudge' – committed work has not yet been exported to a .unifile.json.
  //               Primary: Back up.
  // It is always dismissible and deliberately does NOT appear while the user is
  // actively editing (dirty-but-no-recovered-draft) — the commit bar already
  // signals that — so it nudges without getting in the way.
  // ---------------------------------------------------------------------------

  /** Decide which banner variant (if any) to show for the current state. */
  _refreshPersistenceBanner() {
    const dirty     = state.isDirty;
    const headHash  = state.headHash;
    const hasCommits = (state.vcs?.log?.().length ?? 0) > 0;
    const mark      = loadBackupMark(this._backupScope());
    const backedUp  = !!mark && mark.headHash === headHash && !dirty;

    let variant = null;
    if (this._draftSavedAt && dirty) {
      variant = 'draft';
    } else if (!IS_QUINE && !dirty && hasCommits && !backedUp && this._nudgeDismissedForHash !== headHash) {
      // The back-up nudge is a PWA concern: quine mode's durable copy is the
      // .html file itself, so "iOS can clear this storage" wouldn't apply.
      variant = 'nudge';
    }

    if (!variant) { document.getElementById('uf-draft-banner')?.remove(); return; }
    this._renderPersistenceBanner(variant, mark);
  }

  _renderPersistenceBanner(variant, mark) {
    document.getElementById('uf-draft-banner')?.remove();

    const el = document.createElement('div');
    el.id = 'uf-draft-banner';
    el.className = 'draft-banner';

    let msg, primaryLabel;
    if (variant === 'draft') {
      msg = `Unsaved draft restored from ${_formatAge(this._draftSavedAt)} ago — not committed or backed up.`;
      primaryLabel = 'Commit…';
    } else {
      const behind = this._commitsSinceBackup(mark);
      const n = behind === 1 ? '1 change' : `${behind} changes`;
      msg = `Saved on this device only — ${n} not backed up. iOS can clear this storage.`;
      primaryLabel = 'Back up';
    }

    el.innerHTML = `
      <span class="draft-banner-msg">${_escBanner(msg)}</span>
      <button class="draft-banner-btn draft-banner-primary" type="button">${primaryLabel}</button>
      ${variant === 'draft'
        ? '<button class="draft-banner-btn draft-banner-discard" type="button">Discard</button>'
        : ''}
      <button class="draft-banner-btn draft-banner-close" type="button" aria-label="Dismiss">×</button>
    `;

    el.querySelector('.draft-banner-primary').addEventListener('click', () => {
      if (variant === 'draft') {
        // Move toward durable storage: open the commit UI (captures a message +
        // identity).  After the commit lands, onCommit re-runs the refresh and
        // the 'back up' nudge takes over.
        state.openPanel(PANELS.COMMIT);
      } else {
        this._saveDataFile();
      }
    });

    el.querySelector('.draft-banner-discard')?.addEventListener('click', () => {
      // Revert to the last committed content and wipe the draft.
      state.setContent(state.vcs.headContent);
      clearDraft();
      this._draftSavedAt = null;
      this._refreshPersistenceBanner();
    });

    el.querySelector('.draft-banner-close').addEventListener('click', () => {
      if (variant === 'draft') this._draftSavedAt = null;
      else this._nudgeDismissedForHash = state.headHash; // re-nudges after the next commit
      el.remove();
    });

    // Insert just below the topbar.
    const main = document.getElementById('uf-main');
    main?.parentElement?.insertBefore(el, main);
  }

  /** How many commits on the current branch are newer than the last backup. */
  _commitsSinceBackup(mark) {
    const log = state.vcs?.log?.() ?? []; // root → head
    if (!mark) return log.length;
    const idx = log.findIndex(c => c.hash === mark.headHash);
    return idx >= 0 ? log.length - 1 - idx : log.length;
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
      // Ctrl+Shift+M → merge
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        if (state.activePanel === PANELS.MERGE) state.closePanel();
        else state.openPanel(PANELS.MERGE);
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

    let dragging = false, didDrag = false, startX = 0, startFlex = [50, 50];

    // On mobile, "go to split" instead toggles between the two single-pane modes.
    const _mobilePaneToggle = () => state.setViewMode(
      state.viewMode === VIEW_MODES.PREVIEW ? VIEW_MODES.EDITOR : VIEW_MODES.PREVIEW
    );

    // ── Button clicks (to-preview / to-editor / to-split) ────────────────────
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
      }
    });

    // ── Drag-to-resize (SPLIT + desktop only) / background-click ────────────
    divider.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.divider-btn')) return; // buttons use click handler

      dragging = true;
      didDrag  = false;
      startX   = e.clientX;

      // Pre-capture current flex percentages for drag calculation
      if (state.viewMode === VIEW_MODES.SPLIT && !_isMobile()) {
        const editorWrap  = document.getElementById('uf-editor-wrap');
        const previewWrap = document.getElementById('uf-preview-wrap');
        if (editorWrap && previewWrap) {
          const total = main.clientWidth;
          startFlex = [
            (editorWrap.clientWidth  / total) * 100,
            (previewWrap.clientWidth / total) * 100
          ];
        }
        document.body.style.userSelect = 'none';
      }
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) didDrag = true;
      if (!didDrag) return;

      // Drag-to-resize only in SPLIT mode on non-mobile
      if (state.viewMode !== VIEW_MODES.SPLIT || _isMobile()) return;

      document.body.style.cursor = 'col-resize';
      const total  = main.clientWidth;
      const pct    = (dx / total) * 100;
      const newLeft = Math.max(15, Math.min(85, startFlex[0] + pct));

      const editorWrap  = document.getElementById('uf-editor-wrap');
      const previewWrap = document.getElementById('uf-preview-wrap');
      if (editorWrap)  editorWrap.style.flex  = `0 0 ${newLeft}%`;
      if (previewWrap) previewWrap.style.flex = `0 0 ${100 - newLeft}%`;
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
/** Format a timestamp as a human-readable age string (e.g. "5 minutes"). */
function _formatAge(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90)   return `${s} second${s !== 1 ? 's' : ''}`;
  const m = Math.round(s / 60);
  if (m < 90)   return `${m} minute${m !== 1 ? 's' : ''}`;
  const h = Math.round(m / 60);
  return `${h} hour${h !== 1 ? 's' : ''}`;
}

/** Local-time YYYY-MM-DD stamp for backup filenames. */
function _localDateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function _escBanner(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _chevronRight() {
  return `<svg width="8" height="12" viewBox="0 0 8 12" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
    <polyline points="1,1 7,6 1,11"/>
  </svg>`;
}

/** Double right-pointing chevrons — used for divider-to-editor (go to editor-only). */
function _chevronRight2() {
  return `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
    <polyline points="1,1 5,6 1,11"/>
    <polyline points="5,1 9,6 5,11"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Mobile pane-switcher icons (commit · code · render).  The render icon is
// DSL-specific — ABC shows a music note, everything else a preview "eye".
// ---------------------------------------------------------------------------

/** Git-commit node — the commit-history pane. */
function _iconCommitPane() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5"/>
    <line x1="1.5" y1="12" x2="8.5" y2="12"/>
    <line x1="15.5" y1="12" x2="22.5" y2="12"/>
  </svg>`;
}

/** Angle brackets `</>` — the code-editor pane. */
function _iconCodePane() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="8,7 3,12 8,17"/>
    <polyline points="16,7 21,12 16,17"/>
  </svg>`;
}

/** Music note — the render pane for ABC notation documents. */
function _iconMusicNote() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18V5l11-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="17" cy="16" r="3"/>
  </svg>`;
}

/** Preview "eye" — the render pane for text-ish documents (Markdown, slides…). */
function _iconEye() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`;
}

/** Nodes-and-edges — the render pane for diagram DSLs (Mermaid). */
function _iconDiagram() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="8" y="3" width="8" height="5" rx="1"/>
    <rect x="3" y="16" width="7" height="5" rx="1"/>
    <rect x="14" y="16" width="7" height="5" rx="1"/>
    <path d="M12 8v4M12 12H6.5v4M12 12h5.5v4"/>
  </svg>`;
}

/** Pick the render-pane icon for a DSL id. */
function _paneRenderIconFor(dslId) {
  switch (dslId) {
    case 'abcjs':   return _iconMusicNote();
    case 'mermaid': return _iconDiagram();
    default:        return _iconEye();
  }
}

