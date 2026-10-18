/**
 * {document} — tables with formulas and merged cells.
 *
 * A GFM pipe table in a {document} is a small spreadsheet.  The engine is
 * pure and Node-tested (src/core/tables/: grid.js parses, formula.js
 * computes, render.js draws + exports); this module is the glue into
 * markdown.js:
 *
 *   • marked      — `markedTablesExtension`: a block tokenizer that claims
 *                   every `| … |` table and renders it with computed values,
 *                   `||` / `^^` merges as colspan/rowspan, and the Excel-style
 *                   rulers (column letters + row numbers) on any table that
 *                   holds a formula.  Values come from the WHOLE document
 *                   (`setTableContext(fullText)` before a parse — cross-table
 *                   references name the heading above a table: `=Budget!D4`).
 *   • DOCX        — `tableTokenToDocx`: the same table as a Word table (merges
 *                   kept, values computed).
 *   • XLSX        — `exportTablesXlsx`: every table as a sheet of a real .xlsx.
 *   • editor      — formulas / references / spans tinted, formula errors as
 *                   lint, the computed value on hover, function completion
 *                   after `=`, Tab / Shift-Tab between cells, TSV paste →
 *                   table, Alt-Shift-F aligns the pipes, Insert table.
 *
 * The text stays the source of truth: values are shown, never written back.
 */

import { marked } from 'marked';
import { keymap, EditorView, Decoration, ViewPlugin, hoverTooltip } from '@codemirror/view';
import { EditorSelection, Prec, RangeSetBuilder } from '@codemirror/state';
import {
  Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType,
} from 'docx';
import { state } from '../ui/state.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import {
  parseWorkbook, parseRowCells, isTableRow, cellAtOffset, cellAddress, alignTables, blankTable, tsvToTable,
} from '../core/tables/grid.js';
import { evaluateWorkbook, tokenize, FUNCTION_NAMES, isError } from '../core/tables/formula.js';
import { FN_DETAIL } from '../core/tables/formula-help.js';
import { renderSheetHtml, displayValue, valueKind, workbookToXlsx, escHtml } from '../core/tables/render.js';

export { alignTables };

// ---------------------------------------------------------------------------
// Workbook cache — parse + evaluate once per document text
// ---------------------------------------------------------------------------

let _cache = { text: null, wb: null, values: null, errors: null, decimals: null };

