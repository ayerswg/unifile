/**
 * {spreadsheet} — the edit operations (pure, Node-tested in test/sheet.test.mjs).
 *
 * The text is the source of truth.  Every grid gesture is a function from the
 * document text to a new text:
 *
 *   parse → a plain MODEL of one sheet (cell texts + settings) → mutate →
 *   serialize the sheet canonically → replace that sheet's block in the text
 *
 * so the grid never holds state the file does not.  Each operation returns
 * `{ text, changes }` where `changes` are CodeMirror-style replacements in
 * ORIGINAL coordinates (the editor dispatches them, so they land in undo).
 *
 * The canonical serialization (`serializeModel`) is what "Tidy" writes too:
 *   ---                      the front matter: name · header · freeze · width ·
 *   name: Budget             height · decimals · sort · filter, then any other
 *   header: 1                keys the file carried, in their order
 *   ---
 *   # remarks                `#` lines, kept
 *   A1:D1 Item, Qty, … {…}   one line per ROW segment (its contiguous cells,
 *   D2:D9 =B*C               blanks as empty items), a run of 3+ identical
 *   A2:A9 {seq: 1}           formulas down a column as ONE fill, then the
 *   A4:C4 {merge}            sequences, merges, widths/heights/hidden, styles
 *   …                        (a style on exactly a value line's range rides on
 *                            that line), rules, scales, comments.
 * A file already in that form re-serializes byte-identically, so a one-cell
 * edit is a one-line diff.
 */

import { parseSpreadsheet, parseRange, formatRange, rangeEquals, rangeWithin, rangeIntersects, isOpen, colLetter, META_KEYS } from './parse.js';
import { formatStyleProps, formatCondition, compareValues, FLAGS } from './style.js';
import { formatStep } from './seq.js';
import { quoteIf, quoteArg } from './lex.js';
import { tokenize } from '../tables/formula.js';
import { literalValue } from '../tables/grid.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Model
 * @property {string} name
 * @property {string[][]} rows       cell texts (a merged-over or generated cell is '')
 * @property {number} headerRows
 * @property {{rows:number, cols:number}} freeze
 * @property {number|null} defaultWidth, defaultHeight, decimals
 * @property {boolean} filterOn
 * @property {Array<{key, value}>} extraMeta   front matter keys the engine doesn't own
 * @property {string[]} remarks      `# …` lines
 * @property {Map<number,number>} widths, heights
 * @property {Array<{r1,c1,r2,c2}>} merges
 * @property {Array<{range, props}>} styles
 * @property {Array<{range, cond, props}>} rules
 * @property {Array<{range, colors}>} scales
 * @property {Array<{r, c, text}>} comments
 * @property {Array<{range, start, step}>} sequences
 * @property {Array<{col, dir}>} sorts
 * @property {Array<{col, cond}>} filters
 * @property {Set<number>} hiddenRows, hiddenCols
 */

/** A fresh, empty model. */
export function emptyModel(name = 'Sheet1') {
  return {
    name, rows: [['']], headerRows: 0, freeze: { rows: 0, cols: 0 }, defaultWidth: null, defaultHeight: null, decimals: null,
    filterOn: false, extraMeta: [], remarks: [], widths: new Map(), heights: new Map(),
    merges: [], styles: [], rules: [], scales: [], comments: [], sequences: [], sorts: [], filters: [],
    hiddenRows: new Set(), hiddenCols: new Set(),
  };
}

/** The plain model of a parsed sheet. */
export function toModel(sheet) {
  const m = emptyModel(sheet.name);
  m.rows = sheet.rows.map(row => row.cells.map(cell => (cell.merged || cell.generated || cell.r !== row.cells[0].r ? '' : cell.text)));
  // A cell covered by a span from another row is the anchor object; blank it.
  sheet.rows.forEach((row, r) => row.cells.forEach((cell, c) => { if (cell.r !== r || cell.c !== c) m.rows[r][c] = ''; }));
  m.headerRows = sheet.headerRows;
  m.freeze = { ...sheet.freeze };
  m.defaultWidth = sheet.defaultWidth;
  m.defaultHeight = sheet.defaultHeight;
  m.decimals = sheet.decimals;
  m.filterOn = sheet.filterOn;
  m.extraMeta = sheet.meta.filter(e => e.key && !META_KEYS.includes(e.key)).map(e => ({ key: e.key, value: e.value }));
  m.remarks = sheet.remarks.map(r => r.text);
  m.widths = new Map(sheet.widths);
  m.heights = new Map(sheet.heights);
  m.merges = sheet.merges.map(x => ({ ...x.range }));
  m.styles = sheet.styles.map(s => ({ range: { ...s.range }, props: { ...s.props } }));
  m.rules = sheet.rules.map(s => ({ range: { ...s.range }, cond: { ...s.cond }, props: { ...s.props } }));
  m.scales = sheet.scales.map(s => ({ range: { ...s.range }, colors: s.colors.slice() }));
  m.comments = sheet.comments.map(c => ({ r: c.r, c: c.c, text: c.text }));
  m.sequences = sheet.sequences.map(s => ({ range: { ...s.range }, start: s.start, step: { ...s.step } }));
  m.sorts = sheet.sorts.map(s => ({ ...s }));
  m.filters = sheet.filters.map(f => ({ col: f.col, cond: { ...f.cond } }));
  m.hiddenRows = new Set(sheet.hidden.rows);
  m.hiddenCols = new Set(sheet.hidden.cols);
  return m;
}

