/**
 * {spreadsheet} — the GRID: the render pane as a spreadsheet editor.
 *
 * The preview pane of the {spreadsheet} app is not a picture of the document,
 * it is where most editing happens: cells, rows and columns are selected and
 * edited the way every spreadsheet works (type to replace, Enter / Tab to
 * move, F2 to edit in place, Delete to clear, Ctrl+C/V as TSV, drag to
 * select, click a letter / number for a column / row, right-click or
 * long-press for the menu), with a formula bar, a toolbar, sheet tabs and
 * popovers for the things that need a form (number formats, colours,
 * filters, conditional-format rules, comments).
 *
 * The grid holds NO document state.  Every gesture becomes one pure edit
 * operation on the current text (src/core/sheet/edit.js) whose changes are
 * dispatched through the CodeMirror editor (`dsl-edit`) — so grid edits land
 * in the same undo history as typing, and the text stays the only source of
 * truth.  Ctrl+Z here IS the editor's undo (`editor-undo`).  The grid keeps
 * only VIEW state across re-renders: the active sheet, the selection, the
 * scroll position and an edit in progress.
 *
 * Rendering reuses the static renderer (core/sheet/render.js) — the same
 * table markup the HTML export and the quine's embedded preview draw — and
 * decorates it: selection classes, sticky frozen rows / columns, the
 * in-cell editor overlay, comment markers.
 */

import { state } from './state.js';
import { computeWorkbook, viewRows, viewCols } from '../core/sheet/book.js';
import * as ops from '../core/sheet/edit.js';
import { renderSheetHtml, colPx } from '../core/sheet/render.js';
import { colLetter, parseRange, formatRange, rangeContains } from '../core/sheet/parse.js';
import { FORMAT_CHOICES, parseCondition, describeCondition, formatStyleProps } from '../core/sheet/style.js';
import { parseStep } from '../core/sheet/seq.js';

const EXTRA_ROWS = 25;
const EXTRA_COLS = 6;
const LONG_PRESS_MS = 480;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mobile = () => window.matchMedia('(max-width: 640px)').matches;

const PALETTE = ['#000000', '#444444', '#888888', '#bbbbbb', '#ffffff', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#1a8cf5', '#8e44ad',
  '#fde2e2', '#fdebd0', '#fff4c2', '#dff5e5', '#dbeeff', '#efe0f7', '#f5f5f5', '#eef', '#ffe', '#efe'];

// Keep ONE grid per host element across re-renders.
const _grids = new WeakMap();

/** Mount (or update) the grid for `book` inside `host`. */
export function mountSheetGrid(host, book, opts = {}) {
  let g = _grids.get(host);
  if (!g || !host.contains(g.root)) {
    g = new SheetGrid(host);
    _grids.set(host, g);
  }
  g.update(book, opts);
  return g;
}

