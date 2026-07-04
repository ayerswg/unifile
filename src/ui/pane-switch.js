/**
 * Mobile pane switcher — the entire top chrome on phones.
 *
 * It replaces the mobile top bar, the hamburger menu and the commit-pane bottom
 * bar.  Each of the three segments does three jobs:
 *   1. **Switch pane** when it isn't the active one (tap → that pane).
 *   2. **Show context**:
 *        • commit  → dirty dot (far left) · branch icon · branch name
 *        • code    → the document title (ellipsised)
 *        • render  → the DSL render icon (music note / eye / diagram)
 *   3. **Become a menu** when it IS the active pane: tapping again opens a
 *      dropdown (a caret appears on the right to signal this).  The menus are:
 *        • commit  → branch picker (switch / new branch)
 *        • code    → document + tooling actions (the old hamburger menu)
 *        • render  → rendered exports (SVG / PDF / MIDI) + export as app
 *
 * Desktop keeps the classic top bar; this whole component is display:none there.
 */

import { state, PANELS } from './state.js';
import { shortHash } from '../core/hash.js';
import { getDSL, listDSLs } from '../dsl/registry.js';
import {
  loadUserPrefs, generateQuine, downloadFile, downloadBlob,
} from '../core/storage.js';
import {
  showNewDocumentModal, showDslHelpModal, showExtensionsModal,
} from './topbar.js';
import { showArchivedCommentsModal } from './comments.js';

const PANES = ['commit', 'editor', 'render'];

export class PaneSwitch {
  /** @param {HTMLElement} el  @param {object} handlers */
  constructor(el, handlers = {}) {
    this.el = el;
    this.handlers = handlers;
    this._active = 'editor';
    this._openMenu = null;         // 'commit' | 'code' | 'render' | null
    this._committing = false;

    state.on('change', () => this.render());
    state.on('content-change', () => this.render());
    state.on('branch-switch', () => this.render());
    state.on('checkout', () => this.render());
    state.on('active-section-change', () => this.render());

    // Outside tap closes any open menu.
    this._onDocClick = (e) => {
      if (this._openMenu && !this.el.contains(e.target)) this._closeMenu();
    };
    document.addEventListener('click', this._onDocClick);

    this.render();
  }

  /** Called by the app when the active pane changes (scroll / programmatic). */
  setActive(pane) {
    if (!PANES.includes(pane)) pane = 'editor';
    if (pane === this._active) return;
    this._active = pane;
    this._openMenu = null;         // switching panes dismisses any menu
    this.render();
  }

  _closeMenu() { if (this._openMenu) { this._openMenu = null; this.render(); } }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render() {
    const dirty = state.isDirty;
    const detached = state.isDetached;
    const branch = detached ? '⚠' : state.currentBranch;
    const dslId = state.activeDslId ?? state.data?.dslType ?? 'markdown';

    const seg = (pane, key, inner, label) => {
      const isActive = this._active === pane;
      return `
        <button type="button" class="ps-btn ps-${key}${isActive ? ' active' : ''}"
          data-pane="${pane}" role="tab" aria-selected="${isActive}" aria-label="${label}"
          ${isActive ? 'aria-haspopup="menu"' : ''}>
          ${inner}
          <span class="ps-caret" aria-hidden="true">${_iconCaret()}</span>
        </button>`;
    };

    this.el.innerHTML = `
      <span class="ps-thumb" aria-hidden="true"></span>
      ${seg('commit', 'commit', `
        <span class="ps-branch-icon" aria-hidden="true">${_iconBranch()}</span>
        <span class="ps-branch-name">${_esc(branch)}</span>
        ${dirty || detached ? `<span class="ps-dirty-dot${detached ? ' detached' : ''}" aria-hidden="true"></span>` : ''}
      `, 'Commit history')}
      ${seg('editor', 'code', `
        <span class="ps-title">${_esc(state.title)}</span>
      `, 'Editor')}
      ${seg('render', 'render', `
        <span class="ps-render-icon" aria-hidden="true">${_renderIconFor(dslId)}</span>
      `, 'Preview')}
      <div class="ps-menu ps-menu-${this._openMenu ?? 'none'}${this._openMenu ? ' open' : ''}" role="menu">
        ${this._openMenu ? this._renderMenu(this._openMenu) : ''}
      </div>
    `;

    this._bind();
  }

