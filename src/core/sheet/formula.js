/**
 * {sheet} — the formula engine (pure, Node-tested in test/sheet.test.mjs).
 *
 * Excel's grammar, the useful subset:
 *   =B2*C2  =SUM(D2:D9)  =IF(B2>10, "big", "small")  =Budget!B3  ='Q1 Sales'!A1
 *   =B*C          a bare column letter is the cell in THIS row (a column formula
 *                 you can write once per row without renumbering)
 *   =SUM(B:B)     a whole column
 *   operators  + - * / ^  &(concat)  = <> < > <= >=  unary -  postfix %
 *   literals   12  1.5  "text"  TRUE  FALSE
 *   functions  see FUNCTIONS (SUM, AVERAGE, MIN, MAX, COUNT, IF, ROUND, VLOOKUP, …)
 *
 * Values: number | string | boolean | null (empty) | FormulaError.
 * Coercion follows Excel: empty is 0 in arithmetic and "" in text, numeric
 * text ("3") counts in arithmetic, booleans are 1/0; SUM/AVERAGE/… over a range
 * skip text and booleans (as Excel does), COUNT counts numbers, COUNTA
 * non-empties.  Errors propagate (#DIV/0!, #VALUE!, #REF!, #NAME?, #N/A,
 * #NUM!, #CIRC! for a circular reference).
 *
 * `evaluateWorkbook(wb)` computes every formula cell once (memoised,
 * dependency-driven, cycle-safe) and returns `{ values: Map<cell, value> }`.
 */

import { literalValue as literal } from './grid.js';

export class FormulaError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = detail; }
  toString() { return this.code; }
}
export const isError = v => v instanceof FormulaError;
const E = (code, detail) => new FormulaError(code, detail);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * @returns {Array<{ type, value, from, to }>}
 *   type: num | str | bool | ref | op | lparen | rparen | comma | name | end
 *   ref.value = { sheet: string|null, a: 'B2'|'B'|'2'…, b: same|null } for `A1`, `A1:B2`, `B:B`, `Sheet!A1`
 */
export function tokenize(src) {
  const toks = [];
  let i = 0;
  const s = src;
  const push = (type, value, from, to) => toks.push({ type, value, from, to });
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    const from = i;
    // String literal "…" with "" escape.
    if (ch === '"') {
      let j = i + 1, out = '';
      for (; j < s.length; j++) {
        if (s[j] === '"') { if (s[j + 1] === '"') { out += '"'; j++; } else break; }
        else out += s[j];
      }
      if (j >= s.length) throw E('#VALUE!', 'unterminated string');
      push('str', out, from, j + 1); i = j + 1; continue;
    }
    // Number.
    const nm = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i));
    if (nm) { push('num', parseFloat(nm[0]), from, i + nm[0].length); i += nm[0].length; continue; }
    // Quoted sheet name 'Q1 Sales'!A1
    const qm = /^'((?:[^']|'')+)'!/.exec(s.slice(i));
    if (qm) {
      const sheet = qm[1].replace(/''/g, "'");
      i += qm[0].length;
      const rm = /^(\$?[A-Za-z]{1,3}\$?\d*)(?::(\$?[A-Za-z]{1,3}\$?\d*|\$?\d+))?/.exec(s.slice(i));
      if (!rm) throw E('#REF!', `bad reference after '${sheet}'!`);
      push('ref', { sheet, a: rm[1].replace(/\$/g, ''), b: rm[2] ? rm[2].replace(/\$/g, '') : null }, from, i + rm[0].length);
      i += rm[0].length; continue;
    }
    // Word: function name, TRUE/FALSE, Sheet!A1, A1, A1:B2, B:B, B
    const wm = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (wm) {
      const word = wm[0];
      let j = i + word.length;
      if (s[j] === '(') { push('name', word.toUpperCase(), from, j); i = j; continue; }
      if (/^(true|false)$/i.test(word) && s[j] !== '!' && s[j] !== ':') { push('bool', word.toLowerCase() === 'true', from, j); i = j; continue; }
      if (s[j] === '!') {
        // Unquoted sheet name.
        j++;
        const rm = /^(\$?[A-Za-z]{1,3}\$?\d*)(?::(\$?[A-Za-z]{1,3}\$?\d*))?/.exec(s.slice(j));
        if (!rm) throw E('#REF!', `bad reference after ${word}!`);
        push('ref', { sheet: word, a: rm[1].replace(/\$/g, ''), b: rm[2] ? rm[2].replace(/\$/g, '') : null }, from, j + rm[0].length);
        i = j + rm[0].length; continue;
      }
      const refm = /^\$?([A-Za-z]{1,3})\$?(\d*)$/.exec(word);
      if (refm) {
        let b = null;
        if (s[j] === ':') {
          const rm = /^:(\$?[A-Za-z]{1,3}\$?\d*)/.exec(s.slice(j));
          if (rm) { b = rm[1].replace(/\$/g, ''); j += rm[0].length; }
        }
        push('ref', { sheet: null, a: word.replace(/\$/g, ''), b }, from, j);
        i = j; continue;
      }
      push('name', word.toUpperCase(), from, j); i = j; continue;
    }
    // $A$1 absolute refs.
    if (ch === '$') {
      const rm = /^\$?([A-Za-z]{1,3})\$?(\d*)(?::(\$?[A-Za-z]{1,3}\$?\d*))?/.exec(s.slice(i));
      if (rm) {
        push('ref', { sheet: null, a: (rm[1] + rm[2]), b: rm[3] ? rm[3].replace(/\$/g, '') : null }, from, i + rm[0].length);
        i += rm[0].length; continue;
      }
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { push('op', two, from, i + 2); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { push('op', ch, from, i + 1); i++; continue; }
    if (ch === '(') { push('lparen', ch, from, i + 1); i++; continue; }
    if (ch === ')') { push('rparen', ch, from, i + 1); i++; continue; }
    if (ch === ',' || ch === ';') { push('comma', ch, from, i + 1); i++; continue; }
    throw E('#VALUE!', `unexpected "${ch}"`);
  }
  push('end', null, s.length, s.length);
  return toks;
}

