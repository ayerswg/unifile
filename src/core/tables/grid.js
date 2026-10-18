/**
 * {document} tables — the workbook parser (pure, Node-tested in test/tables.test.mjs).
 *
 * A spreadsheet is a Markdown document.  Every GFM pipe table is a SHEET; the
 * nearest heading above it (since the previous table) is the sheet's name, the
 * prose around it is notes.  Inside a table:
 *
 *   | Item   | Qty | Price | Total       |      header row(s) = the rows above
 *   |--------|----:|------:|------------:|      the |---| line (GFM alignment)
 *   | Apples |   3 |  1.20 | =B*C        |      `=` starts a FORMULA (A1 refs;
 *   | Pears  |   2 |  0.80 | =B*C        |      a bare column letter = this row)
 *   | Total  ||           | =SUM(D2:D3) |      `||` = the cell spans the next
 *   | ^^     ||           | note        |      column; `^^` = merged with the
 *                                              cell above (MultiMarkdown)
 *
 * Addresses are Excel's: columns A, B, … Z, AA, …; rows count the table's
 * pipe rows from 1 (the |---| separator is not a row, so the header row is
 * row 1 — as in Excel, where a header is just the first row).
 *
 * Nothing here touches the DOM, computes a value (formula.js) or draws
 * (render.js).  Offsets are absolute character offsets into the document, so
 * every cell is a click-back target.
 */

import { parseGlobalFrontMatter } from '../front-matter.js';
import { parseDateText } from './formula.js';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** 0 → 'A', 25 → 'Z', 26 → 'AA'. */
export function colLetter(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 'A' → 0, 'AA' → 26.  Case-insensitive. */
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 'B3' — the address of a 0-based (row, col). */
export function cellAddress(r, c) {
  return colLetter(c) + (r + 1);
}

/** 'B3' → { r: 2, c: 1 } (0-based), or null. */
export function parseAddress(a) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a || '');
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: colIndex(m[1]) };
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

const ROW_RE = /^\s{0,3}\|.*\|\s*$/;
const SEP_CELL_RE = /^\s*:?-+:?\s*$/;

/** True when the line is a pipe row (`| … |`). */
export function isTableRow(line) {
  return ROW_RE.test(line);
}

/**
 * Split a pipe row into cell segments, honouring `\|` escapes.  The leading
 * and trailing pipes are the row's delimiters and are dropped.  Returns
 * `[{ raw, from, to }]` with offsets relative to the line.
 */
export function splitRow(line) {
  const segs = [];
  let start = -1;
  let i = 0;
  // The leading pipe.
  while (i < line.length && line[i] !== '|') i++;
  i++;
  start = i;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { i++; continue; }
    if (ch === '|') {
      segs.push({ raw: line.slice(start, i), from: start, to: i });
      start = i + 1;
    }
  }
  // Text after the last pipe (a row that forgot its closing pipe).
  const tail = line.slice(start);
  if (tail.trim()) segs.push({ raw: tail, from: start, to: line.length });
  return segs;
}

/** The separator line `|---|:--:|` → per-column alignments, or null. */
export function parseSeparator(line) {
  if (!isTableRow(line)) return null;
  const segs = splitRow(line);
  if (!segs.length) return null;
  const aligns = [];
  for (const s of segs) {
    if (!SEP_CELL_RE.test(s.raw)) return null;
    const t = s.raw.trim();
    const l = t.startsWith(':'), r = t.endsWith(':');
    aligns.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null);
  }
  return aligns;
}

/** Unescape `\|` inside a cell and trim it. */
export function cellText(raw) {
  return raw.replace(/\\\|/g, '|').trim();
}

/**
 * The cells of one pipe row with MultiMarkdown spans applied: a zero-length
 * segment (`||`, nothing between the pipes — a space makes an empty cell)
 * extends the previous cell across one more column.
 *
 * @returns {Array<{ text, raw, from, to, col, colspan }>}  offsets relative to the line
 */
export function parseRowCells(line) {
  const cells = [];
  let col = 0;
  for (const seg of splitRow(line)) {
    if (seg.raw.length === 0 && cells.length) {
      cells[cells.length - 1].colspan++;
      cells[cells.length - 1].to = seg.to;   // the span's pipes belong to the cell
      col++;
      continue;
    }
    cells.push({ text: cellText(seg.raw), raw: seg.raw, from: seg.from, to: seg.to, col, colspan: 1 });
    col++;
  }
  return cells;
}

/** A cell whose whole content is `^^` merges with the cell above it. */
export const ROWSPAN_MARK = '^^';

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

