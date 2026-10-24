/**
 * {notes} — QUICK FIND, the Ctrl+K palette (Notion's search, in the app's
 * chrome).  One input over the whole workspace; results grouped by page: the
 * title with its matched letters marked, then the contextual hits — the line
 * around each match, every term highlighted, the heading it sits under.
 * ↑ ↓ move, ↵ opens (a hit lands the editor on that text; the terms stay
 * highlighted in the editor AND the page until Esc), Esc closes.  An empty
 * query lists the recent pages; a query no title equals offers "Create page".
 *
 * Two modes: `open` (navigate) and `link` (insert `[[Title]]` at the caret —
 * the ⋯ menu's "Link to page…").  The search itself is core/notes/search.js
 * (pure); this file is the DOM.
 */

import { searchIndex, parseQuery, markText } from '../core/notes/search.js';
import { normKey } from '../core/notes/parse.js';
import { esc } from '../core/notes/render.js';
import { formatShortcut } from '../core/keys.js';

export class NotesSearch {
  /**
   * @param {object} h
   * @param {() => Promise<import('../core/notes/index.js').Index>} h.getIndex
   * @param {(id: string, hit: {from:number,to:number}|null, terms: string[]) => void} h.onOpen
   * @param {(title: string) => void} h.onCreate
   * @param {(title: string) => void} h.onInsertLink
   * @param {() => string|null} [h.currentId]
   */
  constructor(h) {
    this.h = h;
    this.el = null;
    this.mode = 'open';
    this._results = [];
    this._rows = [];
    this._active = 0;
    this._token = 0;
  }

  get isOpen() { return !!this.el; }

  /** Open the palette (focuses the input). */
  async open({ mode = 'open', query = '' } = {}) {
    this.mode = mode;
    if (!this.el) this._build();
    this.el.classList.toggle('is-link-mode', mode === 'link');
    this.el.querySelector('.nbs-mode').textContent = mode === 'link' ? 'Link to a page' : 'Search the workspace';
    const input = this.el.querySelector('.nbs-input');
    input.value = query;
    input.placeholder = mode === 'link' ? 'Page title…' : 'Search pages, text, #tags…';
    requestAnimationFrame(() => { input.focus(); input.select(); });
    await this._search(query);
  }

