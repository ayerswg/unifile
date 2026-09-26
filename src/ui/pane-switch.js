/**
 * Phone top bar — `( ⑂ )   {♪} Title ⌄   ( ◉ )`
 *
 * Three controls, and that's the whole top chrome on phones (portrait AND
 * landscape; the old landscape dock is gone):
 *
 *   • LEFT circle  — the branch icon.  Tap → the commit/history pane; it is
 *                    filled (accent) while that pane is showing; tap again →
 *                    back to the editor.  Carries the dirty dot.
 *   • CENTRE       — the app mark in braces + the document title + a caret.
 *                    Tap → ONE dropdown with every menu option (branches,
 *                    document, file, export, more).  While the history pane
 *                    is up the label is the branch name instead.
 *   • RIGHT circle — the eye.  Tap → the rendered DSL; filled while showing;
 *                    tap again → back to the editor.
 *
 * The bar hides while typing (app.js sets `data-editing` on the shell) so the
 * keyboard-shortened viewport goes to the text.  Editing verbs (play, undo,
 * align…) live on the floating action button (action-fab.js); this menu is
 * the list of menu options, built from the same registry (actions.js).
 *
 * Desktop keeps the classic top bar; this component is display:none there.
 * In diff mode the centre becomes the L ↔ R commit picker.
 */

import { state } from './state.js';
import { shortHash } from '../core/hash.js';
import { appMark } from '../core/brand.js';
import {
  listActions, GROUP_LABELS, switchBranch, esc,
} from './actions.js';

const PANES = ['commit', 'editor', 'render'];
const WORKING = 'WORKING';
const MENU_GROUPS = ['branch', 'document', 'file', 'export', 'more'];

export class PaneSwitch {
  /** @param {HTMLElement} el  @param {object} ctx  { handlers, editor, openTopMenu } */
  constructor(el, ctx = {}) {
    this.el = el;
    this.ctx = ctx;
    this._active = 'editor';
    this._openMenu = null;         // 'main' | 'left' | 'right' | null

    for (const ev of ['change', 'content-change', 'branch-switch', 'checkout', 'active-section-change']) {
      state.on(ev, () => this.render());
    }
    state.on('diff-change', () => { this._openMenu = null; this.render(); });

    // Outside tap closes any open menu.
    document.addEventListener('click', (e) => {
      if (this._openMenu && !this.el.contains(e.target)) this._closeMenu();
    });

    this.render();
  }

  /** Called by the app when the active pane changes (programmatic). */
  setActive(pane) {
    if (!PANES.includes(pane)) pane = 'editor';
    if (pane === this._active) return;
    this._active = pane;
    this._openMenu = null;
    this.render();
  }

  /** Open the centre dropdown (the action button's "Switch branch…" lands here). */
  openMenu() {
    if (state.diff) return;
    this._openMenu = 'main';
    this.render();
    this.el.querySelector('.ps-menu')?.scrollTo?.(0, 0);
  }

  _closeMenu() { if (this._openMenu) { this._openMenu = null; this.render(); } }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render() {
    if (state.diff) { this._renderDiff(); return; }

    const dirty = state.isDirty;
    const detached = state.isDetached;
    const branch = detached ? '⚠ detached' : state.currentBranch;
    const dslType = state.data?.dslType ?? 'markdown';
    const commitActive = this._active === 'commit';
    const renderActive = this._active === 'render';
    const label = commitActive ? branch : state.title;
    const menuOpen = this._openMenu === 'main';

    this.el.innerHTML = `
      <button type="button" class="ps-circle ps-branch${commitActive ? ' active' : ''}" data-pane="commit"
        aria-label="${commitActive ? 'Back to the editor' : 'History and branches'}" aria-pressed="${commitActive}">
        ${_iconBranch()}
        ${dirty || detached ? `<span class="ps-dirty-dot${detached ? ' detached' : ''}" aria-hidden="true"></span>` : ''}
      </button>
      <button type="button" class="ps-title-btn${menuOpen ? ' open' : ''}" aria-haspopup="menu" aria-expanded="${menuOpen}">
        <span class="ps-mark" aria-hidden="true">${esc(appMark(dslType))}</span>
        <span class="ps-title">${esc(label)}</span>
        <span class="ps-caret" aria-hidden="true">${_iconCaret()}</span>
      </button>
      <button type="button" class="ps-circle ps-eye${renderActive ? ' active' : ''}" data-pane="render"
        aria-label="${renderActive ? 'Back to the editor' : 'Show the rendered document'}" aria-pressed="${renderActive}">
        ${_iconEye()}
      </button>
      <div class="ps-menu${menuOpen ? ' open' : ''}" role="menu">
        ${menuOpen ? this._renderMainMenu() : ''}
      </div>`;

    this._bind();
  }

  _renderMainMenu() {
    const actions = listActions(this.ctx).filter(a => a.menu !== false);
    const byGroup = {};
    for (const a of actions) (byGroup[a.group] ||= []).push(a);

    const item = (a) => `
      <button class="ps-menu-item${a.disabled ? ' disabled' : ''}" data-act="${esc(a.id)}" role="menuitem">
        <span class="ps-menu-ic">${esc(a.glyph)}</span>
        <span class="ps-menu-name">${esc(a.label)}</span>
      </button>`;

    let html = '';
    for (const g of MENU_GROUPS) {
      const rows = byGroup[g] || [];
      if (!rows.length && g !== 'branch') continue;
      html += `<div class="ps-menu-label">${esc(GROUP_LABELS[g])}</div>`;
      if (g === 'branch') html += this._renderBranchRows();
      html += rows.map(item).join('');
    }
    return html;
  }