  _renderMenu(which) {
    if (which === 'commit') return this._renderCommitMenu();
    if (which === 'code')   return this._renderCodeMenu();
    if (which === 'render') return this._renderRenderMenu();
    return '';
  }

  _renderCommitMenu() {
    const vcs = state.vcs;
    const branches = vcs?.listBranches?.() ?? [];
    const detached = state.isDetached;
    return `
      <div class="ps-menu-label">Switch branch</div>
      ${branches.map(b => `
        <button class="ps-menu-item${b.isCurrent && !detached ? ' current' : ''}" data-act="branch" data-branch="${_esc(b.name)}" role="menuitem">
          <span class="ps-menu-ic">${b.isCurrent && !detached ? '●' : '○'}</span>
          <span class="ps-menu-name">${_esc(b.name)}</span>
          <span class="ps-menu-hash">${b.head ? _esc(shortHash(b.head)) : ''}</span>
        </button>`).join('')}
      <button class="ps-menu-item ps-menu-accent" data-act="new-branch" role="menuitem">
        <span class="ps-menu-ic">＋</span><span class="ps-menu-name">New branch…</span>
      </button>`;
  }

  _renderCodeMenu() {
    const dslId = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    const dslName = (() => { try { return getDSL(dslId)?.name ?? dslId; } catch { return dslId; } })();
    const hasCommits = (state.vcs?.log?.().length ?? 0) > 0;
    const hasExt = listDSLs().some(d => (d.extensionSlots?.length ?? 0) > 0);
    const item = (act, label, extra = '') =>
      `<button class="ps-menu-item${extra}" data-act="${act}" role="menuitem"><span class="ps-menu-name">${label}</span></button>`;
    return `
      ${item('new-doc', 'New document…')}
      ${item('dsl-help', `${_esc(dslName)} help…`)}
      ${item('blame', 'Blame view', hasCommits ? '' : ' disabled')}
      <div class="ps-menu-sep" role="separator"></div>
      ${item('save-data', 'Save data file…')}
      ${item('open-data', 'Open data file…')}
      ${item('merge', 'Import & merge…')}
      ${hasExt ? item('extensions', 'Extensions…') : ''}
      <div class="ps-menu-sep" role="separator"></div>
      ${item('archived', 'Archived comments…')}
      ${item('settings', 'Settings')}`;
  }