/**
 * Parse the document into sheets.
 *
 * @returns {{
 *   sheets: Sheet[],
 *   blocks: Array<{ kind: 'prose'|'name'|'sheet', from, to, text?, sheet? }>,
 *          — in document order; a 'name' block is the heading that names the
 *            sheet that follows (rendered as the sheet's title, not as prose)
 *   bodyFrom: number
 * }}
 *
 * Sheet = {
 *   index, name, nameFrom, nameTo, named (a heading supplied the name), from, to, cols, aligns: (string|null)[],
 *   headerRows: number,
 *   rows: Array<{ from, to, cells: Cell[] }>,
 *   grid: (Cell|null)[][]           // [r][c] → the cell covering it (anchor)
 * }
 * Cell = { r, c, text, raw, from, to (the trimmed content), rawFrom, rawTo (pipe to pipe),
 *          colspan, rowspan, formula: string|null,
 *          merged: boolean (covered by another cell's span) }
 */
export function parseWorkbook(text) {
  const src = text ?? '';
  const { bodyFrom } = parseGlobalFrontMatter(src);
  const lines = [];
  let pos = 0;
  for (const raw of src.split('\n')) {
    lines.push({ text: raw, from: pos, to: pos + raw.length });
    pos += raw.length + 1;
  }

  const sheets = [];
  const blocks = [];
  let pendingName = null;   // { name, from, to } — the heading above the next table
  let proseFrom = bodyFrom;
  let inFence = false;
  const usedNames = new Map();

  const flushProse = (upto) => {
    if (upto > proseFrom) {
      const t = src.slice(proseFrom, upto);
      if (t.trim()) blocks.push({ kind: 'prose', from: proseFrom, to: upto, text: t });
    }
  };

  let i = 0;
  // Skip the front-matter lines.
  while (i < lines.length && lines[i].from < bodyFrom) i++;

  for (; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.text;
    if (/^\s{0,3}(```|~~~)/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(t);
    if (h) {
      // A heading that is not followed by a table (before the next heading)
      // is prose; the one right above a table names it.  Decide by looking
      // ahead: any table before the next heading / end makes this a name.
      let names = false;
      let fence = false;
      for (let k = i + 1; k < lines.length; k++) {
        const u = lines[k].text;
        if (/^\s{0,3}(```|~~~)/.test(u)) { fence = !fence; continue; }
        if (fence) continue;
        if (/^\s{0,3}#{1,6}\s+/.test(u)) break;
        if (isTableRow(u)) { names = true; break; }
      }
      if (names) {
        flushProse(ln.from);
        pendingName = { name: h[1].trim(), from: ln.from, to: ln.to, block: { kind: 'name', from: ln.from, to: ln.to, sheet: null } };
        blocks.push(pendingName.block);
        proseFrom = ln.to + 1;
      }
      continue;
    }

    if (!isTableRow(t)) continue;

    // A table: consecutive pipe rows; the first |---| line (if any, within the
    // first few rows) marks the rows above it as header rows.
    const start = i;
    let end = i;
    while (end + 1 < lines.length && isTableRow(lines[end + 1].text)) end++;

    const rows = [];
    let headerRows = 0;
    let aligns = [];
    let sawSep = false;
    for (let k = start; k <= end; k++) {
      const lineText = lines[k].text;
      const sep = !sawSep ? parseSeparator(lineText) : null;
      if (sep && (rows.length > 0 || k === start)) {
        sawSep = true;
        headerRows = rows.length;
        aligns = sep;
        continue;
      }
      const cells = parseRowCells(lineText).map(c => ({
        ...c, from: lines[k].from + c.from, to: lines[k].from + c.to,
      }));
      rows.push({ from: lines[k].from, to: lines[k].to, cells });
    }
    if (!rows.length) { i = end; continue; }

    const sheet = _buildSheet(rows, headerRows, aligns);
    sheet.from = lines[start].from;
    sheet.to = lines[end].to;
    sheet.index = sheets.length;

    // Name: the pending heading, else Sheet<n>; names are unique per workbook.
    let base = pendingName?.name || `Sheet${sheets.length + 1}`;
    const n = usedNames.get(base.toLowerCase()) || 0;
    usedNames.set(base.toLowerCase(), n + 1);
    sheet.name = n ? `${base} ${n + 1}` : base;
    sheet.nameFrom = pendingName?.from ?? sheet.from;
    sheet.nameTo = pendingName?.to ?? sheet.from;
    sheet.named = !!pendingName;
    if (pendingName) pendingName.block.sheet = sheet;
    pendingName = null;

    flushProse(sheet.from);
    blocks.push({ kind: 'sheet', from: sheet.from, to: sheet.to, sheet });
    sheets.push(sheet);
    proseFrom = sheet.to;
    i = end;
  }
  flushProse(src.length);

  return { sheets, blocks, bodyFrom };
}

