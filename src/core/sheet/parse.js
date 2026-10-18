/**
 * {spreadsheet} — the DSL parser (pure, Node-tested in test/sheet.test.mjs).
 *
 * A workbook is a plain-text file of SHEETS.  Each sheet is a YAML front
 * matter block (the sheet-wide settings) followed by one line per cell or
 * range it defines:
 *
 *   ---
 *   name: Budget
 *   header: 1                  header rows: bold, frozen, out of sort/filter
 *   freeze: cols 1             frozen panes beyond the header
 *   filter: B > 0              on | off | criteria (`;`-separated)
 *   sort: D desc, A asc        a VIEW sort (the text never moves)
 *   decimals: 2
 *   ---
 *   A1:D1  Item, Qty, Price, Total {bold, bg: #eef}
 *   A2:C2  Apples, 3, 1.20
 *   A3:C3  Pears, 2, 0.80
 *   D2:D3  =B*C {format: $#,##0.00}
 *   A4:C4  Total {merge}
 *   D4     =SUM(D2:D3)
 *   A2:A3  {seq: 1}            generated values (numbers, dates, names)
 *   D2:D3  {rule: > 3, bold, color: green}
 *   B2     {comment: "Market price, October"}
 *   A      {width: 18}
 *   5:7    {hidden}
 *
 * A line is `<range> [values] [{settings}]`.  Values are comma-separated and
 * fill the range row by row (one value fills every cell; quote text holding
 * commas; `=…` is a formula — commas inside it are its own).  Settings are
 * `key: value` pairs and flags between braces: the style properties, `merge`,
 * `comment`, `rule` (the block's properties become a conditional format),
 * `scale`, `seq`/`step`, `width`, `height`, `hidden`.  `# …` lines are
 * comments.  Addresses are Excel's (`A1`, `B2:D9`, `A:A`, `3:5`).
 *
 * The result is the model the grid (src/ui/sheet-grid.js), the renderer
 * (render.js) and the edit operations (edit.js) share.  Every cell and line
 * carries absolute character offsets (click-back; edit.js rewrites exactly
 * one sheet block).  Problems are collected, never thrown.
 */

import { colLetter, colIndex, cellText } from '../tables/grid.js';
import { splitTop, unquote, trimSeg, tokenizeArgs } from './lex.js';
import { parseStyleProps, parseCondition, parseColor } from './style.js';
import { parseStep, generateSequence } from './seq.js';

export { tokenizeArgs, quoteArg } from './lex.js';

export const SETTING_KEYS = ['merge', 'comment', 'rule', 'scale', 'bar', 'seq', 'step', 'width', 'height', 'hidden', 'chart', 'title', 'at', 'size', 'series', 'legend'];
export const META_KEYS = ['name', 'header', 'freeze', 'width', 'height', 'decimals', 'sort', 'filter'];
export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'scatter'];

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
export const rangeWithin = (A, B) => A.r1 >= B.r1 && A.r2 <= B.r2 && A.c1 >= B.c1 && A.c2 <= B.c2;
export const rangeIntersects = (A, B) => A.r1 <= B.r2 && B.r1 <= A.r2 && A.c1 <= B.c2 && B.c1 <= A.c2;
export const isCellRange = (R) => R.r1 === R.r2 && R.c1 === R.c2 && R.r2 !== Infinity && R.c2 !== Infinity;
export const isOpen = (R) => R.r2 === Infinity || R.c2 === Infinity;

