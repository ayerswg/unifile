/**
 * {sheet} DSL plugin — a spreadsheet written as Markdown tables.
 *
 * The whole document is the workbook (`wholeDocument: true`): every GFM pipe
 * table is a sheet, the heading above it names the sheet, the prose between is
 * notes.  Inside a table a cell that starts with `=` is a FORMULA (Excel's
 * grammar, A1 references, `Sheet!A1` across sheets, a bare column letter for
 * "this row"), `||` merges a cell across columns and `^^` merges it with the
 * cell above (the MultiMarkdown conventions).  The engine is pure and
 * Node-tested: src/core/sheet/{grid,formula,render}.js.  This module is the
 * DOM half:
 *
 *   • render()   — the Excel-style grid per sheet (column letters, row numbers,
 *                  merged cells, computed values, formulas on hover), every cell
 *                  a click-back target, the cell under the caret highlighted
 *                  with its address · formula · value in a status strip.
 *   • editor     — GFM Markdown highlighting (tables), formulas and references
 *                  tinted, `||` / `^^` marked, formula errors as lint, function
 *                  autocomplete inside a formula, Tab / Shift-Tab = next /
 *                  previous CELL (a new row past the last cell), pasted TSV
 *                  (what a spreadsheet copies) lands as a pipe table,
 *                  Alt-Shift-F aligns the pipes.
 *   • exports    — XLSX (formulas + merges, opens in Excel / Numbers / Sheets),
 *                  CSV (one sheet → .csv, several → a .zip of CSVs), HTML, PDF.
 *
 * The text is the single source of truth: computed values are never written
 * back into it, so a diff is a diff of what you typed.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { markdown as cmMarkdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { keymap, EditorView, Decoration, ViewPlugin, hoverTooltip } from '@codemirror/view';
import { EditorSelection, RangeSetBuilder } from '@codemirror/state';
import { linter } from '@codemirror/lint';
import { registerDSL } from './registry.js';
import { state } from '../ui/state.js';
import { parseGlobalFrontMatter, getFrontMatterRange } from '../core/front-matter.js';
import { schemaCompletions, schemaLint } from '../core/fm-schema.js';
import { buildZip } from '../core/zip.js';
import {
  parseWorkbook, parseRowCells, isTableRow, cellAtOffset, cellAddress, alignTables,
  blankTable, tsvToTable,
} from '../core/sheet/grid.js';
import { evaluateWorkbook, tokenize, FUNCTION_NAMES, isError } from '../core/sheet/formula.js';
import {
  renderWorkbookHtml, displayValue, sheetToCsv, workbookToXlsx, sheetDocument, printDocument, escHtml,
} from '../core/sheet/render.js';

// ---------------------------------------------------------------------------
// Workbook cache — parse + evaluate once per document text
// ---------------------------------------------------------------------------

let _cache = { text: null, wb: null, values: null, errors: null, decimals: null };

function workbookFor(text) {
  const t = text ?? '';
  if (_cache.text === t) return _cache;
  const wb = parseWorkbook(t);
  const { values, errors } = evaluateWorkbook(wb);
  const { meta } = parseGlobalFrontMatter(t);
  const d = meta?.decimals;
  const decimals = d != null && d !== '' && !Number.isNaN(Number(d)) ? Math.max(0, Math.min(10, Math.trunc(Number(d)))) : null;
  _cache = { text: t, wb, values, errors, decimals };
  return _cache;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const _inline = (text) => DOMPurify.sanitize(marked.parseInline(text || ''));
const _prose  = (text) => DOMPurify.sanitize(marked.parse(text || ''));

let _lastEl = null;

async function render(content, el, { cursorPos } = {}) {
  el.innerHTML = '';
  _lastEl = el;
  const { wb, values, decimals } = workbookFor(content);
  if (!wb.sheets.length && !wb.blocks.length) {
    el.innerHTML = `<p class="preview-empty">Write a table — <code>| A | B |</code> rows with <code>|---|---|</code> under the header. A cell starting with <code>=</code> is a formula.</p>`;
    return;
  }
  const book = document.createElement('div');
  book.className = 'uf-sheet-book';
  book.innerHTML =
    `<div class="uf-sheet-status" hidden><span class="uf-sheet-status-addr"></span><span class="uf-sheet-status-formula"></span><span class="uf-sheet-status-value"></span></div>` +
    renderWorkbookHtml(wb, values, { decimals, inline: _inline, prose: _prose });
  // Scroll sync: the caret's sheet scrolls into view (preview.js reads these).
  book.querySelectorAll('.uf-sheet-block').forEach(b => {
    const s = wb.sheets[parseInt(b.dataset.sheetIndex, 10)];
    if (!s) return;
    b.dataset.pageContentFrom = Math.min(s.nameFrom, s.from);
    b.dataset.pageContentTo = s.to;
  });
  el.appendChild(book);
  _setActive(el, cursorPos ?? null);
}

/** Highlight the cell under the caret and fill the status strip. */
function _setActive(el, pos) {
  if (!el?.isConnected) return;
  const { wb, values, decimals } = workbookFor(state.currentContent);
  el.querySelectorAll('.uf-cell.is-active').forEach(c => c.classList.remove('is-active'));
  el.querySelectorAll('.uf-sheet-col.is-active, .uf-sheet-row.is-active').forEach(c => c.classList.remove('is-active'));
  const status = el.querySelector('.uf-sheet-status');
  const hit = pos != null ? cellAtOffset(wb, pos) : null;
  if (!hit?.cell || hit.cell.merged) { if (status) status.hidden = true; return; }
  const { sheet, cell } = hit;
  const addr = cellAddress(cell.r, cell.c);
  const table = el.querySelector(`.uf-sheet-block[data-sheet-index="${sheet.index}"] table`);
  const td = table?.querySelector(`[data-addr="${addr}"]`);
  if (td) {
    td.classList.add('is-active');
    table.querySelector(`.uf-sheet-col[data-col="${cell.c}"]`)?.classList.add('is-active');
    table.querySelector(`.uf-sheet-row[data-row="${cell.r}"]`)?.classList.add('is-active');
  }
  if (status) {
    const v = values.get(cell);
    status.hidden = false;
    status.querySelector('.uf-sheet-status-addr').textContent = (wb.sheets.length > 1 ? sheet.name + '!' : '') + addr;
    status.querySelector('.uf-sheet-status-formula').textContent = cell.formula != null ? '=' + cell.formula : '';
    const val = status.querySelector('.uf-sheet-status-value');
    val.textContent = cell.formula != null ? displayValue(cell, v, { decimals }) + (isError(v) && v.detail ? '  (' + v.detail + ')' : '') : '';
    val.classList.toggle('is-error', isError(v));
  }
}