function _buildSheet(rows, headerRows, aligns) {
  let cols = 0;
  for (const row of rows) {
    const last = row.cells[row.cells.length - 1];
    if (last) cols = Math.max(cols, last.col + last.colspan);
  }
  cols = Math.max(cols, aligns.length);

  const grid = rows.map(() => new Array(cols).fill(null));
  const cells = [];

  rows.forEach((row, r) => {
    for (const c of row.cells) {
      const lead = c.raw.length - c.raw.trimStart().length;
      const trail = c.raw.length - c.raw.trimEnd().length;
      // The content span inside the pipes; an empty cell collapses to one
      // caret position after `| `.
      const cFrom = c.from + Math.min(lead, Math.max(0, c.raw.length - (c.colspan - 1)));
      const cTo = Math.max(cFrom, c.from + c.raw.length - trail);
      const cell = {
        r, c: c.col, text: c.text, raw: c.raw, from: cFrom, to: cTo, rawFrom: c.from, rawTo: c.to,
        colspan: Math.min(c.colspan, cols - c.col), rowspan: 1,
        formula: c.text.startsWith('=') && c.text.length > 1 ? c.text.slice(1) : null,
        merged: false,
      };
      // `^^` → merge into the anchor cell above this column.
      if (cell.text === ROWSPAN_MARK && r > 0 && grid[r - 1][cell.c]) {
        const anchor = grid[r - 1][cell.c];
        if (anchor.c === cell.c) {
          anchor.rowspan = r - anchor.r + 1;
          cell.merged = true;
          cell.text = '';
          cell.formula = null;
          for (let k = 0; k < anchor.colspan && anchor.c + k < cols; k++) grid[r][anchor.c + k] = anchor;
          cells.push(cell);
          continue;
        }
      }
      for (let k = 0; k < cell.colspan; k++) {
        if (grid[r][cell.c + k] == null) grid[r][cell.c + k] = cell;
      }
      cells.push(cell);
    }
  });

  // Alignment per column (GFM); missing → null (auto: numbers right, text left).
  const al = new Array(cols).fill(null).map((_, i) => aligns[i] ?? null);

  return { rows, cols, aligns: al, headerRows, grid, cells };
}

/** The anchor cell covering (r, c) in a sheet, or null. */
export function cellAt(sheet, r, c) {
  return sheet.grid[r]?.[c] ?? null;
}

