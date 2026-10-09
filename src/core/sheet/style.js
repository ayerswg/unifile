/**
 * {spreadsheet} — styles, conditions and number formats (pure, Node-tested).
 *
 * Style PROPERTIES are space-separated tokens after a range:
 *
 *   bold italic underline strike wrap           flags (`bold:off` clears one)
 *   color:red   bg:#eef   size:14   font:mono|serif|sans
 *   align:left|center|right   valign:top|middle|bottom
 *   format:0.00 | #,##0 | 0% | $#,##0.00 | 0.00E+00 | general | number |
 *          integer | percent | currency | text   (quote patterns with spaces)
 *   border | border:bottom | border:top,left | border:none
 *
 * A CONDITION (after `if <range>` and in `filter`) is one of:
 *
 *   > 100   >= 1   < 0   <= 1   = "late"   <> 0        compare (the right side
 *                                                       is any formula expression:
 *                                                       `> B1*2`, `= TRUE`)
 *   between 10 and 20        contains "x"   starts "x"   ends "x"
 *   blank   filled   error   duplicate   unique   top 3   bottom 3
 *   =D>C                     a formula, evaluated per cell with the row's
 *                            bare-column refs (`=D>C` = this row's D > C)
 *
 * `resolveCellStyle` layers them for one cell: `style` lines in order (later
 * wins per property), then every `if` rule whose condition holds, then the
 * colour `scale` — the result is a flat `{ bold, color, bg, … }` object the
 * renderer turns into CSS and the .xlsx writer into a cell style.
 */

import { parseFormula, evaluate, isError, toNumber, toText, formatNumber } from '../tables/formula.js';
import { literalValue } from '../tables/grid.js';

export const FLAGS = ['bold', 'italic', 'underline', 'strike', 'wrap'];
export const KEYED = ['color', 'bg', 'size', 'font', 'align', 'valign', 'format', 'border'];
export const PROP_NAMES = [...FLAGS, ...KEYED];
export const ALIGNS = ['left', 'center', 'right'];
export const VALIGNS = ['top', 'middle', 'bottom'];
export const FONTS = ['mono', 'serif', 'sans'];
export const BORDERS = ['all', 'top', 'bottom', 'left', 'right', 'none'];
export const NAMED_FORMATS = {
  general: null, number: '#,##0.00', integer: '#,##0', percent: '0%', currency: '$#,##0.00', text: '@',
};
/** Formats offered by the toolbar, in order. */
export const FORMAT_CHOICES = [
  ['general', 'General'], ['#,##0', 'Integer  1,235'], ['#,##0.00', 'Number  1,234.57'], ['0.00', 'Fixed  1234.57'],
  ['0%', 'Percent  12%'], ['0.0%', 'Percent  12.3%'], ['$#,##0.00', 'Currency  $1,234.57'], ['€#,##0.00', 'Euro  €1,234.57'],
  ['£#,##0.00', 'Pound  £1,234.57'], ['0.00E+00', 'Scientific  1.23E+03'], ['text', 'Text'],
];

const CSS_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));

