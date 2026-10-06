/**
 * The document library — the flat list behind the back arrow.
 *
 * One row per document of this app (core/library.js records): title, its
 * file name (`<name>-<version>.uni`, or "not saved yet"), a line of its text,
 * when it was last edited and how many versions it holds.  Tap a row to open
 * it; `+ New` starts a new document (and asks for its name — fixed for good);
 * "Open from device…" brings a `.uni` in; the row's ⋯ holds Rename (the
 * title, not the name) / Duplicate / Delete.
 *
 * THE SEARCH BAR at the top searches file names AND contents
 * (core/library.js `searchRecords`): while a query is typed the list shows
 * only the matching documents, each with its contextual hits — the line
 * around every match, the match highlighted — and tapping a hit opens the
 * document on that very text.
 *
 * On phones this is the `library` pane (`data-mobile-pane="library"`, the
 * left circle of the top bar); on desktop it is a COLLAPSIBLE SIDEBAR on the
 * left (`#unifile-app[data-library]`, toggled by the top bar's ‹ button or
 * Ctrl+Shift+L; it stays open while you work).  Quines have no library: the
 * element stays empty and the entry points hide themselves (`state.library`
 * is null).
 *
 * The skeleton (head, search, list, foot) is built once so the search field
 * keeps its focus and text; only the list re-renders — on every library
 * change and every keystroke in the search field.
 */

import { state } from './state.js';
import { VCS } from '../core/vcs.js';
import { appMark, appName } from '../core/brand.js';
import { isSavedToDevice, searchRecords } from '../core/library.js';
import { esc } from './actions.js';

