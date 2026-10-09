/**
 * Formula editing assist — the pure half of the grid's Excel-style formula
 * entry (src/ui/sheet-grid.js wires it to the cell editor and formula bar):
 *
 *  - `completionAt`  the function names matching the word being typed at an
 *                    operand position (`=su` → SUM, SUMIF, SUMPRODUCT, …);
 *  - `signatureAt`   the innermost open function at the caret and which of
 *                    its arguments the caret is in (the tooltip under the cell:
 *                    `SUM(number1, [number2], …)` with the current one marked);
 *  - `operandSlotAt` where a POINTED reference goes: the span a click on a
 *                    cell replaces.  Right after `=`, `(`, `,`, an operator or
 *                    `:` a reference is expected and the slot is the caret; a
 *                    reference just inserted by pointing stays the slot while
 *                    the caret sits at its end, so a drag or the next click
 *                    replaces it (Excel's Point mode).  Anywhere else a click
 *                    on a cell means "done" and the caller commits;
 *  - `formulaRefs`   every reference in the formula with its span, for the
 *                    coloured outlines (Excel's range finder);
 *  - `insertRef` / `refText`  the text surgery and the A1 spelling.
 *
 * Everything takes the cell's TEXT and a caret offset into it; nothing here
 * touches the DOM.  Node-tested in test/formula-edit.test.mjs.
 */

import { FUNCTION_NAMES } from '../tables/formula.js';
import { FN_DETAIL, FN_PARAMS, functionSignature } from '../tables/formula-help.js';
import { colLetter } from './parse.js';

// A reference is expected right after one of these (ignoring spaces).
const OPERAND_AFTER = new Set(['(', ',', ';', '+', '-', '*', '/', '^', '&', '=', '<', '>', ':', '{']);
const WORD_RE = /[A-Za-z_][A-Za-z0-9_.]*$/;
const REF_WORD_RE = /^\$?[A-Za-z]{1,3}\$?\d+$/;

export const isFormula = (text) => typeof text === 'string' && text.startsWith('=');

/**
 * Walk the formula up to `caret`: are we inside a string literal, and which
 * function calls are open (innermost last) with the argument index at the
 * caret?  `(` without a name in front is a plain group.
 */
export function scanFormula(text, caret) {
  const stack = [];
  let inString = false;
  const end = Math.min(caret, text.length);
  for (let i = 1; i < end; i++) {
    const ch = text[i];
    if (inString) { if (ch === '"') { if (text[i + 1] === '"' && i + 1 < end) i++; else inString = false; } continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(') {
      const m = WORD_RE.exec(text.slice(1, i));
      stack.push({ name: m ? m[0].toUpperCase() : null, nameFrom: m ? i - m[0].length : i, open: i, arg: 0 });
    } else if (ch === ')') { stack.pop(); }
    else if ((ch === ',' || ch === ';') && stack.length) stack[stack.length - 1].arg++;
  }
  return { inString, stack };
}

/** Is a reference (an operand) expected at the end of `before` (text after `=`)? */
function operandExpected(before) {
  const t = before.replace(/\s+$/, '');
  return t === '' || OPERAND_AFTER.has(t[t.length - 1]);
}

/**
 * Where a pointed reference would go, or null when a click on a cell should
 * end the edit instead.  `pointed` = the span of the reference the last
 * pointing gesture inserted (`{from, to}`), `selEnd` = the end of a text
 * selection in the field (a selected run of the formula is replaced).
 */
export function operandSlotAt(text, caret, { pointed = null, selEnd = caret } = {}) {
  if (!isFormula(text) || caret < 1) return null;
  const { inString } = scanFormula(text, caret);
  if (inString) return null;
  if (selEnd > caret) return { from: caret, to: selEnd };
  if (pointed && pointed.to === caret && pointed.from >= 1 && pointed.from <= pointed.to) return { from: pointed.from, to: pointed.to };
  if (operandExpected(text.slice(1, caret))) return { from: caret, to: caret };
  return null;
}

/**
 * The function-name completion for the word being typed before the caret:
 * `{ from, to, query, options: [{ name, detail, signature }] }`, or null when
 * the caret is not on a word at an operand position (or the word reads as a
 * cell reference like `A1`).  Prefix matches come first, then names that
 * contain the letters (Excel's newer behaviour).
 */
export function completionAt(text, caret) {
  if (!isFormula(text) || caret < 2) return null;
  const { inString } = scanFormula(text, caret);
  if (inString) return null;
  const m = WORD_RE.exec(text.slice(1, caret));
  if (!m) return null;
  const word = m[0];
  if (REF_WORD_RE.test(word) || word.includes('.')) return null;
  const from = caret - word.length;
  if (from < 1 || !operandExpected(text.slice(1, from))) return null;
  // The char after the caret continues the word → the caret is mid-word; still complete (Excel does).
  const q = word.toUpperCase();
  const starts = FUNCTION_NAMES.filter(n => n.startsWith(q));
  const within = FUNCTION_NAMES.filter(n => !n.startsWith(q) && n.includes(q));
  const names = [...starts, ...within];
  if (!names.length) return null;
  return { from, to: caret, query: q, options: names.map(n => ({ name: n, detail: FN_DETAIL[n] ?? '', signature: functionSignature(n) })) };
}

/**
 * The innermost open function call around the caret and the argument the
 * caret is in: `{ name, argIndex, params, current }` (`current` = the index
 * into `params` to mark — the last one when the call is variadic), or null.
 */
export function signatureAt(text, caret) {
  if (!isFormula(text)) return null;
  const { inString, stack } = scanFormula(text, caret);
  if (inString) return null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const fr = stack[i];
    if (!fr.name) continue;
    const params = FN_PARAMS[fr.name] ?? null;
    let current = fr.arg;
    if (params) {
      const variadic = params[params.length - 1] === '…';
      if (current >= params.length) current = variadic ? params.length - 1 : -1;
    }
    return { name: fr.name, argIndex: fr.arg, params, current, signature: functionSignature(fr.name) };
  }
  return null;
}

