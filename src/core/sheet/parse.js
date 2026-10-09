/**
 * {spreadsheet} — the DSL parser (pure, Node-tested in test/sheet.test.mjs).
 *
 * A workbook is a plain-text file.  A `# Heading` starts a SHEET (a file with
 * no heading is one sheet, `Sheet1`).  Inside a sheet every line is one of:
 *
 *   | Item   | Qty | Price | Total |        a ROW of cells (pipes, `\|` escapes;
 *   |--------|----:|------:|------:|        an optional |---| line marks the rows
 *   | Apples |   3 |  1.20 | =B*C  |        above it as header rows)
 *
 *   width A 18          height 3 40        freeze cols:1
 *   merge A5:C5                            a DIRECTIVE: a keyword, then an A1
 *   style A1:D1 bold bg:#eef               range, then its arguments
 *   if D2:D9 > 100 then bold color:green
 *   scale D2:D9 #fff #1a8cf5
 *   comment B3 "Market price, October"
 *   sort B desc        filter B > 0        hide C:D
 *
 *   Figures in USD.                         anything else is a NOTE (free text)
 *
 * Addresses are Excel's (A1, B2:D9, A:A, 3:5); rows count the sheet's pipe
 * rows from 1 — the |---| separator is not a row.  Cells hold literal text
 * (`1,200`, `$3.50`, `12%` read as numbers; `'…` forces text) or a formula
 * (`=B*C`, `=SUM(D2:D9)`, `=Costs!B2` — src/core/tables/formula.js).
 *
 * The result is the model the grid (src/ui/sheet-grid.js), the renderer
 * (render.js) and the edit operations (edit.js) share.  Every row, cell and
 * directive carries absolute character offsets, so each is a click-back
 * target and edit.js can rewrite exactly one sheet block.
 */

import { splitRow, parseSeparator, isTableRow, colLetter, colIndex, cellText } from '../tables/grid.js';
import { parseGlobalFrontMatter } from '../front-matter.js';
import { parseStyleProps, parseCondition, parseColor } from './style.js';

export const DIRECTIVES = ['width', 'height', 'freeze', 'merge', 'style', 'if', 'scale', 'comment', 'sort', 'filter', 'hide'];
const DIRECTIVE_RE = new RegExp(`^(${DIRECTIVES.join('|')})\\b\\s*(.*)$`);
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * Parse an A1-style range: `A1`, `A1:C3`, `A`, `A:C`, `3`, `3:5`, `$A$1`.
 * Open ends are Infinity (`A` = rows 0…∞ of column A; `3` = every column of
 * row 3).  Returns null for anything else.
 * @returns {{ r1, c1, r2, c2 } | null}
 */