const cols = (m) => m.rows.reduce((n, r) => Math.max(n, r.length), 0);

/** Make sure (r, c) exists: grow the rows / columns as needed. */
function ensure(m, r, c) {
  const width = Math.max(cols(m), c + 1);
  while (m.rows.length <= r) m.rows.push(new Array(width).fill(''));
  for (const row of m.rows) while (row.length < width) row.push('');
}

/** Drop trailing empty rows / columns (addresses never change; keep ≥ 1×1). */
function trim(m) {
  const used = (row) => row.some(t => t !== '');
  const bounded = (R) => (R.r2 === Infinity ? 0 : R.r2 + 1);
  const boundedC = (R) => (R.c2 === Infinity ? 0 : R.c2 + 1);
  const rowsNeeded = Math.max(1, m.headerRows, ...m.merges.map(bounded), ...m.comments.map(x => x.r + 1), ...m.sequences.map(s => bounded(s.range)));
  while (m.rows.length > rowsNeeded && !used(m.rows[m.rows.length - 1])) m.rows.pop();
  let w = cols(m);
  const colUsed = (c) => m.rows.some(row => row[c] !== '');
  const colsNeeded = Math.max(1, ...m.merges.map(boundedC), ...m.comments.map(x => x.c + 1), ...m.sequences.map(s => boundedC(s.range)));
  while (w > colsNeeded && !colUsed(w - 1)) w--;
  for (const row of m.rows) { row.length = w; for (let c = 0; c < w; c++) if (row[c] == null) row[c] = ''; }
  while (m.rows.length < rowsNeeded) m.rows.push(new Array(w).fill(''));
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const valueItem = (t) => {
  if (t === '') return '';
  if (t.startsWith('=')) return t;   // a formula: its commas are inside parens, its strings quoted
  if (/[,{}"\\]/.test(t) || t !== t.trim()) return quoteIf(t);
  return t;
};
// A setting value is quoted when it holds a `}`, a quote, or a comma that is
// not a number format's thousands separator (`$#,##0.00` stays bare).
const settingValue = (v) => {
  const t = String(v ?? '');
  const listComma = /,(?![#0-9])/.test(t);
  return /[{}"\\]/.test(t) || listComma || t !== t.trim() || t === '' ? quoteIf(t) : t;
};
const metaValue = (v) => {
  const t = String(v ?? '');
  return /^\s|\s$|^#|:\s|^["']|^(on|off|true|false|yes|no|null)$/i.test(t) && !/^(on|off)$/i.test(t) ? JSON.stringify(t) : t;
};

/** The sheet block as canonical text (no trailing newline). */
export function serializeModel(m) {
  trim(m);
  const w = cols(m);
  const lines = ['---'];
  lines.push(`name: ${metaValue(m.name)}`);
  if (m.headerRows) lines.push(`header: ${m.headerRows}`);
  if (m.freeze.rows || m.freeze.cols) lines.push('freeze: ' + [m.freeze.rows ? `rows ${m.freeze.rows}` : '', m.freeze.cols ? `cols ${m.freeze.cols}` : ''].filter(Boolean).join(', '));
  if (m.defaultWidth) lines.push(`width: ${m.defaultWidth}`);
  if (m.defaultHeight) lines.push(`height: ${m.defaultHeight}`);
  if (m.decimals != null) lines.push(`decimals: ${m.decimals}`);
  if (m.sorts.length) lines.push('sort: ' + m.sorts.map(s => `${colLetter(s.col)} ${s.dir}`).join(', '));
  if (m.filters.length) lines.push('filter: ' + m.filters.map(f => `${f.col == null ? '' : colLetter(f.col) + ' '}${formatCondition(f.cond)}`).join('; '));
  else if (m.filterOn) lines.push('filter: on');
  for (const e of m.extraMeta) lines.push(`${e.key}: ${e.value}`);
  lines.push('---');
  for (const r of m.remarks) lines.push(r);

  // Styles whose range is exactly a value line's range ride on that line.
  const styleByRange = new Map();
  const riding = new Set();
  for (const s of m.styles) styleByRange.set(formatRange(s.range), s);
  const withStyle = (rangeText, line) => {
    const s = styleByRange.get(rangeText);
    if (!s || riding.has(s)) return line;
    const p = formatStyleProps(s.props);
    if (!p) return line;
    riding.add(s);
    return `${line} {${propsToBlock(s.props)}}`;
  };

  // Value lines: column fills (3+ identical formulas), then row segments.
  const consumed = m.rows.map(row => row.map(() => false));
  const vlines = [];   // { r, c, text }
  for (let c = 0; c < w; c++) {
    let r = 0;
    while (r < m.rows.length) {
      const t = m.rows[r][c];
      if (!t.startsWith('=')) { r++; continue; }
      let e = r;
      while (e + 1 < m.rows.length && m.rows[e + 1][c] === t) e++;
      if (e - r + 1 >= 3) {
        for (let k = r; k <= e; k++) consumed[k][c] = true;
        const rangeText = formatRange({ r1: r, c1: c, r2: e, c2: c });
        vlines.push({ r, c, text: withStyle(rangeText, `${rangeText} ${valueItem(t)}`) });
      }
      r = e + 1;
    }
  }
  m.rows.forEach((row, r) => {
    let c = 0;
    while (c < w) {
      if (row[c] === '' || consumed[r][c]) { c++; continue; }
      let e = c;
      let lastUsed = c;
      while (e + 1 < w && !consumed[r][e + 1]) { e++; if (row[e] !== '') lastUsed = e; }
      e = lastUsed;
      const items = [];
      for (let k = c; k <= e; k++) items.push(valueItem(row[k]));
      const rangeText = formatRange({ r1: r, c1: c, r2: r, c2: e });
      vlines.push({ r, c, text: withStyle(rangeText, `${rangeText} ${items.join(', ')}`) });
      c = e + 1;
    }
  });
  vlines.sort((a, b) => a.r - b.r || a.c - b.c);
  if (vlines.length) lines.push('', ...vlines.map(v => v.text));

  const s = [];
  for (const q of m.sequences) s.push(`${formatRange(q.range)} {seq: ${settingValue(q.start)}${q.step.n === 1 && !q.step.unit ? '' : `, step: ${formatStep(q.step)}`}}`);
  for (const R of m.merges) s.push(`${formatRange(R)} {merge}`);
  for (const [range, n] of groupRuns([...m.widths.entries()].sort((a, b) => a[0] - b[0]))) s.push(`${range(colLetter)} {width: ${n}}`);
  for (const [range, n] of groupRuns([...m.heights.entries()].sort((a, b) => a[0] - b[0]))) s.push(`${range(i => String(i + 1))} {height: ${n}}`);
  if (m.hiddenCols.size) for (const [a, b] of runsOf([...m.hiddenCols].sort((x, y) => x - y))) s.push(`${a === b ? colLetter(a) : `${colLetter(a)}:${colLetter(b)}`} {hidden}`);
  if (m.hiddenRows.size) for (const [a, b] of runsOf([...m.hiddenRows].sort((x, y) => x - y))) s.push(`${a === b ? String(a + 1) : `${a + 1}:${b + 1}`} {hidden}`);
  for (const st of m.styles) { if (riding.has(st)) continue; const p = propsToBlock(st.props); if (p) s.push(`${formatRange(st.range)} {${p}}`); }
  // A condition is self-delimiting (its strings are quoted): written raw.
  for (const r of m.rules) s.push(`${formatRange(r.range)} {rule: ${formatCondition(r.cond)}, ${propsToBlock(r.props)}}`);
  for (const sc of m.scales) s.push(`${formatRange(sc.range)} {scale: ${sc.colors.join(' ')}}`);
  for (const c of m.comments) s.push(`${colLetter(c.c)}${c.r + 1} {comment: ${quoteIf(c.text, ',{}')}}`);
  if (s.length) lines.push('', ...s);
  return lines.join('\n');
}

/** Props → block entries: `bold, bg: #eef, format: $#,##0.00`. */
export function propsToBlock(props) {
  const out = [];
  for (const tok of formatStyleProps(props).split(' ').filter(Boolean)) {
    const i = tok.indexOf(':');
    if (i < 0) { out.push(tok); continue; }
    const key = tok.slice(0, i);
    let val = tok.slice(i + 1);
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
    out.push(`${key}: ${settingValue(val)}`);
  }
  return out.join(', ');
}

/** [[i, v], …] sorted by i → [[rangeFn, v]] for runs of consecutive i with equal v. */
function groupRuns(entries) {
  const out = [];
  let i = 0;
  while (i < entries.length) {
    let j = i;
    while (j + 1 < entries.length && entries[j + 1][0] === entries[j][0] + 1 && entries[j + 1][1] === entries[i][1]) j++;
    const a = entries[i][0], b = entries[j][0];
    out.push([(fmt) => (a === b ? fmt(a) : `${fmt(a)}:${fmt(b)}`), entries[i][1]]);
    i = j + 1;
  }
  return out;
}
function runsOf(sorted) {
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === n - 1) last[1] = n; else out.push([n, n]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying a model to the text
// ---------------------------------------------------------------------------

/**
 * Replace sheet `index`'s block with the serialized model.  A missing sheet
 * (an empty document, or `index` past the end) is appended.
 * @returns {{ text, changes: Array<{from,to,insert}> }}
 */
export function applyModel(text, wb, index, model) {
  const sheet = wb.sheets[index];
  const body = serializeModel(model);
  if (sheet) return finish(text, [{ from: sheet.from, to: sheet.to, insert: body }]);
  const at = text.length;
  const prefix = text.length === 0 ? '' : (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n');
  return finish(text, [{ from: at, to: at, insert: prefix + body + (text.length === 0 ? '\n' : '') }]);
}

function finish(text, changes) {
  changes.sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  for (const ch of changes) { out += text.slice(pos, ch.from) + ch.insert; pos = ch.to; }
  out += text.slice(pos);
  return { text: out, changes };
}

/** `op(model, sheet, wb)` on sheet `index` → `{ text, changes }`. */
export function withSheet(text, index, op, book = null) {
  const wb = book?.wb ?? parseSpreadsheet(text);
  const sheet = wb.sheets[index];
  const model = sheet ? toModel(sheet) : emptyModel(index === 0 ? 'Sheet1' : `Sheet${index + 1}`);
  const result = op(model, sheet, wb) ?? {};
  if (result.cancel) return { text, changes: [], ...result };
  const applied = applyModel(text, wb, index, model);
  return { ...applied, ...result };
}

/** Every sheet re-serialized (the Tidy action). */
export function alignSpreadsheet(text) {
  const wb = parseSpreadsheet(text ?? '');
  if (!wb.sheets.length) return text ?? '';
  const changes = wb.sheets.map(s => ({ from: s.from, to: s.to, insert: serializeModel(toModel(s)) }));
  return finish(text, changes).text;
}

// ---------------------------------------------------------------------------
// Cell operations
// ---------------------------------------------------------------------------

export function setCell(text, index, r, c, value, book) {
  return withSheet(text, index, (m) => { ensure(m, r, c); m.rows[r][c] = normalizeInput(value); }, book);
}

/** Paste a matrix of texts at (r, c). */
export function setCells(text, index, r, c, matrix, book) {
  return withSheet(text, index, (m) => {
    matrix.forEach((row, i) => row.forEach((v, j) => { ensure(m, r + i, c + j); m.rows[r + i][c + j] = normalizeInput(v); }));
  }, book);
}

export function clearRange(text, index, R, book) {
  return withSheet(text, index, (m) => {
    const r2 = Math.min(R.r2, m.rows.length - 1), c2 = Math.min(R.c2, cols(m) - 1);
    for (let r = R.r1; r <= r2; r++) for (let c = R.c1; c <= c2; c++) m.rows[r][c] = '';
  }, book);
}

/** A typed value → cell text: newlines collapsed, trimmed. */
function normalizeInput(v) {
  return String(v ?? '').replace(/\r?\n/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Rows & columns
// ---------------------------------------------------------------------------

/**
 * Insert `n` rows before row `at`.  Settings ranges and formula references
 * on or below `at` move down (every sheet's formulas that name this sheet
 * included); bare-column refs are untouched.
 */
export function insertRows(text, index, at, n = 1, book) {
  return structural(text, index, 'row', at, n, book, (m) => {
    const w = cols(m);
    for (let i = 0; i < n; i++) m.rows.splice(at, 0, new Array(w).fill(''));
    if (at < m.headerRows) m.headerRows += n;
  });
}

export function deleteRows(text, index, r1, r2, book) {
  const n = r2 - r1 + 1;
  return structural(text, index, 'row', r1, -n, book, (m) => {
    m.rows.splice(r1, n);
    if (r1 < m.headerRows) m.headerRows = Math.max(0, m.headerRows - Math.min(n, m.headerRows - r1));
    if (!m.rows.length) m.rows.push(new Array(Math.max(1, cols(m))).fill(''));
  });
}

export function insertCols(text, index, at, n = 1, book) {
  return structural(text, index, 'col', at, n, book, (m) => {
    for (const row of m.rows) for (let i = 0; i < n; i++) row.splice(at, 0, '');
  });
}

export function deleteCols(text, index, c1, c2, book) {
  const n = c2 - c1 + 1;
  return structural(text, index, 'col', c1, -n, book, (m) => {
    for (const row of m.rows) row.splice(c1, n);
    if (!cols(m)) for (const row of m.rows) row.push('');
  });
}

/**
 * The shared half of insert/delete: shift every address in the sheet's
 * settings and in every formula referring to this sheet.
 */
function structural(text, index, axis, at, n, book, mutate) {
  const wb = book?.wb ?? parseSpreadsheet(text);
  const sheet = wb.sheets[index];
  if (!sheet) return { text, changes: [] };
  const m = toModel(sheet);
  const name = sheet.name;
  mutate(m);

  const sh = (i) => shiftIndex(i, at, n);
  const shiftR = (R) => shiftRange(R, axis, at, n);
  const shiftMap = (map) => { const out = new Map(); for (const [i, v] of map) { const j = sh(i); if (j != null) out.set(j, v); } return out; };
  if (axis === 'row') { m.heights = shiftMap(m.heights); m.hiddenRows = new Set([...m.hiddenRows].map(sh).filter(x => x != null)); }
  else { m.widths = shiftMap(m.widths); m.hiddenCols = new Set([...m.hiddenCols].map(sh).filter(x => x != null)); }
  m.merges = m.merges.map(shiftR).filter(Boolean).filter(R => R.r1 !== R.r2 || R.c1 !== R.c2);
  m.styles = m.styles.map(s => ({ ...s, range: shiftR(s.range) })).filter(s => s.range);
  m.rules = m.rules.map(s => ({ ...s, range: shiftR(s.range) })).filter(s => s.range);
  m.scales = m.scales.map(s => ({ ...s, range: shiftR(s.range) })).filter(s => s.range);
  m.sequences = m.sequences.map(s => ({ ...s, range: shiftR(s.range) })).filter(s => s.range);
  m.comments = m.comments.map(c => { const R = shiftR({ r1: c.r, c1: c.c, r2: c.r, c2: c.c }); return R ? { ...c, r: R.r1, c: R.c1 } : null; }).filter(Boolean);
  if (axis === 'col') {
    m.sorts = m.sorts.map(s => ({ ...s, col: sh(s.col) })).filter(s => s.col != null);
    m.filters = m.filters.map(f => (f.col == null ? f : (sh(f.col) == null ? null : { ...f, col: sh(f.col) }))).filter(Boolean);
  }
  // Formulas in this sheet (local refs) …
  for (const row of m.rows) row.forEach((t, c) => { if (t.startsWith('=')) row[c] = '=' + shiftFormula(t.slice(1), axis, at, n, name, true); });
  if (axis === 'row') {
    for (const f of m.filters) if (f.cond.kind === 'formula') f.cond = { ...f.cond, formula: shiftFormula(f.cond.formula, axis, at, n, name, true) };
    for (const r of m.rules) if (r.cond.kind === 'formula') r.cond = { ...r.cond, formula: shiftFormula(r.cond.formula, axis, at, n, name, true) };
  }
  const changes = [];
  // … and in the other sheets (refs that name this sheet).
  for (const other of wb.sheets) {
    if (other === sheet) continue;
    for (const cell of other.cells) {
      if (cell.formula == null || cell.merged || cell.synthetic || cell.generated) continue;
      const nf = shiftFormula(cell.formula, axis, at, n, name, false);
      if (nf !== cell.formula) changes.push({ from: cell.from, to: cell.to, insert: valueItem('=' + nf) });
    }
  }
  // A cell set by a fill line is one source span shared by every cell of the
  // fill: dedupe so one replacement goes out per span.
  const seen = new Set();
  const deduped = changes.filter(ch => { const k = ch.from + ':' + ch.to; if (seen.has(k)) return false; seen.add(k); return true; });
  deduped.push({ from: sheet.from, to: sheet.to, insert: serializeModel(m) });
  return finish(text, deduped);
}

/** A 0-based index after inserting (n>0) / deleting (n<0, |n| items) at `at`; null = deleted. */
function shiftIndex(i, at, n) {
  if (n > 0) return i >= at ? i + n : i;
  const end = at - n - 1;
  if (i < at) return i;
  if (i > end) return i + n;
  return null;
}

/** Shift a range along one axis; a range entirely deleted → null, partly → clipped. */
export function shiftRange(R, axis, at, n) {
  const lo = axis === 'row' ? R.r1 : R.c1, hi = axis === 'row' ? R.r2 : R.c2;
  let a, b;
  if (hi === Infinity) { a = lo === 0 ? 0 : shiftIndex(lo, at, n) ?? (n < 0 ? at : lo); b = Infinity; }
  else if (n > 0) { a = lo >= at ? lo + n : lo; b = hi >= at ? hi + n : hi; }
  else {
    const end = at - n - 1;
    if (lo >= at && hi <= end) return null;
    a = lo < at ? lo : lo > end ? lo + n : at;
    b = hi < at ? hi : hi > end ? hi + n : at - 1;
    if (b < a) return null;
  }
  return axis === 'row' ? { ...R, r1: a, r2: b } : { ...R, c1: a, c2: b };
}

/**
 * Rewrite the references in a formula for rows/columns inserted or deleted
 * on sheet `name`.  `local` = the formula lives on that sheet (so unqualified
 * refs are its own).  A reference entirely deleted becomes `#REF!`.
 */
export function shiftFormula(formula, axis, at, n, name, local) {
  let toks;
  try { toks = tokenize(formula); } catch { return formula; }
  let out = '';
  let last = 0;
  for (const t of toks) {
    if (t.type === 'end') break;
    out += formula.slice(last, t.from);
    if (t.type === 'ref' && ((t.value.sheet == null && local) || (t.value.sheet != null && t.value.sheet.toLowerCase() === name.toLowerCase()))) {
      out += shiftRefText(t.value, axis, at, n);
    } else {
      out += formula.slice(t.from, t.to);
    }
    last = t.to;
  }
  return out + formula.slice(last);
}

function shiftRefText(ref, axis, at, n) {
  const sheet = ref.sheet == null ? '' : (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.sheet) ? ref.sheet : `'${ref.sheet.replace(/'/g, "''")}'`) + '!';
  const parse = (a) => { const m = /^([A-Za-z]{1,3})(\d*)$/.exec(a); return { c: m ? colIndexOf(m[1]) : null, r: m && m[2] ? parseInt(m[2], 10) - 1 : null }; };
  const fmt = (p) => (p.c == null ? '' : colLetter(p.c)) + (p.r == null ? '' : String(p.r + 1));
  const A = parse(ref.a), B = ref.b == null ? null : parse(ref.b);
  const move = (p) => {
    const q = { ...p };
    if (axis === 'row' && p.r != null) q.r = shiftIndex(p.r, at, n);
    if (axis === 'col' && p.c != null) q.c = shiftIndex(p.c, at, n);
    return q;
  };
  if (!B) {
    const q = move(A);
    if ((axis === 'row' && A.r != null && q.r == null) || (axis === 'col' && q.c == null)) return '#REF!';
    return sheet + fmt(q);
  }
  const lo = axis === 'row' ? A.r : A.c, hi = axis === 'row' ? B.r : B.c;
  if (lo == null || hi == null) {
    const qa = move(A), qb = move(B);
    if ((axis === 'col' && (qa.c == null || qb.c == null)) || (axis === 'row' && lo != null && (qa.r == null || qb.r == null))) return '#REF!';
    return sheet + fmt(qa) + ':' + fmt(qb);
  }
  const R = shiftRange(axis === 'row' ? { r1: Math.min(lo, hi), r2: Math.max(lo, hi), c1: 0, c2: 0 } : { c1: Math.min(lo, hi), c2: Math.max(lo, hi), r1: 0, r2: 0 }, axis, at, n);
  if (!R) return '#REF!';
  const qa = { ...A }, qb = { ...B };
  if (axis === 'row') { qa.r = R.r1; qb.r = R.r2; } else { qa.c = R.c1; qb.c = R.c2; }
  return sheet + fmt(qa) + ':' + fmt(qb);
}
function colIndexOf(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// ---------------------------------------------------------------------------
// Sorting the DATA (a one-time reorder of the rows' text)
// ---------------------------------------------------------------------------

/**
 * Reorder the body rows (below the header) by column `col`.  Row-level
 * things ride along: heights, hidden flags, comments and single-row styles;
 * block-level ranges and sequences stay where they are.  Formulas are not
 * rewritten (Excel doesn't either — bare-column formulas like `=B*C` travel
 * intact).  Generated (sequence) cells are positional and stay.
 */
export function sortRows(text, index, col, dir, book, { header = null } = {}) {
  return withSheet(text, index, (m, sheet) => {
    const h = header ?? (m.headerRows || (m.freeze.rows ? m.freeze.rows : 1));
    const body = m.rows.slice(h);
    if (body.length < 2) return;
    const keyed = body.map((row, i) => {
      const cell = sheet?.grid[h + i]?.[col];
      const v = cell && book ? book.valueOf(cell) : literalValue(row[col] ?? '');
      return { row, i, v };
    });
    keyed.sort((a, b) => {
      const xb = a.v == null || a.v === '', yb = b.v == null || b.v === '';
      if (xb && yb) return a.i - b.i;
      if (xb) return 1;
      if (yb) return -1;
      const d = compareValues(a.v, b.v);
      return d ? (dir === 'desc' ? -d : d) : a.i - b.i;
    });
    const perm = new Map(keyed.map((k, newI) => [h + k.i, h + newI]));
    m.rows = [...m.rows.slice(0, h), ...keyed.map(k => k.row)];
    const mv = (r) => perm.get(r) ?? r;
    m.heights = new Map([...m.heights].map(([r, v]) => [mv(r), v]));
    m.hiddenRows = new Set([...m.hiddenRows].map(mv));
    m.comments = m.comments.map(c => ({ ...c, r: mv(c.r) }));
    const single = (R) => R.r1 === R.r2 && R.r2 !== Infinity && R.r1 >= h;
    m.styles = m.styles.map(s => single(s.range) ? { ...s, range: { ...s.range, r1: mv(s.range.r1), r2: mv(s.range.r1) } } : s);
    m.merges = m.merges.map(R => single(R) ? { ...R, r1: mv(R.r1), r2: mv(R.r1) } : R);
  }, book);
}

// ---------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------

export function mergeRange(text, index, R, book) {
  return withSheet(text, index, (m) => {
    if (R.r1 === R.r2 && R.c1 === R.c2) return { cancel: true };
    ensure(m, R.r2, R.c2);
    let keep = '';
    for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) { if (!keep && m.rows[r][c]) keep = m.rows[r][c]; m.rows[r][c] = ''; }
    m.rows[R.r1][R.c1] = keep;
    m.merges = m.merges.filter(x => !rangeIntersects(x, R));
    m.merges.push({ r1: R.r1, c1: R.c1, r2: R.r2, c2: R.c2 });
  }, book);
}

export function unmergeRange(text, index, R, book) {
  return withSheet(text, index, (m) => {
    const before = m.merges.length;
    m.merges = m.merges.filter(x => !rangeIntersects(x, R));
    if (m.merges.length === before) return { cancel: true };
  }, book);
}

// ---------------------------------------------------------------------------
// Styles, rules, scales, comments, sequences
// ---------------------------------------------------------------------------

/**
 * Set properties on a range.  `props` values: true/false for flags, a value
 * or null (clear) for keyed ones.  Earlier style entries inside the range
 * lose those keys (an entry left empty goes); an entry with the same range
 * takes the new keys; a clear that an overlapping wider entry still sets is
 * written as `bold: off` / `color: none`.
 */
export function setStyle(text, index, R, props, book) {
  return withSheet(text, index, (m) => {
    const keys = Object.keys(props);
    const clears = keys.filter(k => props[k] === false || props[k] == null);
    const sets = keys.filter(k => !clears.includes(k));
    m.styles = m.styles.map(s => {
      if (!rangeWithin(s.range, R)) return s;
      const p = { ...s.props };
      for (const k of keys) delete p[k];
      return { ...s, props: p };
    }).filter(s => Object.keys(s.props).length);
    const explicit = clears.filter(k => m.styles.some(s => rangeIntersects(s.range, R) && k in s.props && s.props[k] !== false && s.props[k] != null));
    const write = {};
    for (const k of sets) write[k] = props[k];
    for (const k of explicit) write[k] = FLAGS.includes(k) ? false : null;
    if (!Object.keys(write).length) return;
    const same = m.styles.find(s => rangeEquals(s.range, R));
    if (same) Object.assign(same.props, write);
    else m.styles.push({ range: { ...R }, props: write });
  }, book);
}

/** True when EVERY cell of the range resolves `key` (for toggles). */
export function rangeHas(book, sheet, R, key) {
  const r2 = Math.min(R.r2, sheet.rows.length - 1), c2 = Math.min(R.c2, sheet.cols - 1);
  if (r2 < R.r1 || c2 < R.c1) return false;
  for (let r = R.r1; r <= r2; r++) for (let c = R.c1; c <= c2; c++) {
    const cell = sheet.grid[r]?.[c];
    if (!cell) return false;
    if (!book.styleOf(cell)[key]) return false;
  }
  return true;
}

export function addRule(text, index, R, cond, props, book) {
  return withSheet(text, index, (m) => { m.rules.push({ range: { ...R }, cond, props }); }, book);
}
export function removeRule(text, index, i, book) {
  return withSheet(text, index, (m) => { m.rules.splice(i, 1); }, book);
}
export function updateRule(text, index, i, { range, cond, props }, book) {
  return withSheet(text, index, (m) => { if (m.rules[i]) m.rules[i] = { range: { ...range }, cond, props }; }, book);
}
export function addScale(text, index, R, colors, book) {
  return withSheet(text, index, (m) => { m.scales = m.scales.filter(s => !rangeEquals(s.range, R)); m.scales.push({ range: { ...R }, colors }); }, book);
}
export function removeScale(text, index, i, book) {
  return withSheet(text, index, (m) => { m.scales.splice(i, 1); }, book);
}

export function setComment(text, index, r, c, comment, book) {
  return withSheet(text, index, (m) => {
    m.comments = m.comments.filter(x => !(x.r === r && x.c === c));
    const t = String(comment ?? '').replace(/\s*\n\s*/g, ' ').trim();
    if (t) { ensure(m, r, c); m.comments.push({ r, c, text: t }); }
  }, book);
}

/** A sequence over a range (`null` start removes any sequence on exactly that range). */
export function setSequence(text, index, R, start, step, book) {
  return withSheet(text, index, (m) => {
    m.sequences = m.sequences.filter(s => !rangeEquals(s.range, R));
    if (start != null && start !== '') {
      // The cells the sequence generates must not hold explicit values.
      if (!isOpen(R)) { ensure(m, R.r2, R.c2); for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) m.rows[r][c] = ''; }
      m.sequences.push({ range: { ...R }, start: String(start), step: step ?? { n: 1, unit: null } });
    }
  }, book);
}

// ---------------------------------------------------------------------------
// Layout: widths, heights, freeze, hide, header, sort/filter views
// ---------------------------------------------------------------------------

export function setWidth(text, index, c1, c2, n, book) {
  return withSheet(text, index, (m) => { for (let c = c1; c <= c2; c++) { if (n) m.widths.set(c, n); else m.widths.delete(c); } }, book);
}
export function setHeight(text, index, r1, r2, n, book) {
  return withSheet(text, index, (m) => { for (let r = r1; r <= r2; r++) { if (n) m.heights.set(r, n); else m.heights.delete(r); } }, book);
}
export function setFreeze(text, index, rows, colsN, book) {
  return withSheet(text, index, (m) => { m.freeze = { rows: Math.max(0, rows | 0), cols: Math.max(0, colsN | 0) }; }, book);
}
export function setHidden(text, index, axis, a, b, hidden, book) {
  return withSheet(text, index, (m) => {
    const set = axis === 'row' ? m.hiddenRows : m.hiddenCols;
    for (let i = a; i <= b; i++) { if (hidden) set.add(i); else set.delete(i); }
  }, book);
}
export function setSortView(text, index, sorts, book) {
  return withSheet(text, index, (m) => { m.sorts = sorts.map(s => ({ col: s.col, dir: s.dir })); }, book);
}
export function setFilter(text, index, col, cond, book) {
  return withSheet(text, index, (m) => {
    m.filters = m.filters.filter(f => f.col !== col);
    if (cond) { m.filters.push({ col, cond }); m.filterOn = true; }
  }, book);
}
export function setFilterOn(text, index, on, book) {
  return withSheet(text, index, (m) => { m.filterOn = !!on; if (!on) m.filters = []; }, book);
}
export function clearFilters(text, index, book) {
  return withSheet(text, index, (m) => { m.filters = []; m.sorts = []; }, book);
}
export function setHeaderRows(text, index, n, book) {
  return withSheet(text, index, (m) => { m.headerRows = Math.max(0, Math.min(n | 0, m.rows.length - 1)); }, book);
}
/** Any front matter key (the engine's own keys go through their setters). */
export function setMeta(text, index, key, value, book) {
  return withSheet(text, index, (m) => {
    m.extraMeta = m.extraMeta.filter(e => e.key !== key);
    if (value != null && value !== '') m.extraMeta.push({ key, value: String(value) });
  }, book);
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export function addSheet(text, name, book) {
  const wb = book?.wb ?? parseSpreadsheet(text);
  const used = new Set(wb.sheets.map(s => s.name.toLowerCase()));
  const base = (name || `Sheet${wb.sheets.length + 1}`).trim() || 'Sheet';
  let n = base, k = 2;
  while (used.has(n.toLowerCase())) n = `${base} ${k++}`;
  const m = emptyModel(n);
  const at = text.length;
  const prefix = text.length === 0 ? '' : (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n');
  return { ...finish(text, [{ from: at, to: at, insert: prefix + serializeModel(m) + '\n' }]), index: wb.sheets.length };
}

export function renameSheet(text, index, name, book) {
  const wb = book?.wb ?? parseSpreadsheet(text);
  const sheet = wb.sheets[index];
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!sheet || !n || wb.sheets.some((s, i) => i !== index && s.name.toLowerCase() === n.toLowerCase())) return { text, changes: [] };
  const changes = [];
  const nameEntry = sheet.meta.find(e => e.key === 'name');
  if (nameEntry) changes.push({ from: nameEntry.from, to: nameEntry.to, insert: `name: ${metaValue(n)}` });
  else if (sheet.metaRange && !sheet.metaRange.unclosed) changes.push({ from: sheet.metaRange.from + 3, to: sheet.metaRange.from + 3, insert: `\nname: ${metaValue(n)}` });
  else changes.push({ from: sheet.from, to: sheet.from, insert: `---\nname: ${metaValue(n)}\n---\n` });
  const q = /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`;
  const seen = new Set();
  for (const other of wb.sheets) {
    for (const cell of other.cells) {
      if (cell.formula == null || cell.merged || cell.synthetic || cell.generated) continue;
      const nf = renameRefs(cell.formula, sheet.name, q);
      const k = cell.from + ':' + cell.to;
      if (nf !== cell.formula && !seen.has(k)) { seen.add(k); changes.push({ from: cell.from, to: cell.to, insert: '=' + nf }); }
    }
  }
  return finish(text, changes);
}

function renameRefs(formula, oldName, newQuoted) {
  let toks;
  try { toks = tokenize(formula); } catch { return formula; }
  let out = '', last = 0;
  for (const t of toks) {
    if (t.type === 'end') break;
    out += formula.slice(last, t.from);
    if (t.type === 'ref' && t.value.sheet != null && t.value.sheet.toLowerCase() === oldName.toLowerCase()) {
      out += newQuoted + '!' + t.value.a.toUpperCase() + (t.value.b != null ? ':' + t.value.b.toUpperCase() : '');
    } else out += formula.slice(t.from, t.to);
    last = t.to;
  }
  return out + formula.slice(last);
}

export function deleteSheet(text, index, book) {
  const wb = book?.wb ?? parseSpreadsheet(text);
  const sheet = wb.sheets[index];
  if (!sheet || wb.sheets.length < 2) return { text, changes: [] };
  let from = sheet.from, to = sheet.to;
  while (to < text.length && text[to] === '\n') to++;
  if (index === wb.sheets.length - 1) while (from > 1 && text[from - 1] === '\n' && text[from - 2] === '\n') from--;
  return finish(text, [{ from, to, insert: '' }]);
}

/** New-document text: one named sheet with a header row. */
export function starterText(title = 'Sheet1') {
  return `---\nname: ${title}\nheader: 1\n---\n`;
}

export { parseRange, formatRange, quoteArg };