const RANGE_TOKEN_RE = /^(\$?[A-Za-z]{1,3}\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d*)?|\d+(?::\d+)?)(?=\s|$|\{)/;

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * Parse one cell line.  Offsets are relative to the line.
 * @returns {{ range, rangeText, values: Array<{text, from, to}>|null, block: {entries, from, to}|null, error? }}
 *   values  — the trimmed items (quotes removed; `text` is what the cell holds)
 *   block   — entries: Array<{ key, value: string|null, from, to }>
 */
export function parseLine(line) {
  const m = RANGE_TOKEN_RE.exec(line.trimStart());
  const lead = line.length - line.trimStart().length;
  if (!m) return { range: null, error: 'a line starts with a cell or range (A1, A1:C3, A, 3)' };
  const range = parseRange(m[1]);
  if (!range) return { range: null, error: `"${m[1]}" is not a cell or range` };
  const rest = line.slice(lead + m[0].length);
  const restFrom = lead + m[0].length;
  // The settings block is the LAST `{ … }` at the top level.
  let blockAt = -1;
  { let depth = 0, inStr = false;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === '{' && depth === 0) { blockAt = i; break; }
    } }
  let valuesText = blockAt >= 0 ? rest.slice(0, blockAt) : rest;
  let block = null;
  if (blockAt >= 0) {
    const close = rest.lastIndexOf('}');
    if (close < blockAt) return { range, rangeText: m[1], values: null, block: null, error: 'missing `}`' };
    const inner = rest.slice(blockAt + 1, close);
    const entries = [];
    for (const seg of splitTop(inner, ',', { formats: true })) {
      const t = trimSeg(seg);
      if (!t.text) continue;
      const colon = findTopColon(t.text);
      const key = (colon < 0 ? t.text : t.text.slice(0, colon)).trim().toLowerCase();
      const value = colon < 0 ? null : unquote(t.text.slice(colon + 1).trim());
      entries.push({ key, value, from: restFrom + blockAt + 1 + t.from, to: restFrom + blockAt + 1 + t.to });
    }
    block = { entries, from: restFrom + blockAt, to: restFrom + close + 1 };
    if (rest.slice(close + 1).trim()) return { range, rangeText: m[1], values: null, block, error: 'text after `}`' };
  }
  let values = null;
  if (valuesText.trim()) {
    values = splitTop(valuesText, ',').map(seg => {
      const t = trimSeg(seg);
      return { text: unquote(t.text), raw: t.text, from: restFrom + t.from, to: restFrom + t.to };
    });
  }
  return { range, rangeText: m[1], values, block };
}

/** The first `:` outside quotes (a `key: value` split; `$#,##0.00` has none). */
function findTopColon(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (inStr) { if (s[i] === '\\') i++; else if (s[i] === '"') inStr = false; continue; }
    if (s[i] === '"') inStr = true;
    else if (s[i] === ':') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Sheet front matter
// ---------------------------------------------------------------------------

/** Flat `key: value` lines → ordered entries (unknown keys kept verbatim). */
export function parseMeta(text, base = 0) {
  const entries = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (m && !raw.startsWith(' ')) {
      let v = m[2].trim();
      // A trailing ` # comment` (not a colour: `#eef` is glued to text/space before).
      v = v.replace(/\s+#(?![0-9a-fA-F]{3,8}\b).*$/, '').trim();
      v = unquoteYaml(v);
      entries.push({ key: m[1].toLowerCase(), value: v, from: base + pos, to: base + pos + raw.length, raw });
    } else if (raw.trim() && !raw.trim().startsWith('#')) {
      entries.push({ key: null, value: null, from: base + pos, to: base + pos + raw.length, raw });
    }
    pos += raw.length + 1;
  }
  return entries;
}
function unquoteYaml(v) {
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) return v.slice(1, -1);
  return v;
}