export function parseRange(s) {
  const m = /^\$?([A-Za-z]{1,3})?\$?(\d+)?(?::\$?([A-Za-z]{1,3})?\$?(\d+)?)?$/.exec(String(s ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  const hasB = s.includes(':');
  if (hasB && !m[3] && !m[4]) return null;
  const a = { c: m[1] ? colIndex(m[1]) : null, r: m[2] ? parseInt(m[2], 10) - 1 : null };
  const b = hasB ? { c: m[3] ? colIndex(m[3]) : null, r: m[4] ? parseInt(m[4], 10) - 1 : null } : a;
  // `A1:C` or `A:C3` are malformed; a side must be a cell, a column or a row consistently.
  if (hasB && ((a.c == null) !== (b.c == null) || (a.r == null) !== (b.r == null))) return null;
  if (a.r != null && a.r < 0) return null;
  const c1 = a.c == null ? 0 : Math.min(a.c, b.c);
  const c2 = a.c == null ? Infinity : Math.max(a.c, b.c);
  const r1 = a.r == null ? 0 : Math.min(a.r, b.r);
  const r2 = a.r == null ? Infinity : Math.max(a.r, b.r);
  return { r1, c1, r2, c2 };
}

/** The canonical spelling of a range: `B3`, `A1:C3`, `A`, `A:C`, `3`, `3:5`. */
export function formatRange(R) {
  const colsOpen = R.c1 === 0 && R.c2 === Infinity;
  const rowsOpen = R.r1 === 0 && R.r2 === Infinity;
  if (rowsOpen && !colsOpen) return R.c1 === R.c2 ? colLetter(R.c1) : `${colLetter(R.c1)}:${colLetter(R.c2)}`;
  if (colsOpen && !rowsOpen) return R.r1 === R.r2 ? String(R.r1 + 1) : `${R.r1 + 1}:${R.r2 + 1}`;
  if (colsOpen && rowsOpen) return 'A:XFD';
  const a = colLetter(R.c1) + (R.r1 + 1);
  if (R.r1 === R.r2 && R.c1 === R.c2) return a;
  return `${a}:${colLetter(R.c2)}${R.r2 + 1}`;
}

export const rangeContains = (R, r, c) => r >= R.r1 && r <= R.r2 && c >= R.c1 && c <= R.c2;
export const rangeEquals = (A, B) => A.r1 === B.r1 && A.r2 === B.r2 && A.c1 === B.c1 && A.c2 === B.c2;
/** True when A lies entirely inside B. */
export const rangeWithin = (A, B) => A.r1 >= B.r1 && A.r2 <= B.r2 && A.c1 >= B.c1 && A.c2 <= B.c2;
export const rangeIntersects = (A, B) => A.r1 <= B.r2 && B.r1 <= A.r2 && A.c1 <= B.c2 && B.c1 <= A.c2;
export const isCellRange = (R) => R.r1 === R.r2 && R.c1 === R.c2 && R.r2 !== Infinity && R.c2 !== Infinity;

// ---------------------------------------------------------------------------
// Directive arguments
// ---------------------------------------------------------------------------

/**
 * Split a directive's argument text into tokens: whitespace-separated, but a
 * `"…"` span (with `\"` escapes) is one token even with spaces, and it may
 * sit inside a token (`format:"$#,##0.00"`).  Each token keeps its source
 * offsets.  The `then` keyword is returned as its own token.
 * @returns {Array<{ text, from, to, quoted }>}
 */
export function tokenizeArgs(s, base = 0) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const from = i;
    let text = '';
    let quoted = false;
    while (i < s.length && !/\s/.test(s[i])) {
      if (s[i] === '"') {
        quoted = true;
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) { text += s[i + 1]; i += 2; continue; }
          text += s[i++];
        }
        i++;   // closing quote
        continue;
      }
      text += s[i++];
    }
    out.push({ text, from: base + from, to: base + i, quoted });
  }
  return out;
}

