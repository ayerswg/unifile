/**
 * uDraft syntax engine — per-line classification + span rendering for the
 * shared line editor (upub/editor.js with `syntax:` plugged in).
 *
 * THE ONE INVARIANT (inherited from uPub, everything depends on it):
 *
 *     textContent(renderLineHtml(line, info)) === line
 *
 * Rendering only ever WRAPS characters in <span>s.  The editor extracts the
 * document back out of the DOM via textContent and restores the caret by
 * absolute offset — any violation corrupts the document.
 *
 * Classification is stateful only for the leading front matter (uDraft has no
 * fences).  Line types: fm-fence | fm | blank | comment | stmt | text.
 * `stmt` lines get token-level spans from the real lexer
 * (core/udraft/parse.js tokenizeLine) — keywords, lengths, sides, room ids,
 * fixture types, strings, comments.  Deliberately NO parse-error underlines
 * in the editor (half-typed lines are always "wrong"; the calm surface wins —
 * diagnostics live in the preview's issue strip).
 */

import { tokenizeLine, STATEMENT_KEYWORDS, FIXTURES, SHAPE_NAMES } from '../core/udraft/parse.js';

const KEYWORDS = new Set(STATEMENT_KEYWORDS);
const SIDES = new Set(['north', 'south', 'east', 'west', 'n', 's', 'e', 'w']);
const CONNECTIVES = new Set([
  'of', 'align', 'offset', 'at', 'from', 'centered', 'center', 'centred',
  'swing', 'on', 'along', 'facing', 'x', 'outline', 'close', 'up', 'down',
  'in', 'out', 'shape', 'path',
]);
const FIXTURE_TYPES = new Set(Object.keys(FIXTURES));
const SHAPES = new Set(SHAPE_NAMES);
// `define … path M 0 0 L 5' 0 …` — the path letters read as operators.
const PATH_LETTERS = new Set(['m', 'l', 'h', 'v', 'c', 'q', 'z']);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * @param {string[]} lines
 * @returns {Array<{type:string, hang:number, kw?:string}>}
 */
export function classifyDoc(lines) {
  const infos = new Array(lines.length);
  // Leading front matter: line 0 is exactly `---` and a closing `---` exists.
  let fmClose = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { fmClose = i; break; }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fmClose > 0 && i <= fmClose) {
      infos[i] = { type: (i === 0 || i === fmClose) ? 'fm-fence' : 'fm', hang: 0 };
      continue;
    }
    if (!line.trim()) { infos[i] = { type: 'blank', hang: 0 }; continue; }
    if (/^\s*#/.test(line)) { infos[i] = { type: 'comment', hang: 0 }; continue; }
    const m = /^([a-z][a-z0-9_-]*)/i.exec(line.trimStart());
    const kw = m && KEYWORDS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
    if (kw) {
      // Wrapped clauses hang-indent to align after the keyword.
      infos[i] = { type: 'stmt', kw, hang: kw.length + 1 };
    } else {
      infos[i] = { type: 'text', hang: 0 };
    }
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls, s) { return `<span class="${cls}">${esc(s)}</span>`; }

/** Column where a comment starts (`#` at 0 or after whitespace, outside strings). */
function commentStart(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // The inch mark (digit before the quote) never toggles string state.
      if (!(i > 0 && /\d/.test(line[i - 1]) && !inStr)) inStr = !inStr;
      continue;
    }
    if (ch === '#' && !inStr && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

export function renderLineHtml(line, info) {
  switch (info.type) {
    case 'blank':
      return line ? esc(line) : '';
    case 'fm-fence':
      return span('md', line);
    case 'fm': {
      const m = /^(\s*)([^:\s][^:]*)(:)([\s\S]*)$/.exec(line);
      if (m) return esc(m[1]) + span('fm-key', m[2]) + span('md', m[3]) + esc(m[4]);
      return esc(line);
    }
    case 'comment':
      return span('cmt', line);
    case 'stmt':
      return renderStmt(line, info);
    default:
      return esc(line);
  }
}

function renderStmt(line, info) {
  const cs = commentStart(line);
  const code = cs >= 0 ? line.slice(0, cs) : line;
  const tokens = tokenizeLine(code);
  let out = '';
  let pos = 0;
  let first = true;
  let inPath = false;
  for (const t of tokens) {
    if (t.col > pos) out += esc(code.slice(pos, t.col));
    // The string token's raw text includes its quotes.
    const raw = t.t === 'str' ? code.slice(t.col, t.col + t.v.length + 2) : t.v;
    let cls = null;
    if (t.t === 'len' || t.t === 'num') cls = 'len';
    else if (t.t === 'str') cls = 'str';
    else if (t.t === 'slash') cls = 'op';
    else if (t.t === 'word') {
      const w = t.v.toLowerCase();
      if (first) cls = KEYWORDS.has(w) ? 'kw' : null;
      else if (inPath && PATH_LETTERS.has(w)) cls = 'op';
      else if (SIDES.has(w)) cls = 'dir';
      else if (CONNECTIVES.has(w)) { cls = 'op'; if (info.kw === 'define' && w === 'path') inPath = true; }
      else if (info.kw === 'fixture' && FIXTURE_TYPES.has(w)) cls = 'fix';
      else if (info.kw === 'define' && SHAPES.has(w)) cls = 'fix';
      else cls = 'id';
    }
    out += cls ? span(cls, raw) : esc(raw);
    pos = t.col + raw.length;
    first = false;
  }
  if (pos < code.length) out += esc(code.slice(pos));
  if (cs >= 0) out += span('cmt', line.slice(cs));
  return out;
}

export function lineClass(info) {
  return 'wr-line t-' + info.type + (info.kw ? ' t-kw-' + info.kw : '');
}