/** `rows 1, cols 2` | `1` | `rows:1 cols:2` → { rows, cols }. */
export function parseFreeze(v) {
  const out = { rows: 0, cols: 0 };
  const t = String(v ?? '').toLowerCase();
  if (/^\d+$/.test(t.trim())) { out.rows = parseInt(t, 10); return out; }
  for (const m of t.matchAll(/(rows?|cols?|columns?)\s*:?\s*(\d+)/g)) out[m[1].startsWith('r') ? 'rows' : 'cols'] = parseInt(m[2], 10);
  return out;
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Sheet
 * @property {number} index
 * @property {string} name
 * @property {number} nameFrom,nameTo   the `name:` line (== from when absent)
 * @property {number} from,to       the whole block (the `---` … last line)
 * @property {Array<{key,value,from,to,raw}>} meta   the front matter entries
 * @property {object|null} metaRange   { from, to } of the front matter block
 * @property {Array<{from,to,text}>} remarks    `# …` lines (preserved)
 * @property {Array} lines          parsed cell lines ({ from, to, range, values, block })
 * @property {Array<{from,to,cells:Cell[]}>} rows   rows[r].from/to = the line that set the row's first cell
 * @property {number} cols
 * @property {number} headerRows
 * @property {(Cell|null)[][]} grid
 * @property {Cell[]} cells
 * — settings:
 * @property {{rows, cols}} freeze
 * @property {Map<number,number>} widths, heights
 * @property {number|null} defaultWidth, defaultHeight
 * @property {boolean} filterOn
 * @property {Array<{range, from, to}>} merges
 * @property {Array<{range, props, from, to}>} styles
 * @property {Array<{range, cond, props, from, to}>} rules
 * @property {Array<{range, colors, from, to}>} scales
 * @property {Array<{r, c, text, from, to}>} comments   cell comments
 * @property {Array<{range, start, step, from, to}>} sequences
 * @property {Array<{col, dir}>} sorts
 * @property {Array<{col, cond}>} filters
 * @property {{rows:Set, cols:Set}} hidden
 * @property {Array<{from,to,message}>} problems
 *
 * Cell = { r, c, text, from, to, rawFrom, rawTo, colspan, rowspan, formula,
 *          merged, synthetic (no source), generated (from a seq), sheet }
 */

/**
 * Parse a {spreadsheet} document.
 * @returns {{ sheets: Sheet[], meta: object, problems: Array }}
 */
export function parseSpreadsheet(text) {
  const src = text ?? '';
  const lines = [];
  let pos = 0;
  for (const raw of src.split('\n')) {
    lines.push({ text: raw, from: pos, to: pos + raw.length });
    pos += raw.length + 1;
  }

  // 1. Cut into sheet blocks: a `---` line opens a sheet; its front matter
  //    runs to the next `---`; the body runs to the next opening `---`.
  const blocks = [];
  let cur = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (/^---\s*$/.test(ln.text)) {
      // Opening fence: collect the front matter.
      cur = { metaFrom: ln.from, metaLines: [], metaRange: null, body: [], from: ln.from };
      blocks.push(cur);
      let k = i + 1;
      while (k < lines.length && !/^---\s*$/.test(lines[k].text)) { cur.metaLines.push(lines[k]); k++; }
      if (k < lines.length) { cur.metaRange = { from: ln.from, to: lines[k].to, innerFrom: lines[i + 1]?.from ?? lines[k].from }; i = k; }
      else { cur.metaRange = { from: ln.from, to: lines[lines.length - 1].to, innerFrom: lines[i + 1]?.from ?? ln.to, unclosed: true }; i = k; }
      continue;
    }
    if (!cur) {
      if (!ln.text.trim()) continue;
      cur = { metaFrom: null, metaLines: [], metaRange: null, body: [], from: ln.from };
      blocks.push(cur);
    }
    cur.body.push(ln);
  }

  const sheets = [];
  const problems = [];
  const usedNames = new Map();
  blocks.forEach((b, index) => {
    const sheet = _parseBlock(b, index);
    const base = sheet.name || `Sheet${index + 1}`;
    const n = usedNames.get(base.toLowerCase()) || 0;
    usedNames.set(base.toLowerCase(), n + 1);
    sheet.name = n ? `${base} ${n + 1}` : base;
    sheets.push(sheet);
    for (const p of sheet.problems) problems.push(p);
  });
  const first = sheets[0];
  const meta = {};
  for (const e of first?.meta ?? []) if (e.key) meta[e.key] = e.value;
  return { sheets, meta, problems, bodyFrom: first?.metaRange?.to ?? 0 };
}