/** The sheet and cell under an absolute document offset, or null. */
export function cellAtOffset(workbook, pos) {
  for (const sheet of workbook.sheets) {
    if (pos < sheet.from || pos > sheet.to) continue;
    for (const cell of sheet.cells) {
      if (pos >= cell.rawFrom && pos <= cell.rawTo) return { sheet, cell };
    }
    return { sheet, cell: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Literal values
// ---------------------------------------------------------------------------

const NUM_RE = /^[-+]?\s*[$€£¥]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?%?$/;

/**
 * The typed value of a literal cell: number (`1,200`, `$3.50`, `12%` → 0.12,
 * `(5)` → -5), boolean (`TRUE`/`FALSE`), `'…` forced text (the apostrophe is
 * dropped), empty → null, else the string.
 */
export function literalValue(text) {
  const t = (text ?? '').trim();
  if (t === '') return null;
  if (t.startsWith("'")) return t.slice(1);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) { const d = parseDateText(t); if (d) return d; }
  let s = t;
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { s = paren[1]; neg = true; }
  if (NUM_RE.test(s) && /\d/.test(s)) {
    const pct = s.endsWith('%');
    const n = parseFloat(s.replace(/[$€£¥,%\s]/g, ''));
    if (!Number.isNaN(n)) {
      let v = pct ? n / 100 : n;
      if (neg) v = -v;
      return v;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Source rewriting — align the pipes
// ---------------------------------------------------------------------------

/** Visible width of a cell's text (CJK counts double — close enough for a column). */
function _width(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
          (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
          (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}

/**
 * Reflow every table so the pipes line up: each column is padded to its
 * widest cell, numbers and right-aligned columns pad on the left, the
 * separator row stretches its dashes.  Spans keep their `||` pipes; a `^^`
 * cell pads like any other.  Idempotent; prose, fences and front matter pass
 * through untouched.
 */
export function alignTables(text) {
  const src = text ?? '';
  const wb = parseWorkbook(src);
  if (!wb.sheets.length) return src;
  let out = '';
  let pos = 0;
  for (const sheet of wb.sheets) {
    out += src.slice(pos, sheet.from);
    out += _alignSheet(src, sheet);
    pos = sheet.to;
  }
  out += src.slice(pos);
  return out;
}

function _alignSheet(src, sheet) {
  const { cols, aligns } = sheet;
  // Column widths from single-column cells only (spans don't set a width).
  const widths = new Array(cols).fill(3);
  for (const cell of sheet.cells) {
    if (cell.colspan !== 1) continue;
    widths[cell.c] = Math.max(widths[cell.c], _width(cell.raw.trim()));
  }
  // Does the column hold numbers (→ right-pad left)?
  const numeric = new Array(cols).fill(false);
  for (let c = 0; c < cols; c++) {
    if (aligns[c] === 'right') { numeric[c] = true; continue; }
    if (aligns[c]) continue;
    let nums = 0, texts = 0;
    for (const cell of sheet.cells) {
      // Row 1 is a header in spirit even without a |---| line; it never
      // decides whether a column is numeric.
      if (cell.c !== c || cell.colspan !== 1 || cell.merged || cell.r < Math.max(1, sheet.headerRows)) continue;
      if (cell.formula) continue;
      const v = literalValue(cell.text);
      if (typeof v === 'number') nums++; else if (v != null) texts++;
    }
    numeric[c] = nums > 0 && texts === 0;
  }

  const lines = src.slice(sheet.from, sheet.to).split('\n');
  const rowLines = new Map(sheet.rows.map((row, i) => [row.from, i]));
  const out = [];
  let lineFrom = sheet.from;
  for (const line of lines) {
    const rowIdx = rowLines.get(lineFrom);
    if (rowIdx != null) {
      out.push(_alignRow(sheet.rows[rowIdx], widths, numeric, aligns, cols));
    } else if (parseSeparator(line)) {
      out.push('|' + aligns.map((a, c) => {
        const w = widths[c] + 2;
        if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
        if (a === 'right') return '-'.repeat(w - 1) + ':';
        if (a === 'left') return ':' + '-'.repeat(w - 1);
        return '-'.repeat(w);
      }).join('|') + '|');
    } else {
      out.push(line);
    }
    lineFrom += line.length + 1;
  }
  return out.join('\n');
}

function _alignRow(row, widths, numeric, aligns, cols) {
  let s = '|';
  let col = 0;
  for (const cell of row.cells) {
    const text = cell.raw.trim();
    // A span's width = the covered columns + their pipes.
    let w = 0;
    // Each extra column adds its width + its ` | ` separator, less the one
    // character its `|` takes at the end of the span.
    for (let k = 0; k < cell.colspan; k++) w += widths[col + k] + (k ? 2 : 0);
    const pad = Math.max(0, w - _width(text));
    // An explicit `--:` aligns every row; an auto-detected numeric column
    // right-pads only its numbers (a text header stays left, as in Excel).
    const right = cell.colspan === 1 &&
      (aligns[cell.col] === 'right' ||
       (aligns[cell.col] == null && numeric[cell.col] && !text.startsWith('=') && typeof literalValue(text) === 'number'));
    const centre = cell.colspan === 1 && aligns[cell.col] === 'center';
    let body;
    if (right) body = ' '.repeat(pad) + text;
    else if (centre) body = ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(pad - Math.floor(pad / 2));
    else body = text + ' '.repeat(pad);
    s += ' ' + body + ' |' + '|'.repeat(cell.colspan - 1);
    col += cell.colspan;
  }
  // Short rows are padded with empty cells so every row has every column.
  for (; col < cols; col++) s += ' ' + ' '.repeat(widths[col]) + ' |';
  return s;
}

/** A fresh `rows × cols` table (header row + separator + rows) as text. */
export function blankTable(rows = 3, cols = 3) {
  const head = '|' + Array.from({ length: cols }, (_, c) => ' ' + colLetter(c).padEnd(5) + ' |').join('');
  const sep = '|' + Array.from({ length: cols }, () => '-------|').join('');
  const body = Array.from({ length: rows }, () => '|' + Array.from({ length: cols }, () => '       |').join(''));
  return [head, sep, ...body].join('\n');
}

/**
 * Convert tab-separated text (what a spreadsheet puts on the clipboard) into
 * a pipe table.  Returns null when the text is not a 2-D TSV block.
 */
export function tsvToTable(text) {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 1 || !lines.some(l => l.includes('\t'))) return null;
  const rows = lines.map(l => l.split('\t').map(c => c.trim().replace(/\|/g, '\\|')));
  const cols = Math.max(...rows.map(r => r.length));
  if (cols < 2) return null;
  const out = rows.map(r => '| ' + Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ') + ' |');
  if (rows.length > 1) out.splice(1, 0, '|' + Array.from({ length: cols }, () => '---|').join(''));
  return alignTables(out.join('\n'));
}