export class SheetGrid {
  constructor(host) {
    this.host = host;
    this.book = null;
    this.sheetIndex = 0;
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0, anchor: { r: 0, c: 0 }, head: { r: 0, c: 0 }, mode: 'cells' };
    this.editing = null;      // { r, c }
    this._drag = null;
    this._clip = null;        // internal clipboard fallback
    this._unsub = [];
    this._build();
    this._bind();
  }

  // ---------------------------------------------------------------------------
  // Skeleton
  // ---------------------------------------------------------------------------

  _build() {
    this.host.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'uf-ss';
    root.tabIndex = 0;
    root.dataset.dslHandled = '1';
    root.innerHTML = `
      <div class="uf-ss-bar" role="toolbar">
        ${btn('undo', '↶', 'Undo (Ctrl+Z)')}${btn('redo', '↷', 'Redo (Ctrl+Y)')}
        <span class="uf-ss-sep"></span>
        ${btn('bold', '<b>B</b>', 'Bold (Ctrl+B)')}${btn('italic', '<i>I</i>', 'Italic (Ctrl+I)')}${btn('underline', '<u>U</u>', 'Underline (Ctrl+U)')}${btn('strike', '<s>S</s>', 'Strikethrough')}
        <span class="uf-ss-sep"></span>
        ${btn('align:left', '⇤', 'Align left')}${btn('align:center', '⇔', 'Align centre')}${btn('align:right', '⇥', 'Align right')}${btn('wrap', '⤶', 'Wrap text')}
        <span class="uf-ss-sep"></span>
        ${btn('format', '0.0', 'Number format…')}${btn('color', '<span class="uf-ss-ico-a">A</span>', 'Text colour…')}${btn('bg', '◼', 'Fill colour…')}${btn('border', '▦', 'Borders')}
        <span class="uf-ss-sep"></span>
        ${btn('merge', '⊞', 'Merge / unmerge cells')}
        ${btn('insert-row', '+⇣', 'Insert row below (Shift: above)')}${btn('insert-col', '+⇢', 'Insert column right (Shift: left)')}${btn('delete-row', '−⇣', 'Delete row(s)')}${btn('delete-col', '−⇢', 'Delete column(s)')}
        <span class="uf-ss-sep"></span>
        ${btn('sort-asc', 'A↓', 'Sort rows by this column, ascending')}${btn('sort-desc', 'Z↓', 'Sort rows by this column, descending')}${btn('filter', '▽', 'Filter this column…')}
        <span class="uf-ss-sep"></span>
        ${btn('comment', '❝', 'Comment…')}${btn('rules', '◈', 'Conditional formatting…')}${btn('more', '⋯', 'More…')}
      </div>
      <div class="uf-ss-fx">
        <button type="button" class="uf-ss-name" title="Go to a cell or range">A1</button>
        <span class="uf-ss-fxlabel">ƒx</span>
        <input class="uf-ss-fxinput" type="text" spellcheck="false" autocomplete="off" aria-label="Cell contents">
      </div>
      <div class="uf-ss-scroll">
        <div class="uf-ss-tablewrap"></div>
        <textarea class="uf-ss-editor" rows="1" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Edit cell"></textarea>
      </div>
      <div class="uf-ss-tabs"></div>
      <div class="uf-ss-pop" hidden></div>
    `;
    this.host.appendChild(root);
    this.root = root;
    this.bar = root.querySelector('.uf-ss-bar');
    this.fxName = root.querySelector('.uf-ss-name');
    this.fxInput = root.querySelector('.uf-ss-fxinput');
    this.scroll = root.querySelector('.uf-ss-scroll');
    this.tableWrap = root.querySelector('.uf-ss-tablewrap');
    this.editor = root.querySelector('.uf-ss-editor');
    this.tabs = root.querySelector('.uf-ss-tabs');
    this.pop = root.querySelector('.uf-ss-pop');
  }

  // ---------------------------------------------------------------------------
  // Model access
  // ---------------------------------------------------------------------------

  get sheet() { return this.book?.sheets[this.sheetIndex] ?? null; }
  get text() { return state.currentContent ?? ''; }

  /** The anchor cell object at (r, c) if the sheet has one, else null. */
  _cell(r, c) { return this.sheet?.grid[r]?.[c] ?? null; }
  _cellText(r, c) { const cell = this._cell(r, c); return cell && !cell.merged ? cell.text : ''; }

  /** The selection as a range, clipped to nothing (open ends stay open for rows/cols modes). */
  _range() {
    const s = this.sel;
    return { r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2), c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2) };
  }
  /** The selection as a bounded range for ops (rows/cols modes bounded by the sheet). */
  _boundedRange() {
    const R = this._range();
    const sh = this.sheet;
    const rows = Math.max(1, sh?.rows.length ?? 1), cols = Math.max(1, sh?.cols ?? 1);
    return { r1: R.r1, c1: R.c1, r2: Math.min(R.r2, Math.max(rows - 1, R.r1)), c2: Math.min(R.c2, Math.max(cols - 1, R.c1)) };
  }
  /** The range as written in a directive: whole rows / columns stay open. */
  _directiveRange() {
    const R = this._range();
    if (this.sel.mode === 'cols') return { r1: 0, r2: Infinity, c1: R.c1, c2: R.c2 };
    if (this.sel.mode === 'rows') return { r1: R.r1, r2: R.r2, c1: 0, c2: Infinity };
    return R;
  }

  // ---------------------------------------------------------------------------
  // Update (render)
  // ---------------------------------------------------------------------------

  update(book, { cursorPos } = {}) {
    const first = !this.book;
    this.book = book;
    if (this.sheetIndex >= book.sheets.length) this.sheetIndex = Math.max(0, book.sheets.length - 1);
    this._renderTabs();
    this._renderTable();
    if (first && cursorPos != null) this._selectFromOffset(cursorPos, { silent: true });
    this._paint();
  }

  _renderTabs() {
    const sheets = this.book.sheets.length ? this.book.sheets : [{ name: 'Sheet1', index: 0 }];
    this.tabs.innerHTML = sheets.map(s =>
      `<button type="button" class="uf-ss-tab${s.index === this.sheetIndex ? ' is-active' : ''}" data-tab="${s.index}" title="Double-click to rename">${esc(s.name)}</button>`
    ).join('') + `<button type="button" class="uf-ss-addtab" data-addtab="1" title="Add a sheet">+</button>`;
  }

  _renderTable() {
    const sheet = this.sheet;
    const top = this.scroll.scrollTop, left = this.scroll.scrollLeft;
    if (!sheet) {
      // An empty document: a blank grid to type into (the first edit creates Sheet1).
      const blank = computeWorkbook(ops.starterText('Sheet1'));
      this.tableWrap.innerHTML = renderSheetHtml(blank, blank.sheets[0], { extraRows: EXTRA_ROWS, extraCols: EXTRA_COLS + 2, docOffsets: false });
    } else {
      this.tableWrap.innerHTML = renderSheetHtml(this.book, sheet, { extraRows: EXTRA_ROWS, extraCols: EXTRA_COLS });
    }
    this.table = this.tableWrap.querySelector('table');
    this._applyFrozen();
    this.scroll.scrollTop = top;
    this.scroll.scrollLeft = left;
    if (this.editing) this._placeEditor();
  }

  /** Sticky offsets for the rulers and the frozen rows / columns. */
  _applyFrozen() {
    const sheet = this.sheet;
    const table = this.table;
    if (!table) return;
    const frozenRows = sheet ? Math.max(sheet.headerRows, sheet.freeze.rows) : 0;
    const frozenCols = sheet ? sheet.freeze.cols : 0;
    const rulerW = 40;
    // Columns: left offsets accumulate the widths of the frozen columns before.
    let left = rulerW;
    const shownCols = sheet ? viewCols(sheet, sheet.cols + EXTRA_COLS) : [];
    for (const c of shownCols) {
      if (c >= frozenCols) break;
      const w = colPx(sheet, c);
      for (const el of table.querySelectorAll(`th.uf-ss-col[data-col="${c}"], td[data-c="${c}"]`)) { el.classList.add('is-frozen-col'); el.style.left = left + 'px'; }
      left += w;
    }
    // Rows: measured after layout — the header row's height is known only then.
    const headH = table.tHead?.offsetHeight ?? 0;
    let top = headH;
    for (const tr of table.tBodies[0].rows) {
      const r = +tr.dataset.row;
      if (!(r < frozenRows)) break;
      tr.classList.add('is-frozen-row');
      for (const el of tr.children) el.style.top = top + 'px';
      top += tr.offsetHeight;
    }
  }

  /** Selection + active-cell classes, the name box and the formula bar. */
  _paint() {
    const table = this.table;
    if (!table) return;
    for (const el of table.querySelectorAll('.is-sel, .is-active')) el.classList.remove('is-sel', 'is-active');
    const R = this._range();
    const mode = this.sel.mode;
    for (const td of table.querySelectorAll('td[data-r]')) {
      const r = +td.dataset.r, c = +td.dataset.c;
      const rs = td.rowSpan || 1, cs = td.colSpan || 1;
      const inRange = mode === 'all' || (r + rs - 1 >= R.r1 && r <= R.r2 && c + cs - 1 >= R.c1 && c <= R.c2);
      if (inRange) td.classList.add('is-sel');
    }
    const head = this.sel.head;
    const active = this._anchorTd(head.r, head.c);
    active?.classList.add('is-active');
    for (const th of table.querySelectorAll('th.uf-ss-col')) { const c = +th.dataset.col; if (mode === 'all' || (c >= R.c1 && c <= R.c2)) th.classList.add('is-sel'); }
    for (const th of table.querySelectorAll('th.uf-ss-row')) { const r = +th.dataset.row; if (mode === 'all' || (r >= R.r1 && r <= R.r2)) th.classList.add('is-sel'); }
    this.fxName.textContent = mode === 'all' ? 'A:…' : formatRange(this._directiveRange());
    if (!this.editing && document.activeElement !== this.fxInput) this.fxInput.value = this._cellText(head.r, head.c);
    this._paintToolbar();
  }

  _paintToolbar() {
    const head = this.sel.head;
    const cell = this._cell(head.r, head.c);
    const st = cell && this.book ? this.book.styleOf(cell) : {};
    for (const key of ['bold', 'italic', 'underline', 'strike', 'wrap']) this.bar.querySelector(`[data-act="${key}"]`)?.classList.toggle('is-on', !!st[key]);
    for (const a of ['left', 'center', 'right']) this.bar.querySelector(`[data-act="align:${a}"]`)?.classList.toggle('is-on', st.align === a);
    const merged = cell && (cell.colspan > 1 || cell.rowspan > 1);
    this.bar.querySelector('[data-act="merge"]')?.classList.toggle('is-on', !!merged);
    const hasComment = !!this.sheet?.comments.find(x => x.r === head.r && x.c === head.c);
    this.bar.querySelector('[data-act="comment"]')?.classList.toggle('is-on', hasComment);
    const col = head.c;
    this.bar.querySelector('[data-act="filter"]')?.classList.toggle('is-on', !!this.sheet?.filters.some(f => f.col === col));
  }

  /** The td whose anchor is (r, c) — for a covered cell, the spanning td. */
  _anchorTd(r, c) {
    const cell = this._cell(r, c);
    const ar = cell ? cell.r : r, ac = cell ? cell.c : c;
    return this.table?.querySelector(`td[data-r="${ar}"][data-c="${ac}"]`) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  _select(r, c, { extend = false, mode = 'cells', silent = false } = {}) {
    r = Math.max(0, r); c = Math.max(0, c);
    const s = this.sel;
    if (extend) { s.head = { r, c }; s.r2 = r; s.c2 = c; }
    else { s.anchor = { r, c }; s.head = { r, c }; s.r1 = s.r2 = r; s.c1 = s.c2 = c; }
    s.mode = mode;
    if (mode === 'cols') { s.r1 = 0; s.r2 = Infinity; }
    if (mode === 'rows') { s.c1 = 0; s.c2 = Infinity; }
    this._paint();
    this._closePop();
    if (!silent) this._mirrorToEditor();
  }

  /** Tell the text editor where we are (without stealing focus). */
  _mirrorToEditor() {
    const { r, c } = this.sel.head;
    const cell = this._cell(r, c);
    if (!cell || cell.synthetic) return;
    state.emit('dsl-select', { from: cell.from, to: cell.to, focus: false });
  }

  /** The editor caret moved → select that cell here (no echo back). */
  _selectFromOffset(pos, { silent = true } = {}) {
    const book = this.book;
    if (!book) return;
    for (const sheet of book.sheets) {
      if (pos < sheet.from || pos > sheet.to + 1) continue;
      if (sheet.index !== this.sheetIndex) { this.sheetIndex = sheet.index; this._renderTabs(); this._renderTable(); }
      for (const row of sheet.rows) {
        if (pos < row.from || pos > row.to) continue;
        let best = row.cells[0];
        for (const cell of row.cells) if (!cell.synthetic && pos >= cell.rawFrom && pos <= cell.rawTo) best = cell;
        if (best) { this._select(best.r, best.c, { silent }); this._scrollCellIntoView(best.r, best.c); }
        return;
      }
      return;
    }
  }

  _scrollCellIntoView(r, c) {
    const td = this._anchorTd(r, c);
    if (!td) return;
    const sc = this.scroll.getBoundingClientRect();
    const tr = td.getBoundingClientRect();
    const headH = (this.table.tHead?.offsetHeight ?? 0);
    const rulerW = 40;
    if (tr.top < sc.top + headH) this.scroll.scrollTop -= (sc.top + headH - tr.top);
    else if (tr.bottom > sc.bottom) this.scroll.scrollTop += (tr.bottom - sc.bottom);
    if (tr.left < sc.left + rulerW) this.scroll.scrollLeft -= (sc.left + rulerW - tr.left);
    else if (tr.right > sc.right) this.scroll.scrollLeft += (tr.right - sc.right);
  }

  _move(dr, dc, { extend = false } = {}) {
    const from = extend ? this.sel.head : this.sel.head;
    let r = from.r, c = from.c;
    // Stepping out of a span: jump past it.
    const cell = this._cell(r, c);
    if (cell && !extend) {
      if (dr > 0) r = cell.r + cell.rowspan - 1;
      if (dc > 0) c = cell.c + cell.colspan - 1;
      if (dr < 0) r = cell.r;
      if (dc < 0) c = cell.c;
    }
    r = Math.max(0, r + dr); c = Math.max(0, c + dc);
    // Hidden rows / columns are skipped.
    const sheet = this.sheet;
    if (sheet) {
      while (dr && sheet.hidden.rows.has(r) && r >= 0 && r < sheet.rows.length + EXTRA_ROWS) r += Math.sign(dr);
      while (dc && sheet.hidden.cols.has(c) && c >= 0 && c < sheet.cols + EXTRA_COLS) c += Math.sign(dc);
      r = Math.max(0, r); c = Math.max(0, c);
    }
    const target = this._cell(r, c);
    if (target && !extend) { r = target.r; c = target.c; }
    this._select(r, c, { extend });
    this._scrollCellIntoView(r, c);
  }

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  _startEdit(r, c, initial = null) {
    const cell = this._cell(r, c);
    if (cell) { r = cell.r; c = cell.c; }
    this.editing = { r, c };
    this.editor.value = initial != null ? initial : this._cellText(r, c);
    this.editor.hidden = false;
    this.editor.classList.add('is-open');
    this._placeEditor();
    this.editor.focus();
    const n = this.editor.value.length;
    this.editor.setSelectionRange(n, n);
    this.fxInput.value = this.editor.value;
  }

  _placeEditor() {
    if (!this.editing) return;
    const td = this._anchorTd(this.editing.r, this.editing.c);
    if (!td) { this._cancelEdit(); return; }
    const tr = td.getBoundingClientRect();
    const wr = this.tableWrap.getBoundingClientRect();
    const st = this.editor.style;
    st.left = (tr.left - wr.left) + 'px';
    st.top = (tr.top - wr.top) + 'px';
    st.width = Math.max(tr.width, 120) + 'px';
    st.height = Math.max(tr.height, 26) + 'px';
    st.textAlign = getComputedStyle(td).textAlign;
  }

  _commitEdit({ move = null } = {}) {
    if (!this.editing) return;
    const { r, c } = this.editing;
    const value = this.editor.value;
    this._cancelEdit({ keepFocus: true });
    if (value !== this._cellText(r, c)) this._apply(ops.setCell(this.text, this.sheetIndex, r, c, value, this.book), { select: { r, c } });
    if (move) this._move(move[0], move[1]);
    this.root.focus({ preventScroll: true });
  }

  _cancelEdit({ keepFocus = false } = {}) {
    this.editing = null;
    this.editor.classList.remove('is-open');
    this.editor.hidden = true;
    if (!keepFocus) this.root.focus({ preventScroll: true });
    this._paint();
  }

  // ---------------------------------------------------------------------------
  // Applying an edit operation
  // ---------------------------------------------------------------------------

  /**
   * Dispatch an operation's changes through the editor, then redraw at once
   * from the resulting text (the preview's own debounced render follows and
   * finds the same text).
   */
  _apply(result, { select = null } = {}) {
    if (!result || !result.changes?.length) return false;
    state.emit('dsl-edit', { changes: result.changes });
    const text = state.currentContent ?? result.text;
    this.update(computeWorkbook(text));
    if (select) {
      if (select.range) { this.sel = { ...this.sel, ...select.range, anchor: { r: select.range.r1, c: select.range.c1 }, head: { r: select.range.r1, c: select.range.c1 }, mode: select.mode ?? 'cells' }; this._paint(); this._mirrorToEditor(); }
      else this._select(select.r, select.c);
    } else {
      this._paint();
      this._mirrorToEditor();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Actions (toolbar, menu, keyboard)
  // ---------------------------------------------------------------------------

  _toggleProp(key) {
    const R = this._directiveRange();
    const on = this.sheet ? ops.rangeHas(this.book, this.sheet, this._boundedRange(), key) : false;
    this._apply(ops.setStyle(this.text, this.sheetIndex, R, { [key]: !on }, this.book), { select: { range: this._range(), mode: this.sel.mode } });
  }
  _setProp(props) {
    const R = this._directiveRange();
    this._apply(ops.setStyle(this.text, this.sheetIndex, R, props, this.book), { select: { range: this._range(), mode: this.sel.mode } });
  }

  _act(id, ev = {}) {
    const R = this._boundedRange();
    const head = this.sel.head;
    const sel = () => ({ range: this._range(), mode: this.sel.mode });
    switch (id) {
      case 'undo': state.emit('editor-undo'); return;
      case 'redo': state.emit('editor-redo'); return;
      case 'bold': case 'italic': case 'underline': case 'strike': case 'wrap': this._toggleProp(id); return;
      case 'align:left': case 'align:center': case 'align:right': {
        const a = id.slice(6);
        const cell = this._cell(head.r, head.c);
        const cur = cell ? this.book.styleOf(cell).align : null;
        this._setProp({ align: cur === a ? null : a });
        return;
      }
      case 'format': this._openFormatPop(ev.target); return;
      case 'border:all': case 'border:top': case 'border:bottom': case 'border:left': case 'border:right': case 'border:none':
        this._setProp({ border: id === 'border:none' ? null : id.slice(7) }); return;
      case 'color': case 'bg': this._openColorPop(id, ev.target); return;
      case 'border': this._openBorderPop(ev.target); return;
      case 'merge': {
        const cell = this._cell(head.r, head.c);
        if (cell && (cell.colspan > 1 || cell.rowspan > 1)) this._apply(ops.unmergeRange(this.text, this.sheetIndex, { r1: cell.r, c1: cell.c, r2: cell.r, c2: cell.c }, this.book), { select: { r: cell.r, c: cell.c } });
        else this._apply(ops.mergeRange(this.text, this.sheetIndex, R, this.book), { select: { r: R.r1, c: R.c1 } });
        return;
      }
      case 'insert-row': case 'insert-row-above': case 'insert-row-below': {
        const above = id === 'insert-row-above' || (id === 'insert-row' && ev.shiftKey);
        const n = R.r2 - R.r1 + 1;
        const at = above ? R.r1 : R.r2 + 1;
        this._apply(ops.insertRows(this.text, this.sheetIndex, at, n, this.book), { select: { range: { r1: at, r2: at + n - 1, c1: 0, c2: Infinity }, mode: 'rows' } });
        return;
      }
      case 'insert-col': case 'insert-col-left': case 'insert-col-right': {
        const leftOf = id === 'insert-col-left' || (id === 'insert-col' && ev.shiftKey);
        const n = R.c2 - R.c1 + 1;
        const at = leftOf ? R.c1 : R.c2 + 1;
        this._apply(ops.insertCols(this.text, this.sheetIndex, at, n, this.book), { select: { range: { r1: 0, r2: Infinity, c1: at, c2: at + n - 1 }, mode: 'cols' } });
        return;
      }
      case 'delete-row': this._apply(ops.deleteRows(this.text, this.sheetIndex, R.r1, R.r2, this.book), { select: { r: R.r1, c: head.c } }); return;
      case 'delete-col': this._apply(ops.deleteCols(this.text, this.sheetIndex, R.c1, R.c2, this.book), { select: { r: head.r, c: R.c1 } }); return;
      case 'clear': this._apply(ops.clearRange(this.text, this.sheetIndex, R, this.book), { select: sel() }); return;
      case 'sort-asc': case 'sort-desc': this._apply(ops.sortRows(this.text, this.sheetIndex, head.c, id === 'sort-asc' ? 'asc' : 'desc', this.book), { select: sel() }); return;
      case 'view-sort-asc': case 'view-sort-desc': this._apply(ops.setSortView(this.text, this.sheetIndex, [{ col: head.c, dir: id.endsWith('asc') ? 'asc' : 'desc' }], this.book), { select: sel() }); return;
      case 'view-sort-clear': this._apply(ops.setSortView(this.text, this.sheetIndex, [], this.book), { select: sel() }); return;
      case 'filter': this._openFilterPop(head.c, ev.target); return;
      case 'filter-clear': this._apply(ops.clearFilters(this.text, this.sheetIndex, this.book), { select: sel() }); return;
      case 'filter-on': this._apply(ops.setFilterOn(this.text, this.sheetIndex, !this.sheet?.filterOn, this.book), { select: sel() }); return;
      case 'sequence': {
        const start = window.prompt('Sequence start (1, 2026-01-01, Jan, Monday, Item 1):', this._cellText(head.r, head.c) || '1');
        if (start == null || !start.trim()) return;
        const stepText = window.prompt('Step (1, -1, 0.5, 7, 1 week, 1 month, 1 year):', '1');
        if (stepText == null) return;
        const step = parseStep(stepText);
        if (!step) { window.alert('Step: a number, or N days / weeks / months / years'); return; }
        this._apply(ops.setSequence(this.text, this.sheetIndex, this._directiveRange(), start.trim(), step, this.book), { select: sel() });
        return;
      }
      case 'comment': this._openCommentPop(head.r, head.c, ev.target); return;
      case 'rules': this._openRulesPop(ev.target); return;
      case 'scale': this._openScalePop(ev.target); return;
      case 'more': this._openMorePop(ev.target); return;
      case 'freeze-rows': this._apply(ops.setFreeze(this.text, this.sheetIndex, head.r + 1, this.sheet?.freeze.cols ?? 0, this.book), { select: sel() }); return;
      case 'freeze-cols': this._apply(ops.setFreeze(this.text, this.sheetIndex, this.sheet?.freeze.rows ?? 0, head.c + 1, this.book), { select: sel() }); return;
      case 'freeze-none': this._apply(ops.setFreeze(this.text, this.sheetIndex, 0, 0, this.book), { select: sel() }); return;
      case 'header-rows': this._apply(ops.setHeaderRows(this.text, this.sheetIndex, this.sheet?.headerRows === head.r + 1 ? 0 : head.r + 1, this.book), { select: sel() }); return;
      case 'hide-rows': this._apply(ops.setHidden(this.text, this.sheetIndex, 'row', R.r1, R.r2, true, this.book), { select: { r: R.r2 + 1, c: head.c } }); return;
      case 'hide-cols': this._apply(ops.setHidden(this.text, this.sheetIndex, 'col', R.c1, R.c2, true, this.book), { select: { r: head.r, c: R.c2 + 1 } }); return;
      case 'unhide-rows': { const rows = [...(this.sheet?.hidden.rows ?? [])]; if (rows.length) this._apply(ops.setHidden(this.text, this.sheetIndex, 'row', Math.min(...rows), Math.max(...rows), false, this.book), { select: sel() }); return; }
      case 'unhide-cols': { const cols = [...(this.sheet?.hidden.cols ?? [])]; if (cols.length) this._apply(ops.setHidden(this.text, this.sheetIndex, 'col', Math.min(...cols), Math.max(...cols), false, this.book), { select: sel() }); return; }
      case 'width': {
        const cur = this.sheet?.widths.get(head.c) ?? '';
        const v = window.prompt('Column width (characters; blank = default):', cur);
        if (v == null) return;
        this._apply(ops.setWidth(this.text, this.sheetIndex, R.c1, R.c2, v.trim() === '' ? 0 : Math.max(1, Math.round(Number(v)) || 0), this.book), { select: sel() });
        return;
      }
      case 'height': {
        const cur = this.sheet?.heights.get(head.r) ?? '';
        const v = window.prompt('Row height (px; blank = default):', cur);
        if (v == null) return;
        this._apply(ops.setHeight(this.text, this.sheetIndex, R.r1, R.r2, v.trim() === '' ? 0 : Math.max(1, Math.round(Number(v)) || 0), this.book), { select: sel() });
        return;
      }
      case 'add-sheet': {
        const name = window.prompt('Sheet name:', `Sheet${(this.book?.sheets.length ?? 0) + 1}`);
        if (name == null) return;
        const res = ops.addSheet(this.text, name, this.book);
        if (this._apply(res)) { this.sheetIndex = res.index; this.update(computeWorkbook(this.text)); this._select(0, 0); }
        return;
      }
      case 'rename-sheet': {
        const name = window.prompt('Sheet name:', this.sheet?.name ?? '');
        if (name == null || !name.trim()) return;
        this._apply(ops.renameSheet(this.text, this.sheetIndex, name, this.book), { select: sel() });
        return;
      }
      case 'delete-sheet': {
        if (!this.sheet || this.book.sheets.length < 2) { window.alert('A workbook keeps at least one sheet.'); return; }
        if (!window.confirm(`Delete sheet "${this.sheet.name}"?`)) return;
        const idx = this.sheetIndex;
        if (this._apply(ops.deleteSheet(this.text, idx, this.book))) { this.sheetIndex = Math.max(0, idx - 1); this.update(computeWorkbook(this.text)); this._select(0, 0); }
        return;
      }
      case 'align-text': {
        const next = ops.alignSpreadsheet(this.text);
        if (next !== this.text) this._apply({ text: next, changes: [{ from: 0, to: this.text.length, insert: next }] }, { select: sel() });
        return;
      }
      case 'copy': this._copy(); return;
      case 'cut': this._copy(); this._act('clear'); return;
      case 'paste': this._pasteFromClipboard(); return;
      case 'select-all': this.sel.mode = 'all'; this.sel.r1 = 0; this.sel.c1 = 0; this.sel.r2 = Infinity; this.sel.c2 = Infinity; this._paint(); return;
    }
  }

  // ---------------------------------------------------------------------------
  // Clipboard — TSV of the cells' TEXT (formulas travel as formulas)
  // ---------------------------------------------------------------------------

  _tsvOfSelection() {
    const R = this._boundedRange();
    const lines = [];
    for (let r = R.r1; r <= R.r2; r++) {
      const row = [];
      for (let c = R.c1; c <= R.c2; c++) row.push(this._cellText(r, c));
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  }
  async _copy() {
    const tsv = this._tsvOfSelection();
    this._clip = tsv;
    try { await navigator.clipboard?.writeText(tsv); } catch { /* the internal buffer still works */ }
  }
  async _pasteFromClipboard() {
    let text = null;
    try { text = await navigator.clipboard?.readText(); } catch { /* Firefox / denied */ }
    this._pasteText(text ?? this._clip ?? '');
  }
  _pasteText(text) {
    if (!text) return;
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const matrix = lines.map(l => l.split('\t'));
    const { r, c } = { r: this._range().r1, c: this._range().c1 };
    this._apply(ops.setCells(this.text, this.sheetIndex, r, c, matrix, this.book),
      { select: { range: { r1: r, c1: c, r2: r + matrix.length - 1, c2: c + Math.max(...matrix.map(m => m.length)) - 1 } } });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  _bind() {
    const root = this.root;
    // The preview's generic click-back must not see our clicks (it would focus the editor).
    root.addEventListener('click', e => e.stopPropagation());

    // Toolbar: keep the grid focused; act on click.
    this.bar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
    this.bar.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (this.editing) this._commitEdit();
      this._act(b.dataset.act, { target: b, shiftKey: e.shiftKey });
    });

    // Tabs
    this.tabs.addEventListener('click', e => {
      const t = e.target.closest('[data-tab]');
      if (t) { this.sheetIndex = +t.dataset.tab; this._cancelEdit(); this._renderTabs(); this._renderTable(); this._select(0, 0); return; }
      if (e.target.closest('[data-addtab]')) this._act('add-sheet');
    });
    this.tabs.addEventListener('dblclick', e => { if (e.target.closest('[data-tab]')) this._act('rename-sheet'); });
    this.tabs.addEventListener('contextmenu', e => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      e.preventDefault();
      this.sheetIndex = +t.dataset.tab; this._renderTabs(); this._renderTable(); this._paint();
      this._openMenu([['rename-sheet', 'Rename sheet…'], ['delete-sheet', 'Delete sheet'], ['add-sheet', 'Add sheet…']], { x: e.clientX, y: e.clientY });
    });

    // Name box: go to
    this.fxName.addEventListener('click', () => {
      const v = window.prompt('Go to cell or range:', this.fxName.textContent);
      const R = v && parseRange(v.trim());
      if (!R) return;
      if (R.r2 === Infinity && R.c2 !== Infinity) { this._select(0, R.c1, { mode: 'cols' }); this.sel.c2 = R.c2; }
      else if (R.c2 === Infinity && R.r2 !== Infinity) { this._select(R.r1, 0, { mode: 'rows' }); this.sel.r2 = R.r2; }
      else { this._select(R.r1, R.c1); this._select(R.r2, R.c2, { extend: true }); this.sel.head = { r: R.r1, c: R.c1 }; }
      this._paint(); this._scrollCellIntoView(R.r1, R.c1);
    });

    // Formula bar
    this.fxInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const { r, c } = this.sel.head; const v = this.fxInput.value; if (v !== this._cellText(r, c)) this._apply(ops.setCell(this.text, this.sheetIndex, r, c, v, this.book), { select: { r, c } }); this._move(1, 0); this.root.focus(); }
      else if (e.key === 'Escape') { this.fxInput.value = this._cellText(this.sel.head.r, this.sel.head.c); this.root.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); const { r, c } = this.sel.head; const v = this.fxInput.value; if (v !== this._cellText(r, c)) this._apply(ops.setCell(this.text, this.sheetIndex, r, c, v, this.book), { select: { r, c } }); this._move(0, 1); this.root.focus(); }
    });

    // In-cell editor
    this.editor.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); this._commitEdit({ move: e.shiftKey ? [-1, 0] : [1, 0] }); }
      else if (e.key === 'Tab') { e.preventDefault(); this._commitEdit({ move: e.shiftKey ? [0, -1] : [0, 1] }); }
      else if (e.key === 'Escape') { e.preventDefault(); this._cancelEdit(); }
      e.stopPropagation();
    });
    this.editor.addEventListener('input', () => { this.fxInput.value = this.editor.value; });
    this.editor.addEventListener('blur', () => { if (this.editing && !this._suppressBlurCommit) this._commitEdit(); });

    // Grid pointer gestures
    this.scroll.addEventListener('pointerdown', e => this._onPointerDown(e));
    this.scroll.addEventListener('pointermove', e => this._onPointerMove(e));
    this.scroll.addEventListener('pointerup', e => this._onPointerUp(e));
    this.scroll.addEventListener('pointercancel', e => this._onPointerUp(e));
    this.scroll.addEventListener('dblclick', e => {
      const td = e.target.closest('td[data-r]');
      if (td) { e.preventDefault(); this._startEdit(+td.dataset.r, +td.dataset.c); }
      const grip = e.target.closest('[data-grip-col]');
      if (grip) { this._apply(ops.setWidth(this.text, this.sheetIndex, +grip.dataset.gripCol, +grip.dataset.gripCol, 0, this.book)); }
    });
    this.scroll.addEventListener('contextmenu', e => {
      const td = e.target.closest('td[data-r]');
      const th = e.target.closest('th[data-col], th[data-row]');
      if (!td && !th) return;
      e.preventDefault();
      if (td) { const r = +td.dataset.r, c = +td.dataset.c; if (!this._inSelection(r, c)) this._select(r, c); }
      else if (th?.dataset.col != null) { const c = +th.dataset.col; if (this.sel.mode !== 'cols' || !this._inSelection(0, c)) this._select(0, c, { mode: 'cols' }); }
      else if (th?.dataset.row != null) { const r = +th.dataset.row; if (this.sel.mode !== 'rows' || !this._inSelection(r, 0)) this._select(r, 0, { mode: 'rows' }); }
      this._openContextMenu({ x: e.clientX, y: e.clientY });
    });

    // Keyboard
    root.addEventListener('keydown', e => this._onKey(e));
    root.addEventListener('copy', e => { if (this._isGridTarget(e)) { e.preventDefault(); const tsv = this._tsvOfSelection(); this._clip = tsv; e.clipboardData.setData('text/plain', tsv); } });
    root.addEventListener('cut', e => { if (this._isGridTarget(e)) { e.preventDefault(); const tsv = this._tsvOfSelection(); this._clip = tsv; e.clipboardData.setData('text/plain', tsv); this._act('clear'); } });
    root.addEventListener('paste', e => { if (this._isGridTarget(e)) { e.preventDefault(); this._pasteText(e.clipboardData.getData('text/plain')); } });

    // Popover: close on outside click / Esc
    document.addEventListener('pointerdown', this._onDocPointer = (e) => { if (!this.pop.hidden && !this.pop.contains(e.target) && !e.target.closest?.('.uf-ss-bar button')) this._closePop(); });

    // Editor caret → grid selection (silent; no echo).
    this._unsub.push(state.on('editor-select', ({ from }) => { if (document.activeElement !== this.root && !this.editing) this._selectFromOffset(from, { silent: true }); }));
    // The phone bubble's verbs land here.
    this._unsub.push(state.on('sheet-grid-action', (id) => this._act(id)));
    // Theme flips: nothing to do, the grid uses tokens; but frozen offsets may change with font metrics.
    this._ro = new ResizeObserver(() => { this._applyFrozen(); if (this.editing) this._placeEditor(); });
    this._ro.observe(this.scroll);
  }

  _isGridTarget(e) { return e.target === this.root || (this.root.contains(e.target) && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)); }
  _inSelection(r, c) { const R = this._range(); return this.sel.mode === 'all' || (r >= R.r1 && r <= R.r2 && c >= R.c1 && c <= R.c2); }

  _onPointerDown(e) {
    if (e.button === 2) return;
    const target = e.target;
    // Column resize grip
    const grip = target.closest('[data-grip-col]');
    if (grip) {
      e.preventDefault();
      const c = +grip.dataset.gripCol;
      const th = grip.closest('th');
      this._drag = { kind: 'col', c, startX: e.clientX, startW: th.offsetWidth, th };
      try { this.scroll.setPointerCapture(e.pointerId); } catch { /* stale id */ }
      return;
    }
    const fbtn = target.closest('[data-filter-col]');
    if (fbtn) {
      e.preventDefault();
      const c = +fbtn.dataset.filterCol;
      this._select(0, c, { mode: 'cols' });
      this._openMenu([['view-sort-asc', 'Sort A → Z (view)'], ['view-sort-desc', 'Sort Z → A (view)'], ['view-sort-clear', 'Clear sort', !this.sheet?.sorts.length], ['-'], ['filter', 'Filter…'], ['filter-clear', 'Clear all filters', !this.sheet?.filters.length]], fbtn);
      return;
    }
    const td = target.closest('td[data-r]');
    const th = target.closest('th[data-col], th[data-row], th[data-corner]');
    if (!td && !th) return;
    if (this.editing) {
      if (td && +td.dataset.r === this.editing.r && +td.dataset.c === this.editing.c) return;
      this._commitEdit();
    }
    e.preventDefault();
    if (document.activeElement !== this.root) this.root.focus({ preventScroll: true });
    const extend = e.shiftKey;
    if (td) {
      const r = +td.dataset.r, c = +td.dataset.c;
      this._select(r, c, { extend });
      this._drag = { kind: 'cells', pointerId: e.pointerId, moved: false, startX: e.clientX, startY: e.clientY, r, c };
    } else if (th?.dataset.corner != null) {
      this._act('select-all');
    } else if (th?.dataset.col != null) {
      const c = +th.dataset.col;
      this._select(extend ? this.sel.anchor.r : 0, c, { extend, mode: 'cols' });
      this._drag = { kind: 'cols', pointerId: e.pointerId, moved: false, startX: e.clientX, startY: e.clientY };
    } else if (th?.dataset.row != null) {
      const r = +th.dataset.row;
      this._select(r, extend ? this.sel.anchor.c : 0, { extend, mode: 'rows' });
      this._drag = { kind: 'rows', pointerId: e.pointerId, moved: false, startX: e.clientX, startY: e.clientY };
    }
    // Long-press (touch) → the context menu.
    if (e.pointerType === 'touch' && this._drag) {
      clearTimeout(this._pressTimer);
      const at = { x: e.clientX, y: e.clientY };
      this._pressTimer = setTimeout(() => { if (this._drag && !this._drag.moved) { this._drag = null; this._openContextMenu(at); } }, LONG_PRESS_MS);
    }
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'col') {
      const w = Math.max(24, d.startW + (e.clientX - d.startX));
      const col = this.table.querySelector(`colgroup col:nth-child(${[...this.table.querySelectorAll('th.uf-ss-col')].findIndex(t => +t.dataset.col === d.c) + 2})`);
      if (col) col.style.width = w + 'px';
      d.w = w;
      return;
    }
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 6) d.moved = true;
    if (!d.moved) return;
    if (e.pointerType === 'touch') return;   // touch drags scroll; selection extends via shift-tap / handles
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const td = el?.closest?.('td[data-r]');
    const th = el?.closest?.('th[data-col], th[data-row]');
    if (d.kind === 'cells' && td) this._select(+td.dataset.r, +td.dataset.c, { extend: true, silent: true });
    else if (d.kind === 'cols' && th?.dataset.col != null) this._select(0, +th.dataset.col, { extend: true, mode: 'cols', silent: true });
    else if (d.kind === 'rows' && th?.dataset.row != null) this._select(+th.dataset.row, 0, { extend: true, mode: 'rows', silent: true });
  }

  _onPointerUp(e) {
    clearTimeout(this._pressTimer);
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.kind === 'col') {
      try { this.scroll.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (d.w) this._apply(ops.setWidth(this.text, this.sheetIndex, d.c, d.c, Math.max(2, Math.round((d.w - 12) / 8)), this.book), { select: { range: this._range(), mode: this.sel.mode } });
      return;
    }
    if (d.moved) this._mirrorToEditor();
  }

  _onKey(e) {
    if (e.target !== this.root) return;   // inputs handle their own keys
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const sel = this.sel;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey) {
      switch (k.toLowerCase()) {
        case 'z': stop(); this._act(e.shiftKey ? 'redo' : 'undo'); return;
        case 'y': stop(); this._act('redo'); return;
        case 'b': stop(); this._act('bold'); return;
        case 'i': stop(); this._act('italic'); return;
        case 'u': stop(); this._act('underline'); return;
        case 'a': stop(); this._act('select-all'); return;
        case 'c': case 'x': case 'v': return;   // the copy/cut/paste events do it
        case ' ': stop(); this._select(0, sel.head.c, { mode: 'cols' }); return;
        case 'enter': stop(); this._startEdit(sel.head.r, sel.head.c); return;
        case 'arrowdown': stop(); this._jump(1, 0, e.shiftKey); return;
        case 'arrowup': stop(); this._jump(-1, 0, e.shiftKey); return;
        case 'arrowleft': stop(); this._jump(0, -1, e.shiftKey); return;
        case 'arrowright': stop(); this._jump(0, 1, e.shiftKey); return;
        case 'home': stop(); this._select(0, 0); this._scrollCellIntoView(0, 0); return;
      }
      return;
    }
    switch (k) {
      case 'ArrowDown': stop(); this._move(1, 0, { extend: e.shiftKey }); return;
      case 'ArrowUp': stop(); this._move(-1, 0, { extend: e.shiftKey }); return;
      case 'ArrowLeft': stop(); this._move(0, -1, { extend: e.shiftKey }); return;
      case 'ArrowRight': stop(); this._move(0, 1, { extend: e.shiftKey }); return;
      case 'Tab': stop(); this._move(0, e.shiftKey ? -1 : 1); return;
      case 'Enter': stop(); if (e.altKey) this._startEdit(sel.head.r, sel.head.c); else this._move(e.shiftKey ? -1 : 1, 0); return;
      case 'F2': stop(); this._startEdit(sel.head.r, sel.head.c); return;
      case 'Delete': case 'Backspace': stop(); this._act('clear'); return;
      case 'Escape': stop(); this._closePop(); return;
      case 'Home': stop(); this._select(sel.head.r, 0, { extend: e.shiftKey }); this._scrollCellIntoView(sel.head.r, 0); return;
      case 'End': { stop(); const c = Math.max(0, (this.sheet?.cols ?? 1) - 1); this._select(sel.head.r, c, { extend: e.shiftKey }); this._scrollCellIntoView(sel.head.r, c); return; }
      case 'PageDown': stop(); this._move(20, 0, { extend: e.shiftKey }); return;
      case 'PageUp': stop(); this._move(-20, 0, { extend: e.shiftKey }); return;
      case ' ': if (e.shiftKey) { stop(); this._select(sel.head.r, 0, { mode: 'rows' }); return; } break;
    }
    // A printable character starts editing with it (replacing the cell).
    if (k.length === 1 && !e.altKey) { stop(); this._startEdit(sel.head.r, sel.head.c, k); }
  }

  /** Ctrl+arrow: to the edge of the data block. */
  _jump(dr, dc, extend) {
    const sheet = this.sheet;
    let { r, c } = this.sel.head;
    const has = (rr, cc) => !!this._cellText(rr, cc);
    const maxR = (sheet?.rows.length ?? 1) - 1, maxC = (sheet?.cols ?? 1) - 1;
    const step = () => { r += dr; c += dc; };
    const inBounds = () => r >= 0 && c >= 0 && r <= maxR && c <= maxC;
    if (has(r, c) && (inBounds() ? has(r + dr, c + dc) : false)) { while (inBounds() && has(r + dr, c + dc)) step(); }
    else { step(); while (inBounds() && !has(r, c)) step(); if (!inBounds()) { r = Math.max(0, Math.min(r, maxR)); c = Math.max(0, Math.min(c, maxC)); } }
    this._select(r, c, { extend });
    this._scrollCellIntoView(r, c);
  }

  // ---------------------------------------------------------------------------
  // Popovers
  // ---------------------------------------------------------------------------

  _openPop(html, anchor) {
    const pop = this.pop;
    pop.innerHTML = html;
    pop.hidden = false;
    const rr = this.root.getBoundingClientRect();
    let x = 12, y = 60;
    if (anchor instanceof Element) { const a = anchor.getBoundingClientRect(); x = a.left - rr.left; y = a.bottom - rr.top + 4; }
    else if (anchor && anchor.x != null) { x = anchor.x - rr.left; y = anchor.y - rr.top; }
    pop.style.left = '0px'; pop.style.top = '0px';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    x = Math.max(4, Math.min(x, rr.width - pw - 4));
    y = Math.max(4, Math.min(y, rr.height - ph - 4));
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
    pop.querySelector('[autofocus]')?.focus();
    return pop;
  }
  _closePop() { if (!this.pop.hidden) { this.pop.hidden = true; this.pop.innerHTML = ''; } }

  _openMenu(items, anchor) {
    const pop = this._openPop(`<div class="uf-ss-menu">${items.map(([id, label, disabled]) => id === '-' ? '<div class="uf-ss-menu-sep"></div>' : `<button type="button" data-menu="${id}"${disabled ? ' disabled' : ''}>${label}</button>`).join('')}</div>`, anchor);
    pop.querySelector('.uf-ss-menu').addEventListener('click', e => {
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      const id = b.dataset.menu;
      this._closePop();
      this._act(id, { target: this.bar.querySelector(`[data-act="${id}"]`) ?? this.bar });
    });
  }

  _openContextMenu(at) {
    const mode = this.sel.mode;
    const items = [];
    if (mode === 'rows') items.push(['insert-row-above', 'Insert row above'], ['insert-row-below', 'Insert row below'], ['delete-row', 'Delete row(s)'], ['hide-rows', 'Hide row(s)'], ['unhide-rows', 'Unhide all rows'], ['height', 'Row height…'], ['-'], ['header-rows', 'Header rows end here'], ['freeze-rows', 'Freeze rows above']);
    else if (mode === 'cols') items.push(['insert-col-left', 'Insert column left'], ['insert-col-right', 'Insert column right'], ['delete-col', 'Delete column(s)'], ['hide-cols', 'Hide column(s)'], ['unhide-cols', 'Unhide all columns'], ['width', 'Column width…'], ['-'], ['sort-asc', 'Sort rows A → Z'], ['sort-desc', 'Sort rows Z → A'], ['filter', 'Filter…'], ['freeze-cols', 'Freeze columns left']);
    else items.push(['cut', 'Cut'], ['copy', 'Copy'], ['paste', 'Paste'], ['clear', 'Clear'], ['-'], ['comment', 'Comment…'], ['merge', 'Merge / unmerge'], ['-'], ['insert-row-above', 'Insert row above'], ['insert-row-below', 'Insert row below'], ['insert-col-left', 'Insert column left'], ['insert-col-right', 'Insert column right'], ['delete-row', 'Delete row'], ['delete-col', 'Delete column']);
    this._openMenu(items, at);
  }

  _openMorePop(anchor) {
    const sh = this.sheet;
    this._openMenu([
      ['freeze-rows', 'Freeze rows through the selected row'], ['freeze-cols', 'Freeze columns through the selected column'], ['freeze-none', 'Unfreeze', !sh || (!sh.freeze.rows && !sh.freeze.cols)], ['-'],
      ['header-rows', sh?.headerRows ? `Header rows: ${sh.headerRows} (toggle at the selected row)` : 'Make rows through the selected row the header'], ['-'],
      ['view-sort-asc', 'View sorted by this column ↑'], ['view-sort-desc', 'View sorted by this column ↓'], ['view-sort-clear', 'Clear view sort', !sh?.sorts.length], ['filter-clear', 'Clear all filters', !sh?.filters.length], ['-'],
      ['filter-on', sh?.filterOn ? 'Hide the header filter buttons' : 'Show filter buttons on the header'], ['-'],
      ['hide-rows', 'Hide selected rows'], ['hide-cols', 'Hide selected columns'], ['unhide-rows', 'Unhide all rows', !sh?.hidden.rows.size], ['unhide-cols', 'Unhide all columns', !sh?.hidden.cols.size], ['-'],
      ['sequence', 'Fill with a sequence…'], ['-'],
      ['width', 'Column width…'], ['height', 'Row height…'], ['scale', 'Colour scale…'], ['-'],
      ['rename-sheet', 'Rename sheet…'], ['add-sheet', 'Add sheet…'], ['delete-sheet', 'Delete sheet'], ['-'],
      ['align-text', 'Tidy the text (align pipes)'],
    ], anchor);
  }

  _openFormatPop(anchor) {
    const cell = this._cell(this.sel.head.r, this.sel.head.c);
    const cur = (cell && this.book.styleOf(cell).format) ?? null;
    const pop = this._openPop(`<div class="uf-ss-menu">${FORMAT_CHOICES.map(([v, label]) => `<button type="button" data-fmt="${esc(v)}"${(cur ?? 'general') === v || (v === 'text' && cur === '@') ? ' class="is-on"' : ''}>${esc(label)}</button>`).join('')}
      <div class="uf-ss-menu-sep"></div><form class="uf-ss-form uf-ss-inline"><input name="fmt" placeholder="Custom, e.g. #,##0.0" value="${esc(cur && !FORMAT_CHOICES.some(([v]) => v === cur) ? cur : '')}"><button type="submit">Apply</button></form></div>`, anchor);
    pop.addEventListener('click', e => { const b = e.target.closest('[data-fmt]'); if (!b) return; const v = b.dataset.fmt; this._closePop(); this._setProp({ format: v === 'general' ? null : v === 'text' ? '@' : v }); });
    pop.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const v = e.target.fmt.value.trim(); this._closePop(); if (v) this._setProp({ format: v }); });
  }

  _openColorPop(key, anchor) {
    const cell = this._cell(this.sel.head.r, this.sel.head.c);
    const cur = (cell && this.book.styleOf(cell)[key]) ?? null;
    const pop = this._openPop(`<div class="uf-ss-swatches">${PALETTE.map(c => `<button type="button" class="uf-ss-swatch${cur === c ? ' is-on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <button type="button" class="uf-ss-swatch is-none" data-color="" title="None">×</button>
      <label class="uf-ss-swatch is-custom" title="Custom…"><input type="color" value="${esc(cur && cur.startsWith('#') && cur.length === 7 ? cur : '#1a8cf5')}">+</label></div>`, anchor);
    pop.addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (!b) return; this._closePop(); this._setProp({ [key]: b.dataset.color || null }); });
    pop.querySelector('input[type=color]').addEventListener('change', e => { this._closePop(); this._setProp({ [key]: e.target.value }); });
  }

  _openBorderPop(anchor) {
    this._openMenu([['border:all', 'All borders'], ['border:top', 'Top'], ['border:bottom', 'Bottom'], ['border:left', 'Left'], ['border:right', 'Right'], ['border:none', 'No border']], anchor);
  }

  _openFilterPop(col, anchor) {
    const sh = this.sheet;
    const cur = sh?.filters.find(f => f.col === col);
    const kinds = [['cmp', 'is'], ['between', 'between'], ['contains', 'contains'], ['starts', 'starts with'], ['ends', 'ends with'], ['blank', 'is blank'], ['filled', 'is not blank'], ['top', 'top N'], ['bottom', 'bottom N'], ['formula', 'formula']];
    const pop = this._openPop(`<form class="uf-ss-form"><div class="uf-ss-form-title">Filter column ${colLetter(col)}</div>
      ${conditionFormHtml(cur?.cond, kinds)}
      <div class="uf-ss-form-row"><button type="submit">Apply</button><button type="button" data-clear>Clear</button>${sh?.filters.length ? '<button type="button" data-clearall>Clear all</button>' : ''}</div></form>`, anchor);
    wireConditionForm(pop);
    pop.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const cond = conditionFromForm(e.target);
      if (cond.error) { window.alert(cond.error); return; }
      this._closePop();
      this._apply(ops.setFilter(this.text, this.sheetIndex, col, cond, this.book), { select: { range: this._range(), mode: this.sel.mode } });
    });
    pop.querySelector('[data-clear]').addEventListener('click', () => { this._closePop(); this._apply(ops.setFilter(this.text, this.sheetIndex, col, null, this.book)); });
    pop.querySelector('[data-clearall]')?.addEventListener('click', () => { this._closePop(); this._act('filter-clear'); });
  }

  _openCommentPop(r, c, anchor) {
    const cur = this.sheet?.comments.find(x => x.r === r && x.c === c);
    const td = this._anchorTd(r, c);
    const pop = this._openPop(`<form class="uf-ss-form"><div class="uf-ss-form-title">Comment on ${colLetter(c)}${r + 1}</div>
      <textarea name="text" rows="3" autofocus placeholder="Note for this cell">${esc(cur?.text ?? '')}</textarea>
      <div class="uf-ss-form-row"><button type="submit">Save</button>${cur ? '<button type="button" data-remove>Remove</button>' : ''}</div></form>`, td ?? anchor);
    pop.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const t = e.target.text.value; this._closePop(); this._apply(ops.setComment(this.text, this.sheetIndex, r, c, t, this.book), { select: { r, c } }); });
    pop.querySelector('[data-remove]')?.addEventListener('click', () => { this._closePop(); this._apply(ops.setComment(this.text, this.sheetIndex, r, c, '', this.book), { select: { r, c } }); });
    pop.querySelector('textarea').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); pop.querySelector('form').requestSubmit(); } e.stopPropagation(); });
  }

  _openRulesPop(anchor) {
    const sh = this.sheet;
    const rules = sh?.rules ?? [];
    const scales = sh?.scales ?? [];
    const kinds = [['cmp', 'is'], ['between', 'between'], ['contains', 'contains'], ['starts', 'starts with'], ['ends', 'ends with'], ['blank', 'is blank'], ['filled', 'is not blank'], ['error', 'is an error'], ['duplicate', 'is a duplicate'], ['unique', 'is unique'], ['top', 'top N'], ['bottom', 'bottom N'], ['formula', 'formula is true']];
    const list = rules.map((r, i) => `<div class="uf-ss-rule"><code>${esc(formatRange(r.range))}</code> ${esc(describeCondition(r.cond))} → <code>${esc(formatStyleProps(r.props))}</code><button type="button" data-del-rule="${i}" title="Remove">×</button></div>`).join('') +
      scales.map((s, i) => `<div class="uf-ss-rule"><code>${esc(formatRange(s.range))}</code> colour scale ${s.colors.map(c => `<span class="uf-ss-dot" style="background:${esc(c)}"></span>`).join('')}<button type="button" data-del-scale="${i}" title="Remove">×</button></div>`).join('');
    const pop = this._openPop(`<form class="uf-ss-form uf-ss-rules"><div class="uf-ss-form-title">Conditional formatting</div>
      ${list ? `<div class="uf-ss-rule-list">${list}</div>` : '<div class="uf-ss-muted">No rules yet.</div>'}
      <div class="uf-ss-form-title">New rule</div>
      <label>Range <input name="range" value="${esc(formatRange(this._directiveRange()))}"></label>
      ${conditionFormHtml(null, kinds)}
      <div class="uf-ss-form-row uf-ss-props">
        <label><input type="checkbox" name="bold"> <b>B</b></label><label><input type="checkbox" name="italic"> <i>I</i></label><label><input type="checkbox" name="underline"> <u>U</u></label><label><input type="checkbox" name="strike"> <s>S</s></label>
        <label>Text <input type="color" name="color" value="#c0392b"><input type="checkbox" name="useColor" checked></label>
        <label>Fill <input type="color" name="bg" value="#fde2e2"><input type="checkbox" name="useBg"></label>
      </div>
      <div class="uf-ss-form-row"><button type="submit">Add rule</button><button type="button" data-scale>Colour scale…</button></div></form>`, anchor);
    wireConditionForm(pop);
    pop.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target;
      const R = parseRange(f.range.value.trim());
      if (!R) { window.alert('Range: use A1, A1:C9, A or 3'); return; }
      const cond = conditionFromForm(f);
      if (cond.error) { window.alert(cond.error); return; }
      const props = {};
      for (const k of ['bold', 'italic', 'underline', 'strike']) if (f[k].checked) props[k] = true;
      if (f.useColor.checked) props.color = f.color.value;
      if (f.useBg.checked) props.bg = f.bg.value;
      if (!Object.keys(props).length) { window.alert('Pick at least one style for the rule.'); return; }
      this._closePop();
      this._apply(ops.addRule(this.text, this.sheetIndex, R, cond, props, this.book), { select: { range: this._range(), mode: this.sel.mode } });
    });
    pop.addEventListener('click', e => {
      const d = e.target.closest('[data-del-rule]'); if (d) { this._closePop(); this._apply(ops.removeRule(this.text, this.sheetIndex, +d.dataset.delRule, this.book)); return; }
      const s = e.target.closest('[data-del-scale]'); if (s) { this._closePop(); this._apply(ops.removeScale(this.text, this.sheetIndex, +s.dataset.delScale, this.book)); return; }
      if (e.target.closest('[data-scale]')) { this._openScalePop(anchor); }
    });
  }

  _openScalePop(anchor) {
    const pop = this._openPop(`<form class="uf-ss-form"><div class="uf-ss-form-title">Colour scale</div>
      <label>Range <input name="range" value="${esc(formatRange(this._directiveRange()))}"></label>
      <div class="uf-ss-form-row"><label>Low <input type="color" name="lo" value="#ffffff"></label><label><input type="checkbox" name="useMid"> Mid <input type="color" name="mid" value="#fff4c2"></label><label>High <input type="color" name="hi" value="#1a8cf5"></label></div>
      <div class="uf-ss-form-row"><button type="submit">Apply</button></div></form>`, anchor);
    pop.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target;
      const R = parseRange(f.range.value.trim());
      if (!R) { window.alert('Range: use A1:C9, A or 3'); return; }
      const colors = f.useMid.checked ? [f.lo.value, f.mid.value, f.hi.value] : [f.lo.value, f.hi.value];
      this._closePop();
      this._apply(ops.addScale(this.text, this.sheetIndex, R, colors, this.book), { select: { range: this._range(), mode: this.sel.mode } });
    });
  }

  destroy() {
    this._unsub.forEach(fn => fn());
    this._ro?.disconnect();
    document.removeEventListener('pointerdown', this._onDocPointer);
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
// Small HTML helpers
// ---------------------------------------------------------------------------

function btn(act, html, title) {
  return `<button type="button" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${html}</button>`;
}

/** The shared condition sub-form (filters and rules). */
function conditionFormHtml(cond, kinds) {
  const kind = cond?.kind ?? 'cmp';
  const ops = [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['=', '='], ['<>', '≠']];
  return `<div class="uf-ss-form-row uf-ss-cond">
    <select name="kind">${kinds.map(([k, l]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <select name="op" data-for="cmp">${ops.map(([k, l]) => `<option value="${k}"${cond?.op === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <input name="value" data-for="cmp contains starts ends top bottom formula" placeholder="value" value="${esc(cond ? (cond.value ?? cond.text ?? cond.n ?? (cond.formula != null ? '=' + cond.formula : '')) : '')}">
    <input name="a" data-for="between" placeholder="from" value="${esc(cond?.a ?? '')}"><span data-for="between">and</span><input name="b" data-for="between" placeholder="to" value="${esc(cond?.b ?? '')}">
  </div>`;
}
function wireConditionForm(pop) {
  const sync = () => {
    const kind = pop.querySelector('[name=kind]').value;
    for (const el of pop.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(kind);
  };
  pop.querySelector('[name=kind]').addEventListener('change', sync);
  sync();
}
function conditionFromForm(f) {
  const kind = f.kind.value;
  const v = f.value?.value?.trim() ?? '';
  const quoteIfText = (s) => (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s) || /^(true|false)$/i.test(s) || /^[A-Za-z]{1,3}\d+$/.test(s) || s.startsWith('=') ? s.replace(/^=/, '') : '"' + s.replace(/"/g, '""') + '"');
  switch (kind) {
    case 'cmp': return v === '' ? { error: 'Enter a value' } : parseCondition([f.op.value, quoteIfText(v)]);
    case 'between': return parseCondition(['between', quoteIfText(f.a.value.trim()), 'and', quoteIfText(f.b.value.trim())]);
    case 'contains': case 'starts': case 'ends': return v === '' ? { error: 'Enter the text' } : { kind, text: v };
    case 'top': case 'bottom': return parseCondition([kind, v || '10']);
    case 'formula': return v ? parseCondition([v.startsWith('=') ? v : '=' + v]) : { error: 'Enter a formula' };
    default: return { kind };
  }
}