function _parseBlock(b, index) {
  const problems = [];
  const problem = (ln, message) => problems.push({ from: ln.from, to: ln.to, message });

  // Front matter
  const metaText = b.metaLines.map(l => l.text).join('\n');
  const meta = parseMeta(metaText, b.metaRange?.innerFrom ?? b.from);
  const get = (k) => meta.find(e => e.key === k)?.value ?? null;
  if (b.metaRange?.unclosed) problems.push({ from: b.metaRange.from, to: b.metaRange.from + 3, message: 'front matter: missing the closing `---`' });
  for (const e of meta) if (e.key == null) problems.push({ from: e.from, to: e.to, message: 'front matter: expected `key: value`' });

  const sheet = {
    index, meta, metaRange: b.metaRange, from: b.from, to: b.from, remarks: [], lines: [], problems,
    name: get('name') || '', headerRows: 0, freeze: { rows: 0, cols: 0 }, widths: new Map(), heights: new Map(),
    defaultWidth: null, defaultHeight: null, decimals: null, filterOn: false,
    merges: [], styles: [], rules: [], scales: [], bars: [], charts: [], comments: [], sequences: [], sorts: [], filters: [],
    hidden: { rows: new Set(), cols: new Set() }, aligns: [],
  };
  const nameEntry = meta.find(e => e.key === 'name');
  sheet.nameFrom = nameEntry ? nameEntry.from : b.from;
  sheet.nameTo = nameEntry ? nameEntry.to : b.from;
  let last = b.metaRange?.to ?? b.from;

  const hdr = get('header');
  if (hdr != null) { const n = parseInt(hdr, 10); if (n >= 0) sheet.headerRows = n; else problem(meta.find(e => e.key === 'header'), 'header: expected a number of rows'); }
  if (get('freeze') != null) sheet.freeze = parseFreeze(get('freeze'));
  for (const k of ['width', 'height']) {
    const v = get(k);
    if (v != null) { const n = Number(v); if (n > 0) sheet[k === 'width' ? 'defaultWidth' : 'defaultHeight'] = n; else problem(meta.find(e => e.key === k), `${k}: expected a number`); }
  }
  const dec = get('decimals');
  if (dec != null && dec !== '' && !Number.isNaN(Number(dec))) sheet.decimals = Math.max(0, Math.min(10, Math.trunc(Number(dec))));
  const sortV = get('sort');
  if (sortV != null && !/^(off|none|)$/i.test(sortV.trim())) {
    for (const part of sortV.split(/[;,]/)) {
      const [colTok, dirTok] = part.trim().split(/\s+/);
      if (!colTok) continue;
      const R = parseRange(colTok);
      if (!R || R.c2 === Infinity) { problem(meta.find(e => e.key === 'sort'), `sort: "${colTok}" is not a column`); continue; }
      const dir = (dirTok || 'asc').toLowerCase();
      if (dir !== 'asc' && dir !== 'desc') { problem(meta.find(e => e.key === 'sort'), `sort: "${dirTok}" should be asc or desc`); continue; }
      sheet.sorts.push({ col: R.c1, dir });
    }
  }
  const filtV = get('filter');
  if (filtV != null) {
    const t = filtV.trim();
    if (/^(on|true|yes)$/i.test(t)) sheet.filterOn = true;
    else if (!/^(off|false|no|none|)$/i.test(t)) {
      sheet.filterOn = true;
      for (const seg of splitTop(t, ';')) {
        const part = seg.text.trim();
        if (!part) continue;
        const toks = tokenizeArgs(part);
        let col = null, condToks = toks;
        if (!toks[0].text.startsWith('=')) {
          const R = parseRange(toks[0].text);
          if (!R || R.c2 === Infinity) { problem(meta.find(e => e.key === 'filter'), `filter: "${toks[0].text}" is not a column`); continue; }
          col = R.c1; condToks = toks.slice(1);
        }
        const cond = parseCondition(condToks);
        if (cond.error) { problem(meta.find(e => e.key === 'filter'), `filter: ${cond.error}`); continue; }
        sheet.filters.push({ col, cond });
      }
    }
  }

  // Body lines
  const valueLines = [];   // { range, values, line }
  for (const ln of b.body) {
    const t = ln.text;
    if (!t.trim()) continue;
    last = ln.to;
    if (t.trimStart().startsWith('#')) { sheet.remarks.push({ from: ln.from, to: ln.to, text: t }); continue; }
    const p = parseLine(t);
    if (p.error && !p.range) { problem(ln, p.error); continue; }
    const rec = { from: ln.from, to: ln.to, range: p.range, rangeText: p.rangeText, values: null, block: null };
    if (p.values) rec.values = p.values.map(v => ({ ...v, from: ln.from + v.from, to: ln.from + v.to }));
    if (p.block) rec.block = { entries: p.block.entries.map(e => ({ ...e, from: ln.from + e.from, to: ln.from + e.to })), from: ln.from + p.block.from, to: ln.from + p.block.to };
    sheet.lines.push(rec);
    if (p.error) problem(ln, p.error);
    if (rec.values) valueLines.push(rec);
    if (rec.block) _applyBlock(sheet, rec, problem);
    if (!rec.values && !rec.block) problem(ln, 'a line needs values and/or a { … } settings block');
  }
  sheet.to = last;

  _buildCells(sheet, valueLines, problem);
  for (const m of sheet.merges) _applyMerge(sheet, m.range);
  for (const c of sheet.cells) c.sheet = index;
  return sheet;
}

