/**
 * Grid model renderer — spreadsheet coordinate system.
 *
 * The primary model is a 2D tabular space. The document content uses
 * cell-reference syntax (A1, B2, etc.) as its coordinate system.
 * Each line is either a cell assignment or a comment.
 *
 * Syntax
 * ──────
 *   CellRef value            — assign a value to a cell  (whitespace separator)
 *   CellRef =formula         — assign a formula (formula starts with =)
 *   // comment or # comment  — ignored
 *   blank lines              — ignored
 *
 * Cell references
 *   A1, B2, AA1, Z99         — column letter(s) + row number (1-based)
 *
 * Values
 *   42         number
 *   3.14       number
 *   "text"     string (quotes optional for plain text)
 *   true/false boolean
 *
 * Formulas (prefix =)
 *   =A1+B2           arithmetic (+, -, *, /, %, ^)
 *   =SUM(A1:A10)     range functions  (colon is range separator inside formulas)
 *   =AVERAGE(B1:B5)
 *   =COUNT(A1:C1)
 *   =MIN(A1:A5) / =MAX(A1:A5)
 *   =IF(A1>0, "yes", "no")
 *   =CONCAT(A1, " ", B1)
 *
 * Example:
 *   ---
 *   model: grid
 *   ---
 *   A1 Item
 *   B1 Price
 *   C1 Qty
 *   D1 Total
 *   A2 Widget
 *   B2 9.99
 *   C2 5
 *   D2 =B2*C2
 *   A3 Gadget
 *   B3 24.99
 *   C3 2
 *   D3 =B3*C3
 *   D4 =SUM(D2:D3)
 *
 * Front matter keys:
 *   frozen-rows   — number of header rows to freeze-style (default: 1 if row 1 exists)
 *   frozen-cols   — number of header columns to freeze-style (default: 0)
 *   show-grid     — true/false (default: true)
 *   show-headers  — show A/B/C... column and 1/2/3... row labels (default: true)
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderGrid(content, container) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const body = content.slice(bodyFrom);
  const { cells, maxCol, maxRow } = _parseSheet(body, bodyFrom);

  const frozenRows = parseInt(meta['frozen-rows'] ?? (maxRow >= 0 ? '1' : '0'), 10);
  const frozenCols = parseInt(meta['frozen-cols'] ?? '0', 10);
  const showGrid    = (meta['show-grid']    ?? 'true') !== 'false';
  const showHeaders = (meta['show-headers'] ?? 'true') !== 'false';

  container.innerHTML = '';
  container.classList.add('grid-model-mode');

  // Container-level click-back fallback (jumps to start of grid body)
  container.dataset.docFrom = bodyFrom;

  if (maxCol < 0 || maxRow < 0) {
    container.innerHTML = '<p class="preview-empty">Enter cell values using A1 value syntax (e.g. A1 Hello, B1 42, C1 =A1+B1).</p>';
    return;
  }

  // Evaluate all formulas
  const evaluated = _evaluateAll(cells, maxCol, maxRow);

  // Build table
  const wrap = document.createElement('div');
  wrap.className = 'uf-grid-wrap';
  if (!showGrid) wrap.classList.add('no-grid-lines');
  container.appendChild(wrap);

  const table = document.createElement('table');
  table.className = 'uf-grid-table';
  wrap.appendChild(table);

  const totalCols = maxCol + 1;
  const totalRows = maxRow + 1;

  // Pre-compute first-cell positions per row and column for header click-back
  const rowFirstPos = new Array(totalRows).fill(null);
  const colFirstPos = new Array(totalCols).fill(null);
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < totalCols; c++) {
      const ref = _indexToCol(c) + (r + 1);
      const srcFrom = cells.get(ref)?.srcFrom;
      if (srcFrom != null) {
        if (rowFirstPos[r] === null || srcFrom < rowFirstPos[r]) rowFirstPos[r] = srcFrom;
        if (colFirstPos[c] === null || srcFrom < colFirstPos[c]) colFirstPos[c] = srcFrom;
      }
    }
  }

  // Column header row (A, B, C...)
  if (showHeaders) {
    const thead = document.createElement('thead');
    table.appendChild(thead);
    const tr = document.createElement('tr');
    thead.appendChild(tr);
    // Corner cell
    const corner = document.createElement('th');
    corner.className = 'uf-grid-corner';
    tr.appendChild(corner);
    for (let c = 0; c < totalCols; c++) {
      const th = document.createElement('th');
      th.className = 'uf-grid-col-hdr';
      if (c < frozenCols) th.classList.add('frozen-col');
      th.textContent = _indexToCol(c);
      // Click-back: jump to first defined cell in this column
      if (colFirstPos[c] != null) th.dataset.docFrom = colFirstPos[c];
      tr.appendChild(th);
    }
  }

  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  for (let r = 0; r < totalRows; r++) {
    const tr = document.createElement('tr');
    tbody.appendChild(tr);

    // Row number cell
    if (showHeaders) {
      const th = document.createElement('th');
      th.className = 'uf-grid-row-hdr';
      if (r < frozenRows) th.classList.add('frozen-row');
      th.textContent = r + 1;
      // Click-back: jump to first defined cell in this row
      if (rowFirstPos[r] != null) th.dataset.docFrom = rowFirstPos[r];
      tr.appendChild(th);
    }

    for (let c = 0; c < totalCols; c++) {
      const ref = _indexToCol(c) + (r + 1);
      const rawVal = evaluated.get(ref);
      const td = document.createElement('td');
      td.className = 'uf-grid-cell';
      if (r < frozenRows) td.classList.add('frozen-row');
      if (c < frozenCols) td.classList.add('frozen-col');

      // Numeric alignment
      const num = typeof rawVal === 'number';
      if (num) td.classList.add('numeric');

      // Source positions for click-back (absolute via bodyFrom)
      const cellData = cells.get(ref);
      if (cellData?.srcFrom != null) {
        td.dataset.docFrom = cellData.srcFrom;
        td.dataset.docTo   = cellData.srcTo;
      }

      td.textContent = rawVal != null ? _formatValue(rawVal) : '';
      tr.appendChild(td);
    }
  }
}

export function teardownGrid(container) {
  container.classList.remove('grid-model-mode');
}

// ---------------------------------------------------------------------------
// Sheet parsing
// ---------------------------------------------------------------------------

/**
 * Parse the document body into a Map of cell ref → { raw, srcFrom }.
 *
 * @param {string} body     - body text (after front matter)
 * @param {number} bodyFrom - absolute offset of body start in the full document
 *                            (used so srcFrom values are full-doc absolute)
 */