// ---------------------------------------------------------------------------
// Parser → AST
// ---------------------------------------------------------------------------

const BIN_PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 6 };

/** Parse a formula body (without the leading `=`) into an AST. */
export function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseExpr(minPrec = 0) {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.type !== 'op' || !(t.value in BIN_PREC)) break;
      const prec = BIN_PREC[t.value];
      if (prec < minPrec) break;
      next();
      // ^ is right-associative in Excel? No — Excel's ^ is left-assoc. Keep left.
      const right = parseExpr(prec + 1);
      left = { type: 'bin', op: t.value, left, right };
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      next();
      const arg = parseUnary();
      return t.value === '-' ? { type: 'neg', arg } : arg;
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    while (peek().type === 'op' && peek().value === '%') { next(); node = { type: 'pct', arg: node }; }
    return node;
  }
  function parsePrimary() {
    const t = next();
    switch (t.type) {
      case 'num':  return { type: 'num', value: t.value };
      case 'str':  return { type: 'str', value: t.value };
      case 'bool': return { type: 'bool', value: t.value };
      case 'ref':  return { type: 'ref', ...t.value };
      case 'lparen': {
        const e = parseExpr();
        if (next().type !== 'rparen') throw E('#VALUE!', 'missing )');
        return e;
      }
      case 'name': {
        if (peek().type !== 'lparen') throw E('#NAME?', t.value);
        next();
        const args = [];
        if (peek().type !== 'rparen') {
          for (;;) {
            if (peek().type === 'comma') { args.push({ type: 'empty' }); next(); continue; }
            args.push(parseExpr());
            if (peek().type === 'comma') { next(); if (peek().type === 'rparen') args.push({ type: 'empty' }); continue; }
            break;
          }
        }
        if (next().type !== 'rparen') throw E('#VALUE!', 'missing )');
        return { type: 'call', name: t.value, args };
      }
      case 'end': throw E('#VALUE!', 'unexpected end of formula');
      default: throw E('#VALUE!', `unexpected ${t.value}`);
    }
  }

  const ast = parseExpr();
  if (peek().type !== 'end') throw E('#VALUE!', `unexpected ${peek().value}`);
  return ast;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function _colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Resolve a ref node to a rectangle on a sheet, relative to the formula's row.
 * `B` alone is the cell in the current row; `B:B` is the whole column.
 * @returns {{ sheet, r1, c1, r2, c2, whole:boolean }}
 */