// The caret moves without an edit → re-point the active cell (no re-render).
state.on('editor-select', ({ from }) => { if (_lastEl) _setActive(_lastEl, from); });

function renderToString(content) {
  const { wb, values, decimals } = workbookFor(content);
  return `<div class="uf-sheet-book">${renderWorkbookHtml(wb, values, { decimals, inline: _inline, prose: _prose, docOffsets: false })}</div>`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const _title = () => state.data?.title || 'Sheet';

async function exportXlsx(content) {
  const { wb, values, decimals } = workbookFor(content);
  const bytes = workbookToXlsx(wb, values, { decimals, title: _title() });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function _safeName(s) {
  return String(s || 'sheet').replace(/[\\/:*?"<>|]/g, '-').trim() || 'sheet';
}

/** One sheet → CSV; several → a ZIP holding `<name>.csv` per sheet. */
async function exportCsv(content) {
  const { wb, values, decimals } = workbookFor(content);
  if (wb.sheets.length <= 1) {
    const s = wb.sheets[0];
    return new Blob([s ? sheetToCsv(s, values, { decimals }) : ''], { type: 'text/csv' });
  }
  const used = new Set();
  const entries = wb.sheets.map(s => {
    let name = _safeName(s.name), k = 2;
    while (used.has(name.toLowerCase())) name = `${_safeName(s.name)} (${k++})`;
    used.add(name.toLowerCase());
    return { name: `${name}.csv`, data: sheetToCsv(s, values, { decimals }) };
  });
  return new Blob([buildZip(entries)], { type: 'application/zip' });
}

async function exportHtml(content) {
  const { wb, values, decimals } = workbookFor(content);
  return new Blob([sheetDocument(wb, values, { title: _title(), decimals, inline: _inline, prose: _prose })], { type: 'text/html' });
}

async function exportPdf(content) {
  const { wb, values, decimals } = workbookFor(content);
  const win = window.open('', '_blank');
  if (!win) return null;
  win.document.open();
  win.document.write(printDocument(wb, values, { title: _title(), decimals, inline: _inline, prose: _prose }));
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 300);
  return null;
}

// ---------------------------------------------------------------------------
// Editor — formula / span highlighting
// ---------------------------------------------------------------------------

const DECO = {
  formula: Decoration.mark({ class: 'cm-sheet-formula' }),
  ref:     Decoration.mark({ class: 'cm-sheet-ref' }),
  fn:      Decoration.mark({ class: 'cm-sheet-fn' }),
  str:     Decoration.mark({ class: 'cm-sheet-str' }),
  span:    Decoration.mark({ class: 'cm-sheet-span' }),
  pipe:    Decoration.mark({ class: 'cm-sheet-pipe' }),
};

function _buildSheetDecos(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let n = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (; n <= last; n++) {
      const line = doc.line(n);
      if (!isTableRow(line.text)) continue;
      const marks = [];
      // Every pipe recedes like a Markdown mark.
      for (let i = 0; i < line.text.length; i++) {
        if (line.text[i] === '|' && line.text[i - 1] !== '\\') marks.push([line.from + i, line.from + i + 1, DECO.pipe]);
      }
      for (const cell of parseRowCells(line.text)) {
        const t = cell.raw;
        const lead = t.length - t.trimStart().length;
        const start = line.from + cell.from + lead;
        const text = t.trim();
        if (text === '^^') { marks.push([start, start + 2, DECO.span]); continue; }
        if (cell.colspan > 1) {
          // The extra pipes of a span.
          const firstPipe = line.from + cell.from + t.length;
          for (let k = 0; k < cell.colspan - 1; k++) marks.push([firstPipe + k, firstPipe + k + 1, DECO.span]);
        }
        if (!text.startsWith('=') || text.length < 2) continue;
        marks.push([start, start + 1, DECO.formula]);
        try {
          for (const tok of tokenize(text.slice(1))) {
            const a = start + 1 + tok.from, b = start + 1 + tok.to;
            if (tok.type === 'ref') marks.push([a, b, DECO.ref]);
            else if (tok.type === 'name') marks.push([a, b, DECO.fn]);
            else if (tok.type === 'str') marks.push([a, b, DECO.str]);
          }
        } catch { /* a half-typed formula: no token marks */ }
      }
      marks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let lastTo = -1;
      for (const [a, b, d] of marks) { if (a < lastTo || a >= b) continue; builder.add(a, b, d); lastTo = b; }
    }
  }
  return builder.finish();
}

const sheetDecoPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = _buildSheetDecos(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = _buildSheetDecos(u.view); }
}, { decorations: v => v.decorations });