function _parseSheet(body, bodyFrom = 0) {
  const cells  = new Map();
  let maxCol   = -1;
  let maxRow   = -1;
  let offset   = 0;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('#')) {
      // Syntax: CellRef<whitespace>value  (colon is NOT the separator)
      const m = /^([A-Z]+\d+)\s+(.*)$/i.exec(trimmed);
      if (m) {
        const ref = m[1].toUpperCase();
        const raw = m[2].trim();
        const pos = _parseCellRef(ref);
        if (pos) {
          const srcFrom = bodyFrom + offset;
          // srcTo: end of meaningful content on this line (no trailing whitespace/newline)
          const srcTo = srcFrom + line.trimEnd().length;
          cells.set(ref, { raw, srcFrom, srcTo });
          maxCol = Math.max(maxCol, pos.col);
          maxRow = Math.max(maxRow, pos.row);
        }
      }
    }

    offset += line.length + 1; // +1 for '\n'
  }

  return { cells, maxCol, maxRow };
}

// ---------------------------------------------------------------------------
// Cell reference utilities
// ---------------------------------------------------------------------------

function _parseCellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  return { col: _colToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

function _colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function _indexToCol(n) {
  let s = '';
  n++;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Parse a range like "A1:C3" into an array of ref strings
function _expandRange(rangeStr) {
  const parts = rangeStr.split(':');
  if (parts.length !== 2) return [rangeStr];
  const start = _parseCellRef(parts[0].trim());
  const end   = _parseCellRef(parts[1].trim());
  if (!start || !end) return [];
  const refs = [];
  for (let r = start.row; r <= end.row; r++) {
    for (let c = start.col; c <= end.col; c++) {
      refs.push(_indexToCol(c) + (r + 1));
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Formula evaluation
// ---------------------------------------------------------------------------

function _evaluateAll(cells, maxCol, maxRow) {
  const evaluated = new Map();
  const visiting  = new Set();

  const getCellVal = (ref) => {
    const normRef = ref.toUpperCase();
    if (evaluated.has(normRef)) return evaluated.get(normRef);
    if (visiting.has(normRef)) return '#CIRC';
    visiting.add(normRef);
    const cell = cells.get(normRef);
    const val  = cell ? _evalCell(cell.raw, getCellVal) : null;
    evaluated.set(normRef, val);
    visiting.delete(normRef);
    return val;
  };

  // Eval all known cells
  for (const [ref] of cells) getCellVal(ref);

  // Also fill nulls for display
  for (let r = 0; r <= maxRow; r++) {
    for (let c = 0; c <= maxCol; c++) {
      const ref = _indexToCol(c) + (r + 1);
      if (!evaluated.has(ref)) evaluated.set(ref, null);
    }
  }

  return evaluated;
}

function _evalCell(raw, getCellVal) {
  if (!raw) return null;
  if (!raw.startsWith('=')) return _parseValue(raw);
  try {
    return _evalFormula(raw.slice(1).trim(), getCellVal);
  } catch {
    return '#ERR';
  }
}

function _parseValue(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s === 'true')  return true;
  if (s === 'false') return false;
  // Unquote strings
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const n = Number(s);
  if (!isNaN(n) && s !== '') return n;
  return s; // plain string
}

function _formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'number') {
    // Format with up to 4 decimal places, stripping trailing zeros
    return parseFloat(v.toFixed(4)).toString();
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Formula expression parser (recursive descent)
// ---------------------------------------------------------------------------

function _evalFormula(expr, getCellVal) {
  const tokens = _tokenize(expr);
  const it = { tokens, pos: 0 };
  const result = _parseExpr(it, getCellVal);
  return result;
}

function _tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }
    // String literal
    if (expr[i] === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== '"') j++;
      tokens.push({ type: 'str', value: expr.slice(i + 1, j) });
      i = j + 1; continue;
    }
    // Number
    if (/[\d.]/.test(expr[i])) {
      let j = i;
      while (j < expr.length && /[\d.]/.test(expr[j])) j++;
      tokens.push({ type: 'num', value: parseFloat(expr.slice(i, j)) });
      i = j; continue;
    }
    // Identifier or cell ref or function
    if (/[A-Za-z_]/.test(expr[i])) {
      let j = i;
      while (j < expr.length && /[\w]/.test(expr[j])) j++;
      const word = expr.slice(i, j).toUpperCase();
      // Check for colon (range) — but that's handled in function args
      if (j < expr.length && expr[j] === '(') {
        tokens.push({ type: 'func', value: word });
      } else if (/^[A-Z]+\d+$/.test(word)) {
        tokens.push({ type: 'ref', value: word });
      } else if (word === 'TRUE')  { tokens.push({ type: 'bool', value: true }); }
      else if (word === 'FALSE') { tokens.push({ type: 'bool', value: false }); }
      else { tokens.push({ type: 'id', value: word }); }
      i = j; continue;
    }
    // Two-char operators
    if (i + 1 < expr.length) {
      const two = expr.slice(i, i + 2);
      if (['<=', '>=', '<>', '!='].includes(two)) {
        tokens.push({ type: 'op', value: two }); i += 2; continue;
      }
    }
    // Single-char operators and punctuation
    const ch = expr[i];
    if ('+-*/%^<>=(),:'.includes(ch)) {
      tokens.push({ type: 'op', value: ch }); i++; continue;
    }
    i++; // skip unknown
  }
  return tokens;
}

