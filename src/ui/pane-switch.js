/**
 * Phone top bar — `( ‹ )   {♪} Title ● ⌄   ( ◉ )`
 *
 * Three controls, and that's the whole top chrome on phones (portrait AND
 * landscape; the old landscape dock is gone):
 *
 *   • LEFT circle  — the back arrow (iA Writer's).  Tap → the document
 *                    LIBRARY pane (the list of this app's documents); filled
 *                    (accent) while that pane is showing; tap again → back to
 *                    the editor.  A quine has no library: its left circle is a
 *                    clock and opens the history pane instead.
 *   • CENTRE       — the app mark in braces + the document title (+ the dirty
 *                    dot while there are unsaved changes) + a caret.  Tap →
 *                    the ONE dropdown with the file-level options: Document,
 *                    File (Save, History, Save to device, Open from device,
 *                    Documents), Export, More (settings).  Same menu in every
 *                    view.
 *   • RIGHT circle — the eye.  Tap → the rendered DSL; filled while showing;
 *                    tap again → back to the editor.
 *
 * The bar blends into the page (same background as the panes, iA-style) and
 * hides while typing (app.js sets `data-editing` on the shell).  Editing verbs
 * (play, undo, align…) and Save live on the floating action button
 * (action-fab.js); this menu is file level only (actions.js listMenuActions).
 *
 * The DOM is built ONCE per mode and PATCHED on state changes — rebuilding the
 * buttons under a finger mid-tap (state changes land between touchstart and
 * click on iOS) is how taps end up on whatever sits underneath.  The bar is
 * also user-select:none so a held tap can't start an iOS text selection.
 *
 * Desktop keeps the classic top bar; this component is display:none there.
 * In diff mode the centre becomes the L ↔ R commit picker.
 */

import { state } from './state.js';
import { shortHash } from '../core/hash.js';
import { appMark } from '../core/brand.js';
import { listMenuActions, GROUP_LABELS, MENU_GROUPS, esc } from './actions.js';

const PANES = ['library', 'history', 'editor', 'render'];
const WORKING = 'WORKING';

export class PaneSwitch {
  /** @param {HTMLElement} el  @param {object} ctx  { handlers, editor } */
  constructor(el, ctx = {}) {
    this.el = el;
    this.ctx = ctx;
    this._active = 'editor';
    this._menuOpen = false;
    this._mode = null;             // 'normal' | 'diff' — which skeleton is built

    for (const ev of ['change', 'content-change', 'checkout', 'active-section-change']) {
      state.on(ev, () => this.render());
    }
    state.on('diff-change', () => { this._menuOpen = false; this.render(); });

    // Outside tap closes the menu.
    document.addEventListener('click', (e) => {
      if (this._menuOpen && !this.el.contains(e.target)) this._setMenu(false);
    });

    this.render();
  }

  /** Called by the app when the active pane changes (programmatic). */
  setActive(pane) {
    if (!PANES.includes(pane)) pane = 'editor';
    if (pane === this._active) return;
    this._active = pane;
    this._menuOpen = false;
    this.render();
  }

  /** Open the centre dropdown programmatically. */
  openMenu() { this._setMenu(true); }

