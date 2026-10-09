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
import { cellAtOffset } from '../core/sheet/parse.js';
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

const RANGE_RE = /^(\$?[A-Za-z]{1,3}\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d*)?|\d+(?::\d+)?)(?=\s|$|\{)/;
const REF_RE = /^(?:'[^']+'!|[A-Za-z_][A-Za-z0-9_]*!)?\$?[A-Za-z]{1,3}\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d*)?(?![A-Za-z0-9_(])/;
const SETTING_RE = /^(merge|comment|rule|scale|seq|step|width|height|hidden|bold|italic|underline|strike|wrap|border|color|bg|size|font|align|valign|format)(?=\s*[:,}])/;

/**
 * Line kinds: `---` fences, front matter `key: value`, `# remarks`, cell
 * lines.  The front matter state carries across lines (a fence toggles it).
 */
function formulaToken(stream) {
  if (stream.eatSpace()) return null;
  if (stream.match(/^"(?:[^"]|"")*"/)) return 'string';
  if (stream.match(/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i)) return 'number';
  if (stream.match(/^[A-Za-z_][A-Za-z0-9_.]*(?=\()/)) return 'keyword';
  if (stream.match(/^(true|false)\b/i)) return 'bool';
  if (stream.match(REF_RE)) return 'propertyName';
  if (stream.match(/^(<=|>=|<>|[-+*/^&=<>%();])/)) return 'operator';
  stream.next();
  return null;
}

const spreadsheetLanguage = StreamLanguage.define({
  name: 'spreadsheet',
  startState: () => ({ fm: false, kind: 'blank', seg: 'range', formula: false, inBlock: false, key: true }),
  token(stream, st) {
    if (stream.sol()) {
      const line = stream.string;
      if (/^---\s*$/.test(line)) { st.kind = 'fence'; st.fm = !st.fm; }
      else if (st.fm) st.kind = 'meta';
      else if (!line.trim()) st.kind = 'blank';
      else if (line.trimStart().startsWith('#')) st.kind = 'remark';
      else if (RANGE_RE.test(line.trimStart())) st.kind = 'cell';
      else st.kind = 'other';
      st.seg = 'range'; st.formula = false; st.inBlock = false; st.key = true;
    }
    switch (st.kind) {
      case 'fence': stream.skipToEnd(); return 'meta';
      case 'blank': case 'other': stream.skipToEnd(); return null;
      case 'remark': stream.skipToEnd(); return 'comment';
      case 'meta': {
        if (stream.sol() && stream.match(/^[A-Za-z][\w-]*(?=\s*:)/)) return 'propertyName';
        if (stream.match(/^:\s*/)) return 'punctuation';
        if (stream.match(/^\s+#.*$/)) return 'comment';
        if (stream.match(/^"[^"]*"/)) return 'string';
        if (stream.match(/^\$?[A-Za-z]{1,3}\$?\d*(?=\s|,|;|$)/)) return 'atom';
        if (stream.match(/^(asc|desc|on|off|rows|cols)\b/i)) return 'keyword';
        if (stream.match(/^[-+]?\d*\.?\d+/)) return 'number';
        stream.next(); return null;
      }
      case 'cell': {
        if (st.seg === 'range') { stream.eatSpace(); if (stream.match(RANGE_RE)) { st.seg = 'values'; return 'heading'; } }
        if (stream.eatSpace()) return null;
        if (st.inBlock) {
          if (stream.eat('}')) { st.inBlock = false; return 'punctuation'; }
          if (stream.eat(',')) { st.key = true; st.formula = false; return 'punctuation'; }
          if (st.key && stream.match(SETTING_RE)) { return 'atom'; }
          if (stream.eat(':')) { st.key = false; return 'punctuation'; }
          if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
          if (stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return 'number';
          if (stream.match(/^=(?=\S)/)) { st.formula = true; return 'operator'; }
          if (st.formula) return formulaToken(stream);
          if (stream.match(/^[^,}"]+/)) return null;
          stream.next(); return null;
        }
        if (stream.eat('{')) { st.inBlock = true; st.key = true; st.formula = false; return 'punctuation'; }
        if (stream.eat(',')) { st.formula = false; return 'punctuation'; }
        if (st.formula) {
          if (stream.peek() === ',' && !st.depth) return null;
          return formulaToken(stream);
        }
        if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
        if (stream.match(/^=(?=\S)/)) { st.formula = true; return 'operator'; }
        if (stream.match(/^[^,{"]+/)) {
          const t = stream.current().trim();
          return /^[-+]?[$€£¥]?[\d,]*\.?\d+%?$|^\([$€£¥]?[\d,.]+\)$|^\d{4}-\d{2}-\d{2}$/.test(t) ? 'number' : (/^(true|false)$/i.test(t) ? 'bool' : null);
        }
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
  ...['bold', 'italic', 'underline', 'strike', 'wrap', 'border', 'merge', 'hidden'].map(p => ({ label: p, type: 'property' })),
  ...ALIGNS.map(a => ({ label: `align: ${a}`, type: 'property' })),
  ...VALIGNS.map(a => ({ label: `valign: ${a}`, type: 'property' })),
  ...FONTS.map(f => ({ label: `font: ${f}`, type: 'property' })),
  { label: 'color: ', type: 'property', detail: 'text colour' }, { label: 'bg: ', type: 'property', detail: 'fill colour' },
  { label: 'size: ', type: 'property', detail: 'font size (px)' },
  ...['format: 0.00', 'format: #,##0', 'format: #,##0.00', 'format: 0%', 'format: $#,##0.00', 'format: text', 'format: general'].map(f => ({ label: f, type: 'property' })),
  { label: 'rule: ', type: 'property', detail: 'a condition: > 100, contains "x", blank, =D>C' },
  { label: 'scale: ', type: 'property', detail: 'two or three colours' },
  { label: 'comment: ', type: 'property', detail: 'a cell note' },
  { label: 'seq: ', type: 'property', detail: 'a sequence start: 1, 2026-01-01, Jan, Item 1' },
  { label: 'step: ', type: 'property', detail: '1 · 7 · 1 week · 1 month · 1 year' },
  { label: 'width: ', type: 'property', detail: 'column width (characters)' },
  { label: 'height: ', type: 'property', detail: 'row height (px)' },
];
const META_OPTIONS = [
  { label: 'name: ', type: 'keyword', detail: 'the sheet name' }, { label: 'header: 1', type: 'keyword', detail: 'header rows (bold, frozen, not sorted)' },
  { label: 'freeze: rows 1, cols 1', type: 'keyword' }, { label: 'width: ', type: 'keyword', detail: 'default column width' },
  { label: 'height: ', type: 'keyword', detail: 'default row height' }, { label: 'decimals: 2', type: 'keyword' },
  { label: 'sort: ', type: 'keyword', detail: 'B desc, C asc — a view sort' }, { label: 'filter: on', type: 'keyword', detail: 'on, or criteria: B > 0; A contains "x"' },
];
const FUNCTION_OPTIONS = FUNCTION_NAMES.map(n => ({ label: n, type: 'function', apply: n + '(' }));

function inFrontMatter(doc, lineNo) {
  let fm = false;
  for (let n = 1; n < lineNo; n++) if (/^---\s*$/.test(doc.line(n).text)) fm = !fm;
  return fm;
}

function complete(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  if (inFrontMatter(context.state.doc, line.number)) {
    const w = context.matchBefore(/[A-Za-z-]*/);
    if (/^[A-Za-z-]*$/.test(before)) return (!w && !context.explicit) ? null : { from: w ? w.from : context.pos, options: META_OPTIONS, validFor: /^[A-Za-z-]*$/ };
    return null;
  }
  // Formula functions: after `=` in a value or a rule.
  const inFormula = /(?:^|[\s,{:])=[^,{}]*$/.test(before);
  if (inFormula) {
    const w = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/);
    if (!w && !context.explicit) return null;
    return { from: w ? w.from : context.pos, options: FUNCTION_OPTIONS, validFor: /^[A-Za-z0-9_.]*$/ };
  }
  // Inside a `{ … }` block: the setting / property names.
  const open = before.lastIndexOf('{');
  if (open >= 0 && before.lastIndexOf('}') < open) {
    const w = context.matchBefore(/[A-Za-z]*/);
    if (!/[{,]\s*[A-Za-z]*$/.test(before)) return null;
    if (!w && !context.explicit) return null;
    return { from: w ? w.from : context.pos, options: PROP_OPTIONS, validFor: /^[A-Za-z]*$/ };
  }
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
    return /^\$?[A-Z]{1,3}\d*(:[A-Z]{1,3}\d*)?\s+\S/m.test(content) && /^---\s*\nname:/m.test(content);
  },
};

registerDSL(spreadsheetDSL);
export default spreadsheetDSL;
export { cellAtOffset };