export function resolveRef(node, ctx) {
  const sheet = node.sheet == null ? ctx.sheet : ctx.sheetByName(node.sheet);
  if (!sheet) throw E('#REF!', `no sheet "${node.sheet}"`);
  const parse = (a) => {
    const m = /^([A-Za-z]{1,3})(\d*)$/.exec(a);
    if (!m) throw E('#REF!', a);
    return { c: _colIndex(m[1]), r: m[2] ? parseInt(m[2], 10) - 1 : null };
  };
  const A = parse(node.a);
  if (node.b == null) {
    const r = A.r == null ? ctx.row : A.r;
    return { sheet, r1: r, c1: A.c, r2: r, c2: A.c, whole: false };
  }
  const B = parse(node.b);
  const whole = A.r == null || B.r == null;
  const r1 = A.r == null ? 0 : A.r;
  const r2 = B.r == null ? sheet.rows.length - 1 : B.r;
  return {
    sheet,
    r1: Math.min(r1, r2), r2: Math.max(r1, r2),
    c1: Math.min(A.c, B.c), c2: Math.max(A.c, B.c),
    whole,
  };
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

export function toNumber(v) {
  if (isError(v)) throw v;
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const t = String(v).trim();
  if (t === '') return 0;
  const n = Number(t.replace(/,/g, ''));
  if (Number.isNaN(n)) {
    if (/^-?\d+(\.\d+)?%$/.test(t)) return parseFloat(t) / 100;
    throw E('#VALUE!', `"${v}" is not a number`);
  }
  return n;
}

export function toText(v) {
  if (isError(v)) throw v;
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v);
  return String(v);
}

export function toBool(v) {
  if (isError(v)) throw v;
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const t = String(v).trim().toUpperCase();
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  throw E('#VALUE!', `"${v}" is not TRUE/FALSE`);
}

/** Excel's General format: up to 10 significant digits, no trailing zeros. */
export function formatNumber(n) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '-∞' : 'NaN';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toPrecision(10);
  if (s.includes('e')) return s.replace(/\.?0+e/, 'e');
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function _cmp(a, b) {
  // Excel: numbers < text < booleans; text compares case-insensitively.
  const rank = v => (v == null ? 0 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) { const x = a ?? 0, y = b ?? 0; return x < y ? -1 : x > y ? 1 : 0; }
  if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return (a ? 1 : 0) - (b ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** Flatten args into a list of scalar values (ranges expand; errors throw). */
function flat(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) { for (const row of a) for (const v of row) out.push(v); }
    else out.push(a);
  }
  for (const v of out) if (isError(v)) throw v;
  return out;
}
/** Numbers only, as SUM/AVERAGE see them: direct numeric args count, range text/bools are skipped. */
function nums(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const row of a) for (const v of row) { if (isError(v)) throw v; if (typeof v === 'number') out.push(v); }
    } else {
      if (isError(a)) throw a;
      if (a == null) continue;
      out.push(toNumber(a));
    }
  }
  return out;
}
const scalar = (v) => {
  if (Array.isArray(v)) { v = v[0]?.[0] ?? null; }
  if (isError(v)) throw v;
  return v;
};
const num = v => toNumber(scalar(v));
const txt = v => toText(scalar(v));
const round = (x, d, fn) => { const k = Math.pow(10, Math.trunc(d)); return fn(x * k) / k; };

/** Excel-style criteria for SUMIF/COUNTIF: `">10"`, `"<>x"`, `"apple"`, 5. */
function criterion(c) {
  c = scalar(c);
  if (typeof c === 'number' || typeof c === 'boolean' || c == null) return v => _cmp(v, c) === 0 && (v != null || c == null);
  const m = /^(<>|<=|>=|<|>|=)?(.*)$/.exec(String(c));
  const op = m[1] || '=';
  const rhsRaw = m[2];
  const rhsNum = rhsRaw.trim() !== '' && !Number.isNaN(Number(rhsRaw)) ? Number(rhsRaw) : null;
  return v => {
    const rhs = rhsNum != null && typeof v === 'number' ? rhsNum : rhsRaw;
    const vv = rhsNum != null && typeof v === 'number' ? v : (v == null ? '' : v);
    if (op === '=' && typeof rhs === 'string' && /[*?]/.test(rhs)) {
      const re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return re.test(toText(vv));
    }
    const d = typeof vv === typeof rhs ? _cmp(vv, rhs) : _cmp(toText(vv), String(rhs));
    switch (op) {
      case '=': return d === 0; case '<>': return d !== 0; case '<': return d < 0;
      case '>': return d > 0; case '<=': return d <= 0; case '>=': return d >= 0;
    }
    return false;
  };
}
const asGrid = v => Array.isArray(v) ? v : [[v]];

