/**
 * uDraft parser — plain text → statements (no geometry yet; layout.js places).
 *
 * The language is strictly ONE STATEMENT PER LINE (that property is what makes
 * line diffs, line comments and click-to-source trivially correct — same as
 * ABC).  Rooms are the spine: each `room` line anchors to a previously
 * declared room by a compass relation; openings punch holes in the walls the
 * layout pass derives.  See plans/udraft-dsl.md for the full design rationale.
 *
 * Everything here is pure string work — no DOM — so it runs under node:test.
 *
 * Units: every length normalizes to INTEGER MICROMETERS (µm).  Integer µm is
 * exact for both families (1" = 25400 µm, 1 mm = 1000 µm; 4.5" = 114300 µm),
 * which is what makes the layout pass's face-distance equality checks (shared
 * wall detection) reliable — no float drift.
 *
 * Lexer landmine (by design): `"` right after a digit is the INCH mark, not a
 * string quote — `12'6"` is a length; label text is the only other
 * double-quote context.  `12'6` (inch mark omitted) parses too.
 */

import { parseGlobalFrontMatter } from '../front-matter.js';

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UM_PER_INCH = 25400;
export const UM_PER_FOOT = 304800;
export const UM_PER_MM = 1000;
export const UM_PER_M = 1000000;

/**
 * Parse one length token to integer µm.
 * Accepted: `12'`, `12'6"`, `12'6`, `6"`, `4.5"`, `3.6m`, `450cm`, `450mm`,
 * bare numbers (feet when units=imperial, meters when metric).
 * @returns {number|null} µm, or null when `str` is not a length.
 */