// ---------------------------------------------------------------------------
// Editor — lint (formula errors) + hover (computed value)
// ---------------------------------------------------------------------------

function sheetLint(view) {
  const text = view.state.doc.toString();
  const { errors } = workbookFor(text);
  const out = errors.map(({ cell, error }) => ({
    from: cell.from, to: cell.to, severity: 'warning',
    message: error.code + (error.detail ? ` — ${error.detail}` : ''),
  }));
  // Front-matter keys.
  const region = getFrontMatterRange(text);
  if (region) out.push(...schemaLint(sheetFrontMatterSchema, region));
  return out.map(d => ({ ...d, from: Math.max(0, Math.min(d.from, text.length)), to: Math.max(0, Math.min(d.to, text.length)) }))
    .filter(d => d.from <= d.to);
}

const sheetHover = hoverTooltip((view, pos) => {
  const { wb, values, decimals } = workbookFor(view.state.doc.toString());
  const hit = cellAtOffset(wb, pos);
  if (!hit?.cell || hit.cell.formula == null) return null;
  const { sheet, cell } = hit;
  const v = values.get(cell);
  return {
    pos: cell.from, end: cell.to, above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-sheet-hover';
      dom.innerHTML = `<b>${escHtml((wb.sheets.length > 1 ? sheet.name + '!' : '') + cellAddress(cell.r, cell.c))}</b> ${escHtml(displayValue(cell, v, { decimals }))}` +
        (isError(v) && v.detail ? `<div class="cm-sheet-hover-detail">${escHtml(v.detail)}</div>` : '');
      return { dom };
    },
  };
});

