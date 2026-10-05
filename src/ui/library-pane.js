/**
 * The document library — the list behind the back arrow.
 *
 * One row per document of this app (core/library.js records): title, a line
 * of its text, when it was last edited, how many saves it holds and whether
 * the device holds its current state.  Tap a row to open it; `+` starts a new
 * document; "Open from device…" imports a `.unifile.json`; the row's ⋯ holds
 * Rename / Duplicate / Delete.
 *
 * On phones this is the `library` pane (`data-mobile-pane="library"`, the
 * left circle of the top bar); on desktop it is a left drawer
 * (`#unifile-app[data-library]`).  Quines have no library: the element stays
 * empty and the entry points hide themselves (`state.library` is null).
 *
 * Rendering is a full re-render per refresh — the list is small and never
 * re-rendered under a finger (the pane is not visible while typing).
 */

import { state } from './state.js';
import { VCS } from '../core/vcs.js';
import { appMark, appName } from '../core/brand.js';
import { isSavedToDevice } from '../core/library.js';
import { esc } from './actions.js';

export class LibraryPane {
  /**
   * @param {HTMLElement} el
   * @param {{ open, create, remove, duplicate, rename, openFromDevice, close }} handlers
   */
  constructor(el, handlers = {}) {
    this.el = el;
    this.h = handlers;
    this._menuFor = null;
    this.el.addEventListener('click', (e) => this._onClick(e));
    document.addEventListener('click', (e) => {
      if (this._menuFor && !e.target.closest('.lib-item-menu, .lib-more')) { this._menuFor = null; this.refresh(); }
      // Desktop drawer: a click anywhere outside it (and off its toggle) closes it.
      const root = document.getElementById('unifile-app');
      if (root?.hasAttribute('data-library') && !this.el.contains(e.target) && !e.target.closest('#tb-library, #tb-library-item')) {
        this.h.close?.();
      }
    });
    state.on('document-change', () => this.refresh());
    state.on('device-change', () => this.refresh());
    this.refresh();
  }

  /** Re-read the library and redraw.  Cheap; safe to call often. */
  async refresh() {
    if (!state.library) { this.el.innerHTML = ''; return; }
    const token = (this._token = (this._token || 0) + 1);
    let records = [];
    try { records = await state.library.list(); } catch { records = []; }
    if (token !== this._token) return;             // a newer refresh landed
    this._render(records);
  }

  _render(records) {
    const app = state.library?.app ?? state.data?.dslType ?? 'markdown';
    const rows = records.map(r => this._row(r)).join('');
    this.el.innerHTML = `
      <div class="lib">
        <div class="lib-head">
          <button type="button" class="lib-back" data-act="close" aria-label="Back to the document" title="Back to the document">${_iconBack()}</button>
          <span class="lib-title"><span class="lib-mark">${esc(appMark(app))}</span> Documents</span>
          <button type="button" class="lib-new" data-act="create" title="New document">+ New</button>
        </div>
        <ul class="lib-list" role="list">${rows || '<li class="lib-empty">No documents yet.</li>'}</ul>
        <div class="lib-foot">
          <button type="button" class="lib-link" data-act="open-device">Open from device…</button>
          <p class="lib-note">Documents live in ${esc(appName(app))} on this device, exactly as you leave them.
            <b>Save to device</b> writes a <code>.unifile.json</code> you keep — text and full history, nothing online.</p>
        </div>
      </div>`;
  }

  _row(r) {
    const current = r.id === state.docId;
    let saves = 0, unsaved = false;
    try {
      const vcs = new VCS(r.data);
      saves = vcs.log().length;
      unsaved = (r.data.currentContent ?? '') !== vcs.headContent;
    } catch { /* a damaged record still lists */ }
    const onDevice = isSavedToDevice(r);
    const device = onDevice
      ? `<span class="lib-device saved" title="The file on your device holds this state">${_iconCheck()} ${esc(r.fileName || 'on device')}</span>`
      : r.fileName
        ? `<span class="lib-device stale" title="Changed since it was last saved to the device">${esc(r.fileName)} · changed</span>`
        : `<span class="lib-device none">not on device</span>`;
    const menu = this._menuFor === r.id ? `
      <div class="lib-item-menu" role="menu">
        <button type="button" data-act="rename" data-id="${esc(r.id)}" role="menuitem">Rename…</button>
        <button type="button" data-act="duplicate" data-id="${esc(r.id)}" role="menuitem">Duplicate</button>
        <button type="button" data-act="remove" data-id="${esc(r.id)}" role="menuitem" class="danger">Delete…</button>
      </div>` : '';
    return `
      <li class="lib-item${current ? ' current' : ''}" data-id="${esc(r.id)}" role="listitem">
        <button type="button" class="lib-open" data-act="open" data-id="${esc(r.id)}">
          <span class="lib-item-title">${esc(r.title || 'Untitled')}${unsaved ? '<span class="lib-dot" title="Unsaved changes"></span>' : ''}</span>
          <span class="lib-item-excerpt">${esc(r.excerpt || '')}</span>
          <span class="lib-item-meta">
            <span>${esc(_ago(r.updatedAt))}</span>
            <span>·</span>
            <span>${saves} ${saves === 1 ? 'save' : 'saves'}</span>
            <span>·</span>
            ${device}
          </span>
        </button>
        <button type="button" class="lib-more" data-act="menu" data-id="${esc(r.id)}" aria-label="More" aria-haspopup="menu" aria-expanded="${this._menuFor === r.id}">⋯</button>
        ${menu}
      </li>`;
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !this.el.contains(btn)) return;
    const { act, id } = btn.dataset;
    e.preventDefault();
    e.stopPropagation();
    switch (act) {
      case 'close':       this.h.close?.(); break;
      case 'create':      this.h.create?.(); break;
      case 'open-device': this.h.openFromDevice?.(); break;
      case 'open':        this.h.open?.(id); break;
      case 'menu':
        this._menuFor = this._menuFor === id ? null : id;
        this.refresh();
        break;
      case 'rename': {
        this._menuFor = null;
        const rec = await state.library?.get(id);
        const next = (window.prompt('Document title:', rec?.title ?? '') ?? '').trim();
        if (next && next !== rec?.title) this.h.rename?.(id, next); else this.refresh();
        break;
      }
      case 'duplicate':   this._menuFor = null; this.h.duplicate?.(id); break;
      case 'remove':      this._menuFor = null; this.h.remove?.(id); this.refresh(); break;
    }
  }
}

/** "just now" · "5 min ago" · "3 h ago" · "yesterday" · "Mar 4". */
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

function _iconBack() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 3L5 8l5 5"/></svg>`;
}

function _iconCheck() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 8.5l3 3 7-7"/></svg>`;
}