export class LibraryPane {
  /**
   * @param {HTMLElement} el
   * @param {{ open, create, remove, duplicate, rename, openFromDevice, close }} handlers
   *   open(id, hit?) — hit = { from, to } (a search hit to land on)
   */
  constructor(el, handlers = {}) {
    this.el = el;
    this.h = handlers;
    this._menuFor = null;
    this._records = [];
    this._query = '';
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('input', (e) => {
      if (!e.target.classList.contains('lib-search-input')) return;
      this._query = e.target.value;
      this.el.querySelector('.lib-search')?.classList.toggle('has-query', !!this._query.trim());
      this._renderList();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target.classList.contains('lib-search-input') && e.target.value) {
        e.target.value = ''; this._query = ''; this._renderList(); e.stopPropagation();
      }
    });
    document.addEventListener('click', (e) => {
      if (this._menuFor && !e.target.closest('.lib-item-menu, .lib-more')) { this._menuFor = null; this._renderList(); }
    });
    state.on('document-change', () => this.refresh());
    state.on('device-change', () => this.refresh());
    state.on('saved', () => this.refresh());
    this.refresh();
  }

  /** Re-read the library and redraw the list.  Cheap; safe to call often. */
  async refresh() {
    if (!state.library) { this.el.innerHTML = ''; return; }
    const token = (this._token = (this._token || 0) + 1);
    let records = [];
    try { records = await state.library.list(); } catch { records = []; }
    if (token !== this._token) return;             // a newer refresh landed
    this._records = records;
    this._render();
  }

  /** Focus the search field (Ctrl+Shift+L on desktop lands here). */
  focusSearch() {
    this.el.querySelector('.lib-search-input')?.focus();
  }

  _render() {
    if (!this.el.querySelector('.lib')) {
      const app = state.library?.app ?? state.data?.dslType ?? 'markdown';
      this.el.innerHTML = `
        <div class="lib">
          <div class="lib-head">
            <span class="lib-title"><span class="lib-mark">${esc(appMark(app))}</span> Documents</span>
            <button type="button" class="lib-new" data-act="create" title="New document (you name it; the name is fixed)">+ New</button>
            <button type="button" class="lib-back" data-act="close" aria-label="Hide the documents" title="Hide the documents (Ctrl+Shift+L)">${_iconBack()}</button>
          </div>
          <div class="lib-search">
            <span class="lib-search-icon" aria-hidden="true">${_iconSearch()}</span>
            <input type="search" class="lib-search-input" placeholder="Search names and text…"
              autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search documents">
            <button type="button" class="lib-search-clear" data-act="clear" aria-label="Clear search">×</button>
          </div>
          <ul class="lib-list" role="list"></ul>
          <div class="lib-foot">
            <button type="button" class="lib-link" data-act="open-device">Open from device…</button>
            <p class="lib-note">Documents live in ${esc(appName(app))} on this device, exactly as you leave them.
              <b>Save</b> writes the text to the device as <code>name-A00.uni</code>, <code>name-A01.uni</code>… — one file per version.</p>
          </div>
        </div>`;
    }
    this._renderList();
  }

  _renderList() {
    const list = this.el.querySelector('.lib-list');
    if (!list) return;
    const q = this._query.trim();
    const results = searchRecords(this._records, q);
    const rows = results.map(r => this._row(r.record, r)).join('');
    list.innerHTML = rows || `<li class="lib-empty">${q ? `Nothing matches “${esc(q)}”.` : 'No documents yet.'}</li>`;
    list.classList.toggle('searching', !!q);
  }

  _row(r, { hits = [], nameMatch = false } = {}) {
    const current = r.id === state.docId;
    let versions = 0, unsaved = false;
    try {
      const vcs = new VCS(r.data);
      versions = vcs.log().length;
      unsaved = (r.data.currentContent ?? '') !== vcs.headContent || !isSavedToDevice(r);
    } catch { /* a damaged record still lists */ }
    const file = r.fileName
      ? `<span class="lib-file${isSavedToDevice(r) ? ' saved' : ' stale'}" title="${isSavedToDevice(r) ? 'The device holds this version' : 'Changed since this version was saved'}">${esc(r.fileName)}</span>`
      : `<span class="lib-file none">${r.apiName ? esc(r.apiName) + ' · ' : ''}not saved yet</span>`;
    const menu = this._menuFor === r.id ? `
      <div class="lib-item-menu" role="menu">
        <button type="button" data-act="rename" data-id="${esc(r.id)}" role="menuitem">Rename title…</button>
        <button type="button" data-act="duplicate" data-id="${esc(r.id)}" role="menuitem">Duplicate</button>
        <button type="button" data-act="remove" data-id="${esc(r.id)}" role="menuitem" class="danger">Delete…</button>
      </div>` : '';
    const hitRows = hits.map(h => `
      <li class="lib-hit" data-act="open" data-id="${esc(r.id)}" data-from="${h.from}" data-to="${h.to}" role="button" tabindex="0">
        <span class="lib-hit-line">${h.line}</span>
        <span class="lib-hit-text">${_markSnippet(h)}</span>
      </li>`).join('');
    return `
      <li class="lib-item${current ? ' current' : ''}${nameMatch ? ' name-match' : ''}" data-id="${esc(r.id)}" role="listitem">
        <button type="button" class="lib-open" data-act="open" data-id="${esc(r.id)}">
          <span class="lib-item-title">${esc(r.title || 'Untitled')}${unsaved ? '<span class="lib-dot" title="Not saved to the device"></span>' : ''}</span>
          ${file}
          ${hits.length ? '' : `<span class="lib-item-excerpt">${esc(r.excerpt || '')}</span>`}
          <span class="lib-item-meta">
            <span>${esc(_ago(r.updatedAt))}</span>
            <span>·</span>
            <span>${versions} ${versions === 1 ? 'version' : 'versions'}</span>
          </span>
        </button>
        <button type="button" class="lib-more" data-act="menu" data-id="${esc(r.id)}" aria-label="More" aria-haspopup="menu" aria-expanded="${this._menuFor === r.id}">⋯</button>
        ${menu}
        ${hitRows ? `<ul class="lib-hits" role="list">${hitRows}</ul>` : ''}
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
      case 'clear': {
        const input = this.el.querySelector('.lib-search-input');
        if (input) { input.value = ''; input.focus(); }
        this._query = ''; this.el.querySelector('.lib-search')?.classList.remove('has-query'); this._renderList();
        break;
      }
      case 'open': {
        const hit = btn.dataset.from != null ? { from: +btn.dataset.from, to: +btn.dataset.to } : null;
        this.h.open?.(id, hit);
        break;
      }
      case 'menu':
        this._menuFor = this._menuFor === id ? null : id;
        this._renderList();
        break;
      case 'rename': {
        this._menuFor = null;
        const rec = await state.library?.get(id);
        const next = (window.prompt('Document title (the file name stays as it is):', rec?.title ?? '') ?? '').trim();
        if (next && next !== rec?.title) this.h.rename?.(id, next); else this._renderList();
        break;
      }
      case 'duplicate':   this._menuFor = null; this.h.duplicate?.(id); break;
      case 'remove':      this._menuFor = null; this.h.remove?.(id); this._renderList(); break;
    }
  }
}

/** A hit's snippet with the match wrapped in <mark>. */
function _markSnippet(h) {
  const s = h.snippet;
  return esc(s.slice(0, h.matchStart)) + '<mark>' + esc(s.slice(h.matchStart, h.matchEnd)) + '</mark>' + esc(s.slice(h.matchEnd));
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

function _iconSearch() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`;
}