export const FUNCTIONS = {
  SUM:     (...a) => nums(a).reduce((x, y) => x + y, 0),
  AVERAGE: (...a) => { const n = nums(a); if (!n.length) throw E('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
  AVG:     (...a) => FUNCTIONS.AVERAGE(...a),
  MIN:     (...a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX:     (...a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  COUNT:   (...a) => nums(a).length,
  COUNTA:  (...a) => flat(a).filter(v => v != null && v !== '').length,
  COUNTBLANK: (...a) => flat(a).filter(v => v == null || v === '').length,
  PRODUCT: (...a) => nums(a).reduce((x, y) => x * y, 1),
  ABS:   x => Math.abs(num(x)),
  INT:   x => Math.floor(num(x)),
  MOD:   (x, y) => { const d = num(y); if (d === 0) throw E('#DIV/0!'); const n = num(x); return n - d * Math.floor(n / d); },
  POWER: (x, y) => Math.pow(num(x), num(y)),
  SQRT:  x => { const n = num(x); if (n < 0) throw E('#NUM!'); return Math.sqrt(n); },
  EXP:   x => Math.exp(num(x)),
  LN:    x => { const n = num(x); if (n <= 0) throw E('#NUM!'); return Math.log(n); },
  LOG:   (x, b) => { const n = num(x); if (n <= 0) throw E('#NUM!'); return Math.log(n) / Math.log(b === undefined ? 10 : num(b)); },
  LOG10: x => { const n = num(x); if (n <= 0) throw E('#NUM!'); return Math.log10(n); },
  PI:    () => Math.PI,
  ROUND:     (x, d = 0) => round(num(x), num(d), Math.round),
  ROUNDUP:   (x, d = 0) => { const n = num(x); return Math.sign(n) * round(Math.abs(n), num(d), Math.ceil); },
  ROUNDDOWN: (x, d = 0) => { const n = num(x); return Math.sign(n) * round(Math.abs(n), num(d), Math.floor); },
  CEILING: (x, s = 1) => { const k = num(s) || 1; return Math.ceil(num(x) / k) * k; },
  FLOOR:   (x, s = 1) => { const k = num(s) || 1; return Math.floor(num(x) / k) * k; },
  TRUNC:   (x, d = 0) => round(num(x), num(d), Math.trunc),
  IF:  (c, a = true, b = false) => toBool(scalar(c)) ? scalar(a) : scalar(b),
  IFERROR: (v, alt) => { try { return scalar(v); } catch (e) { if (isError(e)) return scalar(alt); throw e; } },
  AND: (...a) => flat(a).every(v => toBool(v)),
  OR:  (...a) => flat(a).some(v => toBool(v)),
  NOT: x => !toBool(scalar(x)),
  TRUE: () => true,
  FALSE: () => false,
  ISBLANK:  x => scalar(x) == null,
  ISNUMBER: x => typeof scalar(x) === 'number',
  ISTEXT:   x => typeof scalar(x) === 'string',
  ISERROR:  x => { try { scalar(x); return false; } catch (e) { if (isError(e)) return true; throw e; } },
  N:   x => { const v = scalar(x); return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0; },
  VALUE: x => num(x),
  LEN:   x => txt(x).length,
  UPPER: x => txt(x).toUpperCase(),
  LOWER: x => txt(x).toLowerCase(),
  PROPER: x => txt(x).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase()),
  TRIM:  x => txt(x).trim().replace(/\s+/g, ' '),
  LEFT:  (x, n = 1) => txt(x).slice(0, Math.max(0, num(n))),
  RIGHT: (x, n = 1) => { const s = txt(x), k = Math.max(0, num(n)); return k ? s.slice(-k) : ''; },
  MID:   (x, s, n) => txt(x).slice(Math.max(0, num(s) - 1), Math.max(0, num(s) - 1) + Math.max(0, num(n))),
  CONCAT: (...a) => flat(a).map(toText).join(''),
  CONCATENATE: (...a) => flat(a).map(toText).join(''),
  TEXTJOIN: (d, ignoreEmpty, ...a) => flat(a).filter(v => !toBool(scalar(ignoreEmpty)) || (v != null && v !== '')).map(toText).join(txt(d)),
  REPT:  (x, n) => txt(x).repeat(Math.max(0, Math.trunc(num(n)))),
  FIND:  (f, s, start = 1) => { const i = txt(s).indexOf(txt(f), Math.max(0, num(start) - 1)); if (i < 0) throw E('#VALUE!'); return i + 1; },
  SEARCH: (f, s, start = 1) => { const i = txt(s).toLowerCase().indexOf(txt(f).toLowerCase(), Math.max(0, num(start) - 1)); if (i < 0) throw E('#VALUE!'); return i + 1; },
  SUBSTITUTE: (s, a, b) => txt(s).split(txt(a)).join(txt(b)),
  TEXT:  (x, fmt) => formatWith(scalar(x), txt(fmt)),
  SUMIF:   (range, crit, sumRange) => {
    const g = asGrid(range), s = sumRange === undefined ? g : asGrid(sumRange), ok = criterion(crit);
    let t = 0;
    g.forEach((row, r) => row.forEach((v, c) => { if (ok(v)) { const sv = s[r]?.[c]; if (typeof sv === 'number') t += sv; } }));
    return t;
  },
  COUNTIF: (range, crit) => { const ok = criterion(crit); let n = 0; for (const row of asGrid(range)) for (const v of row) if (ok(v)) n++; return n; },
  AVERAGEIF: (range, crit, avgRange) => {
    const g = asGrid(range), s = avgRange === undefined ? g : asGrid(avgRange), ok = criterion(crit);
    let t = 0, n = 0;
    g.forEach((row, r) => row.forEach((v, c) => { if (ok(v)) { const sv = s[r]?.[c]; if (typeof sv === 'number') { t += sv; n++; } } }));
    if (!n) throw E('#DIV/0!');
    return t / n;
  },
  VLOOKUP: (key, table, col, exact = false) => {
    const g = asGrid(table), k = scalar(key), c = Math.trunc(num(col)) - 1;
    if (c < 0) throw E('#VALUE!');
    const approx = toBool(scalar(exact));
    let best = null;
    for (const row of g) {
      const v = row[0];
      if (!approx) { if (_cmp(v, k) === 0 && typeof v === typeof k) return row[c] ?? null; }
      else { if (_cmp(v, k) <= 0) best = row; else break; }
    }
    if (approx && best) return best[c] ?? null;
    throw E('#N/A');
  },
  HLOOKUP: (key, table, rowN, exact = false) => {
    const g = asGrid(table), k = scalar(key), r = Math.trunc(num(rowN)) - 1;
    if (r < 0) throw E('#VALUE!');
    const approx = toBool(scalar(exact));
    const first = g[0] || [];
    let bestC = -1;
    for (let c = 0; c < first.length; c++) {
      const v = first[c];
      if (!approx) { if (_cmp(v, k) === 0 && typeof v === typeof k) return g[r]?.[c] ?? null; }
      else { if (_cmp(v, k) <= 0) bestC = c; else break; }
    }
    if (approx && bestC >= 0) return g[r]?.[bestC] ?? null;
    throw E('#N/A');
  },
  INDEX: (table, r, c = 1) => {
    const g = asGrid(table), ri = Math.trunc(num(r)), ci = Math.trunc(num(c));
    if (ri < 0 || ci < 0) throw E('#VALUE!');
    if (ri === 0 && g.length === 1) return g[0][ci - 1] ?? null;
    if (ci === 0 && (g[0] || []).length === 1) return g[ri - 1]?.[0] ?? null;
    const v = g[ri - 1]?.[ci - 1];
    if (v === undefined) throw E('#REF!');
    return v;
  },
  MATCH: (key, range, type = 1) => {
    const list = flat([range]); const k = scalar(key); const t = num(type);
    if (t === 0) { const i = list.findIndex(v => _cmp(v, k) === 0 && typeof v === typeof k); if (i < 0) throw E('#N/A'); return i + 1; }
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const d = _cmp(list[i], k);
      if (t > 0) { if (d <= 0) best = i; else break; }
      else { if (d >= 0) best = i; else break; }
    }
    if (best < 0) throw E('#N/A');
    return best + 1;
  },
  ROW:    (ref) => ref === undefined ? null : null,  // replaced in evaluate (needs the ref, not its value)
  COLUMN: (ref) => ref === undefined ? null : null,
  ROWS:    r => asGrid(r).length,
  COLUMNS: r => (asGrid(r)[0] || []).length,
  LARGE: (r, k) => { const n = nums([r]).sort((a, b) => b - a); const v = n[Math.trunc(num(k)) - 1]; if (v === undefined) throw E('#NUM!'); return v; },
  SMALL: (r, k) => { const n = nums([r]).sort((a, b) => a - b); const v = n[Math.trunc(num(k)) - 1]; if (v === undefined) throw E('#NUM!'); return v; },
  MEDIAN: (...a) => { const n = nums(a).sort((x, y) => x - y); if (!n.length) throw E('#NUM!'); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  STDEV: (...a) => { const n = nums(a); if (n.length < 2) throw E('#DIV/0!'); const m = n.reduce((x, y) => x + y, 0) / n.length; return Math.sqrt(n.reduce((s, x) => s + (x - m) ** 2, 0) / (n.length - 1)); },
  RANK: (x, r, order = 0) => { const n = nums([r]); const v = num(x); const sorted = toBool(scalar(order)) ? n.sort((a, b) => a - b) : n.sort((a, b) => b - a); const i = sorted.indexOf(v); if (i < 0) throw E('#N/A'); return i + 1; },
  SUMPRODUCT: (...a) => {
    const gs = a.map(asGrid);
    let t = 0;
    gs[0].forEach((row, r) => row.forEach((_, c) => {
      let p = 1;
      for (const g of gs) { const v = g[r]?.[c]; p *= typeof v === 'number' ? v : 0; }
      t += p;
    }));
    return t;
  },
};

/** The function names, for autocomplete / the help. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).filter(n => n !== 'TRUE' && n !== 'FALSE').sort();

// ---------------------------------------------------------------------------
// Number formats (TEXT(), and the document's `decimals:`)
// ---------------------------------------------------------------------------

/**
 * A small Excel format subset: `0`, `0.00`, `#,##0`, `#,##0.00`, `0%`,
 * `0.0%`, `$#,##0.00`, `€…`, `£…`.  Anything else → General.
 */
export function formatWith(v, fmt) {
  if (v == null) return '';
  if (typeof v !== 'number') return toText(v);
  const m = /^([$€£¥]?)(#,##)?0(?:\.(0+))?(%?)$/.exec(String(fmt || '').trim());
  if (!m) return formatNumber(v);
  const cur = m[1], grouped = !!m[2], decimals = m[3] ? m[3].length : 0, pct = !!m[4];
  let n = pct ? v * 100 : v;
  const neg = n < 0;
  n = Math.abs(n);
  let s = n.toFixed(decimals);
  if (grouped) {
    const [i, d] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '');
  }
  return (neg ? '-' : '') + cur + s + (pct ? '%' : '');
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one AST in a context:
 *   ctx = { sheet, row, col, sheetByName(name), valueAt(sheet, r, c) }
 * Range refs yield a 2-D array; a scalar ref yields the value.
 */
export function evaluate(ast, ctx) {
  const ev = (n) => {
    switch (n.type) {
      case 'num': case 'str': case 'bool': return n.value;
      case 'empty': return null;
      case 'ref': {
        const R = resolveRef(n, ctx);
        if (!R.whole && R.r1 === R.r2 && R.c1 === R.c2 && n.b == null) return ctx.valueAt(R.sheet, R.r1, R.c1);
        const rows = [];
        for (let r = R.r1; r <= R.r2; r++) {
          const row = [];
          for (let c = R.c1; c <= R.c2; c++) row.push(ctx.valueAt(R.sheet, r, c));
          rows.push(row);
        }
        return rows;
      }
      case 'neg': return -num(ev(n.arg));
      case 'pct': return num(ev(n.arg)) / 100;
      case 'bin': {
        const a = ev(n.left), b = ev(n.right);
        switch (n.op) {
          case '+': return num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': { const d = num(b); if (d === 0) throw E('#DIV/0!'); return num(a) / d; }
          case '^': return Math.pow(num(a), num(b));
          case '&': return txt(a) + txt(b);
          case '=': return _cmp(scalar(a), scalar(b)) === 0;
          case '<>': return _cmp(scalar(a), scalar(b)) !== 0;
          case '<': return _cmp(scalar(a), scalar(b)) < 0;
          case '>': return _cmp(scalar(a), scalar(b)) > 0;
          case '<=': return _cmp(scalar(a), scalar(b)) <= 0;
          case '>=': return _cmp(scalar(a), scalar(b)) >= 0;
        }
        throw E('#VALUE!', n.op);
      }
      case 'call': {
        if (n.name === 'ROW') { if (!n.args.length) return ctx.row + 1; const R = resolveRef(n.args[0], ctx); return R.r1 + 1; }
        if (n.name === 'COLUMN') { if (!n.args.length) return ctx.col + 1; const R = resolveRef(n.args[0], ctx); return R.c1 + 1; }
        const fn = FUNCTIONS[n.name];
        if (!fn) throw E('#NAME?', n.name);
        if (n.name === 'IF' || n.name === 'IFERROR') {
          // Lazy branches: a #DIV/0! in the untaken branch must not surface.
          const cond = n.name === 'IF' ? toBool(scalar(ev(n.args[0]))) : null;
          if (n.name === 'IF') return n.args.length > 1 ? scalar(ev(cond ? n.args[1] : (n.args[2] ?? { type: 'bool', value: false }))) : cond;
          try { return scalar(ev(n.args[0])); } catch (e) { if (isError(e)) return scalar(ev(n.args[1] ?? { type: 'empty' })); throw e; }
        }
        const args = n.args.map(a => a.type === 'empty' ? undefined : ev(a));
        return fn(...args);
      }
    }
    throw E('#VALUE!', n.type);
  };
  return ev(ast);
}

/**
 * Compute every formula in a workbook (from grid.js).  Returns
 * `{ values: Map<cell, value>, errors: Array<{ cell, sheet, error }> }`.
 * `values` holds every cell's displayed value (literal or computed).
 */
export function evaluateWorkbook(wb) {
  const values = new Map();
  const errors = [];
  const visiting = new Set();
  const byName = new Map(wb.sheets.map(s => [s.name.toLowerCase(), s]));
  const sheetByName = (name) => byName.get(String(name).toLowerCase()) ?? null;

  function valueOfCell(sheet, cell) {
    if (!cell) return null;
    if (values.has(cell)) return values.get(cell);
    if (cell.merged) return null;
    if (cell.formula == null) {
      const v = literal(cell.text);
      values.set(cell, v);
      return v;
    }
    if (visiting.has(cell)) return E('#CIRC!', 'circular reference');
    visiting.add(cell);
    let v;
    try {
      const ast = parseFormula(cell.formula);
      v = evaluate(ast, {
        sheet, row: cell.r, col: cell.c, sheetByName,
        valueAt: (s, r, c) => {
          const target = s.grid[r]?.[c];
          if (!target) return null;
          const tv = valueOfCell(s, target);
          if (isError(tv) && tv.code === '#CIRC!') throw tv;
          return tv;
        },
      });
      if (Array.isArray(v)) v = v[0]?.[0] ?? null;
    } catch (e) {
      v = isError(e) ? e : E('#VALUE!', e.message);
    }
    visiting.delete(cell);
    values.set(cell, v);
    if (isError(v)) errors.push({ cell, sheet, error: v });
    return v;
  }

  for (const sheet of wb.sheets) for (const cell of sheet.cells) valueOfCell(sheet, cell);
  return { values, errors };
}

/**
 * Rewrite a formula's bare-column refs (`B` → `B5`) and `AVG` alias for
 * Excel (the XLSX export); other text passes through.
 */
export function formulaForExcel(formula, row) {
  const toks = tokenize(formula);
  let out = '';
  let last = 0;
  for (const t of toks) {
    if (t.type === 'end') break;
    out += formula.slice(last, t.from);
    if (t.type === 'ref') {
      const fix = a => (/^[A-Za-z]{1,3}$/.test(a) && t.value.b == null) ? a + (row + 1) : a;
      const sheet = t.value.sheet == null ? '' : (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value.sheet) ? t.value.sheet : `'${t.value.sheet.replace(/'/g, "''")}'`) + '!';
      out += sheet + fix(t.value.a).toUpperCase() + (t.value.b != null ? ':' + t.value.b.toUpperCase() : '');
    } else if (t.type === 'name' && t.value === 'AVG') {
      out += 'AVERAGE';
    } else {
      out += formula.slice(t.from, t.to);
    }
    last = t.to;
  }
  out += formula.slice(last);
  return out;
}