/** The parsed + computed workbook for a document text (memoised on the text). */
export function workbookFor(text) {
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

/** True when a table carries at least one formula (→ it gets the rulers). */
export function hasFormula(sheet) {
  return sheet.cells.some(c => c.formula != null);
}

// ---------------------------------------------------------------------------
// marked — the block extension
// ---------------------------------------------------------------------------

// The workbook the renderer reads from, and how many copies of each table
// text it has already handed out (two identical tables are matched in order).
let _ctx = { book: null, seen: new Map() };

/**
 * Point the renderer at the document the next `marked.parse` draws from.
 * markdown.js calls this with the FULL text (state.currentContent for the
 * preview, the export's content for exports) — layouts parse the document in
 * slices, and a slice cannot compute `=Budget!D4`.
 */
export function setTableContext(fullText) {
  _ctx = { book: workbookFor(fullText), seen: new Map() };
}

/** The sheet whose source is `raw`, matched in document order. */
function sheetForRaw(raw) {
  const key = raw.replace(/\s+$/, '');
  const book = _ctx.book;
  if (book) {
    const matches = book.wb.sheets.filter(s => book.text.slice(s.from, s.to).replace(/\s+$/, '') === key);
    const n = _ctx.seen.get(key) || 0;
    _ctx.seen.set(key, n + 1);
    const s = matches[n] ?? matches[0];
    if (s) return { sheet: s, values: book.values, decimals: book.decimals };
  }
  // Not part of the current document (a stale render, a detached parse):
  // compute the table on its own.
  const local = workbookFor(key);
  const s = local.wb.sheets[0];
  return s ? { sheet: s, values: local.values, decimals: local.decimals } : null;
}

const TABLE_START_RE = /(?:^|\n)[ ]{0,3}\|[^\n]*\|[ \t]*(?=\n|$)/;
const TABLE_RE = /^(?:[ ]{0,3}\|[^\n]*\|[ \t]*(?:\n|$))+/;

const _inline = (text) => marked.parseInline(text || '');

export const markedTablesExtension = {
  name: 'ufTable',
  level: 'block',
  start(src) { return src.match(TABLE_START_RE)?.index ?? -1; },
  tokenizer(src) {
    const m = TABLE_RE.exec(src);
    if (!m) return;
    // Every row must be a real `| … |` row; otherwise leave it to marked's
    // own GFM table tokenizer.
    const lines = m[0].replace(/\n$/, '').split('\n');
    if (!lines.every(isTableRow)) return;
    return { type: 'ufTable', raw: m[0] };
  },
  renderer(token) {
    const hit = sheetForRaw(token.raw);
    if (!hit) return '';
    const { sheet, values, decimals } = hit;
    return `<div class="uf-sheet-block"><div class="uf-sheet-scroll">` +
      renderSheetHtml(sheet, values, { decimals, inline: _inline, headings: hasFormula(sheet) }) +
      `</div></div>\n`;
  },
};

// ---------------------------------------------------------------------------
// Preview — the cell under the caret
// ---------------------------------------------------------------------------

/**
 * Outline the rendered cell whose source holds the caret (and tint its
 * ruler letter / number) — on every caret move, with no re-render.  Cells
 * carry absolute `data-doc-from/to`; the preview pane is the only live host.
 */
function _markActiveCell(pos) {
  if (typeof document === 'undefined') return;
  const cells = document.querySelectorAll('.preview-content .uf-sheet .uf-cell[data-doc-from]');
  if (!cells.length) return;
  let active = null;
  for (const td of cells) {
    const from = parseInt(td.dataset.docFrom, 10), to = parseInt(td.dataset.docTo, 10);
    // The pipes around a cell count as the cell (a caret right after `| `).
    if (!active && pos >= from - 1 && pos <= to + 1) active = td;
  }
  for (const el of document.querySelectorAll('.preview-content .uf-sheet .is-active')) el.classList.remove('is-active');
  if (!active) return;
  active.classList.add('is-active');
  const table = active.closest('table');
  const addr = /^([A-Z]+)(\d+)$/.exec(active.dataset.addr || '');
  if (table && addr) {
    table.querySelector(`.uf-sheet-col[data-col="${table.querySelectorAll('.uf-sheet-col').length ? [...table.querySelectorAll('.uf-sheet-col')].findIndex(c => c.textContent === addr[1]) : -1}"]`)?.classList.add('is-active');
    table.querySelector(`.uf-sheet-row[data-row="${parseInt(addr[2], 10) - 1}"]`)?.classList.add('is-active');
  }
}
state.on('editor-select', ({ from }) => _markActiveCell(from));
state.on('content-change', ({ cursorPos }) => { if (cursorPos != null) setTimeout(() => _markActiveCell(cursorPos), 350); });

// ---------------------------------------------------------------------------
// DOCX — a ufTable token as a Word table (merges + computed values)
// ---------------------------------------------------------------------------

const TOTAL_TWIPS = 9360;

/** @param token  a `ufTable` marked token (setTableContext first) */
export function tableTokenToDocx(token) {
  const hit = sheetForRaw(token.raw);
  if (!hit) return new Paragraph({ style: 'Normal' });
  const { sheet, values, decimals } = hit;
  const cols = Math.max(sheet.cols, 1);
  const lens = new Array(cols).fill(3);
  for (const c of sheet.cells) {
    if (c.colspan !== 1 || c.merged) continue;
    lens[c.c] = Math.max(lens[c.c], displayValue(c, values.get(c), { decimals }).length + 2);
  }
  const total = lens.reduce((a, b) => a + b, 0);
  const widths = lens.map(l => Math.max(Math.round(l / total * TOTAL_TWIPS), 720));
  const rows = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const cells = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.grid[r][c];
      if (cell && (cell.r !== r || cell.c !== c)) {
        // Covered by a span above: Word needs a continuation cell for a
        // rowspan, nothing for a colspan.
        if (cell.r !== r && cell.c === c) cells.push(new TableCell({ width: { size: widths[c], type: WidthType.DXA }, verticalMerge: 'continue', children: [new Paragraph({ style: 'Normal' })] }));
        continue;
      }
      const v = cell ? values.get(cell) : null;
      const text = cell ? displayValue(cell, v, { decimals }) : '';
      const kind = valueKind(cell, v);
      const align = sheet.aligns[c] ?? (kind === 'num' || kind === 'bool' ? 'right' : 'left');
      const span = cell?.colspan > 1 ? cell.colspan : 1;
      let width = 0;
      for (let k = 0; k < span; k++) width += widths[c + k] ?? 0;
      cells.push(new TableCell({
        width: { size: width, type: WidthType.DXA },
        columnSpan: span > 1 ? span : undefined,
        verticalMerge: cell?.rowspan > 1 ? 'restart' : undefined,
        children: [new Paragraph({
          style: 'Normal',
          alignment: align === 'right' ? AlignmentType.RIGHT : align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: [new TextRun({ text, bold: r < sheet.headerRows || undefined })],
        })],
      }));
    }
    rows.push(new TableRow({ tableHeader: r < sheet.headerRows, children: cells }));
  }
  return new Table({ columnWidths: widths, rows });
}