function _peek(it)  { return it.tokens[it.pos]; }
function _next(it)  { return it.tokens[it.pos++]; }

function _parseExpr(it, gcv)    { return _parseComparison(it, gcv); }

function _parseComparison(it, gcv) {
  let left = _parseAddSub(it, gcv);
  while (_peek(it)?.type === 'op' && ['<', '>', '<=', '>=', '=', '<>', '!='].includes(_peek(it).value)) {
    const op = _next(it).value;
    const right = _parseAddSub(it, gcv);
    switch (op) {
      case '<':  left = left <  right; break;
      case '>':  left = left >  right; break;
      case '<=': left = left <= right; break;
      case '>=': left = left >= right; break;
      case '=':
      case '==': left = left == right; break; // eslint-disable-line eqeqeq
      case '<>':
      case '!=': left = left != right; break; // eslint-disable-line eqeqeq
    }
  }
  return left;
}

function _parseAddSub(it, gcv) {
  let left = _parseMulDiv(it, gcv);
  while (_peek(it)?.type === 'op' && ['+', '-'].includes(_peek(it).value)) {
    const op = _next(it).value;
    const right = _parseMulDiv(it, gcv);
    left = op === '+' ? _add(left, right) : _num(left) - _num(right);
  }
  return left;
}

function _parseMulDiv(it, gcv) {
  let left = _parsePower(it, gcv);
  while (_peek(it)?.type === 'op' && ['*', '/', '%'].includes(_peek(it).value)) {
    const op = _next(it).value;
    const right = _parsePower(it, gcv);
    if (op === '*') left = _num(left) * _num(right);
    else if (op === '/') left = _num(right) === 0 ? '#DIV/0' : _num(left) / _num(right);
    else left = _num(left) % _num(right);
  }
  return left;
}