/** Settings block → the sheet's lists. */
function _applyBlock(sheet, rec, problem) {
  const R = rec.range;
  const entries = rec.block.entries;
  const has = (k) => entries.some(e => e.key === k);
  const val = (k) => entries.find(e => e.key === k)?.value ?? null;
  const styleToks = [];
  for (const e of entries) {
    if (SETTING_KEYS.includes(e.key)) continue;
    styleToks.push(e.value == null ? e.key : `${e.key}:${e.value}`);
    if (!/^[a-z]+$/.test(e.key)) problem(rec, `"${e.key}" is not a setting`);
  }
  const { props, problems } = parseStyleProps(styleToks);
  for (const p of problems) problem(rec, p);

  if (has('merge')) {
    if (isOpen(R)) problem(rec, 'merge: a merge needs a bounded range');
    else if (!isCellRange(R)) sheet.merges.push({ range: R, from: rec.from, to: rec.to });
  }
  if (has('comment')) {
    if (val('comment') == null || val('comment') === '') problem(rec, 'comment: missing the text');
    else if (!isCellRange(R)) problem(rec, 'comment: expected a cell');
    else sheet.comments.push({ r: R.r1, c: R.c1, text: val('comment'), from: rec.from, to: rec.to });
  }
  if (has('rule')) {
    const cond = parseCondition(tokenizeArgs(val('rule') ?? ''));
    if (cond.error) problem(rec, `rule: ${cond.error}`);
    else if (!Object.keys(props).length) problem(rec, 'rule: add the properties to apply (bold, color: …)');
    else sheet.rules.push({ range: R, cond, props, from: rec.from, to: rec.to });
  } else if (Object.keys(props).length) {
    sheet.styles.push({ range: R, props, from: rec.from, to: rec.to });
  }
  if (has('scale')) {
    const colors = String(val('scale') ?? '').split(/[\s,]+/).filter(Boolean).map(parseColor);
    if (colors.length < 2 || colors.some(c => !c)) problem(rec, 'scale: expected two or three colours');
    else sheet.scales.push({ range: R, colors, from: rec.from, to: rec.to });
  }
  if (has('bar')) {
    const color = parseColor(val('bar') ?? '#1a8cf5') ?? (val('bar') == null ? '#1a8cf5' : null);
    if (!color) problem(rec, 'bar: expected a colour');
    else sheet.bars.push({ range: R, color, from: rec.from, to: rec.to });
  }
  if (has('chart')) {
    const type = String(val('chart') ?? 'column').toLowerCase();
    if (!CHART_TYPES.includes(type)) problem(rec, `chart: expected one of ${CHART_TYPES.join(', ')}`);
    else if (isOpen(R)) problem(rec, 'chart: the data needs a bounded range');
    else {
      const at = val('at') ? parseRange(val('at')) : null;
      if (val('at') && !at) problem(rec, 'at: expected a cell');
      const sm = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(val('size') ?? ''));
      if (val('size') && !sm) problem(rec, 'size: expected WIDTHxHEIGHT in px');
      const series = String(val('series') ?? 'cols').toLowerCase();
      sheet.charts.push({
        range: R, type, title: val('title') ?? '', at: at ? { r: at.r1, c: at.c1 } : null,
        size: sm ? { w: +sm[1], h: +sm[2] } : null, series: series === 'rows' ? 'rows' : 'cols',
        legend: !/^(off|false|no|none)$/i.test(String(val('legend') ?? 'on')), from: rec.from, to: rec.to,
      });
    }
  } else if (has('title') || has('at') || has('size') || has('series') || has('legend')) {
    problem(rec, 'title / at / size / series / legend belong to a chart');
  }
  if (has('seq')) {
    const step = parseStep(val('step'));
    if (!step) problem(rec, `step: "${val('step')}" — a number, or N days | weeks | months | years`);
    else if (!generateSequence(val('seq'), step, 1)) problem(rec, `seq: "${val('seq')}" is not a number, a date, a name or text ending in a number`);
    else sheet.sequences.push({ range: R, start: val('seq'), step, from: rec.from, to: rec.to, line: rec });
  } else if (has('step')) problem(rec, 'step: needs a seq');
  if (has('width')) {
    const n = Number(val('width'));
    if (!(n > 0)) problem(rec, 'width: expected a number of characters');
    else if (R.r2 !== Infinity) problem(rec, 'width: applies to columns (A, A:C)');
    else for (let c = R.c1; c <= Math.min(R.c2, R.c1 + 1000); c++) sheet.widths.set(c, n);
  }
  if (has('height')) {
    const n = Number(val('height'));
    if (!(n > 0)) problem(rec, 'height: expected a height in px');
    else if (R.c2 !== Infinity) problem(rec, 'height: applies to rows (3, 3:5)');
    else for (let r = R.r1; r <= Math.min(R.r2, R.r1 + 10000); r++) sheet.heights.set(r, n);
  }
  if (has('hidden')) {
    if (R.r2 === Infinity && R.c2 !== Infinity) for (let c = R.c1; c <= R.c2; c++) sheet.hidden.cols.add(c);
    else if (R.c2 === Infinity && R.r2 !== Infinity) for (let r = R.r1; r <= R.r2; r++) sheet.hidden.rows.add(r);
    else problem(rec, 'hidden: applies to whole rows (3:5) or columns (C:D)');
  }
}

