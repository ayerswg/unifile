/**
 * {spreadsheet} — the computed workbook (pure, Node-tested).
 *
 *   computeWorkbook(text)  parse + evaluate every formula + build the style
 *                          resolvers: everything a renderer needs, memoised
 *                          on the text by the callers
 *   viewRows(book, sheet)  the row order the grid SHOWS: header rows first,
 *                          then the body rows that pass every `filter`,
 *                          in `sort` order, minus the hidden ones — the
 *                          text's rows are never reordered by a view sort
 *   cellDisplay(...)       what a cell shows: the typed text, or the value
 *                          through its number format
 */

import { parseSpreadsheet } from './parse.js';
import { evaluateWorkbook, isError, formatNumber } from '../tables/formula.js';
import { literalValue } from '../tables/grid.js';
import { styleResolver, compileCondition, compareValues, formatValue } from './style.js';

/**
 * @returns {{
 *   text, wb, sheets, values: Map, errors, meta, decimals,
 *   styleOf(cell) → flat style, display(sheet, cell) → text, kindOf(cell) → 'num'|'text'|…
 * }}
 */
export function computeWorkbook(text) {
  const t = text ?? '';
  const wb = parseSpreadsheet(t);
  const { values, errors } = evaluateWorkbook(wb);
  const d = wb.meta?.decimals;
  const decimals = d != null && d !== '' && !Number.isNaN(Number(d)) ? Math.max(0, Math.min(10, Math.trunc(Number(d)))) : null;

  const byName = new Map(wb.sheets.map(s => [s.name.toLowerCase(), s]));
  const ctx = {
    sheetByName: (name) => byName.get(String(name).toLowerCase()) ?? null,
    valueAt: (s, r, c) => { const cell = s.grid[r]?.[c]; return cell ? (values.get(cell) ?? null) : null; },
  };
  const resolvers = new Map(wb.sheets.map(s => [s, styleResolver(s, values, ctx)]));
  const styleCache = new Map();

  const book = {
    text: t, wb, sheets: wb.sheets, values, errors, meta: wb.meta, decimals, problems: wb.problems, ctx,
    styleOf(cell) {
      if (styleCache.has(cell)) return styleCache.get(cell);
      const sheet = wb.sheets[cell.sheet ?? 0];
      const st = sheet ? resolvers.get(sheet)(cell) : {};
      styleCache.set(cell, st);
      return st;
    },
    /** The `style` lines alone — no rules, no scale (the .xlsx cell style). */
    staticStyleOf(cell) {
      const sheet = wb.sheets[cell.sheet ?? 0];
      return sheet ? resolvers.get(sheet)(cell, { conditional: false }) : {};
    },
    valueOf(cell) { return cell ? (values.get(cell) ?? null) : null; },
    display(cell) { return cellDisplay(cell, book.valueOf(cell), book.styleOf(cell), wb.sheets[cell.sheet ?? 0]?.decimals ?? null); },
    kindOf(cell) { return valueKind(cell, book.valueOf(cell)); },
  };
  return book;
}


/** 'num' | 'text' | 'bool' | 'error' | 'empty'. */
export function valueKind(cell, value) {
  if (!cell || cell.merged) return 'empty';
  if (isError(value)) return 'error';
  if (value == null || value === '') return 'empty';
  if (typeof value === 'number') return 'num';
  if (typeof value === 'boolean') return 'bool';
  return 'text';
}

/**
 * The text a cell shows.  A literal cell shows what was typed (minus a
 * forcing apostrophe) unless it has a number format and reads as a number;
 * a formula result is formatted by its format, else General (`decimals:`
 * from the front matter rounds non-integers).
 */
export function cellDisplay(cell, value, style = {}, decimals = null) {
  if (!cell || cell.merged) return '';
  const fmt = style.format ?? null;
  if (cell.formula == null) {
    const t = cell.text.startsWith("'") ? cell.text.slice(1) : cell.text;
    if (fmt && fmt !== '@') { const v = literalValue(cell.text); if (typeof v === 'number') return formatValue(v, fmt); }
    return t;
  }
  if (isError(value)) return value.code;
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (fmt && fmt !== '@') return formatValue(value, fmt);
    if (decimals != null && !Number.isInteger(value)) return formatValue(value, '0.' + '0'.repeat(decimals));
    return formatNumber(value);
  }
  return String(value);
}

/**
 * The row indexes to show, in order: header rows, then the body filtered by
 * every `filter`, sorted by `sort` (stable; blanks last), hidden rows removed.
 * @returns {number[]}
 */
export function viewRows(book, sheet) {
  const header = [];
  let body = [];
  for (let r = 0; r < sheet.rows.length; r++) (r < sheet.headerRows ? header : body).push(r);

  if (sheet.filters.length) {
    const fctx = { ...book.ctx, sheet };
    const tests = sheet.filters.map(f => {
      const R = f.col == null ? { r1: sheet.headerRows, r2: sheet.rows.length - 1, c1: 0, c2: 0 } : { r1: sheet.headerRows, r2: sheet.rows.length - 1, c1: f.col, c2: f.col };
      const rangeVals = () => body.map(r => book.valueOf(sheet.grid[r]?.[R.c1] ?? null));
      return { col: f.col ?? 0, test: compileCondition(f.cond, fctx, rangeVals) };
    });
    body = body.filter(r => tests.every(({ col, test }) => {
      const cell = sheet.grid[r]?.[col] ?? { r, c: col };
      return test({ r, c: col }, cell && cell.r === r && cell.c === col ? book.valueOf(cell) : null);
    }));
  }

  if (sheet.sorts.length) {
    const keyed = body.map((r, i) => ({ r, i, keys: sheet.sorts.map(s => { const cell = sheet.grid[r]?.[s.col]; return cell && cell.r === r && cell.c === s.col ? book.valueOf(cell) : null; }) }));
    keyed.sort((a, b) => {
      for (let k = 0; k < sheet.sorts.length; k++) {
        const x = a.keys[k], y = b.keys[k];
        const xb = x == null || x === '', yb = y == null || y === '';
        if (xb && yb) continue;
        if (xb) return 1;
        if (yb) return -1;
        const d = compareValues(x, y);
        if (d) return sheet.sorts[k].dir === 'desc' ? -d : d;
      }
      return a.i - b.i;
    });
    body = keyed.map(k => k.r);
  }

  const hidden = sheet.hidden.rows;
  return [...header, ...body].filter(r => !hidden.has(r));
}

/** The column indexes to show (hidden columns removed). */
export function viewCols(sheet, total = sheet.cols) {
  const out = [];
  for (let c = 0; c < total; c++) if (!sheet.hidden.cols.has(c)) out.push(c);
  return out;
}

export { compareValues, formatValue };