// ---------------------------------------------------------------------------
// Editor — completion: function names inside a formula, front-matter keys
// ---------------------------------------------------------------------------

const sheetFrontMatterSchema = {
  title:    { type: 'string', doc: 'Workbook title (the top bar, the export file names).' },
  decimals: { type: 'number', doc: 'Show non-integer formula results with this many decimals (e.g. `2`). Omit for Excel\'s General format.' },
};

const FN_OPTIONS = FUNCTION_NAMES.map(n => ({ label: n, type: 'function', apply: n + '(', boost: n === 'SUM' ? 2 : 0 }));

function sheetComplete(context) {
  const doc = context.state.doc;
  const region = getFrontMatterRange(doc.toString());
  if (region && context.pos <= region.bodyFrom) {
    try { return schemaCompletions(sheetFrontMatterSchema, region, context.pos, context.explicit); } catch { return null; }
  }
  const line = doc.lineAt(context.pos);
  if (!isTableRow(line.text)) return null;
  const col = context.pos - line.from;
  // Inside a formula cell: the text from the cell's `=` to the caret.
  let cellStart = line.text.lastIndexOf('|', col - 1);
  while (cellStart > 0 && line.text[cellStart - 1] === '\\') cellStart = line.text.lastIndexOf('|', cellStart - 1);
  const cellText = line.text.slice(cellStart + 1, col);
  if (!/^\s*=/.test(cellText)) return null;
  const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(cellText);
  if (!word || (word[0].length < 2 && !context.explicit)) return null;
  // A1-looking words are references, not functions.
  if (/^[A-Za-z]{1,3}\d+$/.test(word[0])) return null;
  return { from: context.pos - word[0].length, options: FN_OPTIONS, validFor: /^[A-Za-z_][A-Za-z0-9_.]*$/ };
}

// ---------------------------------------------------------------------------
// Editor — Tab / Shift-Tab = next / previous cell
// ---------------------------------------------------------------------------

/** A row's cells: selectable content range + the pipe-to-pipe range (absolute offsets). */
function _cellRanges(line) {
  return parseRowCells(line.text).map(c => {
    const lead = c.raw.length - c.raw.trimStart().length;
    const trail = c.raw.length - c.raw.trimEnd().length;
    const from = line.from + c.from + Math.min(lead, Math.max(0, c.raw.length - (c.colspan - 1)));
    const to = Math.max(from, line.from + c.from + c.raw.length - trail);
    return { from, to, rawFrom: line.from + c.from, rawTo: line.from + c.to };
  });
}

function _moveCell(view, dir) {
  const { state: s } = view;
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  if (!isTableRow(line.text)) return false;
  const cells = _cellRanges(line);
  if (!cells.length) return false;
  // The caret's cell by its pipes; on the pipe itself = the cell before it.
  let idx = cells.findIndex(c => head >= c.rawFrom - 1 && head <= c.rawTo);
  if (idx < 0) idx = head < cells[0].rawFrom ? -1 : cells.length - 1;
  let target = null;
  if (dir > 0) {
    if (idx + 1 < cells.length) target = cells[idx + 1];
    else {
      // Past the last cell: the next row's first cell, or a new row.
      if (line.number < s.doc.lines) {
        const nxt = s.doc.line(line.number + 1);
        if (isTableRow(nxt.text)) {
          const nc = _cellRanges(nxt);
          // Skip a separator row.
          if (/^\s*\|[\s:|-]+\|\s*$/.test(nxt.text) && line.number + 1 < s.doc.lines) {
            const nn = s.doc.line(line.number + 2);
            if (isTableRow(nn.text)) { const r = _cellRanges(nn); if (r.length) target = r[0]; }
          } else if (nc.length) target = nc[0];
        }
      }
      if (!target) {
        const cols = parseRowCells(line.text).reduce((n, c) => n + c.colspan, 0) || 1;
        const insert = '\n|' + '  |'.repeat(cols);
        view.dispatch({ changes: { from: line.to, insert }, selection: EditorSelection.cursor(line.to + 3), scrollIntoView: true, userEvent: 'input' });
        return true;
      }
    }
  } else {
    if (idx > 0) target = cells[idx - 1];
    else if (line.number > 1) {
      let n = line.number - 1;
      let prev = s.doc.line(n);
      if (/^\s*\|[\s:|-]+\|\s*$/.test(prev.text) && n > 1) prev = s.doc.line(n - 1);
      if (isTableRow(prev.text)) { const r = _cellRanges(prev); if (r.length) target = r[r.length - 1]; }
    }
  }
  if (!target) return false;
  view.dispatch({ selection: EditorSelection.range(target.from, target.to), scrollIntoView: true });
  return true;
}