/** Values + sequences → cells, grid, rows. */
function _buildCells(sheet, valueLines, problem) {
  // Extent: the bounded value lines, bounded sequences, merges, notes.
  let rows = 0, cols = 0;
  const grow = (R) => { if (R.r2 !== Infinity) rows = Math.max(rows, R.r2 + 1); if (R.c2 !== Infinity) cols = Math.max(cols, R.c2 + 1); };
  for (const l of valueLines) {
    const R = l.range;
    if (!isOpen(R)) { grow(R); continue; }
    // An open range with a list: the list sets the extent along the open axis.
    const n = l.values.length;
    if (R.r2 === Infinity && R.c2 === Infinity) { rows = Math.max(rows, n); cols = Math.max(cols, 1); }
    else if (R.r2 === Infinity) { const w = R.c2 - R.c1 + 1; rows = Math.max(rows, n > 1 ? Math.ceil(n / w) : 1); cols = Math.max(cols, R.c2 + 1); }
    else { const h = R.r2 - R.r1 + 1; cols = Math.max(cols, n > 1 ? Math.ceil(n / h) : 1); rows = Math.max(rows, R.r2 + 1); }
  }
  for (const s of sheet.sequences) grow(s.range);
  for (const m of sheet.merges) grow(m.range);
  for (const n of sheet.comments) grow({ r1: n.r, c1: n.c, r2: n.r, c2: n.c });
  for (const ch of sheet.charts) grow(ch.range);
  rows = Math.max(rows, 1, sheet.headerRows); cols = Math.max(cols, 1);

  const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const rowLine = new Array(rows).fill(null);
  const bound = (R) => ({ r1: R.r1, c1: R.c1, r2: Math.min(R.r2, rows - 1), c2: Math.min(R.c2, cols - 1) });
  const place = (r, c, text, v, line, generated) => {
    const cell = {
      r, c, text, from: v.from, to: v.to, rawFrom: v.from, rawTo: v.to,
      colspan: 1, rowspan: 1, merged: false, synthetic: false, generated,
      formula: text.startsWith('=') && text.length > 1 ? text.slice(1) : null, line,
    };
    grid[r][c] = cell;
    if (!generated && (rowLine[r] == null || line.from < rowLine[r].from)) rowLine[r] = line;
  };

  // Value lines in order: a later line overrides.
  for (const l of valueLines) {
    const R = bound(l.range);
    const vals = l.values;
    const open = isOpen(l.range);
    if (vals.length === 1) {
      // One value fills the range — but an open range only fills the
      // extent's cells below the header (a column fill never numbers the header).
      const r1 = open && l.range.r2 === Infinity ? Math.max(R.r1, sheet.headerRows) : R.r1;
      for (let r = r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) place(r, c, vals[0].text, vals[0], l, false);
      continue;
    }
    const w = R.c2 - R.c1 + 1, h = R.r2 - R.r1 + 1;
    if (!open && vals.length > w * h) problem(l, `${vals.length} values for ${w * h} cells — the extra values are dropped`);
    vals.forEach((v, k) => {
      const r = R.r1 + Math.floor(k / w), c = R.c1 + (k % w);
      if (r > R.r2) return;
      place(r, c, v.text, v, l, false);
    });
  }
  // Sequences fill the cells nothing set explicitly.
  for (const s of sheet.sequences) {
    const R = bound(s.range);
    const r1 = isOpen(s.range) && s.range.r2 === Infinity ? Math.max(R.r1, sheet.headerRows) : R.r1;
    const w = R.c2 - R.c1 + 1, h = R.r2 - r1 + 1;
    if (h <= 0 || w <= 0) continue;
    const vals = generateSequence(s.start, s.step, w * h) ?? [];
    const v = { from: s.from, to: s.to };
    vals.forEach((text, k) => {
      const r = r1 + Math.floor(k / w), c = R.c1 + (k % w);
      if (!grid[r][c]) place(r, c, text, v, s.line, true);
    });
  }
  // Synthetic empties for the rest.
  const sheetEnd = sheet.to;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!grid[r][c]) grid[r][c] = { r, c, text: '', from: sheetEnd, to: sheetEnd, rawFrom: sheetEnd, rawTo: sheetEnd, colspan: 1, rowspan: 1, merged: false, synthetic: true, generated: false, formula: null, line: null };
  }
  sheet.rows = grid.map((row, r) => ({ from: rowLine[r]?.from ?? sheetEnd, to: rowLine[r]?.to ?? sheetEnd, cells: row }));
  sheet.grid = grid;
  sheet.cells = grid.flat();
  sheet.cols = cols;
}

/** Apply a merge range onto the grid: the top-left cell spans it. */
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
    let best = null;
    for (const cell of sheet.cells) {
      if (cell.synthetic || cell.merged) continue;
      if (pos >= cell.rawFrom && pos <= cell.rawTo) { if (!best || cell.rawTo - cell.rawFrom < best.rawTo - best.rawFrom) best = cell; }
    }
    if (best) return { sheet, cell: best };
    // On a line that sets several cells (a fill): the first of them.
    const line = sheet.lines.find(l => pos >= l.from && pos <= l.to);
    if (line) { const cell = sheet.cells.find(c => c.line === line && !c.merged); if (cell) return { sheet, cell }; }
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

export { colLetter, colIndex, cellText };