function _parsePower(it, gcv) {
  let base = _parseUnary(it, gcv);
  if (_peek(it)?.type === 'op' && _peek(it).value === '^') {
    _next(it);
    const exp = _parseUnary(it, gcv);
    base = Math.pow(_num(base), _num(exp));
  }
  return base;
}

function _parseUnary(it, gcv) {
  if (_peek(it)?.type === 'op' && _peek(it).value === '-') {
    _next(it);
    return -_num(_parseAtom(it, gcv));
  }
  if (_peek(it)?.type === 'op' && _peek(it).value === '+') {
    _next(it);
  }
  return _parseAtom(it, gcv);
}

function _parseAtom(it, gcv) {
  const tok = _peek(it);
  if (!tok) return 0;

  if (tok.type === 'num') { _next(it); return tok.value; }
  if (tok.type === 'str') { _next(it); return tok.value; }
  if (tok.type === 'bool') { _next(it); return tok.value; }
  if (tok.type === 'ref') { _next(it); return gcv(tok.value) ?? 0; }

  if (tok.type === 'func') {
    _next(it);
    // consume '('
    if (_peek(it)?.value === '(') _next(it);
    const args = _parseArgs(it, gcv);
    // consume ')'
    if (_peek(it)?.value === ')') _next(it);
    return _callFunction(tok.value, args, gcv);
  }

  if (tok.type === 'op' && tok.value === '(') {
    _next(it);
    const val = _parseExpr(it, gcv);
    if (_peek(it)?.value === ')') _next(it);
    return val;
  }

  _next(it);
  return 0;
}

function _parseArgs(it, gcv) {
  // Arguments can be: expressions, or ranges like A1:B3
  const args = [];
  while (_peek(it) && _peek(it).value !== ')') {
    // Check for range: ref : ref
    if (_peek(it)?.type === 'ref') {
      const ref = _next(it);
      if (_peek(it)?.value === ':') {
        _next(it); // consume ':'
        const endRef = _next(it);
        args.push({ type: 'range', start: ref.value, end: endRef.value });
      } else {
        args.push({ type: 'val', value: gcv(ref.value) ?? 0 });
      }
    } else {
      args.push({ type: 'val', value: _parseExpr(it, gcv) });
    }
    if (_peek(it)?.value === ',') _next(it);
  }
  return args;
}

function _resolveArg(arg, gcv) {
  if (arg.type === 'range') {
    return _expandRange(arg.start + ':' + arg.end)
      .map(ref => gcv(ref))
      .filter(v => v != null && typeof v === 'number');
  }
  return [arg.value];
}

function _callFunction(name, args, gcv) {
  const nums = () => args.flatMap(a => _resolveArg(a, gcv)).map(Number).filter(n => !isNaN(n));

  switch (name) {
    case 'SUM':     { const ns = nums(); return ns.reduce((a, b) => a + b, 0); }
    case 'AVERAGE': { const ns = nums(); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0; }
    case 'COUNT':   { return args.flatMap(a => _resolveArg(a, gcv)).filter(v => v != null).length; }
    case 'MIN':     { const ns = nums(); return ns.length ? Math.min(...ns) : 0; }
    case 'MAX':     { const ns = nums(); return ns.length ? Math.max(...ns) : 0; }
    case 'ABS':     { const ns = nums(); return ns.length ? Math.abs(ns[0]) : 0; }
    case 'ROUND': {
      const ns = nums();
      const dp = ns[1] ?? 0;
      return ns.length ? parseFloat(ns[0].toFixed(dp)) : 0;
    }
    case 'IF': {
      const cond = args[0] ? _resolveArg(args[0], gcv)[0] : false;
      const tVal = args[1] ? _resolveArg(args[1], gcv)[0] : '';
      const fVal = args[2] ? _resolveArg(args[2], gcv)[0] : '';
      return cond ? tVal : fVal;
    }
    case 'CONCAT':
    case 'CONCATENATE': {
      return args.flatMap(a => _resolveArg(a, gcv)).join('');
    }
    case 'LEN': {
      const v = args[0] ? _resolveArg(args[0], gcv)[0] : '';
      return String(v ?? '').length;
    }
    case 'UPPER': { const v = args[0] ? _resolveArg(args[0], gcv)[0] : ''; return String(v).toUpperCase(); }
    case 'LOWER': { const v = args[0] ? _resolveArg(args[0], gcv)[0] : ''; return String(v).toLowerCase(); }
    default: return '#NAME?';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _num(v) { return typeof v === 'number' ? v : parseFloat(v) || 0; }

function _add(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return String(a ?? '') + String(b ?? '');
  return _num(a) + _num(b);
}