  close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    document.removeEventListener('keydown', this._onDocKey, true);
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'nbs-scrim';
    el.innerHTML = `
      <div class="nbs" role="dialog" aria-modal="true" aria-label="Search">
        <div class="nbs-head">
          <span class="nbs-icon" aria-hidden="true">⌕</span>
          <input type="text" class="nbs-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search">
          <span class="nbs-mode"></span>
          <button type="button" class="nbs-close" aria-label="Close">×</button>
        </div>
        <div class="nbs-list" role="listbox"></div>
        <div class="nbs-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> <span class="nbs-foot-verb">open</span> · <kbd>esc</kbd> close
          · <span class="nbs-foot-tip"><code>#tag</code> · <code>"a phrase"</code> · <code>title:word</code></span></div>
      </div>`;
    (document.getElementById('unifile-app') ?? document.body).appendChild(el);
    this.el = el;
    const input = el.querySelector('.nbs-input');
    let timer = null;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this._search(input.value), 60); });
    input.addEventListener('keydown', (e) => this._onKey(e));
    el.addEventListener('mousedown', (e) => { if (e.target === el) { e.preventDefault(); this.close(); } });
    el.querySelector('.nbs-close').addEventListener('click', () => this.close());
    const list = el.querySelector('.nbs-list');
    list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('[data-row]');
      if (row && +row.dataset.row !== this._active) { this._active = +row.dataset.row; this._paintActive(false); }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault());   // keep the input focused
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-row]');
      if (!row) return;
      this._active = +row.dataset.row;
      this._choose();
    });
    this._onDocKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } };
    document.addEventListener('keydown', this._onDocKey, true);
  }

  _onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); this._choose(); }
    else if (e.key === 'Tab') { e.preventDefault(); this._move(e.shiftKey ? -1 : 1); }
  }

  _move(d) {
    if (!this._rows.length) return;
    this._active = (this._active + d + this._rows.length) % this._rows.length;
    this._paintActive(true);
  }

  async _search(query) {
    const token = ++this._token;
    let index;
    try { index = await this.h.getIndex(); } catch { index = null; }
    if (token !== this._token || !this.el) return;
    const q = String(query ?? '');
    const results = index ? searchIndex(index, q, { limit: 40, maxHits: 4 }) : [];
    const terms = parseQuery(q).all;
    this._results = results;
    this._rows = [];
    const list = this.el.querySelector('.nbs-list');
    const current = this.h.currentId?.() ?? null;
    let html = '';
    const trimmed = q.trim();
    const exact = trimmed && index ? index.resolve(trimmed) : null;
    const showCreate = trimmed && !exact && !/^#/.test(trimmed) && this.mode === 'open';
    if (!trimmed) html += `<div class="nbs-group">Recent</div>`;
    for (const r of results) {
      const rowIdx = this._rows.length;
      this._rows.push({ kind: 'page', id: r.page.id, title: r.page.title });
      const title = markText(r.page.title, r.titleMarks, esc);
      const sub = r.page.apiName ? `<span class="nbs-sub">${esc(r.page.apiName)}</span>` : '';
      html += `<div class="nbs-item${r.page.id === current ? ' is-current' : ''}" role="option" data-row="${rowIdx}" data-id="${esc(r.page.id)}">`
        + `<span class="nbs-item-mark">⊛</span><span class="nbs-item-title">${title}</span>${sub}`
        + `<span class="nbs-item-meta">${esc(_ago(r.page.updatedAt))}${r.totalHits > r.hits.length ? ` · ${r.totalHits} matches` : ''}</span></div>`;
      if (this.mode === 'open') {
        for (const h of r.hits) {
          const hi = this._rows.length;
          this._rows.push({ kind: 'hit', id: r.page.id, hit: { from: h.from, to: h.to }, title: r.page.title });
          const crumb = h.heading ? `<span class="nbs-hit-crumb">${esc(h.heading)} ›</span>` : h.kind === 'heading' ? `<span class="nbs-hit-crumb">heading</span>` : '';
          html += `<div class="nbs-hit" role="option" data-row="${hi}" data-id="${esc(r.page.id)}" data-from="${h.from}" data-to="${h.to}">${crumb}<span class="nbs-hit-text">${markText(h.snippet, h.marks, esc)}</span></div>`;
        }
      }
    }
    if (showCreate) {
      const ci = this._rows.length;
      this._rows.push({ kind: 'create', title: trimmed });
      html += `<div class="nbs-create" role="option" data-row="${ci}"><span class="nbs-item-mark">+</span>Create page “${esc(trimmed)}”</div>`;
    }
    if (this.mode === 'link' && trimmed && !exact) {
      const ci = this._rows.length;
      this._rows.push({ kind: 'link', title: trimmed });
      html += `<div class="nbs-create" role="option" data-row="${ci}"><span class="nbs-item-mark">⟦</span>Link to “${esc(trimmed)}” (a new page)</div>`;
    }
    if (!html) html = `<div class="nbs-empty">${index ? `Nothing matches “${esc(trimmed)}”.` : 'No workspace — this document stands alone.'}</div>`;
    list.innerHTML = html;
    this.el.querySelector('.nbs-foot-verb').textContent = this.mode === 'link' ? 'insert link' : 'open';
    this._terms = terms;
    this._active = 0;
    this._paintActive(false);
  }

  _paintActive(scroll) {
    if (!this.el) return;
    this.el.querySelectorAll('[data-row]').forEach(r => r.classList.toggle('is-active', +r.dataset.row === this._active));
    if (scroll) this.el.querySelector(`[data-row="${this._active}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  _choose() {
    const row = this._rows[this._active];
    if (!row) return;
    const terms = this._terms ?? [];
    this.close();
    if (this.mode === 'link') {
      if (row.kind === 'page' || row.kind === 'link' || row.kind === 'hit') this.h.onInsertLink?.(row.title);
      return;
    }
    if (row.kind === 'create') this.h.onCreate?.(row.title);
    else this.h.onOpen?.(row.id, row.hit ?? null, terms);
  }
}

/** The label of the keyboard shortcut that opens the palette. */
export const SEARCH_SHORTCUT = () => formatShortcut('Mod-k');

export { normKey };

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
