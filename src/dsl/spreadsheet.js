/**
 * {spreadsheet} DSL plugin — a spreadsheet whose file is readable text.
 *
 * The whole document is ONE workbook (`wholeDocument: true`): preview.js hands
 * the full source to `render()`, which mounts the GRID (src/ui/sheet-grid.js)
 * — the render pane is where most editing happens.  The engine is pure and
 * Node-tested (src/core/sheet/: parse.js, style.js, book.js, edit.js,
 * render.js, xlsx.js); this module is the DOM half:
 *
 *   • render()        — the live grid (one instance per preview, updated in place)
 *   • renderToString  — the static table (the quine's embedded preview)
 *   • editor          — a stream tokenizer for the DSL (rows, formulas, directives),
 *                       lint (directive problems + formula errors), completion
 *                       (functions after `=`, directive keywords, properties),
 *                       Alt-Shift-F tidies the pipes
 *   • exports         — .xlsx (styles, rules, comments included), CSV (active
 *                       sheet), HTML, PDF (print window)
 */

import { StreamLanguage } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { registerDSL } from './registry.js';
import { state } from '../ui/state.js';
import { computeWorkbook } from '../core/sheet/book.js';
import { DIRECTIVES, cellAtOffset } from '../core/sheet/parse.js';
import { alignSpreadsheet } from '../core/sheet/edit.js';
import { renderWorkbookHtml, workbookDocument, printDocument, sheetToCsv } from '../core/sheet/render.js';
import { workbookToXlsx } from '../core/sheet/xlsx.js';
import { PROP_NAMES, ALIGNS, VALIGNS, FONTS } from '../core/sheet/style.js';
import { FUNCTION_NAMES } from '../core/tables/formula.js';
import { mountSheetGrid } from '../ui/sheet-grid.js';

// ---------------------------------------------------------------------------
// Workbook cache — parse + evaluate once per document text
// ---------------------------------------------------------------------------

let _cache = { text: null, book: null };