export function parseLength(str, units = 'imperial') {
  const s = String(str).trim();
  let m;
  if ((m = /^(-?)(\d+(?:\.\d+)?)'(?:\s*(\d+(?:\.\d+)?)"?)?$/.exec(s))) {
    const sign = m[1] === '-' ? -1 : 1;
    return sign * Math.round(parseFloat(m[2]) * UM_PER_FOOT + (m[3] ? parseFloat(m[3]) * UM_PER_INCH : 0));
  }
  if ((m = /^(-?)(\d+(?:\.\d+)?)"$/.exec(s))) {
    return (m[1] === '-' ? -1 : 1) * Math.round(parseFloat(m[2]) * UM_PER_INCH);
  }
  if ((m = /^(-?)(\d+(?:\.\d+)?)(mm|cm|m)$/.exec(s))) {
    const mul = m[3] === 'mm' ? UM_PER_MM : m[3] === 'cm' ? 10 * UM_PER_MM : UM_PER_M;
    return (m[1] === '-' ? -1 : 1) * Math.round(parseFloat(m[2]) * mul);
  }
  if ((m = /^(-?)(\d+(?:\.\d+)?)$/.exec(s))) {
    const mul = units === 'metric' ? UM_PER_M : UM_PER_FOOT;
    return (m[1] === '-' ? -1 : 1) * Math.round(parseFloat(m[2]) * mul);
  }
  return null;
}

/** Format µm for display: `12'-6"` (imperial) or `3.6 m` (metric). */
export function formatLength(um, units = 'imperial') {
  if (units === 'metric') {
    const mm = um / UM_PER_MM;
    if (Math.abs(mm) < 1000) return `${trim(mm)} mm`;
    return `${trim(mm / 1000)} m`;
  }
  const sign = um < 0 ? '-' : '';
  um = Math.abs(um);
  const ft = Math.floor(um / UM_PER_FOOT);
  const inches = (um - ft * UM_PER_FOOT) / UM_PER_INCH;
  const inR = Math.round(inches * 100) / 100;
  if (inR >= 12) return `${sign}${ft + 1}'-0"`;      // rounding carried over
  if (!inR) return `${sign}${ft}'-0"`;
  return `${sign}${ft}'-${trim(inR)}"`;
}

function trim(n) {
  return String(Math.round(n * 100) / 100);
}

/** Area in display units: square feet (imperial) or m² (metric). */
export function formatArea(um2, units = 'imperial') {
  if (units === 'metric') return `${trim(um2 / (UM_PER_M * UM_PER_M))} m²`;
  return `${Math.round(um2 / (UM_PER_FOOT * UM_PER_FOOT))} SF`;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const SIDE = { north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w' };
export const SIDE_NAMES = { n: 'north', s: 'south', e: 'east', w: 'west' };

export const STATEMENT_KEYWORDS = [
  'floor', 'room', 'door', 'window', 'opening', 'stairs', 'fixture',
  'define', 'label', 'note', 'dim',
];

/** v1 fixture symbol library: type → default {w, d} (µm; plan-view width × depth). */
export const FIXTURES = {
  sink:          { w: 30 * UM_PER_INCH, d: 21 * UM_PER_INCH },
  range:         { w: 30 * UM_PER_INCH, d: 26 * UM_PER_INCH },
  fridge:        { w: 36 * UM_PER_INCH, d: 30 * UM_PER_INCH },
  dishwasher:    { w: 24 * UM_PER_INCH, d: 24 * UM_PER_INCH },
  toilet:        { w: 20 * UM_PER_INCH, d: 28 * UM_PER_INCH },
  tub:           { w: 60 * UM_PER_INCH, d: 30 * UM_PER_INCH },
  shower:        { w: 36 * UM_PER_INCH, d: 36 * UM_PER_INCH },
  washer:        { w: 27 * UM_PER_INCH, d: 27 * UM_PER_INCH },
  dryer:         { w: 27 * UM_PER_INCH, d: 27 * UM_PER_INCH },
  'water-heater': { w: 24 * UM_PER_INCH, d: 24 * UM_PER_INCH },
  counter:       { w: 48 * UM_PER_INCH, d: 24 * UM_PER_INCH },
  island:        { w: 78 * UM_PER_INCH, d: 42 * UM_PER_INCH },
  bed:           { w: 60 * UM_PER_INCH, d: 80 * UM_PER_INCH },
  table:         { w: 60 * UM_PER_INCH, d: 36 * UM_PER_INCH },
  // Furniture symbols (drawn from unit-box paths in svg.js, so they scale to
  // any footprint — `define` can borrow them via `shape <name>`).
  'grand-piano':   { w: 60 * UM_PER_INCH, d: 78 * UM_PER_INCH },
  'upright-piano': { w: 58 * UM_PER_INCH, d: 24 * UM_PER_INCH },
  sofa:          { w: 84 * UM_PER_INCH, d: 36 * UM_PER_INCH },
  chair:         { w: 30 * UM_PER_INCH, d: 30 * UM_PER_INCH },
};

/**
 * Names a `define … shape <name>` clause accepts: the two primitives plus
 * every built-in symbol (a custom object can wear any of them at its own size).
 */
export const SHAPE_NAMES = ['box', 'round', ...Object.keys(FIXTURES)];

/** Path commands a `define … path …` clause accepts (absolute; case-insensitive). */
const PATH_CMDS = { m: 2, l: 2, h: 1, v: 1, c: 6, q: 4, z: 0 };

// ---------------------------------------------------------------------------
// Tokenizer (per line)
// ---------------------------------------------------------------------------

// Length must be tried before word/number.  `"` after digits = inch mark.
const T_LENGTH = /^-?\d+(?:\.\d+)?(?:'(?:\d+(?:\.\d+)?"?)?|"|mm|cm|m\b)/;
const T_NUMBER = /^-?\d+(?:\.\d+)?/;
const T_WORD = /^[A-Za-z][A-Za-z0-9_-]*/;
const T_STRING = /^"([^"]*)"/;

/**
 * Tokenize one source line.  Commas are soft separators (skipped); `#` starts
 * a comment at line start or when preceded by whitespace.
 * @returns {Array<{t:'len'|'num'|'word'|'str'|'slash', v:string, col:number}>}
 */
export function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = rest[0];
    if (ch === ' ' || ch === '\t' || ch === ',') { i++; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;   // comment
    let m;
    if ((m = T_LENGTH.exec(rest))) { tokens.push({ t: 'len', v: m[0], col: i }); i += m[0].length; continue; }
    if ((m = T_STRING.exec(rest))) { tokens.push({ t: 'str', v: m[1], col: i }); i += m[0].length; continue; }
    if (ch === '/') { tokens.push({ t: 'slash', v: '/', col: i }); i++; continue; }
    if ((m = T_WORD.exec(rest))) { tokens.push({ t: 'word', v: m[0], col: i }); i += m[0].length; continue; }
    if ((m = T_NUMBER.exec(rest))) { tokens.push({ t: 'num', v: m[0], col: i }); i += m[0].length; continue; }
    tokens.push({ t: 'junk', v: ch, col: i }); i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Statement parsing
// ---------------------------------------------------------------------------

/**
 * A tiny cursor over a line's tokens; every statement parser drains one.
 * Errors throw ParseError with the token column for precise squiggles.
 */
class ParseError extends Error {
  constructor(message, col) { super(message); this.col = col; }
}

class Cur {
  constructor(tokens, line) { this.toks = tokens; this.i = 0; this.line = line; }
  peek(k = 0) { return this.toks[this.i + k] || null; }
  next() { return this.toks[this.i++] || null; }
  done() { return this.i >= this.toks.length; }
  /** Next token if it's a word equal (case-insens.) to one of `words`; else null. */
  word(...words) {
    const t = this.peek();
    if (t && t.t === 'word' && words.includes(t.v.toLowerCase())) { this.i++; return t.v.toLowerCase(); }
    return null;
  }
  expectWord(desc, ...words) {
    const w = this.word(...words);
    if (w == null) this.fail(`expected ${desc}`);
    return w;
  }
  /** A length (or bare number treated as one). */
  length(units, desc) {
    const t = this.peek();
    if (t && (t.t === 'len' || t.t === 'num')) {
      const um = parseLength(t.v, units);
      if (um == null) this.fail(`bad length "${t.v}"`);
      this.i++;
      return um;
    }
    this.fail(`expected ${desc}`);
  }
  side(desc = 'a side (north/south/east/west)') {
    const t = this.peek();
    if (t && t.t === 'word' && SIDE[t.v.toLowerCase()]) { this.i++; return SIDE[t.v.toLowerCase()]; }
    this.fail(`expected ${desc}`);
  }
  ident(desc = 'a name') {
    const t = this.peek();
    if (t && t.t === 'word' && /^[a-z][a-z0-9_-]*$/i.test(t.v)) { this.i++; return t.v.toLowerCase(); }
    this.fail(`expected ${desc}`);
  }
  string(desc = 'quoted text') {
    const t = this.peek();
    if (t && t.t === 'str') { this.i++; return t.v; }
    this.fail(`expected ${desc}`);
  }
  fail(message) {
    const t = this.peek();
    throw new ParseError(message + (t ? ` (got "${t.v}")` : ''), t ? t.col : this.line.length);
  }
  endOrFail() {
    if (!this.done()) this.fail('unexpected trailing input');
  }
}

/** `<dir> of <room> [align <side>] [offset <len>]` | `at <x> <y>` | nothing. */
function parsePlacement(cur, units) {
  if (cur.word('at')) {
    const x = cur.length(units, 'x coordinate');
    const y = cur.length(units, 'y coordinate');
    return { at: { x, y } };
  }
  const t = cur.peek();
  if (t && t.t === 'word' && SIDE[t.v.toLowerCase()] && cur.peek(1) && cur.peek(1).t === 'word'
      && cur.peek(1).v.toLowerCase() === 'of') {
    const dir = cur.side();
    cur.next();   // 'of'
    const ref = cur.ident('a room name after "of"');
    const rel = { dir, ref };
    while (!cur.done()) {
      if (cur.word('align')) { rel.align = cur.side('a side after "align"'); continue; }
      if (cur.word('offset')) { rel.offset = cur.length(units, 'a length after "offset"'); continue; }
      break;
    }
    return { rel };
  }
  return null;
}

/** `<side> <len> … close` — the legs of an orthogonal walk (rooms and defines). */
function parseOutlineLegs(cur, units) {
  const legs = [];
  for (;;) {
    if (cur.word('close')) break;
    const t = cur.peek();
    if (t && t.t === 'word' && SIDE[t.v.toLowerCase()]) {
      const dir = cur.side();
      const len = cur.length(units, `a length after "${SIDE_NAMES[dir]}"`);
      if (len <= 0) cur.fail('outline legs must be positive lengths');
      legs.push({ dir, len });
      continue;
    }
    cur.fail('expected an outline leg (e.g. "E 8\'") or "close"');
  }
  if (legs.length < 2) cur.fail('an outline needs at least two legs');
  return legs;
}

const LEG_DELTA = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/**
 * A define's outline walk → its bounding box (w, d) and a closed polygon path
 * in unit-box coordinates.  Unlike rooms (layout.js does the wall geometry),
 * an object silhouette is only ever drawn, so it needs no rectangle split —
 * just a closed walk.
 */
function outlineToPath(legs) {
  let x = 0, y = 0;
  const pts = [[0, 0]];
  for (const { dir, len } of legs) {
    const [dx, dy] = LEG_DELTA[dir];
    x += dx * len; y += dy * len;
    pts.push([x, y]);
  }
  if (x !== 0 && y !== 0) return { error: 'outline does not close onto an axis — add a leg before "close"' };
  if (x === 0 && y === 0) pts.pop();                       // walked back onto the start
  if (pts.length < 4) return { error: 'outline needs at least four corners' };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of pts) {
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  const w = x1 - x0, d = y1 - y0;
  if (!w || !d) return { error: 'outline must enclose an area' };
  const cmds = pts.map(([px, py], i) => ({ c: i ? 'L' : 'M', p: [(px - x0) / w, (py - y0) / d] }));
  cmds.push({ c: 'Z', p: [] });
  return { w, d, path: cmds };
}

/**
 * `path M 0 0 L 5' 0 C … Z` — an SVG-style path in the object's own
 * coordinates (lengths from its north-west corner; x east, y south, the
 * FRONT of the object along y = depth).  Commands are absolute and
 * case-insensitive: M L H V C Q Z.  Stored normalized to the w × d box so a
 * `fixture` size override scales the drawing with the footprint.
 */
function parsePathCmds(cur, units, w, d) {
  const cmds = [];
  let cx = 0, cy = 0;
  const nx = (um) => um / w, ny = (um) => um / d;
  while (!cur.done()) {
    const t = cur.peek();
    const c = t.t === 'word' ? t.v.toLowerCase() : null;
    if (c == null || !(c in PATH_CMDS)) cur.fail('expected a path command (M, L, H, V, C, Q or Z)');
    cur.next();
    const argc = PATH_CMDS[c];
    const args = [];
    for (let i = 0; i < argc; i++) args.push(cur.length(units, `${argc} coordinate${argc > 1 ? 's' : ''} after "${c.toUpperCase()}"`));
    switch (c) {
      case 'm': case 'l':
        [cx, cy] = args;
        cmds.push({ c: c.toUpperCase(), p: [nx(cx), ny(cy)] });
        break;
      case 'h':
        cx = args[0];
        cmds.push({ c: 'L', p: [nx(cx), ny(cy)] });
        break;
      case 'v':
        cy = args[0];
        cmds.push({ c: 'L', p: [nx(cx), ny(cy)] });
        break;
      case 'c':
        cx = args[4]; cy = args[5];
        cmds.push({ c: 'C', p: [nx(args[0]), ny(args[1]), nx(args[2]), ny(args[3]), nx(cx), ny(cy)] });
        break;
      case 'q':
        cx = args[2]; cy = args[3];
        cmds.push({ c: 'Q', p: [nx(args[0]), ny(args[1]), nx(cx), ny(cy)] });
        break;
      case 'z':
        cmds.push({ c: 'Z', p: [] });
        break;
    }
  }
  if (!cmds.length || cmds[0].c !== 'M') cur.fail('a path starts with "M <x> <y>"');
  if (cmds.length < 2) cur.fail('a path needs at least one drawing command after "M"');
  return cmds;
}

/** `<id>/<id>` (shared wall) or `<id> <side>` (a room's exterior wall). */
function parseWallRef(cur) {
  const a = cur.ident('a room name');
  if (cur.peek() && cur.peek().t === 'slash') {
    cur.next();
    const b = cur.ident('a room name after "/"');
    return { a, b };
  }
  const side = cur.side('a side (or "/other-room")');
  return { room: a, side };
}

/** `centered` | `at <len> [from <side>]`. */
function parsePosition(cur, units) {
  if (cur.word('centered', 'center', 'centred')) return { type: 'centered' };
  if (cur.word('at')) {
    const dist = cur.length(units, 'a distance after "at"');
    let from = null;
    if (cur.word('from')) from = cur.side('a side after "from"');
    return { type: 'at', dist, from };
  }
  cur.fail('expected a position ("centered" or "at <distance>")');
}

const STMT_PARSERS = {
  floor(cur, units) {
    const t = cur.peek();
    let num = null;
    if (t && (t.t === 'num' || (t.t === 'word' && /^\d+$/.test(t.v)))) { num = parseInt(cur.next().v, 10); }
    let title = null;
    if (cur.peek() && cur.peek().t === 'str') title = cur.string();
    cur.endOrFail();
    return { kind: 'floor', num, title };
  },

  room(cur, units) {
    const id = cur.ident('a room name');
    if (cur.word('outline')) {
      const legs = parseOutlineLegs(cur, units);
      const placement = parsePlacement(cur, units);
      cur.endOrFail();
      return { kind: 'room', id, outline: legs, ...placement };
    }
    const w = cur.length(units, 'a width (e.g. 12\')');
    cur.expectWord('"x" between width and depth', 'x');
    const h = cur.length(units, 'a depth after "x"');
    if (w <= 0 || h <= 0) cur.fail('room dimensions must be positive');
    const placement = parsePlacement(cur, units);
    cur.endOrFail();
    return { kind: 'room', id, w, h, ...placement };
  },

  door(cur, units) { return parseOpening(cur, units, 'door'); },
  window(cur, units) { return parseOpening(cur, units, 'window'); },
  opening(cur, units) { return parseOpening(cur, units, 'opening'); },

  stairs(cur, units) {
    const room = cur.ident('a room name');
    const w = cur.length(units, 'a stair width');
    cur.expectWord('"x" between width and length', 'x');
    const h = cur.length(units, 'a stair length after "x"');
    const dir = cur.expectWord('"up" or "down"', 'up', 'down');
    let along = null;
    if (cur.word('along')) along = cur.side('a side after "along"');
    cur.endOrFail();
    return { kind: 'stairs', room, w, h, dir, along };
  },

  fixture(cur, units, ctx) {
    const room = cur.ident('a room name');
    const typeTok = cur.peek();
    const type = cur.ident('a fixture type');
    if (!FIXTURES[type] && !ctx?.defines?.has(type)) {
      const known = [...Object.keys(FIXTURES), ...(ctx?.defines?.keys() ?? [])];
      throw new ParseError(`unknown fixture "${type}" — one of: ${known.join(', ')}`
        + ` (or define it above this line: define ${type} 5' x 4')`,
        typeTok ? typeTok.col : 0);
    }
    let w = null, d = null;
    const t = cur.peek();
    if (t && (t.t === 'len' || t.t === 'num')) {
      w = cur.length(units, 'a width');
      if (cur.word('x')) d = cur.length(units, 'a depth after "x"');
      if (w <= 0 || (d != null && d <= 0)) cur.fail('fixture dimensions must be positive');
    }
    if (cur.word('on')) {
      const side = cur.side('a side after "on"');
      let at = null, facing = null;
      while (!cur.done()) {
        if (cur.word('at')) { at = cur.length(units, 'a distance after "at"'); continue; }
        if (cur.word('facing')) { facing = cur.side('a side after "facing"'); continue; }
        break;
      }
      cur.endOrFail();
      return { kind: 'fixture', room, type, w, d, side, at, facing };
    }
    // Free-standing (an island, a piano …): `centered` in the room, or
    // `at <x>, <y>` from the room's north-west interior corner.  `facing`
    // turns the object — its front faces that side (south when omitted).
    let place = null;
    if (cur.word('centered', 'center', 'centred')) place = 'centered';
    else if (cur.word('at')) {
      const x = cur.length(units, 'an x offset after "at"');
      const y = cur.length(units, 'a y offset');
      place = { x, y };
    } else {
      cur.fail('expected "on <side>", "at <x>, <y>" or "centered"');
    }
    let facing = null;
    if (cur.word('facing')) facing = cur.side('a side after "facing"');
    cur.endOrFail();
    return { kind: 'fixture', room, type, w, d, place, facing };
  },

  define(cur, units) {
    const idTok = cur.peek();
    const id = cur.ident('a name for the object');
    if (FIXTURES[id]) {
      throw new ParseError(`"${id}" is a built-in fixture type — pick another name`,
        idTok ? idTok.col : 0);
    }
    let w, d, path = null, shape = null, label = null;
    if (cur.word('outline')) {
      // Orthogonal silhouette — the room walk grammar (an L-shaped desk, a
      // sectional).  The footprint is the walk's bounding box; the walk
      // becomes the object's path, normalized to that box.
      const legs = parseOutlineLegs(cur, units);
      const o = outlineToPath(legs);
      if (o.error) cur.fail(o.error);
      ({ w, d, path } = o);
    } else {
      w = cur.length(units, `a width (e.g. 5')`);
      cur.expectWord('"x" between width and depth', 'x');
      d = cur.length(units, 'a depth after "x"');
      if (w <= 0 || d <= 0) cur.fail('object dimensions must be positive');
    }
    while (!cur.done()) {
      const t = cur.peek();
      if (t.t === 'str') { label = cur.string(); continue; }
      if (cur.word('shape')) {
        if (path) cur.fail('an outline already gives the object its shape');
        const nameTok = cur.peek();
        const name = cur.ident('a shape name after "shape"');
        if (!SHAPE_NAMES.includes(name)) {
          throw new ParseError(`unknown shape "${name}" — one of: ${SHAPE_NAMES.join(', ')}`,
            nameTok ? nameTok.col : 0);
        }
        shape = name;
        continue;
      }
      if (cur.word('path')) {
        if (path) cur.fail('an outline already gives the object its shape');
        if (shape) cur.fail('"shape" and "path" are alternatives — use one');
        path = parsePathCmds(cur, units, w, d);
        continue;
      }
      cur.fail('expected a "Label", "shape <name>" or "path …"');
    }
    return { kind: 'define', id, w, d, label, shape, path };
  },

  label(cur) {
    const room = cur.ident('a room name');
    const text = cur.string('the label text in quotes');
    cur.endOrFail();
    return { kind: 'label', room, text };
  },

  note(cur) {
    const room = cur.ident('a room name');
    const text = cur.string('the note text in quotes');
    cur.endOrFail();
    return { kind: 'note', room, text };
  },

  dim(cur) {
    const room = cur.ident('a room name');
    const side = cur.side();
    cur.endOrFail();
    return { kind: 'dim', room, side };
  },
};

function parseOpening(cur, units, kind) {
  const wall = parseWallRef(cur);
  const width = cur.length(units, `the ${kind} width`);
  if (width <= 0) cur.fail(`${kind} width must be positive`);
  const pos = parsePosition(cur, units);
  let swing = null;
  if (cur.word('swing')) {
    if (kind !== 'door') cur.fail(`only doors swing`);
    const t = cur.peek();
    if (!t || t.t !== 'word') cur.fail('expected a room (or "in"/"out") after "swing"');
    const into = cur.next().v.toLowerCase();
    const hinge = cur.side('a hinge side after the swing target');
    swing = { into, hinge };
  }
  cur.endOrFail();
  return { kind, wall, width, pos, swing };
}

// ---------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------

const META_DEFAULTS = {
  units: 'imperial',
  dims: 'auto',
  scale: '1/4in',
  style: 'plain',
};

/** Interpret the raw front-matter map into typed uDraft settings. */
export function interpretMeta(rawMeta) {
  const meta = { ...META_DEFAULTS };
  if (rawMeta.units === 'metric' || rawMeta.units === 'imperial') meta.units = rawMeta.units;
  if (rawMeta.dims === 'off' || rawMeta.dims === 'auto') meta.dims = rawMeta.dims;
  if (typeof rawMeta.scale === 'string' && rawMeta.scale) meta.scale = rawMeta.scale;
  if (rawMeta.style === 'blueprint') meta.style = 'blueprint';
  meta.title = typeof rawMeta.title === 'string' ? rawMeta.title : '';
  const walls = (rawMeta.walls && typeof rawMeta.walls === 'object') ? rawMeta.walls : {};
  meta.wallExt = parseLength(walls.exterior ?? '', meta.units) ?? 6 * UM_PER_INCH;
  meta.wallInt = parseLength(walls.interior ?? '', meta.units) ?? Math.round(4.5 * UM_PER_INCH);
  if (meta.wallExt <= 0) meta.wallExt = 6 * UM_PER_INCH;
  if (meta.wallInt <= 0) meta.wallInt = Math.round(4.5 * UM_PER_INCH);
  meta.sheet = (rawMeta.sheet && typeof rawMeta.sheet === 'object') ? rawMeta.sheet : {};
  return meta;
}

/**
 * Print scale: paper mm per model µm multiplier is left to svg.js; here we
 * normalize the `scale:` string to model-feet-per-paper-inch.
 * `1/4in` = 1/4" : 1'-0" → 4 ft/in;  `1:50` → 50/12·… handled as ratio.
 * @returns {{ ratio:number }} model length = paper length × ratio.
 */
export function parseScale(str) {
  let m;
  if ((m = /^1\/(\d+)\s*in$/.exec(String(str).trim()))) {
    return { ratio: parseInt(m[1], 10) * 12 };            // 1/4in → 48
  }
  if ((m = /^1:(\d+)$/.exec(String(str).trim()))) {
    return { ratio: parseInt(m[1], 10) };
  }
  return { ratio: 48 };
}

/**
 * Parse a whole uDraft document (front matter included).
 *
 * @param {string} text  full document text
 * @returns {{
 *   meta: object,
 *   floors: Array<{num:number|null, title:string|null, line:number|null, statements:object[]}>,
 *   issues: Array<{line:number, col:number, from:number, to:number, message:string, severity:string}>,
 *   roomIds: string[],
 *   defines: Map<string, {w:number, d:number, label:string|null, shape:string|null,
 *            path:Array<{c:string, p:number[]}>|null, line:number, from:number, to:number}>,
 * }}
 * Every statement carries { line, from, to } — 0-based line index and absolute
 * char offsets of its source line (the click-to-source map).
 */
export function parseDocument(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const { meta: rawMeta, bodyFrom } = parseGlobalFrontMatter(src);
  const meta = interpretMeta(rawMeta);
  const issues = [];
  const floors = [];
  const roomIds = [];
  // Custom object types (`define`) are DOCUMENT-global — defined once, placed
  // on any floor — but still define-before-use (the map fills in line order,
  // matching the room forward-reference rule).
  const defines = new Map();
  let floor = null;

  const openFloor = (num, title, line) => {
    floor = { num, title, line, statements: [], ids: new Set() };
    floors.push(floor);
  };

  const lines = src.split('\n');
  let offset = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const from = offset;
    const to = offset + line.length;
    offset = to + 1;
    if (from < bodyFrom) continue;                        // front matter
    const tokens = tokenizeLine(line);
    if (!tokens.length) continue;                          // blank / comment

    const head = tokens[0];
    const kw = head.t === 'word' ? head.v.toLowerCase() : null;
    const parser = kw && STMT_PARSERS[kw];
    if (!parser) {
      issues.push({
        line: li, col: head.col, from, to, severity: 'error',
        message: kw
          ? `unknown statement "${kw}" — one of: ${STATEMENT_KEYWORDS.join(', ')}`
          : 'a statement starts with a keyword (room, door, window, …)',
      });
      continue;
    }
    const cur = new Cur(tokens.slice(1), line);
    try {
      const stmt = parser(cur, meta.units, { defines });
      stmt.line = li; stmt.from = from; stmt.to = to;
      if (stmt.kind === 'floor') {
        openFloor(stmt.num, stmt.title, li);
        continue;
      }
      if (stmt.kind === 'define') {
        // Document-level, like `floor` — never opens an implicit floor.
        if (defines.has(stmt.id)) {
          issues.push({ line: li, col: head.col, from, to, severity: 'error',
            message: `object "${stmt.id}" is already defined` });
          continue;
        }
        defines.set(stmt.id, { w: stmt.w, d: stmt.d, label: stmt.label,
          shape: stmt.shape, path: stmt.path, line: li, from, to });
        continue;
      }
      if (!floor) openFloor(null, null, null);             // implicit single floor
      if (stmt.kind === 'room') {
        // Ids are scoped PER FLOOR (each storey can have its own "bath");
        // roomIds stays the deduped global list for editor autocomplete.
        if (floor.ids.has(stmt.id)) {
          issues.push({ line: li, col: head.col, from, to, severity: 'error',
            message: `room "${stmt.id}" is already declared on this floor` });
          continue;
        }
        floor.ids.add(stmt.id);
        if (!roomIds.includes(stmt.id)) roomIds.push(stmt.id);
      }
      floor.statements.push(stmt);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      issues.push({ line: li, col: e.col ?? 0, from, to, severity: 'error',
        message: `${kw}: ${e.message}` });
    }
  }

  if (!floors.length) openFloor(null, null, null);
  return { meta, floors, issues, roomIds, defines };
}