  _setMenu(open) {
    if (this._menuOpen === open) return;
    this._menuOpen = open;
    this.render();
    if (open) this.el.querySelector('.ps-menu')?.scrollTo?.(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Skeleton (built once per mode) + patch
  // ---------------------------------------------------------------------------

  _build(mode) {
    this._mode = mode;
    // The left circle: the library's back arrow, or (quine — no library) the
    // history clock.  Decided once per build: state.library is set before the
    // shell mounts and never changes.
    const leftPane = state.library ? 'library' : 'history';
    this.el.innerHTML = `
      <button type="button" class="ps-circle ps-left ps-${leftPane}" data-pane="${leftPane}">
        ${state.library ? _iconBack() : _iconClock()}
      </button>
      <button type="button" class="ps-title-btn" aria-haspopup="menu" aria-expanded="false">
        <span class="ps-mark" aria-hidden="true"></span>
        <span class="ps-title"></span>
        <span class="ps-dirty-dot" aria-hidden="true" hidden></span>
        <span class="ps-caret" aria-hidden="true">${_iconCaret()}</span>
      </button>
      <button type="button" class="ps-circle ps-eye" data-pane="render">${_iconEye()}</button>
      <div class="ps-menu" role="menu"></div>`;

    this._n = {
      left:   this.el.querySelector('.ps-left'),
      dot:    this.el.querySelector('.ps-dirty-dot'),
      titleBtn: this.el.querySelector('.ps-title-btn'),
      mark:   this.el.querySelector('.ps-mark'),
      title:  this.el.querySelector('.ps-title'),
      eye:    this.el.querySelector('.ps-eye'),
      menu:   this.el.querySelector('.ps-menu'),
    };

    this.el.querySelectorAll('.ps-circle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pane = btn.dataset.pane;
        this._menuOpen = false;
        // Tapping the active circle goes back to the editor.
        state.emit('mobile-goto-pane', pane === this._active ? 'editor' : pane);
      });
    });
    this._n.titleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._setMenu(!this._menuOpen);
    });
    // One delegated listener for the menu — its rows are re-rendered per open.
    this._n.menu.addEventListener('click', (e) => {
      const item = e.target.closest('.ps-menu-item');
      if (!item) return;
      e.stopPropagation();
      if (item.classList.contains('disabled')) return;
      this._onMenuAction(item.dataset);
    });
  }

  render() {
    const mode = state.diff ? 'diff' : 'normal';
    if (mode !== this._mode) this._build(mode);
    const n = this._n;

    const leftPane = n.left.dataset.pane;
    const leftActive = this._active === leftPane;
    const renderActive = this._active === 'render';
    n.left.classList.toggle('active', leftActive);
    n.left.setAttribute('aria-pressed', String(leftActive));
    n.left.setAttribute('aria-label', leftActive ? 'Back to the document' : (leftPane === 'library' ? 'Documents' : 'History'));
    n.eye.classList.toggle('active', renderActive);
    n.eye.setAttribute('aria-pressed', String(renderActive));
    n.eye.setAttribute('aria-label', renderActive ? 'Back to the editor' : 'Show the rendered document');

    n.dot.hidden = !state.isDirty;

    if (mode === 'diff') {
      const d = state.diff;
      const L = d.left === WORKING ? 'Current' : shortHash(d.left);
      const R = d.right === WORKING ? 'Current' : shortHash(d.right);
      n.mark.textContent = '';
      n.mark.hidden = true;
      n.title.className = 'ps-title ps-diff-title';
      n.title.innerHTML = `<span class="ps-diff-role">L</span> ${esc(L)} <span class="ps-diff-arrow">↔</span> <span class="ps-diff-role">R</span> ${esc(R)}`;
    } else {
      n.mark.hidden = false;
      n.mark.textContent = appMark(state.data?.dslType ?? 'markdown');
      n.title.className = 'ps-title';
      n.title.textContent = state.title;
    }

    n.titleBtn.classList.toggle('open', this._menuOpen);
    n.titleBtn.setAttribute('aria-expanded', String(this._menuOpen));
    n.menu.classList.toggle('open', this._menuOpen);
    n.menu.innerHTML = this._menuOpen
      ? (mode === 'diff' ? this._renderDiffMenu() : this._renderMainMenu())
      : '';
  }

  // ---------------------------------------------------------------------------
  // Menu contents
  // ---------------------------------------------------------------------------

  _renderMainMenu() {
    const actions = listMenuActions(this.ctx);
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
      if (!rows.length) continue;
      html += `<div class="ps-menu-label">${esc(GROUP_LABELS[g])}</div>` + rows.map(item).join('');
    }
    return html;
  }

  _renderDiffMenu() {
    return `<div class="ps-menu-label">Left side</div>${this._renderSidePicker('left')}
            <div class="ps-menu-label">Right side</div>${this._renderSidePicker('right')}`;
  }

  /** A picker for one diff side: "Current" (left only) + every save. */
  _renderSidePicker(side) {
    const vcs = state.vcs;
    const cur = side === 'left' ? state.diff.left : state.diff.right;
    const item = (hash, name) => `
      <button class="ps-menu-item${hash === cur ? ' current' : ''}" data-act="pick" data-side="${side}" data-hash="${esc(hash)}" role="menuitem">
        <span class="ps-menu-ic">${hash === cur ? '●' : '○'}</span>
        <span class="ps-menu-name">${esc(name)}</span>
        <span class="ps-menu-hash">${hash === WORKING ? '' : esc(shortHash(hash))}</span>
      </button>`;
    let html = '';
    if (side === 'left') html += item(WORKING, 'Current');
    const log = vcs?.log?.() ?? [];   // newest first
    html += log.map(c => item(c.hash, c.message || '(no message)')).join('');
    return html || '<div class="ps-menu-empty">No saves.</div>';
  }

  _onMenuAction(ds) {
    if (ds.act === 'pick') {
      if (ds.side === 'left') state.openDiff(ds.hash, state.diff.right);
      else state.openDiff(state.diff.left, ds.hash);
      this._setMenu(false);
      return;
    }
    const act = listMenuActions(this.ctx).find(a => a.id === ds.act);
    this._setMenu(false);
    if (act && !act.disabled) act.run();
  }
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function _iconBack() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 3L5 8l5 5"/></svg>`;
}

function _iconClock() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>`;
}

function _iconCaret() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4"/></svg>`;
}

function _iconEye() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
