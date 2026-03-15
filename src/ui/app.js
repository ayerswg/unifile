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
  downloadFile,
  loadUserPrefs,
  IS_QUINE
} from '../core/storage.js';
import { isEncrypted, decryptData } from '../core/crypto.js';
import { getDSL } from '../dsl/registry.js';

import { initTheme } from './theme.js';
import { TopBar } from './topbar.js';
import { Editor } from './editor.js';
import { Preview } from './preview.js';
import { DslFooter } from './dsl-footer.js';
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

    state.update({
      data,
      vcs,
      currentContent,
      isDirty: false,
      viewMode,
      dsl: this._getDsl(data.dslType)
    });

    // 6. Render the shell
    this._buildShell();

    // 7. Mount components
    this._mountComponents();

    // 8. Global keyboard shortcuts
    this._bindGlobalKeys();

    // 9. PWA: register service worker
    if (!IS_QUINE && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(console.warn);
    }
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  _buildShell() {
    const root = document.getElementById('unifile-app');
    root.innerHTML = `
      <div id="uf-topbar"></div>
      <div id="uf-main">
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

    const previewFooterEl = document.createElement('div');
    previewFooterEl.id = 'uf-preview-footer';
    document.getElementById('uf-preview-wrap').appendChild(previewFooterEl);

    this._components.dslFooter = new DslFooter(previewFooterEl);

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
      { renderPreview: handlers.renderPreview }
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

        // Auto-save quine
        await this._saveQuine(newData);
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
      }
    };
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
  // Misc
  // ---------------------------------------------------------------------------

  _getDsl(dslType) {
    try { return getDSL(dslType); }
    catch { return null; }
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

const _mql = window.matchMedia('(max-width: 640px)');
/** Returns true when the viewport is in phone/narrow mode (<= 640px). */
const _isMobile = () => _mql.matches;

// ---------------------------------------------------------------------------
// Divider icon helpers
// ---------------------------------------------------------------------------

/** Single right-pointing chevron — used for divider-to-split in PREVIEW mode.
 *  CSS flips it (scaleX(-1)) when data-mode="editor". */
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