/** Quote a string for a directive when it needs it. */
export function quoteArg(s) {
  const t = String(s ?? '');
  if (t !== '' && !/[\s"\\]/.test(t) && !/^(then|and)$/i.test(t)) return t;
  return '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Sheet
 * @property {number} index
 * @property {string} name          the heading text, else `Sheet<n>`
 * @property {boolean} named        a heading supplied the name
 * @property {number} nameFrom,nameTo   the heading line (== from when unnamed)
 * @property {number} from,to       the whole block (heading … last line)
 * @property {Array<{from,to,cells:Cell[]}>} rows
 * @property {number} cols
 * @property {number} headerRows    rows above the |---| line
 * @property {(string|null)[]} aligns   the separator's `:--:` alignments
 * @property {object|null} sepLine  { from, to } of the |---| line
 * @property {(Cell|null)[][]} grid [r][c] → the anchor cell covering it
 * @property {Cell[]} cells         every cell (row order), merged ones included
 * @property {Array} directives     every directive line, parsed (see below)
 * @property {Array<{from,to,text}>} notes   free-text lines
 * @property {Array<{from,to,text,message}>} problems   lint diagnostics
 * — derived views over `directives`:
 * @property {Map<number,number>} widths     col → characters
 * @property {Map<number,number>} heights    row → px
 * @property {{rows:number, cols:number}} freeze
 * @property {Array<{range, from, to}>} merges
 * @property {Array<{range, props, from, to}>} styles
 * @property {Array<{range, cond, props, from, to}>} rules
 * @property {Array<{range, colors:string[], from, to}>} scales
 * @property {Array<{r, c, text, from, to}>} comments
 * @property {Array<{col, dir}>} sorts
 * @property {Array<{col, cond, from, to}>} filters
 * @property {{rows:Set<number>, cols:Set<number>}} hidden
 *
 * Cell = { r, c, text, raw, from, to, rawFrom, rawTo, colspan, rowspan,
 *          formula: string|null, merged: boolean, synthetic: boolean }
 *   (`synthetic` = the row is shorter than the sheet; the cell has no source
 *    characters — from/to point at the row's end)
 */

/**
 * Parse a {spreadsheet} document.
 * @returns {{ sheets: Sheet[], bodyFrom: number, meta: object, problems: Array }}
 */
export function parseSpreadsheet(text) {
  const src = text ?? '';
  const { meta, bodyFrom } = parseGlobalFrontMatter(src);
  const lines = [];
  let pos = 0;
  for (const raw of src.split('\n')) {
    lines.push({ text: raw, from: pos, to: pos + raw.length });
    pos += raw.length + 1;
  }

  // 1. Cut the body into sheet blocks at headings.
  const blocks = [];
  let cur = null;
  let i = 0;
  while (i < lines.length && lines[i].from < bodyFrom) i++;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    const h = HEADING_RE.exec(ln.text);
    if (h) {
      cur = { name: h[1].trim(), named: true, nameFrom: ln.from, nameTo: ln.to, from: ln.from, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) {
      if (!ln.text.trim()) continue;
      cur = { name: null, named: false, nameFrom: ln.from, nameTo: ln.from, from: ln.from, lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(ln);
  }

  // 2. Each block → a sheet.
  const sheets = [];
  const usedNames = new Map();
  const problems = [];
  blocks.forEach((b, index) => {
    const sheet = _parseBlock(b, index);
    let base = b.name || `Sheet${index + 1}`;
    const n = usedNames.get(base.toLowerCase()) || 0;
    usedNames.set(base.toLowerCase(), n + 1);
    sheet.name = n ? `${base} ${n + 1}` : base;
    sheets.push(sheet);
    for (const p of sheet.problems) problems.push(p);
  });

  return { sheets, bodyFrom, meta, problems };
}

function _parseBlock(b, index) {
  const rowLines = [];
  let sepLine = null;
  let headerRows = 0;
  let aligns = [];
  const directiveLines = [];
  const notes = [];
  let lastContent = b.nameTo;

  for (const ln of b.lines) {
    const t = ln.text;
    if (!t.trim()) continue;
    lastContent = ln.to;
    if (isTableRow(t)) {
      const sep = sepLine ? null : parseSeparator(t);
      if (sep && rowLines.length > 0) {
        sepLine = { from: ln.from, to: ln.to };
        headerRows = rowLines.length;
        aligns = sep;
        continue;
      }
      rowLines.push(ln);
      continue;
    }
    const d = DIRECTIVE_RE.exec(t.trim());
    if (d) {
      directiveLines.push({ keyword: d[1], args: d[2], from: ln.from, to: ln.to, argsFrom: ln.from + t.indexOf(d[2], t.indexOf(d[1]) + d[1].length) });
      continue;
    }
    notes.push({ from: ln.from, to: ln.to, text: t });
  }

  // Rows → cells (with the inline `||` / `^^` spans of {document} tables
  // honoured, so a pasted Markdown table keeps its merges).
  const rows = rowLines.map(ln => {
    const cells = _rowCells(ln);
    return { from: ln.from, to: ln.to, cells };
  });
  const sheet = _buildSheet(rows, headerRows, aligns);
  sheet.index = index;
  for (const c of sheet.cells) c.sheet = index;
  sheet.named = b.named;
  sheet.nameFrom = b.nameFrom;
  sheet.nameTo = b.nameTo;
  sheet.from = b.from;
  sheet.to = lastContent;
  sheet.sepLine = sepLine;
  sheet.notes = notes;
  sheet.problems = [];

  _parseDirectives(sheet, directiveLines);
  return sheet;
}

/** Cells of a pipe row with `||` spans; offsets absolute. */
function _rowCells(ln) {
  const cells = [];
  let col = 0;
  for (const seg of splitRow(ln.text)) {
    if (seg.raw.length === 0 && cells.length) {
      cells[cells.length - 1].colspan++;
      cells[cells.length - 1].rawTo = ln.from + seg.to;
      col++;
      continue;
    }
    const lead = seg.raw.length - seg.raw.trimStart().length;
    const trail = seg.raw.length - seg.raw.trimEnd().length;
    const from = ln.from + seg.from + lead;
    const to = Math.max(from, ln.from + seg.to - trail);
    cells.push({
      c: col, text: cellText(seg.raw), raw: seg.raw,
      from, to, rawFrom: ln.from + seg.from, rawTo: ln.from + seg.to,
      colspan: 1, rowspan: 1, merged: false, synthetic: false,
    });
    col++;
  }
  return cells;
}

function _buildSheet(rows, headerRows, aligns) {
  let cols = 0;
  for (const row of rows) {
    const last = row.cells[row.cells.length - 1];
    if (last) cols = Math.max(cols, last.c + last.colspan);
  }
  cols = Math.max(cols, aligns.length);

  const grid = rows.map(() => new Array(cols).fill(null));
  const cells = [];

  rows.forEach((row, r) => {
    // Pad short rows with synthetic empty cells so every (r, c) has a cell.
    const byCol = new Map(row.cells.map(c => [c.c, c]));
    for (let c = 0; c < cols; c++) {
      let cell = byCol.get(c);
      if (!cell) {
        if (grid[r][c]) continue;   // covered by a span
        cell = { c, text: '', raw: '', from: row.to, to: row.to, rawFrom: row.to, rawTo: row.to, colspan: 1, rowspan: 1, merged: false, synthetic: true };
      }
      cell.r = r;
      cell.colspan = Math.min(cell.colspan, cols - c);
      cell.formula = cell.text.startsWith('=') && cell.text.length > 1 ? cell.text.slice(1) : null;
      // `^^` → merge into the anchor above.
      if (cell.text === '^^' && r > 0 && grid[r - 1][c] && grid[r - 1][c].c === c) {
        const anchor = grid[r - 1][c];
        anchor.rowspan = r - anchor.r + 1;
        cell.merged = true;
        cell.text = '';
        cell.formula = null;
        for (let k = 0; k < anchor.colspan && c + k < cols; k++) grid[r][c + k] = anchor;
        cells.push(cell);
        continue;
      }
      for (let k = 0; k < cell.colspan; k++) if (grid[r][c + k] == null) grid[r][c + k] = cell;
      cells.push(cell);
    }
    row.cells = cells.filter(c => c.r === r);
  });

  return {
    rows, cols, headerRows, grid, cells,
    aligns: new Array(cols).fill(null).map((_, i) => aligns[i] ?? null),
  };
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

function _parseDirectives(sheet, lines) {
  sheet.directives = [];
  sheet.widths = new Map();
  sheet.heights = new Map();
  sheet.freeze = { rows: 0, cols: 0 };
  sheet.merges = [];
  sheet.styles = [];
  sheet.rules = [];
  sheet.scales = [];
  sheet.comments = [];
  sheet.sorts = [];
  sheet.filters = [];
  sheet.hidden = { rows: new Set(), cols: new Set() };
  const problem = (d, message) => sheet.problems.push({ from: d.from, to: d.to, message });

  for (const d of lines) {
    const toks = tokenizeArgs(d.args, d.argsFrom);
    const rec = { kind: d.keyword, from: d.from, to: d.to, raw: d.args, args: toks };
    sheet.directives.push(rec);
    const need = (n, what) => { if (toks.length < n) { problem(d, `${d.keyword}: expected ${what}`); return false; } return true; };
    const range = (tok) => {
      const R = parseRange(tok?.text);
      if (!R) problem(d, `${d.keyword}: "${tok?.text ?? ''}" is not a cell or range (A1, A1:C3, A, 3)`);
      return R;
    };
    switch (d.keyword) {
      case 'width': {
        if (!need(2, 'a column and a width')) break;
        const R = range(toks[0]); const n = Number(toks[1].text);
        if (!R || !(n > 0)) { if (R) problem(d, 'width: expected a number of characters'); break; }
        rec.range = R; rec.value = n;
        for (let c = R.c1; c <= Math.min(R.c2, R.c1 + 1000); c++) sheet.widths.set(c, n);
        break;
      }
      case 'height': {
        if (!need(2, 'a row and a height')) break;
        const R = range(toks[0]); const n = Number(toks[1].text);
        if (!R || !(n > 0)) { if (R) problem(d, 'height: expected a height in px'); break; }
        rec.range = R; rec.value = n;
        for (let r = R.r1; r <= Math.min(R.r2, R.r1 + 10000); r++) sheet.heights.set(r, n);
        break;
      }
      case 'freeze': {
        for (const t of toks) {
          const m = /^(rows|cols):(\d+)$/.exec(t.text);
          if (m) sheet.freeze[m[1]] = parseInt(m[2], 10);
          else if (/^\d+$/.test(t.text)) sheet.freeze.rows = parseInt(t.text, 10);
          else problem(d, `freeze: expected rows:<n> cols:<n>, got "${t.text}"`);
        }
        rec.rows = sheet.freeze.rows; rec.cols = sheet.freeze.cols;
        break;
      }
      case 'merge': {
        if (!need(1, 'a range')) break;
        for (const t of toks) {
          const R = range(t);
          if (!R || R.r2 === Infinity || R.c2 === Infinity) { if (R) problem(d, 'merge: a merge needs a bounded range'); continue; }
          sheet.merges.push({ range: R, from: d.from, to: d.to });
          _applyMerge(sheet, R);
        }
        rec.range = sheet.merges[sheet.merges.length - 1]?.range ?? null;
        break;
      }
      case 'style': {
        if (!need(2, 'a range and properties')) break;
        const R = range(toks[0]);
        if (!R) break;
        const { props, problems } = parseStyleProps(toks.slice(1));
        for (const p of problems) problem(d, `style: ${p}`);
        rec.range = R; rec.props = props;
        sheet.styles.push({ range: R, props, from: d.from, to: d.to });
        break;
      }
      case 'if': {
        if (!need(3, 'a range, a condition and `then` properties')) break;
        const R = range(toks[0]);
        if (!R) break;
        const thenAt = toks.findIndex((t, k) => k > 0 && !t.quoted && t.text.toLowerCase() === 'then');
        if (thenAt < 0) { problem(d, 'if: missing `then`'); break; }
        const cond = parseCondition(toks.slice(1, thenAt));
        if (cond.error) { problem(d, `if: ${cond.error}`); break; }
        const { props, problems } = parseStyleProps(toks.slice(thenAt + 1));
        for (const p of problems) problem(d, `if: ${p}`);
        rec.range = R; rec.cond = cond; rec.props = props;
        sheet.rules.push({ range: R, cond, props, from: d.from, to: d.to });
        break;
      }
      case 'scale': {
        if (!need(3, 'a range and two colours')) break;
        const R = range(toks[0]);
        if (!R) break;
        const colors = toks.slice(1).map(t => parseColor(t.text));
        if (colors.some(c => !c)) { problem(d, 'scale: expected colours (#rgb, #rrggbb or a CSS name)'); break; }
        rec.range = R; rec.colors = colors;
        sheet.scales.push({ range: R, colors, from: d.from, to: d.to });
        break;
      }
      case 'comment': {
        if (!need(2, 'a cell and the text')) break;
        const R = range(toks[0]);
        if (!R) break;
        if (!isCellRange(R)) { problem(d, 'comment: expected a single cell'); break; }
        const text = toks.slice(1).map(t => t.text).join(' ');
        rec.range = R; rec.text = text;
        sheet.comments.push({ r: R.r1, c: R.c1, text, from: d.from, to: d.to });
        break;
      }
      case 'sort': {
        if (!need(1, 'a column')) break;
        // sort B desc, C asc
        const parts = d.args.split(',');
        for (const part of parts) {
          const [colTok, dirTok] = part.trim().split(/\s+/);
          const R = parseRange(colTok);
          if (!R || R.c2 === Infinity) { problem(d, `sort: "${colTok}" is not a column`); continue; }
          const dir = (dirTok || 'asc').toLowerCase();
          if (dir !== 'asc' && dir !== 'desc') { problem(d, `sort: "${dirTok}" should be asc or desc`); continue; }
          sheet.sorts.push({ col: R.c1, dir });
        }
        rec.sorts = sheet.sorts.slice();
        break;
      }
      case 'filter': {
        if (!need(1, 'a column and a condition')) break;
        let col = null;
        let condToks = toks;
        if (!toks[0].text.startsWith('=')) {
          if (!need(2, 'a column and a condition')) break;
          const R = parseRange(toks[0].text);
          if (!R || R.c2 === Infinity) { problem(d, `filter: "${toks[0].text}" is not a column`); break; }
          col = R.c1;
          condToks = toks.slice(1);
        }
        const cond = parseCondition(condToks);
        if (cond.error) { problem(d, `filter: ${cond.error}`); break; }
        rec.col = col; rec.cond = cond;
        sheet.filters.push({ col, cond, from: d.from, to: d.to });
        break;
      }
      case 'hide': {
        if (!need(1, 'rows or columns')) break;
        for (const t of toks) {
          const R = range(t);
          if (!R) continue;
          if (R.r2 === Infinity && R.c2 !== Infinity) for (let c = R.c1; c <= R.c2; c++) sheet.hidden.cols.add(c);
          else if (R.c2 === Infinity && R.r2 !== Infinity) for (let r = R.r1; r <= R.r2; r++) sheet.hidden.rows.add(r);
          else problem(d, 'hide: expected whole rows (3:5) or columns (C:D)');
        }
        break;
      }
    }
  }
}

/** Apply a `merge` range onto the grid: the top-left cell spans it. */
function _applyMerge(sheet, R) {
  const r2 = Math.min(R.r2, sheet.rows.length - 1);
  const c2 = Math.min(R.c2, sheet.cols - 1);
  const anchor = sheet.grid[R.r1]?.[R.c1];
  if (!anchor || anchor.r !== R.r1 || anchor.c !== R.c1) return;
  if (r2 < R.r1 || c2 < R.c1) return;
  anchor.rowspan = Math.max(anchor.rowspan, r2 - R.r1 + 1);
  anchor.colspan = Math.max(anchor.colspan, c2 - R.c1 + 1);
  for (let r = R.r1; r <= r2; r++) {
    for (let c = R.c1; c <= c2; c++) {
      const cell = sheet.grid[r][c];
      if (cell && cell !== anchor && cell.r === r && cell.c === c) cell.merged = true;
      sheet.grid[r][c] = anchor;
    }
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The sheet and cell under an absolute document offset, or null. */
export function cellAtOffset(wb, pos) {
  for (const sheet of wb.sheets) {
    if (pos < sheet.from || pos > sheet.to + 1) continue;
    for (const row of sheet.rows) {
      if (pos < row.from || pos > row.to) continue;
      for (const cell of row.cells) {
        if (!cell.synthetic && pos >= cell.rawFrom && pos <= cell.rawTo) return { sheet, cell };
      }
      return { sheet, cell: row.cells[row.cells.length - 1] ?? null };
    }
    return { sheet, cell: null };
  }
  return null;
}

/** The used extent of a sheet: the last row / column holding any text. */
export function usedExtent(sheet) {
  let rows = 0, cols = 0;
  for (const cell of sheet.cells) {
    if (cell.merged || !cell.text) continue;
    rows = Math.max(rows, cell.r + 1);
    cols = Math.max(cols, cell.c + cell.colspan);
  }
  return { rows, cols };
}

export { colLetter, colIndex };