/** Accept a completion: replace the word with `NAME(` and put the caret after the paren. */
export function acceptCompletion(text, comp, name) {
  const t = text.slice(0, comp.from) + name + '(' + text.slice(comp.to);
  return { text: t, caret: comp.from + name.length + 1 };
}

/** Put `ref` into `slot`; the new slot is the inserted text. */
export function insertRef(text, slot, ref) {
  const t = text.slice(0, slot.from) + ref + text.slice(slot.to);
  return { text: t, slot: { from: slot.from, to: slot.from + ref.length } };
}

/** The A1 spelling of a pointed range: `B3`, `B3:D5`, `B:B`, `B:D`, `3:3`, `3:5`. */
export function refText(R) {
  const colsOpen = R.r1 === 0 && R.r2 === Infinity;
  const rowsOpen = R.c1 === 0 && R.c2 === Infinity;
  if (colsOpen && !rowsOpen) return `${colLetter(R.c1)}:${colLetter(R.c2)}`;
  if (rowsOpen && !colsOpen) return `${R.r1 + 1}:${R.r2 + 1}`;
  if (colsOpen && rowsOpen) return 'A:XFD';
  const a = colLetter(R.c1) + (R.r1 + 1);
  if (R.r1 === R.r2 && R.c1 === R.c2) return a;
  return `${a}:${colLetter(R.c2)}${R.r2 + 1}`;
}

const colIndex = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/**
 * Every reference in a formula: `{ from, to, text, key, kind, R }` where
 * `kind` is `range` (R = {r1,c1,r2,c2}, open ends Infinity), `col` (a bare
 * column letter — the cell in THIS row: `R.c`), or `sheet` (a reference into
 * another sheet, not drawn).  `key` is the normalised spelling (upper-case,
 * `$` stripped) so equal references share a colour.
 */
export function formulaRefs(text) {
  const out = [];
  if (!isFormula(text)) return out;
  const s = text;
  let i = 1;
  const push = (from, to, kind, R) => out.push({ from, to, text: s.slice(from, to), key: s.slice(from, to).toUpperCase().replace(/\$/g, ''), kind, R });
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') { let j = i + 1; for (; j < s.length; j++) { if (s[j] === '"') { if (s[j + 1] === '"') j++; else break; } } i = j + 1; continue; }
    const rest = s.slice(i);
    // Sheet-qualified: 'Q1 Sales'!A1:B2 or Budget!D4 — another sheet, skipped.
    const sq = /^(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!(\$?[A-Za-z]{1,3}\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d*)?|\$?\d+:\$?\d+)?/.exec(rest);
    if (sq) { push(i, i + sq[0].length, 'sheet', null); i += sq[0].length; continue; }
    // Number (so `3:5` is only a row range at an operand position, not the tail of `1.3`).
    const nm = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(rest);
    if (nm && !/^\$?\d+:\$?\d+/.test(rest)) { i += nm[0].length; continue; }
    // Row range `3:5`.
    const rr = /^\$?(\d+):\$?(\d+)(?![\d.])/.exec(rest);
    if (rr) {
      const a = parseInt(rr[1], 10) - 1, b = parseInt(rr[2], 10) - 1;
      push(i, i + rr[0].length, 'range', { r1: Math.min(a, b), c1: 0, r2: Math.max(a, b), c2: Infinity });
      i += rr[0].length; continue;
    }
    // Cell / cell range `A1`, `$A$1:B3`, `A1:B` (mixed ends are left to the engine).
    const cm = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?(?![A-Za-z0-9_.(!])/.exec(rest);
    if (cm) {
      const c1 = colIndex(cm[1]), r1 = parseInt(cm[2], 10) - 1;
      const c2 = cm[3] ? colIndex(cm[3]) : c1, r2 = cm[4] ? parseInt(cm[4], 10) - 1 : r1;
      push(i, i + cm[0].length, 'range', { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) });
      i += cm[0].length; continue;
    }
    // Column range `B:B`, `$B:$D`.
    const cr = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![A-Za-z0-9_.(!])/.exec(rest);
    if (cr) {
      const a = colIndex(cr[1]), b = colIndex(cr[2]);
      push(i, i + cr[0].length, 'range', { r1: 0, c1: Math.min(a, b), r2: Infinity, c2: Math.max(a, b) });
      i += cr[0].length; continue;
    }
    // A word: a function name (followed by `(`), TRUE/FALSE, or a bare column letter.
    const wm = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (wm) {
      const w = wm[0];
      const after = s[i + w.length];
      if (after !== '(' && /^[A-Za-z]{1,3}$/.test(w) && !/^(true|false)$/i.test(w)) push(i, i + w.length, 'col', { c: colIndex(w) });
      i += w.length; continue;
    }
    i++;
  }
  return out;
}
