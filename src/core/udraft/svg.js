/**
 * uDraft SVG renderer — scene (layout.js) → blueprint SVG markup.
 *
 * Pure string building (no DOM) so the same code serves the live preview, the
 * SVG export, the PDF print body, and node:test.
 *
 * Conventions:
 *   • SVG user unit = 1 mm of building (µm / 1000).  Stroke widths and text
 *     sizes are MODEL sizes, chosen so they come out at sane pen weights on a
 *     true-scale print (20 mm model ≈ 0.4 mm paper at 1/4" = 1'-0").
 *   • Walls render as ONE nonzero-winding path over all wall rects — the
 *     union fills once however much the bands and corner squares overlap.
 *   • Opening gaps are rects painted in the paper colour on top of the walls;
 *     door/window symbols draw over the gap.
 *   • Everything strokes/fills via CSS classes (`ud-*`).  In the app the
 *     stylesheet themes them with CSS vars; exports embed exportStyles().
 *   • When `interactive`, entities carry data-doc-from/to (absolute char
 *     offsets of their source line) — the click-to-source map.
 */

import { formatLength, formatArea, parseScale } from './parse.js';

const MM = 1000;                       // µm per svg user unit

// Model-space sizes (mm).
const S = {
  labelText: 280,
  areaText: 200,
  noteText: 190,
  dimText: 200,
  fixText: 170,
  stairText: 180,
  symStroke: 20,                       // door/window/fixture line weight
  thinStroke: 12,                      // dims, extension lines
  tick: 110,                           // dimension tick half-length
  dimExt: 160,                         // extension line overshoot
  margin: 700,                         // viewBox padding beyond content
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const mm = (um) => Math.round(um / MM * 100) / 100;

/** data-doc attrs for click-to-source (only in interactive renders). */
function docAttrs(ent, interactive) {
  if (!interactive || ent.from == null) return '';
  return ` data-doc-from="${ent.from}" data-doc-to="${ent.to}"`;
}

/**
 * Invisible hit target (interactive renders only).  Thin strokes are hopeless
 * tap targets, so every entity group gets one of these covering its footprint
 * (padded a little); transparent fill still counts as "painted" for SVG
 * pointer-events, and the group's data-doc-from does the rest.
 */
function hitRect(x, y, w, h, interactive, pad = 60 * MM) {
  if (!interactive) return '';
  return `<rect class="ud-hit" x="${mm(x - pad)}" y="${mm(y - pad)}"`
    + ` width="${mm(w + 2 * pad)}" height="${mm(h + 2 * pad)}" fill="transparent"/>`;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function wallsPath(wallRects) {
  if (!wallRects.length) return '';
  const d = wallRects.map(r =>
    `M${mm(r.x)} ${mm(r.y)}h${mm(r.w)}v${mm(r.h)}h${-mm(r.w)}Z`).join('');
  return `<path class="ud-walls" fill-rule="nonzero" d="${d}"/>`;
}

function openingMarkup(o, interactive) {
  const [b0, b1] = o.band;
  const vertical = o.axis === 'v';                      // wall runs north–south
  // Gap rect (paper colour) punches the wall; a hair of overhang across the
  // band avoids antialias slivers along the band edges.
  const oh = 5;
  const gap = vertical
    ? `<rect class="ud-gap" x="${mm(b0 - oh)}" y="${mm(o.lo)}" width="${mm(b1 - b0 + 2 * oh)}" height="${mm(o.hi - o.lo)}"/>`
    : `<rect class="ud-gap" x="${mm(o.lo)}" y="${mm(b0 - oh)}" width="${mm(o.hi - o.lo)}" height="${mm(b1 - b0 + 2 * oh)}"/>`;

  const jamb = (u) => vertical
    ? line(b0, u, b1, u, 'ud-sym')
    : line(u, b0, u, b1, 'ud-sym');

  let body = '';
  if (o.kind === 'window') {
    // Triple line: frame along both faces + glazing line down the middle.
    const midB = (b0 + b1) / 2;
    body = jamb(o.lo) + jamb(o.hi)
      + (vertical
        ? line(b0, o.lo, b0, o.hi, 'ud-sym') + line(midB, o.lo, midB, o.hi, 'ud-sym') + line(b1, o.lo, b1, o.hi, 'ud-sym')
        : line(o.lo, b0, o.hi, b0, 'ud-sym') + line(o.lo, midB, o.hi, midB, 'ud-sym') + line(o.lo, b1, o.hi, b1, 'ud-sym'));
  } else if (o.kind === 'opening') {
    // Cased opening: jambs + a dashed header line across the gap.
    const midB = (b0 + b1) / 2;
    body = jamb(o.lo) + jamb(o.hi)
      + (vertical
        ? line(midB, o.lo, midB, o.hi, 'ud-sym ud-dash')
        : line(o.lo, midB, o.hi, midB, 'ud-sym ud-dash'));
  } else {
    // Door: leaf + quarter-circle swing arc from the hinge jamb.
    body = jamb(o.lo) + jamb(o.hi) + doorSwing(o);
  }
  // Hit target: the gap band (doors additionally get their swing quadrant).
  let hit;
  if (o.kind === 'door') {
    const w = o.hi - o.lo;
    const x0 = vertical ? (o.openDir === 'w' ? b0 - w : b0) : o.lo;
    const y0 = vertical ? o.lo : (o.openDir === 'n' ? b0 - w : b0);
    hit = hitRect(x0, y0, vertical ? (b1 - b0) + w : w, vertical ? w : (b1 - b0) + w, interactive);
  } else {
    hit = vertical
      ? hitRect(b0, o.lo, b1 - b0, o.hi - o.lo, interactive)
      : hitRect(o.lo, b0, o.hi - o.lo, b1 - b0, interactive);
  }
  return `<g class="ud-ent ud-${o.kind}" data-ent="${o.kind}"${docAttrs(o, interactive)}>${gap}${body}${hit}</g>`;
}

function doorSwing(o) {
  const [b0, b1] = o.band;
  const w = o.hi - o.lo;
  const vertical = o.axis === 'v';
  const hingeU = o.hingeEnd === 'lo' ? o.lo : o.hi;
  const strikeU = o.hingeEnd === 'lo' ? o.hi : o.lo;
  // The leaf pivots at the hinge jamb on the wall face it opens toward, drawn
  // open 90° (perpendicular to the wall); the arc runs leaf tip → strike jamb.
  const face = o.openDir === 'w' || o.openDir === 'n' ? b0 : b1;
  let H, L, Sk;                                          // hinge, leaf end, strike
  if (vertical) {
    H = [face, hingeU];
    L = [face + (o.openDir === 'w' ? -w : w), hingeU];
    Sk = [face, strikeU];
  } else {
    H = [hingeU, face];
    L = [hingeU, face + (o.openDir === 'n' ? -w : w)];
    Sk = [strikeU, face];
  }
  const cross = (L[0] - H[0]) * (Sk[1] - H[1]) - (L[1] - H[1]) * (Sk[0] - H[0]);
  const sweep = cross > 0 ? 1 : 0;
  return line(H[0], H[1], L[0], L[1], 'ud-sym')
    + `<path class="ud-sym ud-arc" d="M${mm(L[0])} ${mm(L[1])}A${mm(w)} ${mm(w)} 0 0 ${sweep} ${mm(Sk[0])} ${mm(Sk[1])}"/>`;
}

function line(x0, y0, x1, y1, cls, swAttr = '') {
  return `<line class="${cls}" x1="${mm(x0)}" y1="${mm(y0)}" x2="${mm(x1)}" y2="${mm(y1)}"${swAttr}/>`;
}

function text(x, y, str, cls, extra = '') {
  return `<text class="${cls}" x="${mm(x)}" y="${mm(y)}"${extra}>${esc(str)}</text>`;
}

function stairsMarkup(st, interactive) {
  const { x, y, w, h } = st.rect;
  const out = [`<rect class="ud-sym" fill="none" x="${mm(x)}" y="${mm(y)}" width="${mm(w)}" height="${mm(h)}"/>`];
  const TREAD = 280 * MM;
  if (st.runAxis === 'v') {
    for (let ty = y + TREAD; ty < y + h; ty += TREAD) out.push(line(x, ty, x + w, ty, 'ud-sym'));
    const cx = x + w / 2;
    out.push(line(cx, y + h - 150 * MM, cx, y + 150 * MM, 'ud-thin'));
    out.push(arrowHead(cx, y + 150 * MM, 'n'));
    out.push(text(cx, y + h - 120 * MM, st.dir === 'up' ? 'UP' : 'DN', 'ud-txt ud-stair-txt', ' text-anchor="middle"'));
  } else {
    for (let tx = x + TREAD; tx < x + w; tx += TREAD) out.push(line(tx, y, tx, y + h, 'ud-sym'));
    const cy = y + h / 2;
    out.push(line(x + 150 * MM, cy, x + w - 150 * MM, cy, 'ud-thin'));
    out.push(arrowHead(x + w - 150 * MM, cy, 'e'));
    out.push(text(x + 120 * MM, cy + S.stairText * MM / 3, st.dir === 'up' ? 'UP' : 'DN', 'ud-txt ud-stair-txt'));
  }
  out.push(hitRect(x, y, w, h, interactive, 0));
  return `<g class="ud-ent ud-stairs" data-ent="stairs"${docAttrs(st, interactive)}>${out.join('')}</g>`;
}

function arrowHead(x, y, dir) {
  const a = 140 * MM;
  const pts = dir === 'n' ? [[x - a / 2, y + a], [x, y], [x + a / 2, y + a]]
    : dir === 's' ? [[x - a / 2, y - a], [x, y], [x + a / 2, y - a]]
    : dir === 'e' ? [[x - a, y - a / 2], [x, y], [x - a, y + a / 2]]
    : [[x + a, y - a / 2], [x, y], [x + a, y + a / 2]];
  return `<polyline class="ud-thin" fill="none" points="${pts.map(p => `${mm(p[0])},${mm(p[1])}`).join(' ')}"/>`;
}

// ── Fixtures — drawn in a local w×d box with the wall along y=0, rotated in ──

/**
 * Unit-box symbol paths: every coordinate is a fraction of the object's
 * w (x, 0 = west edge) × d (y, 0 = back/wall side, 1 = front).  One shape
 * fits any footprint, which is what lets `define … shape <name>` reuse them.
 * A string is an SVG path with unit coordinates; `scalePath` turns it into
 * a model-space `d`.  (Custom `define … path` shapes arrive as parsed
 * command lists in the same unit space — `cmdsPath` handles those.)
 */
const UNIT_SHAPES = {
  // Baby grand, keyboard along the front (y=1): the bass side (x=0) runs
  // straight the full depth, the treble side stops short and bends inward at
  // the waist, and the tail rounds off behind the bass side.
  'grand-piano': [
    'M0 1 L1 1 L1 0.7 C1 0.58 0.8 0.56 0.68 0.5 C0.6 0.45 0.58 0.38 0.58 0.32'
      + ' C0.58 0.14 0.45 0 0.29 0 C0.13 0 0 0.13 0 0.3 Z',
    'M0 0.86 L1 0.86',                                   // fallboard edge
    'M0.05 0.93 L0.95 0.93',                             // key strip
  ],
  // Upright: the case with the keybed stepping forward of it.
  'upright-piano': [
    'M0 0 L1 0 L1 0.6 L0.95 0.6 L0.95 1 L0.05 1 L0.05 0.6 L0 0.6 Z',
    'M0.05 0.6 L0.95 0.6',
    'M0.08 0.8 L0.92 0.8',
  ],
  // Sofa: back rail, two arms, three seat cushions.
  sofa: [
    'M0 0 L1 0 L1 1 L0 1 Z',
    'M0 0.28 L1 0.28',
    'M0.12 0.28 L0.12 1 M0.88 0.28 L0.88 1',
    'M0.373 0.28 L0.373 1 M0.627 0.28 L0.627 1',
  ],
  chair: [
    'M0 0 L1 0 L1 1 L0 1 Z',
    'M0 0.25 L1 0.25',
    'M0.18 0.25 L0.18 1 M0.82 0.25 L0.82 1',
  ],
};

/** A unit-space path string → model-space `d` (numbers scaled by w/d). */
function scalePath(unit, w, d) {
  let axis = 0;                                          // alternates x, y
  return unit.replace(/[A-Za-z]|-?\d*\.?\d+/g, (tok) => {
    if (/[A-Za-z]/.test(tok)) { axis = 0; return tok; }
    const v = parseFloat(tok) * (axis ? d : w);
    axis ^= 1;
    return String(mm(v));
  });
}

/** Parsed unit-space commands ({c, p}) → model-space `d`. */
function cmdsPath(cmds, w, d) {
  return cmds.map(({ c, p }) =>
    c + p.map((v, i) => mm(v * (i % 2 ? d : w))).join(' ')).join(' ');
}

const unitPaths = (paths, w, d) =>
  paths.map(u => `<path class="ud-sym" fill="none" d="${scalePath(u, w, d)}"/>`).join('');

/**
 * @param {string} type  built-in fixture type, or a `define`d id
 * @param {object} [def] the define record ({label, shape, path}) for custom ids
 * @param {boolean} [quiet]  suppress the built-in's own text (REF/DW/…) — a
 *   custom object wearing that shape draws its own label instead
 * @param {number} [angle]  the group's rotation; text counter-rotates about
 *   its centre so a label stays upright (a south-wall fridge's REF would
 *   otherwise read upside down, a west-facing piano's label sideways)
 */
function fixtureLocal(type, w, d, def, quiet = false, angle = 0) {
  const r = (x, y, ww, hh, extra = '') =>
    `<rect class="ud-sym" fill="none" x="${mm(x)}" y="${mm(y)}" width="${mm(ww)}" height="${mm(hh)}"${extra}/>`;
  const c = (x, y, rad) => `<circle class="ud-sym" fill="none" cx="${mm(x)}" cy="${mm(y)}" r="${mm(rad)}"/>`;
  const el = (x, y, rx, ry) => `<ellipse class="ud-sym" fill="none" cx="${mm(x)}" cy="${mm(y)}" rx="${mm(rx)}" ry="${mm(ry)}"/>`;
  const IN = 25400;
  const upright = angle ? ` transform="rotate(${-angle} ${mm(w / 2)} ${mm(d / 2)})"` : '';
  const lbl = (s) => quiet ? ''
    : `<text class="ud-txt ud-fix-txt" x="${mm(w / 2)}" y="${mm(d / 2 + S.fixText * MM / 3)}" text-anchor="middle"${upright}>${s}</text>`;
  if (UNIT_SHAPES[type]) return unitPaths(UNIT_SHAPES[type], w, d);
  switch (type) {
    case 'sink':
      return r(0, 0, w, d) + r(3 * IN, 3 * IN, w - 6 * IN, d - 6 * IN, ` rx="${mm(2 * IN)}"`) + c(w / 2, 2 * IN, 0.8 * IN);
    case 'range':
      return r(0, 0, w, d)
        + c(w * 0.28, d * 0.3, 3.5 * IN) + c(w * 0.72, d * 0.3, 3.5 * IN)
        + c(w * 0.28, d * 0.72, 3.5 * IN) + c(w * 0.72, d * 0.72, 3.5 * IN);
    case 'fridge':
      return r(0, 0, w, d) + line(0, d - 2 * IN, w, d - 2 * IN, 'ud-sym') + lbl('REF');
    case 'dishwasher':
      return r(0, 0, w, d) + lbl('DW');
    case 'toilet':
      return r(w / 2 - 10 * IN, 0, 20 * IN, 8 * IN) + el(w / 2, 8 * IN + (d - 8 * IN) / 2, 7 * IN, (d - 8 * IN) / 2);
    case 'tub':
      return r(0, 0, w, d) + r(2.5 * IN, 2.5 * IN, w - 5 * IN, d - 5 * IN, ` rx="${mm(6 * IN)}"`) + c(6 * IN, d / 2, 1.5 * IN);
    case 'shower':
      return r(0, 0, w, d) + line(0, 0, w, d, 'ud-thin') + c(w / 2, d / 2, 1.5 * IN);
    case 'washer':
      return r(0, 0, w, d) + c(w / 2, d / 2, Math.min(w, d) * 0.3) + lbl('W');
    case 'dryer':
      return r(0, 0, w, d) + c(w / 2, d / 2, Math.min(w, d) * 0.3) + lbl('D');
    case 'water-heater':
      return c(w / 2, d / 2, Math.min(w, d) / 2) + lbl('WH');
    case 'counter':
      return r(0, 0, w, d);
    case 'island':
      // Countertop outline + an inset line suggesting the cabinet under the
      // overhang — reads as an island wherever it stands.
      return r(0, 0, w, d) + r(1.5 * IN, 1.5 * IN, w - 3 * IN, d - 3 * IN);
    case 'bed':
      return r(0, 0, w, d) + line(0, 10 * IN, w, 10 * IN, 'ud-sym');
    case 'table':
      return r(0, 0, w, d, ` rx="${mm(2 * IN)}"`);
    default: {
      // Custom objects (`define`): a `path`/`outline` silhouette, a borrowed
      // built-in symbol (`shape sofa`), `round`, or the default box — with
      // the object's label centered on it.
      let body;
      if (def?.path) body = `<path class="ud-sym" fill="none" d="${cmdsPath(def.path, w, d)}"/>`;
      else if (def?.shape === 'round') body = el(w / 2, d / 2, w / 2, d / 2);
      else if (def?.shape && def.shape !== 'box') body = fixtureLocal(def.shape, w, d, null, !!def.label, angle);
      else body = r(0, 0, w, d, ` rx="${mm(1.5 * IN)}"`);
      return body + (def?.label ? lbl(esc(def.label)) : '');
    }
  }
}

function fixtureMarkup(f, interactive) {
  const { x, y, w: rw, h: rh } = f.rect;
  // Local box (w along the wall × d deep), wall at local y=0; rotate per side.
  const w = (f.side === 'n' || f.side === 's') ? rw : rh;
  const d = (f.side === 'n' || f.side === 's') ? rh : rw;
  let tf, angle;
  if (f.side === 'n') { tf = `translate(${mm(x)} ${mm(y)})`; angle = 0; }
  else if (f.side === 's') { tf = `translate(${mm(x + rw)} ${mm(y + rh)}) rotate(180)`; angle = 180; }
  else if (f.side === 'w') { tf = `translate(${mm(x)} ${mm(y + rh)}) rotate(-90)`; angle = -90; }
  else { tf = `translate(${mm(x + rw)} ${mm(y)}) rotate(90)`; angle = 90; }
  return `<g class="ud-ent ud-fixture" data-ent="fixture" transform="${tf}"${docAttrs(f, interactive)}>`
    + `${fixtureLocal(f.type, w, d, f.def, false, angle)}${hitRect(0, 0, w, d, interactive)}</g>`;
}

function dimMarkup(dim, meta, interactive) {
  const t = formatLength(dim.um, meta.units);
  const out = [];
  const tick = S.tick * MM;
  const ext = S.dimExt * MM;
  if (dim.axis === 'h') {
    const y = dim.pos;
    out.push(line(dim.u0, y, dim.u1, y, 'ud-thin'));
    out.push(line(dim.u0, y - ext, dim.u0, y + ext, 'ud-thin'));
    out.push(line(dim.u1, y - ext, dim.u1, y + ext, 'ud-thin'));
    out.push(line(dim.u0 - tick, y + tick, dim.u0 + tick, y - tick, 'ud-thin'));
    out.push(line(dim.u1 - tick, y + tick, dim.u1 + tick, y - tick, 'ud-thin'));
    out.push(text((dim.u0 + dim.u1) / 2, y - 90 * MM, t, 'ud-txt ud-dim-txt', ' text-anchor="middle"'));
  } else {
    const x = dim.pos;
    out.push(line(x, dim.u0, x, dim.u1, 'ud-thin'));
    out.push(line(x - ext, dim.u0, x + ext, dim.u0, 'ud-thin'));
    out.push(line(x - ext, dim.u1, x + ext, dim.u1, 'ud-thin'));
    out.push(line(x - tick, dim.u0 + tick, x + tick, dim.u0 - tick, 'ud-thin'));
    out.push(line(x - tick, dim.u1 + tick, x + tick, dim.u1 - tick, 'ud-thin'));
    out.push(text(x - 90 * MM, (dim.u0 + dim.u1) / 2, t, 'ud-txt ud-dim-txt',
      ` text-anchor="middle" transform="rotate(-90 ${mm(x - 90 * MM)} ${mm((dim.u0 + dim.u1) / 2)})"`));
  }
  const band = (S.dimText + 180) * MM;                   // line + ticks + text
  out.push(dim.axis === 'h'
    ? hitRect(dim.u0, dim.pos - band, dim.u1 - dim.u0, band + 180 * MM, interactive)
    : hitRect(dim.pos - band, dim.u0, band + 180 * MM, dim.u1 - dim.u0, interactive));
  return `<g class="ud-ent ud-dim" data-ent="dim"${docAttrs(dim, interactive)}>${out.join('')}</g>`;
}

/**
 * The room's interior hit surface.  Rendered EARLY — just above the walls —
 * so every entity inside the room (fixtures, door swings, stairs) paints
 * OVER it and wins the tap; the room only catches clicks on empty interior.
 * (Rendering it late shadowed every object in the room — real bug.)
 */
function roomHitMarkup(room, interactive) {
  if (!interactive) return '';
  const polyD = 'M' + room.poly.map(p => `${mm(p[0])} ${mm(p[1])}`).join('L') + 'Z';
  return `<path class="ud-room-hit" d="${polyD}" fill="transparent" data-ent="room"`
    + ` data-room-id="${esc(room.id)}" data-room="${esc(room.id)}"${docAttrs(room, true)}/>`;
}

/**
 * The room's label block — rendered LAST so it stays readable and tappable
 * over everything.  Tapping it enters the room like the interior does
 * (data-ent="room"); its doc offsets point at the `label` statement when one
 * renamed the room, else at the `room` line (what long-press jumps to).
 */
function roomLabelMarkup(room, meta, interactive, obstacles = []) {
  // Label at the centre of the room's largest decomposed rect (good for L-shapes).
  let best = room.rects[0] || room.bbox;
  for (const r of room.rects) if (r.w * r.h > best.w * best.h) best = r;
  const cx = best.x + best.w / 2;
  let cy = best.y + best.h / 2;
  // Dodge the room's fixtures: a `centered` island or piano sits exactly where
  // the label goes.  If the text block would land on one, re-centre it in the
  // larger clear band above/below the in-the-way rects — but only when a band
  // actually fits the block (a stair-filled hall keeps today's centred label).
  {
    const noteH = room.note ? S.noteText * MM * 1.35 : 0;
    const blockH = S.labelText * MM + S.areaText * MM * 1.35 + noteH + 120 * MM;
    const halfW = Math.max(room.label.length * S.labelText * 0.62, 8 * S.labelText) * MM / 2;
    const inWay = obstacles.filter(o => o.x < cx + halfW && o.x + o.w > cx - halfW);
    if (inWay.some(o => o.y < cy + blockH - S.labelText * MM && o.y + o.h > cy - S.labelText * MM)) {
      const top = Math.min(...inWay.map(o => o.y));
      const bot = Math.max(...inWay.map(o => o.y + o.h));
      const above = top - best.y;
      const below = best.y + best.h - bot;
      const cand = [];
      if (below >= blockH) cand.push({ h: below, cy: bot + (below - blockH) / 2 + S.labelText * MM });
      if (above >= blockH) cand.push({ h: above, cy: best.y + (above - blockH) / 2 + S.labelText * MM });
      if (cand.length) cy = cand.sort((a, b) => b.h - a.h)[0].cy;
    }
  }
  const lines = [
    text(cx, cy, room.label.toUpperCase(), 'ud-txt ud-label', ' text-anchor="middle"'),
    text(cx, cy + S.areaText * MM * 1.35, formatArea(room.areaUm2, meta.units), 'ud-txt ud-area', ' text-anchor="middle"'),
  ];
  let noteH = 0;
  if (room.note) {
    lines.push(text(cx, cy + S.areaText * MM * 1.35 + S.noteText * MM * 1.35, `(${room.note})`, 'ud-txt ud-note', ' text-anchor="middle"'));
    noteH = S.noteText * MM * 1.35;
  }
  const labelW = Math.max(room.label.length * S.labelText * 0.62, 8 * S.labelText) * MM;
  const labelTop = cy - S.labelText * MM;
  const labelH = S.labelText * MM + S.areaText * MM * 1.35 + noteH + 120 * MM;
  const labelHit = hitRect(cx - labelW / 2, labelTop, labelW, labelH, interactive, 0);
  const attrs = docAttrs(room.labelStmt ?? room, interactive);
  return `<g class="ud-ent ud-roomlabel" data-ent="room" data-room-id="${esc(room.id)}"${attrs}>${lines.join('')}${labelHit}</g>`;
}

// ---------------------------------------------------------------------------
// Scope annotations — live dimensions drawn ON the blueprint for the focused
// room or object (the app's drill-down view).  Class `ud-anno` themes them as
// "live" (accent) in the app; exports never pass a scope, so they stay clean.
// ---------------------------------------------------------------------------

/** One annotation dimension: line, ticks, and the measurement text. */
function annoDim(axis, u0, u1, pos, um, meta) {
  if (u1 - u0 <= 0) return '';
  const t = formatLength(um, meta.units);
  const tick = 90 * MM;
  const out = [];
  if (axis === 'h') {
    out.push(line(u0, pos, u1, pos, 'ud-anno-ln'));
    out.push(line(u0 - tick, pos + tick, u0 + tick, pos - tick, 'ud-anno-ln'));
    out.push(line(u1 - tick, pos + tick, u1 + tick, pos - tick, 'ud-anno-ln'));
    out.push(text((u0 + u1) / 2, pos - 80 * MM, t, 'ud-anno-txt', ' text-anchor="middle"'));
  } else {
    out.push(line(pos, u0, pos, u1, 'ud-anno-ln'));
    out.push(line(pos - tick, u0 + tick, pos + tick, u0 - tick, 'ud-anno-ln'));
    out.push(line(pos - tick, u1 + tick, pos + tick, u1 - tick, 'ud-anno-ln'));
    out.push(text(pos - 80 * MM, (u0 + u1) / 2, t, 'ud-anno-txt',
      ` text-anchor="middle" transform="rotate(-90 ${mm(pos - 80 * MM)} ${mm((u0 + u1) / 2)})"`));
  }
  return out.join('');
}

/**
 * Annotations for the current drill-down scope.
 * @param {object} scope  { roomId } (room scope) or { entFrom } (object scope)
 * @returns {string} svg markup (empty when the scope doesn't resolve)
 */
export function annotationMarkup(floor, meta, scope) {
  if (!scope) return '';
  const D = 420 * MM;                                    // offset from what's measured
  if (scope.entFrom == null) {
    const room = floor.rooms.find(r => r.id === scope.roomId);
    if (!room) return '';
    const b = room.bbox;
    // Interior clear dims, written OUTSIDE the walls (the isolation view has
    // the space, and the interior stays uncluttered).
    const out = meta.wallExt + 1400 * MM;
    return `<g class="ud-anno">`
      + annoDim('h', b.x, b.x + b.w, b.y - out, b.w, meta)
      + annoDim('v', b.y, b.y + b.h, b.x - out, b.h, meta)
      + `</g>`;
  }
  const from = scope.entFrom;
  const parts = [];
  const o = floor.openings.find(e => e.from === from);
  if (o) {
    const [b0, b1] = o.band;
    // Annotate on the side away from a door's swing so nothing crosses the arc.
    const away = o.kind === 'door'
      ? (o.openDir === 'w' || o.openDir === 'n' ? 1 : -1)   // opposite the leaf
      : -1;                                                  // lo band side
    const pos = away < 0 ? b0 - D : b1 + D;
    const axis = o.axis === 'v' ? 'v' : 'h';
    parts.push(annoDim(axis, o.lo, o.hi, pos, o.width, meta));
    if (o.offsetFromLo > 0) {
      parts.push(annoDim(axis, o.lo - o.offsetFromLo, o.lo, pos, o.offsetFromLo, meta));
    }
  }
  const f = floor.fixtures.find(e => e.from === from);
  if (f) {
    const r = f.rect;
    // Width along the wall on the room-inward side; depth beside it.
    if (f.side === 'n') {
      parts.push(annoDim('h', r.x, r.x + r.w, r.y + r.h + D, r.w, meta));
      parts.push(annoDim('v', r.y, r.y + r.h, r.x - D, r.h, meta));
    } else if (f.side === 's') {
      parts.push(annoDim('h', r.x, r.x + r.w, r.y - D + 160 * MM, r.w, meta));
      parts.push(annoDim('v', r.y, r.y + r.h, r.x - D, r.h, meta));
    } else if (f.side === 'w') {
      parts.push(annoDim('v', r.y, r.y + r.h, r.x + r.w + D, r.h, meta));
      parts.push(annoDim('h', r.x, r.x + r.w, r.y - D + 160 * MM, r.w, meta));
    } else {
      parts.push(annoDim('v', r.y, r.y + r.h, r.x - D, r.h, meta));
      parts.push(annoDim('h', r.x, r.x + r.w, r.y - D + 160 * MM, r.w, meta));
    }
  }
  const st = floor.stairs.find(e => e.from === from);
  if (st) {
    const r = st.rect;
    if (st.runAxis === 'v') {
      parts.push(annoDim('h', r.x, r.x + r.w, r.y - D + 160 * MM, r.w, meta));
      parts.push(annoDim('v', r.y, r.y + r.h, r.x + r.w + D, r.h, meta));
    } else {
      parts.push(annoDim('v', r.y, r.y + r.h, r.x - D, r.h, meta));
      parts.push(annoDim('h', r.x, r.x + r.w, r.y - D + 160 * MM, r.w, meta));
    }
  }
  return parts.length ? `<g class="ud-anno">${parts.join('')}</g>` : '';
}

/** The µm-space rect a scope's zoom-extents should frame (annotations included). */
export function scopeExtent(floor, scope) {
  if (!scope) return null;
  const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
  if (scope.entFrom == null) {
    const room = floor.rooms.find(r => r.id === scope.roomId);
    return room ? room.bbox : null;
  }
  const from = scope.entFrom;
  const o = floor.openings.find(e => e.from === from);
  if (o) {
    const w = o.hi - o.lo;
    const [b0, b1] = o.band;
    let r = o.axis === 'v'
      ? { x: b0, y: o.lo - o.offsetFromLo, w: b1 - b0, h: (o.hi - o.lo) + o.offsetFromLo }
      : { x: o.lo - o.offsetFromLo, y: b0, w: (o.hi - o.lo) + o.offsetFromLo, h: b1 - b0 };
    if (o.kind === 'door') {                             // include the swing
      if (o.openDir === 'w') { r.x -= w; r.w += w; }
      else if (o.openDir === 'e') r.w += w;
      else if (o.openDir === 'n') { r.y -= w; r.h += w; }
      else r.h += w;
    }
    return pad(r, 500000);
  }
  const f = floor.fixtures.find(e => e.from === from);
  if (f) return pad(f.rect, 500000);
  const st = floor.stairs.find(e => e.from === from);
  if (st) return pad(st.rect, 500000);
  const d = floor.dims.find(e => e.from === from);
  if (d) {
    return d.axis === 'h'
      ? { x: d.u0, y: d.pos - 800000, w: d.u1 - d.u0, h: 1600000 }
      : { x: d.pos - 800000, y: d.u0, w: 1600000, h: d.u1 - d.u0 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Neighbour arrows — the isolation view's wayfinding: one labelled arrow per
// adjoining room, drawn just outside the shared wall (at the connecting
// opening when there is one), tappable to walk into that room.
// ---------------------------------------------------------------------------

function neighborMarkup(floor, roomId, interactive) {
  const nbrs = new Map();                                // id → {side, at, face, via}
  for (const w of floor.walls) {
    if (!w.shared) continue;
    let nbr, side;
    if (w.loSideRoom === roomId) { nbr = w.hiSideRoom; side = w.axis === 'v' ? 'e' : 's'; }
    else if (w.hiSideRoom === roomId) { nbr = w.loSideRoom; side = w.axis === 'v' ? 'w' : 'n'; }
    else continue;
    const op = floor.openings.find(o => o.shared && o.rooms.includes(roomId)
      && o.rooms.includes(nbr) && o.axis === w.axis && o.lo >= w.lo && o.hi <= w.hi);
    const at = op ? (op.lo + op.hi) / 2 : (w.lo + w.hi) / 2;
    const face = (side === 'e' || side === 's') ? w.band[1] : w.band[0];
    if (!nbrs.has(nbr) || op) nbrs.set(nbr, { side, at, face, via: !!op });
  }
  const parts = [];
  const GAP = 180 * MM, LEN = 480 * MM, TXT = 150 * MM;
  for (const [id, n] of nbrs) {
    const nbrRoom = floor.rooms.find(r => r.id === id);
    if (!nbrRoom) continue;
    const name = nbrRoom.label.toUpperCase();
    let body = '';
    if (n.side === 'n') {
      body = line(n.at, n.face - GAP, n.at, n.face - GAP - LEN, 'ud-nbr-ln') + arrowHead(n.at, n.face - GAP - LEN, 'n')
        + text(n.at, n.face - GAP - LEN - TXT, name, 'ud-txt ud-nbr-txt', ' text-anchor="middle"');
    } else if (n.side === 's') {
      body = line(n.at, n.face + GAP, n.at, n.face + GAP + LEN, 'ud-nbr-ln') + arrowHead(n.at, n.face + GAP + LEN, 's')
        + text(n.at, n.face + GAP + LEN + TXT + 140 * MM, name, 'ud-txt ud-nbr-txt', ' text-anchor="middle"');
    } else if (n.side === 'e') {
      body = line(n.face + GAP, n.at, n.face + GAP + LEN, n.at, 'ud-nbr-ln') + arrowHead(n.face + GAP + LEN, n.at, 'e')
        + text(n.face + GAP + LEN + TXT, n.at + 70 * MM, name, 'ud-txt ud-nbr-txt');
    } else {
      body = line(n.face - GAP, n.at, n.face - GAP - LEN, n.at, 'ud-nbr-ln') + arrowHead(n.face - GAP - LEN, n.at, 'w')
        + text(n.face - GAP - LEN - TXT, n.at + 70 * MM, name, 'ud-txt ud-nbr-txt', ' text-anchor="end"');
    }
    // Generous tap target over arrow + name.
    const nameW = Math.max(name.length * 130 * MM, 900 * MM);
    let hx, hy, hw, hh;
    if (n.side === 'n') { hx = n.at - nameW / 2; hy = n.face - GAP - LEN - 2 * TXT - 220 * MM; hw = nameW; hh = LEN + 2 * TXT + GAP + 220 * MM; }
    else if (n.side === 's') { hx = n.at - nameW / 2; hy = n.face; hw = nameW; hh = LEN + 2 * TXT + GAP + 220 * MM; }
    else if (n.side === 'e') { hx = n.face; hy = n.at - 300 * MM; hw = GAP + LEN + TXT + nameW; hh = 600 * MM; }
    else { hx = n.face - GAP - LEN - TXT - nameW; hy = n.at - 300 * MM; hw = GAP + LEN + TXT + nameW; hh = 600 * MM; }
    parts.push(`<g class="ud-ent ud-nbr" data-ent="room" data-room-id="${esc(id)}"${docAttrs(nbrRoom, interactive)}>`
      + body + hitRect(hx, hy, hw, hh, interactive, 0) + `</g>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Floor → SVG
// ---------------------------------------------------------------------------

function floorBounds(floor) {
  let { x, y, w, h } = floor.outerBbox;
  let x1 = x + w, y1 = y + h;
  for (const d of floor.dims) {
    const textPad = (S.dimText + 150) * MM;
    if (d.axis === 'h') {
      x = Math.min(x, d.u0); x1 = Math.max(x1, d.u1);
      y = Math.min(y, d.pos - textPad); y1 = Math.max(y1, d.pos + textPad);
    } else {
      y = Math.min(y, d.u0); y1 = Math.max(y1, d.u1);
      x = Math.min(x, d.pos - textPad); x1 = Math.max(x1, d.pos + textPad);
    }
  }
  const M = S.margin * MM;
  return { x: x - M, y: y - M, w: x1 - x + 2 * M, h: y1 - y + 2 * M };
}

/**
 * Render one floor to SVG markup.
 * @param {object} floor  a floor from layoutDocument()
 * @param {object} meta   scene meta
 * @param {object} opts   { interactive?, styles?, background?, scope?, isolate? }
 *   styles     — a <style> payload embedded in the svg (exports); omit in-app
 *   background — paint an opaque paper rect (exports)
 *   scope      — drill-down scope ({roomId} or {entFrom}); draws live
 *                dimension annotations on top (app preview only)
 *   isolate    — a room id: render ONLY that room (its walls, openings,
 *                fixtures, stairs — no labels, no floor dims) plus labelled
 *                arrows to adjoining rooms (app drill-down view only)
 * @returns {{ svg: string, viewBox: {x,y,w,h}, widthMm: number, heightMm: number }}
 */
export function renderFloorSvg(floor, meta, opts = {}) {
  const interactive = !!opts.interactive;
  const iso = opts.isolate ? floor.rooms.find(r => r.id === opts.isolate) : null;
  const inIso = (rec) => !iso
    || rec.roomId === iso.id || rec.rooms?.includes(iso.id);
  const vb = iso
    ? {
        // The isolation view frames just the room: walls + outside dims +
        // neighbour arrows and their names.
        x: iso.bbox.x - meta.wallExt - 3200 * MM,
        y: iso.bbox.y - meta.wallExt - 3200 * MM,
        w: iso.bbox.w + 2 * (meta.wallExt + 3200 * MM),
        h: iso.bbox.h + 2 * (meta.wallExt + 3200 * MM),
      }
    : floorBounds(floor);
  const parts = [];
  if (opts.styles) parts.push(`<style>${opts.styles}</style>`);
  if (opts.background) {
    parts.push(`<rect class="ud-paper" x="${mm(vb.x)}" y="${mm(vb.y)}" width="${mm(vb.w)}" height="${mm(vb.h)}"/>`);
  }
  parts.push(wallsPath(iso ? floor.wallRects.filter(r => r.rooms?.includes(iso.id)) : floor.wallRects));
  for (const room of floor.rooms) {
    if (!iso || room === iso) parts.push(roomHitMarkup(room, interactive));
  }
  for (const o of floor.openings) { if (inIso(o)) parts.push(openingMarkup(o, interactive)); }
  for (const st of floor.stairs) { if (inIso(st)) parts.push(stairsMarkup(st, interactive)); }
  for (const f of floor.fixtures) { if (inIso(f)) parts.push(fixtureMarkup(f, interactive)); }
  if (!iso) {
    for (const d of floor.dims) parts.push(dimMarkup(d, meta, interactive));
    for (const room of floor.rooms) {
      parts.push(roomLabelMarkup(room, meta, interactive,
        floor.fixtures.filter(f => f.roomId === room.id).map(f => f.rect)));
    }
  } else {
    parts.push(neighborMarkup(floor, iso.id, interactive));
  }
  if (opts.scope) parts.push(annotationMarkup(floor, meta, opts.scope));

  const widthMm = mm(vb.w), heightMm = mm(vb.h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mm(vb.x)} ${mm(vb.y)} ${widthMm} ${heightMm}"`
    + ` class="ud-svg" font-family="ui-monospace, Menlo, Consolas, monospace">${parts.join('')}</svg>`;
  return { svg, viewBox: vb, widthMm, heightMm };
}

// ---------------------------------------------------------------------------
// Export styling (the app themes via its own stylesheet instead)
// ---------------------------------------------------------------------------

/** Concrete-colour styles for standalone exports. */
export function exportStyles(style = 'plain') {
  const blueprint = style === 'blueprint';
  const fg = blueprint ? '#e8f1ff' : '#101014';
  const bg = blueprint ? '#123a6d' : '#ffffff';
  const mut = blueprint ? '#b9cdf0' : '#4a4a52';
  return baseStyles(fg, bg, mut);
}

/**
 * The shared ud-* rules with the three colours injected.  The app stylesheet
 * mirrors these with CSS vars — keep the class list in sync with udraft.css.
 */
export function baseStyles(fg, bg, mut) {
  return [
    `.ud-paper{fill:${bg}}`,
    `.ud-walls{fill:${fg}}`,
    `.ud-gap{fill:${bg}}`,
    `.ud-sym{stroke:${fg};stroke-width:${S.symStroke};fill:none;stroke-linecap:round}`,
    `.ud-thin{stroke:${mut};stroke-width:${S.thinStroke};fill:none}`,
    `.ud-dash{stroke-dasharray:${S.symStroke * 6} ${S.symStroke * 4}}`,
    `.ud-arc{stroke-width:${S.thinStroke}}`,
    `.ud-txt{fill:${fg};stroke:none}`,
    `.ud-label{font-size:${S.labelText}px;font-weight:600;letter-spacing:.08em}`,
    `.ud-area{font-size:${S.areaText}px;fill:${mut}}`,
    `.ud-note{font-size:${S.noteText}px;fill:${mut};font-style:italic}`,
    `.ud-dim-txt{font-size:${S.dimText}px;fill:${mut}}`,
    `.ud-fix-txt{font-size:${S.fixText}px;fill:${mut}}`,
    `.ud-stair-txt{font-size:${S.stairText}px;fill:${mut};font-weight:600}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Standalone exports
// ---------------------------------------------------------------------------

/** One floor as a self-contained SVG document string. */
export function renderExportSvg(scene, floorIndex = 0) {
  const floor = scene.floors[floorIndex];
  const { svg } = renderFloorSvg(floor, scene.meta, {
    interactive: false,
    background: true,
    styles: exportStyles(scene.meta.style),
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + svg;
}

/**
 * Print body for the PDF export: one sheet per floor, each svg sized in real
 * inches so the plan prints AT SCALE (`scale:` front matter, default
 * 1/4" = 1'-0").  The caller wraps this in a print window with
 * `@page { margin: 0 }` and body padding as margins.
 */
export function renderPrintBody(scene, docTitle = '') {
  const { ratio } = parseScale(scene.meta.scale);
  const sheets = scene.floors.map((floor, i) => {
    const { svg, widthMm, heightMm } = renderFloorSvg(floor, scene.meta, {
      interactive: false,
      styles: exportStyles('plain'),                     // print is always ink-on-paper
    });
    const wIn = (widthMm / 25.4) / ratio;
    const hIn = (heightMm / 25.4) / ratio;
    const sized = svg.replace('<svg ', `<svg width="${wIn.toFixed(3)}in" height="${hIn.toFixed(3)}in" `);
    const label = floor.title || (floor.num != null ? `Floor ${floor.num}` : '');
    const sub = [docTitle, label, scaleLabel(scene.meta.scale)].filter(Boolean).join(' — ');
    return `<div class="ud-sheet" style="break-inside:avoid;page-break-inside:avoid;margin-bottom:0.4in">`
      + `${sized}<div style="font:600 10px/1.6 ui-monospace,Menlo,monospace;color:#333">${esc(sub)}</div></div>`;
  });
  return sheets.join('\n');
}

export function scaleLabel(scale) {
  const m = /^1\/(\d+)\s*in$/.exec(String(scale).trim());
  if (m) return `SCALE: 1/${m[1]}" = 1'-0"`;
  const r = /^1:(\d+)$/.exec(String(scale).trim());
  if (r) return `SCALE 1:${r[1]}`;
  return '';
}