// ---------------------------------------------------------------------------
// XLSX — every table of the document as a sheet
// ---------------------------------------------------------------------------

export async function exportTablesXlsx(content, opts = {}) {
  const { wb, values, decimals } = workbookFor(content);
  const bytes = workbookToXlsx(wb, values, { decimals, title: opts.title || state.data?.title || 'Document' });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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
};

function _buildDecos(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let n = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (; n <= last; n++) {
      const line = doc.line(n);
      if (!isTableRow(line.text)) continue;
      const marks = [];
      for (const cell of parseRowCells(line.text)) {
        const t = cell.raw;
        const lead = t.length - t.trimStart().length;
        const start = line.from + cell.from + lead;
        const text = t.trim();
        if (text === '^^') { marks.push([start, start + 2, DECO.span]); continue; }
        if (cell.colspan > 1) {
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

const tableDecoPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = _buildDecos(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = _buildDecos(u.view); }
}, { decorations: v => v.decorations });

// ---------------------------------------------------------------------------
// Editor — lint (formula errors) + hover (the computed value)
// ---------------------------------------------------------------------------

/** Diagnostics for every formula error in the document (merged by markdownLint). */
export function tableLint(view) {
  const text = view.state.doc.toString();
  const { errors } = workbookFor(text);
  return errors.map(({ cell, error }) => ({
    from: Math.min(cell.from, text.length), to: Math.min(cell.to, text.length), severity: 'warning',
    message: error.code + (error.detail ? ` — ${error.detail}` : ''),
  })).filter(d => d.from <= d.to);
}

const tableHover = hoverTooltip((view, pos) => {
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
// Editor — completion: function names inside a formula cell
// ---------------------------------------------------------------------------

const FN_OPTIONS = FUNCTION_NAMES.map(n => ({ label: n, type: 'function', apply: n + '(', detail: FN_DETAIL[n] ?? '', boost: n === 'SUM' ? 2 : 0 }));

/** Null when the caret is not in a formula cell (markdownComplete falls through). */
export function tableComplete(context) {
  const doc = context.state.doc;
  const line = doc.lineAt(context.pos);
  if (!isTableRow(line.text)) return null;
  const col = context.pos - line.from;
  let cellStart = line.text.lastIndexOf('|', col - 1);
  while (cellStart > 0 && line.text[cellStart - 1] === '\\') cellStart = line.text.lastIndexOf('|', cellStart - 1);
  const cellText = line.text.slice(cellStart + 1, col);
  if (!/^\s*=/.test(cellText)) return null;
  const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(cellText);
  if (!word) {
    // Right after `=` or an operator: offer the list on an explicit request.
    return context.explicit ? { from: context.pos, options: FN_OPTIONS, validFor: /^[A-Za-z_][A-Za-z0-9_.]*$/ } : null;
  }
  if (word[0].length < 2 && !context.explicit) return null;
  // A1-looking words are references, not functions.
  if (/^[A-Za-z]{1,3}\d+$/.test(word[0])) return null;
  return { from: context.pos - word[0].length, options: FN_OPTIONS, validFor: /^[A-Za-z_][A-Za-z0-9_.]*$/ };
}

// ---------------------------------------------------------------------------
// Editor — Tab / Shift-Tab = next / previous cell
// ---------------------------------------------------------------------------

const SEP_ROW_RE = /^\s*\|[\s:|-]+\|\s*$/;

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
  let idx = cells.findIndex(c => head >= c.rawFrom - 1 && head <= c.rawTo);
  if (idx < 0) idx = head < cells[0].rawFrom ? -1 : cells.length - 1;
  let target = null;
  if (dir > 0) {
    if (idx + 1 < cells.length) target = cells[idx + 1];
    else {
      // Past the last cell: the next row's first cell (skipping the |---|
      // separator), or a new row of the same width.
      let n = line.number + 1;
      if (n <= s.doc.lines && SEP_ROW_RE.test(s.doc.line(n).text)) n++;
      if (n <= s.doc.lines && isTableRow(s.doc.line(n).text)) {
        const r = _cellRanges(s.doc.line(n));
        if (r.length) target = r[0];
      }
      if (!target) {
        const cols = parseRowCells(line.text).reduce((k, c) => k + c.colspan, 0) || 1;
        const insert = '\n|' + '  |'.repeat(cols);
        view.dispatch({ changes: { from: line.to, insert }, selection: EditorSelection.cursor(line.to + 3), scrollIntoView: true, userEvent: 'input' });
        return true;
      }
    }
  } else {
    if (idx > 0) target = cells[idx - 1];
    else if (line.number > 1) {
      let n = line.number - 1;
      if (n > 1 && SEP_ROW_RE.test(s.doc.line(n).text)) n--;
      const prev = s.doc.line(n);
      if (isTableRow(prev.text)) { const r = _cellRanges(prev); if (r.length) target = r[r.length - 1]; }
    }
  }
  if (!target) return false;
  view.dispatch({ selection: EditorSelection.range(target.from, target.to), scrollIntoView: true });
  return true;
}

// Prec.high: ahead of the editor's indentWithTab, but only in a table row
// (the handlers return false elsewhere, so Tab still indents prose).
const cellKeymap = Prec.high(keymap.of([
  { key: 'Tab', run: v => _moveCell(v, 1) },
  { key: 'Shift-Tab', run: v => _moveCell(v, -1) },
]));

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
    const before = from > line.from ? '\n' : '';
    const after = to < line.to ? '\n' : '';
    view.dispatch({ changes: { from, to, insert: before + table + after }, userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
});

/** Everything the editor needs; markdown.js spreads this into its extensions. */
export const tableEditorExtensions = [cellKeymap, tableDecoPlugin, tableHover, tsvPaste];

// ---------------------------------------------------------------------------
// Actions (the ⋯ menu + the phone bubble)
// ---------------------------------------------------------------------------

export const tableActions = [
  { id: 'table', label: 'Insert table', glyph: '▦', run: () => state.emit('editor-insert-block', { text: blankTable(3, 3) }) },
  { id: 'align', label: 'Align table columns', glyph: '⫴', run: ({ editor }) => editor?.alignActiveDsl?.() },
];

/** Front-matter keys the tables read (merged into markdown's schema). */
export const tablesFrontMatterSchema = {
  decimals: { type: 'number', doc: 'Show non-integer formula results in tables with this many decimals (e.g. `2`). Omit for Excel\'s General format.' },
};