/** The computed workbook for a text (memoised on the text). */
export function bookFor(text) {
  const t = text ?? '';
  if (_cache.text !== t) _cache = { text: t, book: computeWorkbook(t) };
  return _cache.book;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let _grid = null;

async function render(content, el, { cursorPos } = {}) {
  _grid = mountSheetGrid(el, bookFor(content), { cursorPos });
}

/** Static HTML for the quine's embedded preview. */
function renderToString(content) {
  return `<div class="uf-ss-static">${renderWorkbookHtml(bookFor(content || ''), { docOffsets: false })}</div>`;
}

/** The sheet the grid shows (exports of "this sheet"). */
function activeSheetIndex() {
  return _grid?.sheetIndex ?? 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const _docTitle = () => state.data?.title || 'Spreadsheet';

async function exportXlsx(content) {
  const bytes = workbookToXlsx(bookFor(content), { title: _docTitle() });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function exportCsv(content) {
  const book = bookFor(content);
  const sheet = book.sheets[activeSheetIndex()] ?? book.sheets[0];
  return new Blob([sheet ? sheetToCsv(book, sheet) : ''], { type: 'text/csv' });
}

async function exportHtml(content) {
  return new Blob([workbookDocument(bookFor(content), { title: _docTitle() })], { type: 'text/html' });
}

async function exportPdf(content) {
  const win = window.open('', '_blank');
  if (!win) return null;
  win.document.open();
  win.document.write(printDocument(bookFor(content), { title: _docTitle() }));
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 300);
  return null;
}

// ---------------------------------------------------------------------------
// Editor — tokenizer
// ---------------------------------------------------------------------------

const DIRECTIVE_START = new RegExp(`^(${DIRECTIVES.join('|')})\\b`);
const REF_RE = /^(?:'[^']+'!|[A-Za-z_][A-Za-z0-9_]*!)?\$?[A-Za-z]{1,3}\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d*)?(?![A-Za-z0-9_(])/;

function classify(line) {
  const t = line.trim();
  if (!t) return 'blank';
  if (/^#{1,6}\s/.test(t)) return 'heading';
  if (t.startsWith('|')) return /^\|(\s*:?-+:?\s*\|)+\s*$/.test(t) ? 'sep' : 'row';
  if (DIRECTIVE_START.test(t)) return 'directive';
  return 'note';
}

/** Formula tokens (inside a cell after `=`, or a `=…` condition). */
function formulaToken(stream) {
  if (stream.eatSpace()) return null;
  if (stream.match(/^"(?:[^"]|"")*"/)) return 'string';
  if (stream.match(/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i)) return 'number';
  if (stream.match(/^[A-Za-z_][A-Za-z0-9_.]*(?=\()/)) return 'keyword';
  if (stream.match(/^(true|false)\b/i)) return 'bool';
  if (stream.match(REF_RE)) return 'propertyName';
  if (stream.match(/^(<=|>=|<>|[-+*/^&=<>%(),;])/)) return 'operator';
  stream.next();
  return null;
}

const spreadsheetLanguage = StreamLanguage.define({
  name: 'spreadsheet',
  startState: () => ({ kind: 'blank', cellStart: false, formula: false, args: 0 }),
  token(stream, st) {
    if (stream.sol()) {
      st.kind = classify(stream.string);
      st.cellStart = false; st.formula = false; st.args = 0;
    }
    switch (st.kind) {
      case 'blank': stream.skipToEnd(); return null;
      case 'heading': stream.skipToEnd(); return 'heading';
      case 'sep': stream.skipToEnd(); return 'meta';
      case 'note': stream.skipToEnd(); return null;
      case 'row': {
        if (stream.eat('|')) { st.cellStart = true; st.formula = false; return 'separator'; }
        if (stream.eatSpace()) return null;
        if (st.cellStart) {
          st.cellStart = false;
          if (stream.eat('=')) { st.formula = true; return 'operator'; }
          if (stream.match(/^\^\^(?=\s*\|)/)) return 'atom';
          if (stream.match(/^'/)) return 'meta';
        }
        if (st.formula) {
          if (stream.peek() === '|') { st.formula = false; return null; }
          if (stream.match(/^\\\|/)) return 'string';
          return formulaToken(stream);
        }
        if (stream.match(/^\\\|/)) return 'meta';
        if (stream.match(/^[^|\\]+/)) {
          const t = stream.current().trim();
          return /^[-+]?[$€£¥]?[\d,]*\.?\d+%?$|^\([$€£¥]?[\d,.]+\)$/.test(t) ? 'number' : (/^(true|false)$/i.test(t) ? 'bool' : null);
        }
        stream.next(); return null;
      }
      case 'directive': {
        if (stream.sol() || st.args === 0) {
          if (stream.eatSpace()) return null;
          if (stream.match(DIRECTIVE_START)) { st.args = 1; return 'keyword'; }
        }
        if (stream.eatSpace()) return null;
        if (st.formula) return formulaToken(stream);
        if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
        if (stream.match(/^(then|and|asc|desc)\b/i)) return 'keyword';
        if (stream.match(/^=(?=\S)/)) { st.formula = true; return 'operator'; }
        if (stream.match(/^(<=|>=|<>|!=|==|[<>=])/)) return 'operator';
        if (stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return 'number';
        if (stream.match(/^[a-z]+:(?:"(?:[^"\\]|\\.)*"|\S*)/)) return 'atom';
        if (stream.match(/^(bold|italic|underline|strike|wrap|border|blank|filled|error|duplicate|unique|top|bottom|between|contains|starts|ends)\b/)) return 'atom';
        if (stream.match(/^\$?[A-Za-z]{1,3}\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d*)?(?![A-Za-z0-9_:])/)) return 'propertyName';
        if (stream.match(/^\d+(?::\d+)?(?![A-Za-z])/)) return 'propertyName';
        if (stream.match(/^[-+]?\d*\.?\d+/)) return 'number';
        stream.next(); return null;
      }
    }
    stream.next();
    return null;
  },
  languageData: { autocomplete: complete },
});

// ---------------------------------------------------------------------------
// Editor — completion
// ---------------------------------------------------------------------------

const PROP_OPTIONS = [
  ...['bold', 'italic', 'underline', 'strike', 'wrap', 'border'].map(p => ({ label: p, type: 'property' })),
  ...ALIGNS.map(a => ({ label: `align:${a}`, type: 'property' })),
  ...VALIGNS.map(a => ({ label: `valign:${a}`, type: 'property' })),
  ...FONTS.map(f => ({ label: `font:${f}`, type: 'property' })),
  { label: 'color:', type: 'property', detail: 'text colour' }, { label: 'bg:', type: 'property', detail: 'fill colour' },
  { label: 'size:', type: 'property', detail: 'font size (px)' },
  ...['format:0.00', 'format:#,##0', 'format:#,##0.00', 'format:0%', 'format:$#,##0.00', 'format:text', 'format:general'].map(f => ({ label: f, type: 'property' })),
];
const COND_OPTIONS = ['blank', 'filled', 'error', 'duplicate', 'unique', 'top 3', 'bottom 3', 'between 1 and 10', 'contains "x"', 'starts "x"', 'ends "x"', '> 0', '< 0', '= "x"', '<> 0']
  .map(c => ({ label: c, type: 'keyword' }));
const DIRECTIVE_OPTIONS = [
  { label: 'width', detail: 'width A:B 12', type: 'keyword' }, { label: 'height', detail: 'height 2 40', type: 'keyword' },
  { label: 'freeze', detail: 'freeze rows:1 cols:1', type: 'keyword' }, { label: 'merge', detail: 'merge A1:C1', type: 'keyword' },
  { label: 'style', detail: 'style A1:D1 bold bg:#eef', type: 'keyword' }, { label: 'if', detail: 'if D2:D9 > 100 then bold', type: 'keyword' },
  { label: 'scale', detail: 'scale D2:D9 #fff #1a8cf5', type: 'keyword' }, { label: 'comment', detail: 'comment B3 "…"', type: 'keyword' },
  { label: 'sort', detail: 'sort B desc', type: 'keyword' }, { label: 'filter', detail: 'filter B > 0', type: 'keyword' },
  { label: 'hide', detail: 'hide C:D', type: 'keyword' }, { label: '# ', detail: 'a new sheet', type: 'keyword' },
];
const FUNCTION_OPTIONS = FUNCTION_NAMES.map(n => ({ label: n, type: 'function', apply: n + '(' }));

function complete(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const kind = classify(line.text);
  // Formula functions: after `=` in a cell / condition, on a word.
  const cellStart = before.lastIndexOf('|');
  const inFormulaCell = kind === 'row' && cellStart >= 0 && /^\s*=/.test(before.slice(cellStart + 1));
  const inFormulaCond = kind === 'directive' && /(?:^|\s)=\S*$/.test(before);
  if (inFormulaCell || inFormulaCond) {
    const w = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/);
    if (!w && !context.explicit) return null;
    return { from: w ? w.from : context.pos, options: FUNCTION_OPTIONS, validFor: /^[A-Za-z0-9_.]*$/ };
  }
  if (kind === 'row') return null;
  // Line start: directive keywords.
  const w = context.matchBefore(/[A-Za-z#]*/);
  if (/^\s*[A-Za-z#]*$/.test(before)) {
    if (!w && !context.explicit) return null;
    return { from: w ? w.from : context.pos, options: DIRECTIVE_OPTIONS, validFor: /^[A-Za-z#]*$/ };
  }
  if (kind !== 'directive') return null;
  const m = /^\s*(\w+)\s+(\S+)?\s*(.*)$/.exec(before);
  if (!m || !m[2]) return null;
  const kw = m[1];
  const w2 = context.matchBefore(/[A-Za-z:#.,$0-9"]*/);
  const from = w2 ? w2.from : context.pos;
  if (kw === 'style' || (kw === 'if' && /\bthen\b/.test(before))) return { from, options: PROP_OPTIONS, validFor: /^[A-Za-z:#.,$0-9]*$/ };
  if (kw === 'if' || kw === 'filter') return { from, options: COND_OPTIONS, validFor: /^[A-Za-z<>=!]*$/ };
  if (kw === 'freeze') return { from, options: [{ label: 'rows:1', type: 'property' }, { label: 'cols:1', type: 'property' }], validFor: /^[a-z:0-9]*$/ };
  if (kw === 'sort') return { from, options: [{ label: 'asc', type: 'keyword' }, { label: 'desc', type: 'keyword' }], validFor: /^[a-z]*$/ };
  return null;
}

// ---------------------------------------------------------------------------
// Editor — lint
// ---------------------------------------------------------------------------

function lintSource(view) {
  const text = view.state.doc.toString();
  const book = bookFor(text);
  const len = text.length;
  const clamp = n => Math.max(0, Math.min(n, len));
  const out = [];
  for (const p of book.problems) out.push({ from: clamp(p.from), to: clamp(p.to), severity: 'warning', message: p.message });
  for (const e of book.errors) {
    const cell = e.cell;
    if (!cell || cell.synthetic) continue;
    out.push({ from: clamp(cell.from), to: clamp(Math.max(cell.to, cell.from + 1)), severity: 'error', message: `${e.error.code}${e.error.detail ? ' — ' + e.error.detail : ''}` });
  }
  return out.filter(d => d.from <= d.to);
}

function getEditorExtensions() {
  return [
    spreadsheetLanguage,
    linter(lintSource, { delay: 400 }),
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const gridAct = (id) => () => state.emit('sheet-grid-action', id);

const spreadsheetDSL = {
  id: 'spreadsheet',
  label: 'Ss',
  version: '1.0.0',
  name: 'Spreadsheet',
  extensions: ['.uni', '.txt'],
  editorMode: 'spreadsheet',
  wholeDocument: true,

  render,
  renderToString,
  print: exportPdf,
  getEditorExtensions,
  alignSource: alignSpreadsheet,

  // The editor view's verbs (⋯ menu, the phone bubble in the editor view).
  actions: [
    { id: 'tidy', label: 'Tidy the text (align pipes)', glyph: '⫴', run: ({ editor }) => { editor?.alignActiveDsl?.(); } },
  ],
  // The grid's verbs for the phone bubble in the render view.
  renderActions: [
    { id: 'undo', label: 'Undo', glyph: '↶', run: gridAct('undo') },
    { id: 'redo', label: 'Redo', glyph: '↷', run: gridAct('redo') },
    { id: 'bold', label: 'Bold', glyph: 'B', run: gridAct('bold') },
    { id: 'insert-row-below', label: 'Insert row below', glyph: '+⇣', run: gridAct('insert-row-below') },
    { id: 'insert-col-right', label: 'Insert column right', glyph: '+⇢', run: gridAct('insert-col-right') },
    { id: 'delete-row', label: 'Delete row', glyph: '−⇣', run: gridAct('delete-row') },
    { id: 'delete-col', label: 'Delete column', glyph: '−⇢', run: gridAct('delete-col') },
    { id: 'merge', label: 'Merge / unmerge', glyph: '⊞', run: gridAct('merge') },
    { id: 'comment', label: 'Comment', glyph: '❝', run: gridAct('comment') },
    { id: 'clear', label: 'Clear cells', glyph: '⌫', run: gridAct('clear') },
  ],

  exporters: {
    xlsx: { label: 'Excel (.xlsx)', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx', binary: true, export: exportXlsx },
    csv:  { label: 'CSV (this sheet)', mime: 'text/csv', ext: '.csv', export: exportCsv },
    html: { label: 'HTML', mime: 'text/html', ext: '.html', export: exportHtml },
    pdf:  { label: 'PDF', mime: 'application/pdf', ext: '.pdf', export: exportPdf },
  },

  detect(content) {
    return /^\s*\|.*\|\s*$/m.test(content) && /^(style|merge|if|comment|width|freeze|sort|filter|hide|scale|height)\s/m.test(content);
  },
};

registerDSL(spreadsheetDSL);
export default spreadsheetDSL;
export { cellAtOffset };