const cellKeymap = keymap.of([
  { key: 'Tab', run: v => _moveCell(v, 1) },
  { key: 'Shift-Tab', run: v => _moveCell(v, -1) },
]);

// ---------------------------------------------------------------------------
// Editor — paste TSV (a spreadsheet's clipboard) as a table
// ---------------------------------------------------------------------------

const tsvPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const text = event.clipboardData?.getData('text/plain');
    if (!text || !text.includes('\t')) return false;
    const table = tsvToTable(text);
    if (!table) return false;
    event.preventDefault();
    const { from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    // Into a table row: the clipboard's rows replace from this row down? No —
    // keep it simple and predictable: the block lands on its own lines.
    const before = from > line.from ? '\n' : '';
    const after = to < line.to ? '\n' : '';
    view.dispatch({ changes: { from, to, insert: before + table + after }, userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
});

// ---------------------------------------------------------------------------
// Editor — insert a table
// ---------------------------------------------------------------------------

function insertTable() {
  // editor.js places a block on its own lines at the caret (undoable).
  state.emit('editor-insert-block', { text: blankTable(3, 3) });
}

function getEditorExtensions() {
  const md = cmMarkdown({ base: markdownLanguage });
  return [
    md,
    md.language.data.of({ autocomplete: sheetComplete }),
    cellKeymap,
    keymap.of(markdownKeymap),
    sheetDecoPlugin,
    sheetHover,
    linter(sheetLint, { delay: 400 }),
    tsvPaste,
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const sheetDSL = {
  id: 'sheet',
  label: 'Sh',
  version: '1.0.0',
  name: 'Sheet',
  extensions: ['.md'],
  editorMode: 'markdown',
  wholeDocument: true,

  render,
  renderToString,
  print: exportPdf,
  getEditorExtensions,
  frontMatterSchema: sheetFrontMatterSchema,

  /** Alt-Shift-F / the bubble: line the pipes up. */
  alignSource: alignTables,

  actions: [
    { id: 'align', label: 'Align columns', glyph: '⫴', run: ({ editor }) => editor?.alignActiveDsl?.() },
    { id: 'table', label: 'Insert table',  glyph: '▦', run: () => insertTable() },
  ],

  exporters: {
    xlsx: { label: 'Excel workbook', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx', binary: true, export: exportXlsx },
    csv: {
      label: 'CSV',
      // One sheet is a .csv; a workbook of several is a .zip of them.
      get ext()    { return workbookFor(state.currentContent).wb.sheets.length > 1 ? '.zip' : '.csv'; },
      get mime()   { return workbookFor(state.currentContent).wb.sheets.length > 1 ? 'application/zip' : 'text/csv'; },
      get binary() { return workbookFor(state.currentContent).wb.sheets.length > 1; },
      export: exportCsv,
    },
    html: { label: 'HTML', mime: 'text/html', ext: '.html', export: exportHtml },
    pdf:  { label: 'PDF',  mime: 'application/pdf', ext: '.pdf', export: exportPdf },
  },

  detect(content) {
    return /^\s*\|.*\|\s*$/m.test(content) && /^\s*\|[\s:|-]+\|\s*$/m.test(content);
  },
};

registerDSL(sheetDSL);
export default sheetDSL;