  _renderBranchRows() {
    const vcs = state.vcs;
    const branches = vcs?.listBranches?.() ?? [];
    const detached = state.isDetached;
    return branches.map(b => `
      <button class="ps-menu-item${b.isCurrent && !detached ? ' current' : ''}" data-act="branch" data-branch="${esc(b.name)}" role="menuitem">
        <span class="ps-menu-ic">${b.isCurrent && !detached ? '●' : '○'}</span>
        <span class="ps-menu-name">${esc(b.name)}</span>
        <span class="ps-menu-hash">${b.head ? esc(shortHash(b.head)) : ''}</span>
      </button>`).join('');
  }

  // ---------------------------------------------------------------------------
  // Diff mode — circles unchanged (history pane / right diff pane); the centre
  // shows `L ↔ R` and its dropdown carries both side pickers.
  // ---------------------------------------------------------------------------

  _renderDiff() {
    const diff = state.diff;
    const leftLabel  = diff.left  === WORKING ? 'Current' : shortHash(diff.left);
    const rightLabel = diff.right === WORKING ? 'Current' : shortHash(diff.right);
    const commitActive = this._active === 'commit';
    const renderActive = this._active === 'render';
    const menuOpen = this._openMenu === 'main';

    this.el.innerHTML = `
      <button type="button" class="ps-circle ps-branch${commitActive ? ' active' : ''}" data-pane="commit"
        aria-label="History" aria-pressed="${commitActive}">${_iconBranch()}</button>
      <button type="button" class="ps-title-btn ps-diff${menuOpen ? ' open' : ''}" aria-haspopup="menu" aria-expanded="${menuOpen}">
        <span class="ps-title ps-diff-title"><span class="ps-diff-role">L</span> ${esc(leftLabel)} <span class="ps-diff-arrow">↔</span> <span class="ps-diff-role">R</span> ${esc(rightLabel)}</span>
        <span class="ps-caret" aria-hidden="true">${_iconCaret()}</span>
      </button>
      <button type="button" class="ps-circle ps-eye${renderActive ? ' active' : ''}" data-pane="render"
        aria-label="Right side" aria-pressed="${renderActive}">${_iconEye()}</button>
      <div class="ps-menu${menuOpen ? ' open' : ''}" role="menu">
        ${menuOpen ? `<div class="ps-menu-label">Left side</div>${this._renderSidePicker('left')}
                      <div class="ps-menu-label">Right side</div>${this._renderSidePicker('right')}` : ''}
      </div>`;

    this._bind();
  }

  /** A commit picker for one diff side: "Current" (left only) + all commits, all branches. */
  _renderSidePicker(side) {
    const vcs = state.vcs;
    const cur = side === 'left' ? state.diff.left : state.diff.right;
    const branches = vcs?.listBranches?.() ?? [];

    const item = (hash, name) => `
      <button class="ps-menu-item${hash === cur ? ' current' : ''}" data-act="pick" data-side="${side}" data-hash="${esc(hash)}" role="menuitem">
        <span class="ps-menu-ic">${hash === cur ? '●' : '○'}</span>
        <span class="ps-menu-name">${esc(name)}</span>
        <span class="ps-menu-hash">${hash === WORKING ? '' : esc(shortHash(hash))}</span>
      </button>`;

    let html = '';
    if (side === 'left') html += item(WORKING, 'Current');
    for (const b of branches) {
      const log = vcs.log(b.name);   // newest first
      if (!log.length) continue;
      html += `<div class="ps-menu-sublabel">${esc(b.name)}</div>`;
      html += log.map(c => item(c.hash, c.message || '(no message)')).join('');
    }
    return html || '<div class="ps-menu-empty">No commits.</div>';
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  _bind() {
    this.el.querySelectorAll('.ps-circle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pane = btn.dataset.pane;
        this._openMenu = null;
        // Tapping the active circle goes back to the editor.
        state.emit('mobile-goto-pane', pane === this._active ? 'editor' : pane);
      });
    });
    this.el.querySelector('.ps-title-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openMenu = this._openMenu === 'main' ? null : 'main';
      this.render();
    });
    this.el.querySelectorAll('.ps-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.classList.contains('disabled')) return;
        this._onMenuAction(item.dataset);
      });
    });
  }

  _onMenuAction(ds) {
    if (ds.act === 'pick') {
      if (ds.side === 'left') state.openDiff(ds.hash, state.diff.right);
      else state.openDiff(state.diff.left, ds.hash);
      this._closeMenu();
      return;
    }
    if (ds.act === 'branch') { switchBranch(ds.branch); this._closeMenu(); return; }
    const act = listActions(this.ctx).find(a => a.id === ds.act);
    this._closeMenu();
    if (act && !act.disabled) act.run();
  }
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function _iconBranch() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="6" r="1.7"/>
    <path d="M4 5.2v5.6M4 9.5C4 7 12 9 12 7.7"/></svg>`;
}

function _iconCaret() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4"/></svg>`;
}

function _iconEye() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