/** A colour token → its canonical form (`#rrggbb` lower-case, or the CSS name), else null. */
export function parseColor(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return t;
  if (/^#[0-9a-f]{8}$/.test(t)) return t;
  if (CSS_COLORS.has(t)) return t;
  return null;
}

/** `#rrggbb` → [r, g, b]; CSS names via a small table for the ones scales commonly use. */
export function colorToRgb(c) {
  const t = parseColor(c);
  if (!t) return null;
  if (t.startsWith('#')) {
    const h = t.length === 4 ? '#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3] : t;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  const named = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], orange: [255, 165, 0], gold: [255, 215, 0], lime: [0, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], pink: [255, 192, 203], purple: [128, 0, 128], navy: [0, 0, 128], teal: [0, 128, 128], crimson: [220, 20, 60], coral: [255, 127, 80], salmon: [250, 128, 114], tomato: [255, 99, 71], lightgreen: [144, 238, 144], lightblue: [173, 216, 230], lightyellow: [255, 255, 224], lightgray: [211, 211, 211], lightgrey: [211, 211, 211], skyblue: [135, 206, 235], steelblue: [70, 130, 180], seagreen: [46, 139, 87], forestgreen: [34, 139, 34], firebrick: [178, 34, 34], darkred: [139, 0, 0], darkgreen: [0, 100, 0], darkblue: [0, 0, 139], ivory: [255, 255, 240], beige: [245, 245, 220], khaki: [240, 230, 140], lavender: [230, 230, 250], mintcream: [245, 255, 250], honeydew: [240, 255, 240], mistyrose: [255, 228, 225] };
  return named[t] ?? [128, 128, 128];
}

const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const rgbToHex = ([r, g, b]) => '#' + hex2(r) + hex2(g) + hex2(b);

// ---------------------------------------------------------------------------
// Style properties
// ---------------------------------------------------------------------------

/**
 * Parse property tokens (from parse.js `tokenizeArgs`, or plain strings).
 * @returns {{ props: object, problems: string[] }}
 *   props: { bold: true|false, color: '#…'|null, format: '0.00'|null, … }
 *   — `false` / `null` mean "clear" (from `bold:off` / `color:none`).
 */
export function parseStyleProps(tokens) {
  const props = {};
  const problems = [];
  for (const tok of tokens) {
    const text = typeof tok === 'string' ? tok : tok.text;
    const m = /^([a-z]+)(?::(.*))?$/is.exec(text);
    if (!m) { problems.push(`"${text}" is not a property`); continue; }
    const key = m[1].toLowerCase();
    let val = m[2];
    if (val != null && /^".*"$/s.test(val)) val = val.slice(1, -1);   // a value quoted by hand
    if (FLAGS.includes(key)) {
      if (val == null || /^(on|true|yes)$/i.test(val)) props[key] = true;
      else if (/^(off|false|no|none)$/i.test(val)) props[key] = false;
      else problems.push(`${key}: expected on or off`);
      continue;
    }
    if (!KEYED.includes(key)) { problems.push(`unknown property "${key}"`); continue; }
    if (val == null || val === '') {
      if (key === 'border') { props.border = 'all'; continue; }
      problems.push(`${key}: missing value`); continue;
    }
    if (/^(none|off|auto|general)$/i.test(val)) {
      // `border:none` draws no border; every other reset clears the property.
      props[key] = key === 'border' && /^none$/i.test(val) ? 'none' : null;
      continue;
    }
    switch (key) {
      case 'color': case 'bg': {
        const c = parseColor(val);
        if (!c) { problems.push(`${key}: "${val}" is not a colour`); break; }
        props[key] = c; break;
      }
      case 'size': {
        const n = Number(val);
        if (!(n > 0)) { problems.push(`size: "${val}" is not a number`); break; }
        props.size = n; break;
      }
      case 'font': {
        const f = val.toLowerCase();
        if (!FONTS.includes(f)) { problems.push(`font: expected mono, serif or sans`); break; }
        props.font = f; break;
      }
      case 'align': {
        const a = val.toLowerCase();
        if (!ALIGNS.includes(a)) { problems.push(`align: expected left, center or right`); break; }
        props.align = a; break;
      }
      case 'valign': {
        const a = val.toLowerCase();
        if (!VALIGNS.includes(a)) { problems.push(`valign: expected top, middle or bottom`); break; }
        props.valign = a; break;
      }
      case 'format': {
        const named = NAMED_FORMATS[val.toLowerCase()];
        if (val.toLowerCase() in NAMED_FORMATS) { props.format = named; break; }
        if (!isValidFormat(val)) { problems.push(`format: "${val}" is not a number format`); break; }
        props.format = val; break;
      }
      case 'border': {
        const sides = val.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (!sides.length || sides.some(s => !BORDERS.includes(s))) { problems.push(`border: expected all, top, bottom, left, right or none`); break; }
        props.border = sides.includes('all') ? 'all' : sides.includes('none') ? 'none' : sides.join(',');
        break;
      }
    }
  }
  return { props, problems };
}

/** The canonical token list for a props object (the serializer). */
export function formatStyleProps(props) {
  const out = [];
  for (const key of PROP_NAMES) {
    if (!(key in props)) continue;
    const v = props[key];
    if (FLAGS.includes(key)) { out.push(v ? key : `${key}:off`); continue; }
    if (v == null) { out.push(`${key}:none`); continue; }
    if (key === 'format') {
      // Patterns are written as patterns (`#,##0.00` reads fine); `@` is `text`.
      const val = v === '@' ? 'text' : v;
      out.push('format:' + (/[\s"]/.test(val) ? '"' + val.replace(/"/g, '\\"') + '"' : val));
      continue;
    }
    if (key === 'border' && v === 'all') { out.push('border'); continue; }
    out.push(`${key}:${v}`);
  }
  return out.join(' ');
}

/** Does a props object set anything? */
export const hasProps = (props) => Object.keys(props).length > 0;

// ---------------------------------------------------------------------------
// Number formats
// ---------------------------------------------------------------------------

const FORMAT_RE = /^([^#0.,E%]*?)(#,##)?(0+)(?:\.(0+))?(E\+0+)?(%?)([^#0.,E%]*)$/;

export function isValidFormat(fmt) {
  if (fmt === '@') return true;
  return FORMAT_RE.test(String(fmt));
}

/**
 * Format a value with a number-format pattern (`#,##0.00`, `0%`, `$#,##0`,
 * `0.00E+00`, text prefix/suffix, `@` = text).  Non-numbers pass through as
 * text; a null pattern = General.
 */
export function formatValue(v, fmt) {
  if (v == null) return '';
  if (isError(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v !== 'number') return String(v);
  if (!fmt) return formatNumber(v);
  if (fmt === '@') return formatNumber(v);
  const m = FORMAT_RE.exec(fmt);
  if (!m) return formatNumber(v);
  const [, prefix, grouped, , decs, sci, pct, suffix] = m;
  const decimals = decs ? decs.length : 0;
  let n = pct ? v * 100 : v;
  const neg = n < 0;
  n = Math.abs(n);
  let s;
  if (sci) {
    s = n.toExponential(decimals);
    s = s.replace(/e([+-])(\d)$/, (_, sign, d) => `E${sign}${d.padStart(sci.length - 2, '0')}`);
  } else {
    s = n.toFixed(decimals);
    if (grouped) {
      const [i, d] = s.split('.');
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '');
    }
  }
  return (neg ? '-' : '') + prefix + s + (pct ? '%' : '') + suffix;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const OPS = { '=': '=', '==': '=', '<>': '<>', '!=': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
const WORD_KINDS = ['blank', 'filled', 'error', 'duplicate', 'unique'];

/**
 * Parse condition tokens.
 * @returns {{ kind, op?, value?, a?, b?, text?, n?, formula?, error? }}
 *   kind: 'cmp' | 'between' | 'contains' | 'starts' | 'ends' | 'blank' |
 *         'filled' | 'error' | 'duplicate' | 'unique' | 'top' | 'bottom' | 'formula'
 */
export function parseCondition(tokens) {
  const toks = tokens.map(t => (typeof t === 'string' ? { text: t, quoted: false } : t));
  if (!toks.length) return { error: 'missing condition' };
  const first = toks[0];
  const lower = first.text.toLowerCase();
  // =formula  (everything up to the end is the formula)
  if (!first.quoted && first.text.startsWith('=') && !/^(=|==)$/.test(first.text) && !OPS[first.text]) {
    const formula = toks.map(t => t.text).join(' ').slice(1);
    try { parseFormula(formula); } catch (e) { return { error: `formula: ${e.detail || e.message}` }; }
    return { kind: 'formula', formula };
  }
  if (!first.quoted && WORD_KINDS.includes(lower)) {
    if (toks.length > 1) return { error: `${lower} takes no value` };
    return { kind: lower };
  }
  if (!first.quoted && (lower === 'top' || lower === 'bottom')) {
    const n = Number(toks[1]?.text);
    if (!(n > 0) || toks.length !== 2) return { error: `${lower}: expected a count` };
    return { kind: lower, n: Math.trunc(n) };
  }
  if (!first.quoted && (lower === 'contains' || lower === 'starts' || lower === 'ends')) {
    if (toks.length < 2) return { error: `${lower}: expected text` };
    return { kind: lower, text: toks.slice(1).map(t => t.text).join(' ') };
  }
  if (!first.quoted && lower === 'between') {
    const andAt = toks.findIndex(t => !t.quoted && t.text.toLowerCase() === 'and');
    if (andAt < 2 || andAt === toks.length - 1) return { error: 'between: expected `between a and b`' };
    const a = exprOf(toks.slice(1, andAt)), b = exprOf(toks.slice(andAt + 1));
    if (a.error || b.error) return { error: `between: ${a.error || b.error}` };
    return { kind: 'between', a: a.text, b: b.text };
  }
  // Comparison: `> 100`, `>100`, `= "late"`, `<> 0`
  let op = null, rest = toks;
  if (!first.quoted && OPS[first.text]) { op = OPS[first.text]; rest = toks.slice(1); }
  else if (!first.quoted) {
    const m = /^(<>|!=|<=|>=|==|=|<|>)(.+)$/.exec(first.text);
    if (m) { op = OPS[m[1]]; rest = [{ text: m[2], quoted: false }, ...toks.slice(1)]; }
  }
  if (!op) return { error: `cannot read "${toks.map(t => t.text).join(' ')}"` };
  const v = exprOf(rest);
  if (v.error) return { error: v.error };
  return { kind: 'cmp', op, value: v.text };
}

/** Join value tokens into a formula expression (quoted text → a string literal). */
function exprOf(toks) {
  if (!toks.length) return { error: 'missing value' };
  const text = toks.map(t => t.quoted ? '"' + t.text.replace(/"/g, '""') + '"' : t.text).join(' ');
  try { parseFormula(text); } catch (e) { return { error: `"${text}": ${e.detail || e.message}` }; }
  return { text };
}

/** The canonical text of a condition (the serializer). */
export function formatCondition(cond) {
  switch (cond.kind) {
    case 'cmp': return `${cond.op} ${cond.value}`;
    case 'between': return `between ${cond.a} and ${cond.b}`;
    case 'contains': case 'starts': case 'ends': return `${cond.kind} ${quoteText(cond.text)}`;
    case 'top': case 'bottom': return `${cond.kind} ${cond.n}`;
    case 'formula': return `=${cond.formula}`;
    default: return cond.kind;
  }
}
const quoteText = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** A human sentence for a condition (the grid's rule list). */
export function describeCondition(cond) {
  switch (cond.kind) {
    case 'cmp': return `is ${cond.op === '=' ? 'equal to' : cond.op === '<>' ? 'not equal to' : cond.op} ${cond.value}`;
    case 'between': return `is between ${cond.a} and ${cond.b}`;
    case 'contains': return `contains "${cond.text}"`;
    case 'starts': return `starts with "${cond.text}"`;
    case 'ends': return `ends with "${cond.text}"`;
    case 'top': return `is in the top ${cond.n}`;
    case 'bottom': return `is in the bottom ${cond.n}`;
    case 'formula': return `formula =${cond.formula} is true`;
    case 'blank': return 'is blank';
    case 'filled': return 'is not blank';
    case 'error': return 'is an error';
    case 'duplicate': return 'is a duplicate';
    case 'unique': return 'is unique';
  }
  return cond.kind;
}

/**
 * Compile a condition into a predicate over a cell.
 *
 * @param cond        from parseCondition
 * @param ctx         { sheet, sheetByName(name), valueAt(sheet, r, c) }  (formula.js shape)
 * @param rangeValues () → the values of every cell the condition's range
 *                    covers (for top/bottom/duplicate/unique; computed lazily once)
 * @returns {(cell, value) => boolean}   cell = { r, c }
 */
export function compileCondition(cond, ctx, rangeValues) {
  const safe = fn => (cell, v) => { try { return !!fn(cell, v); } catch { return false; } };
  const expr = (text) => { try { return parseFormula(text); } catch { return null; } };
  const evalAt = (ast, cell) => evaluate(ast, { ...ctx, row: cell.r, col: cell.c });
  const scalar = x => Array.isArray(x) ? (x[0]?.[0] ?? null) : x;
  switch (cond.kind) {
    case 'cmp': {
      const ast = expr(cond.value);
      if (!ast) return () => false;
      return safe((cell, v) => {
        if (v == null && cond.op !== '=' && cond.op !== '<>') return false;
        const rhs = scalar(evalAt(ast, cell));
        if (isError(v) || isError(rhs)) return false;
        const d = compareValues(v, rhs);
        switch (cond.op) {
          case '=': return d === 0; case '<>': return d !== 0; case '<': return d < 0;
          case '>': return d > 0; case '<=': return d <= 0; case '>=': return d >= 0;
        }
        return false;
      });
    }
    case 'between': {
      const a = expr(cond.a), b = expr(cond.b);
      if (!a || !b) return () => false;
      return safe((cell, v) => {
        if (v == null || isError(v)) return false;
        const lo = toNumber(scalar(evalAt(a, cell))), hi = toNumber(scalar(evalAt(b, cell)));
        const n = toNumber(v);
        return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
      });
    }
    case 'contains': return safe((_, v) => v != null && !isError(v) && toText(v).toLowerCase().includes(cond.text.toLowerCase()));
    case 'starts': return safe((_, v) => v != null && !isError(v) && toText(v).toLowerCase().startsWith(cond.text.toLowerCase()));
    case 'ends': return safe((_, v) => v != null && !isError(v) && toText(v).toLowerCase().endsWith(cond.text.toLowerCase()));
    case 'blank': return (_, v) => v == null || v === '';
    case 'filled': return (_, v) => !(v == null || v === '');
    case 'error': return (_, v) => isError(v);
    case 'duplicate': case 'unique': {
      let counts = null;
      return safe((_, v) => {
        if (v == null || isError(v)) return false;
        if (!counts) {
          counts = new Map();
          for (const x of rangeValues()) { if (x == null || isError(x)) continue; const k = keyOf(x); counts.set(k, (counts.get(k) || 0) + 1); }
        }
        const n = counts.get(keyOf(v)) || 0;
        return cond.kind === 'duplicate' ? n > 1 : n === 1;
      });
    }
    case 'top': case 'bottom': {
      let cut = null;
      return safe((_, v) => {
        if (typeof v !== 'number') return false;
        if (cut == null) {
          const nums = rangeValues().filter(x => typeof x === 'number').sort((a, b) => cond.kind === 'top' ? b - a : a - b);
          cut = nums.length ? nums[Math.min(cond.n, nums.length) - 1] : null;
        }
        if (cut == null) return false;
        return cond.kind === 'top' ? v >= cut : v <= cut;
      });
    }
    case 'formula': {
      const ast = expr(cond.formula);
      if (!ast) return () => false;
      return safe((cell) => {
        const r = scalar(evalAt(ast, cell));
        if (isError(r) || r == null) return false;
        return typeof r === 'number' ? r !== 0 : typeof r === 'boolean' ? r : String(r).toUpperCase() === 'TRUE';
      });
    }
  }
  return () => false;
}

const keyOf = v => (typeof v === 'string' ? 's:' + v.toLowerCase() : typeof v + ':' + String(v));

/** Excel-ish comparison: numbers < text < booleans; text case-insensitive; numeric text compares as numbers to numbers. */
export function compareValues(a, b) {
  if (a == null) a = typeof b === 'number' ? 0 : '';
  if (b == null) b = typeof a === 'number' ? 0 : '';
  if (typeof a === 'number' && typeof b === 'string') { const n = literalValue(b); if (typeof n === 'number') b = n; }
  if (typeof b === 'number' && typeof a === 'string') { const n = literalValue(a); if (typeof n === 'number') a = n; }
  const rank = v => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return (a ? 1 : 0) - (b ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Resolution — one flat style per cell
// ---------------------------------------------------------------------------

/**
 * Build the per-cell style resolver for a sheet.
 *
 * @param sheet     from parse.js
 * @param values    Map<cell, value> from evaluateWorkbook
 * @param ctx       { sheetByName, valueAt } — the formula context (sheet is added)
 * @returns {(cell, { conditional }) => object}   the flat style for a cell ({} when
 *   plain); `conditional: false` = the `style` lines alone (the .xlsx writes
 *   those as cell styles and the rules as real conditional formats)
 */
export function styleResolver(sheet, values, ctx) {
  const fctx = { ...ctx, sheet };
  const valueOf = (r, c) => { const cell = sheet.grid[r]?.[c]; return cell ? values.get(cell) ?? null : null; };
  const rangeVals = (R) => () => {
    const out = [];
    const r2 = Math.min(R.r2, sheet.rows.length - 1), c2 = Math.min(R.c2, sheet.cols - 1);
    for (let r = R.r1; r <= r2; r++) for (let c = R.c1; c <= c2; c++) { const cell = sheet.grid[r][c]; if (cell && cell.r === r && cell.c === c) out.push(values.get(cell) ?? null); }
    return out;
  };
  const rules = sheet.rules.map(rule => ({ ...rule, test: compileCondition(rule.cond, fctx, rangeVals(rule.range)) }));
  const scales = sheet.scales.map(sc => {
    const nums = rangeVals(sc.range)().filter(x => typeof x === 'number');
    const min = nums.length ? Math.min(...nums) : 0, max = nums.length ? Math.max(...nums) : 0;
    return { ...sc, min, max, rgb: sc.colors.map(colorToRgb) };
  });

  return (cell, { conditional = true } = {}) => {
    const out = {};
    const { r, c } = cell;
    for (const s of sheet.styles) {
      if (!rangeContainsCell(s.range, r, c)) continue;
      applyProps(out, s.props);
    }
    if (conditional && (rules.length || scales.length)) {
      const v = values.get(cell) ?? null;
      for (const rule of rules) {
        if (!rangeContainsCell(rule.range, r, c)) continue;
        if (rule.test(cell, v)) applyProps(out, rule.props);
      }
      for (const sc of scales) {
        if (!rangeContainsCell(sc.range, r, c) || typeof v !== 'number') continue;
        out.bg = scaleColor(v, sc);
      }
    }
    return out;
  };
}

const rangeContainsCell = (R, r, c) => r >= R.r1 && r <= R.r2 && c >= R.c1 && c <= R.c2;

function applyProps(out, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) delete out[k];
    else out[k] = v;
  }
}

/** Interpolate a value's colour on a 2- or 3-stop scale. */
export function scaleColor(v, sc) {
  const stops = sc.rgb.length >= 3 ? [sc.rgb[0], sc.rgb[1], sc.rgb[2]] : [sc.rgb[0], sc.rgb[1]];
  const t = sc.max === sc.min ? 0.5 : Math.max(0, Math.min(1, (v - sc.min) / (sc.max - sc.min)));
  let a, b, u;
  if (stops.length === 3) { if (t < 0.5) { a = stops[0]; b = stops[1]; u = t * 2; } else { a = stops[1]; b = stops[2]; u = (t - 0.5) * 2; } }
  else { a = stops[0]; b = stops[1]; u = t; }
  return rgbToHex([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
}

/** Inline CSS for a resolved style (the grid, the HTML export). */
export function styleToCss(st, { bold = false } = {}) {
  const css = [];
  if (st.bold || bold) css.push('font-weight:600');
  if (st.italic) css.push('font-style:italic');
  const deco = [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  if (st.color) css.push(`color:${st.color}`);
  if (st.bg) css.push(`background:${st.bg}`);
  if (st.size) css.push(`font-size:${st.size}px`);
  if (st.font) css.push(`font-family:${st.font === 'mono' ? 'ui-monospace, Menlo, Consolas, monospace' : st.font === 'serif' ? 'Georgia, "Times New Roman", serif' : '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif'}`);
  if (st.align) css.push(`text-align:${st.align}`);
  if (st.valign) css.push(`vertical-align:${st.valign}`);
  if (st.wrap) css.push('white-space:pre-wrap');
  if (st.border) {
    const sides = st.border === 'all' ? ['top', 'bottom', 'left', 'right'] : st.border === 'none' ? [] : st.border.split(',');
    for (const s of sides) css.push(`border-${s}:1px solid currentColor`);
  }
  return css.join(';');
}