  _renderRenderMenu() {
    const dslId = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    let exporters = {};
    try { exporters = getDSL(dslId)?.exporters ?? {}; } catch {}
    const rows = Object.entries(exporters).map(([key, exp]) =>
      `<button class="ps-menu-item" data-act="export" data-key="${_esc(key)}" role="menuitem">
        <span class="ps-menu-name">${_esc(exp.label ?? key)}</span>
      </button>`).join('');
    return `
      <div class="ps-menu-label">Export</div>
      ${rows || '<div class="ps-menu-empty">No exports for this format.</div>'}
      <div class="ps-menu-sep" role="separator"></div>
      <button class="ps-menu-item" data-act="export-app" role="menuitem">
        <span class="ps-menu-name">Export as app (.html)…</span>
      </button>`;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  _bind() {
    this.el.querySelectorAll('.ps-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._onSegment(btn.dataset.pane);
      });
    });
    this.el.querySelectorAll('.ps-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.classList.contains('disabled')) return;
        this._onMenuAction(item.dataset);
      });
    });
  }

  _onSegment(pane) {
    // Menu key is 'code' for the editor pane, else the pane name.
    const menuKey = pane === 'editor' ? 'code' : pane;
    if (pane !== this._active) {
      this._openMenu = null;
      state.emit('mobile-goto-pane', pane);   // app → setPane → setActive()
    } else {
      this._openMenu = this._openMenu === menuKey ? null : menuKey;
      this.render();
    }
  }

  _onMenuAction(ds) {
    const act = ds.act;
    // Most actions dismiss the menu; branch switching re-renders anyway.
    const close = () => this._closeMenu();

    switch (act) {
      case 'branch':      this._switchBranch(ds.branch); break;
      case 'new-branch':  close(); this._newBranch(); break;

      case 'new-doc':     close(); showNewDocumentModal(this.handlers); break;
      case 'dsl-help':    close(); showDslHelpModal(state.activeDslId ?? state.data?.dslType ?? 'markdown'); break;
      case 'blame':       close(); state.activePanel === PANELS.BLAME ? state.closePanel() : state.openPanel(PANELS.BLAME); break;
      case 'save-data':   close(); state.emit('save-data-file'); break;
      case 'open-data':   close(); state.emit('open-data-file'); break;
      case 'merge':       close(); state.activePanel === PANELS.MERGE ? state.closePanel() : state.openPanel(PANELS.MERGE); break;
      case 'extensions':  close(); showExtensionsModal(); break;
      case 'archived':    close(); showArchivedCommentsModal(); break;
      case 'settings':    close(); state.activePanel === PANELS.SETTINGS ? state.closePanel() : state.openPanel(PANELS.SETTINGS); break;

      case 'export':      close(); this._exportFormat(ds.key); break;
      case 'export-app':  close(); this._exportApp(); break;
    }
  }

  // ── Branch actions (moved off the old commit-bar bottom bar) ───────────────

  _switchBranch(name) {
    if (!name || !state.vcs || (name === state.currentBranch && !state.isDetached)) { this._closeMenu(); return; }
    if (state.isDirty) state.stash = { content: state.currentContent, fromHash: state.headHash };
    const baseContent = state.vcs.switchBranch(name);
    const newHash = state.vcs.headHash;
    let content = baseContent;
    if (state.stash && state.stash.fromHash === newHash) { content = state.stash.content; state.stash = null; }
    state.update({ currentContent: content, isDirty: content !== baseContent });
    state.emit('branch-switch', { name, content });
    this._closeMenu();
  }

  _newBranch() {
    const name = (window.prompt('New branch name:') || '').trim();
    if (!name) return;
    if (!/^[A-Za-z0-9/_-]+$/.test(name)) { window.alert('Branch name may only contain letters, numbers, /, _ and -'); return; }
    try { state.vcs.createBranch(name, state.headHash); }
    catch (err) { window.alert(err?.message || 'Could not create branch.'); return; }
    state.update({ data: { ...state.data, ...state.vcs.serialize() } });
    this._switchBranch(name);
  }

  // ── Exports (render menu) ──────────────────────────────────────────────────

  async _exportFormat(key) {
    const dslId = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    let exp; try { exp = getDSL(dslId)?.exporters?.[key]; } catch {}
    if (!exp) return;
    try {
      const result = await exp.export(state.currentContent);
      if (result instanceof Blob) {
        const name = _slug(state.title) + (exp.ext ?? '');
        if (exp.binary) downloadBlob(result, name);
        else downloadFile(await result.text(), name, exp.mime);
      }
      // null → handled elsewhere (e.g. PDF via print dialog)
    } catch (err) {
      window.alert(`Export failed: ${err?.message ?? err}`);
    }
  }

  async _exportApp() {
    try {
      const preview = await this.handlers.renderPreview?.() ?? '';
      const data = { ...state.data, ...(state.vcs?.serialize?.() ?? {}) };
      const html = generateQuine(data, preview, state.title);
      downloadFile(html, _slug(state.title) + '.html', 'text/html');
    } catch (err) {
      window.alert(`Export failed: ${err?.message ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _slug(s) {
  return (String(s || 'untitled').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled');
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _iconBranch() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/>
    <path d="M4 5v6M4 9.5C4 7 12 9 12 7.5"/></svg>`;
}

function _iconCaret() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4"/></svg>`;
}

function _renderIconFor(dslId) {
  if (dslId === 'abcjs') return _iconMusicNote();
  if (dslId === 'mermaid') return _iconDiagram();
  return _iconEye();
}
function _iconMusicNote() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>`;
}
function _iconEye() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function _iconDiagram() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="8" y="3" width="8" height="5" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M12 8v4M12 12H6.5v4M12 12h5.5v4"/></svg>`;
}
