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
  return `<g class="ud-ent ud-${o.kind}"${docAttrs(o, interactive)}>${gap}${body}</g>`;
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
  return `<g class="ud-ent ud-stairs"${docAttrs(st, interactive)}>${out.join('')}</g>`;
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

function fixtureLocal(type, w, d) {
  const r = (x, y, ww, hh, extra = '') =>
    `<rect class="ud-sym" fill="none" x="${mm(x)}" y="${mm(y)}" width="${mm(ww)}" height="${mm(hh)}"${extra}/>`;
  const c = (x, y, rad) => `<circle class="ud-sym" fill="none" cx="${mm(x)}" cy="${mm(y)}" r="${mm(rad)}"/>`;
  const el = (x, y, rx, ry) => `<ellipse class="ud-sym" fill="none" cx="${mm(x)}" cy="${mm(y)}" rx="${mm(rx)}" ry="${mm(ry)}"/>`;
  const IN = 25400;
  const lbl = (s) => `<text class="ud-txt ud-fix-txt" x="${mm(w / 2)}" y="${mm(d / 2 + S.fixText * MM / 3)}" text-anchor="middle">${s}</text>`;
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
    case 'bed':
      return r(0, 0, w, d) + line(0, 10 * IN, w, 10 * IN, 'ud-sym');
    case 'table':
      return r(0, 0, w, d, ` rx="${mm(2 * IN)}"`);
    default:
      return r(0, 0, w, d);
  }
}

function fixtureMarkup(f, interactive) {
  const { x, y, w: rw, h: rh } = f.rect;
  // Local box (w along the wall × d deep), wall at local y=0; rotate per side.
  const w = (f.side === 'n' || f.side === 's') ? rw : rh;
  const d = (f.side === 'n' || f.side === 's') ? rh : rw;
  let tf;
  if (f.side === 'n') tf = `translate(${mm(x)} ${mm(y)})`;
  else if (f.side === 's') tf = `translate(${mm(x + rw)} ${mm(y + rh)}) rotate(180)`;
  else if (f.side === 'w') tf = `translate(${mm(x)} ${mm(y + rh)}) rotate(-90)`;
  else tf = `translate(${mm(x + rw)} ${mm(y)}) rotate(90)`;
  return `<g class="ud-ent ud-fixture" transform="${tf}"${docAttrs(f, interactive)}>${fixtureLocal(f.type, w, d)}</g>`;
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
  return `<g class="ud-ent ud-dim"${docAttrs(dim, interactive)}>${out.join('')}</g>`;
}

function roomMarkup(room, meta, interactive) {
  // Label at the centre of the room's largest decomposed rect (good for L-shapes).
  let best = room.rects[0] || room.bbox;
  for (const r of room.rects) if (r.w * r.h > best.w * best.h) best = r;
  const cx = best.x + best.w / 2;
  const cy = best.y + best.h / 2;
  const polyD = 'M' + room.poly.map(p => `${mm(p[0])} ${mm(p[1])}`).join('L') + 'Z';
  const hit = interactive
    ? `<path class="ud-room-hit" d="${polyD}" fill="transparent" data-room="${esc(room.id)}"/>`
    : '';
  const lines = [
    text(cx, cy, room.label.toUpperCase(), 'ud-txt ud-label', ' text-anchor="middle"'),
    text(cx, cy + S.areaText * MM * 1.35, formatArea(room.areaUm2, meta.units), 'ud-txt ud-area', ' text-anchor="middle"'),
  ];
  if (room.note) lines.push(text(cx, cy + S.areaText * MM * 1.35 + S.noteText * MM * 1.35, `(${room.note})`, 'ud-txt ud-note', ' text-anchor="middle"'));
  return `<g class="ud-ent ud-room"${docAttrs(room, interactive)}>${hit}${lines.join('')}</g>`;
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
 * @param {object} opts   { interactive?, styles?, background? }
 *   styles     — a <style> payload embedded in the svg (exports); omit in-app
 *   background — paint an opaque paper rect (exports)
 * @returns {{ svg: string, viewBox: {x,y,w,h}, widthMm: number, heightMm: number }}
 */
export function renderFloorSvg(floor, meta, opts = {}) {
  const interactive = !!opts.interactive;
  const vb = floorBounds(floor);
  const parts = [];
  if (opts.styles) parts.push(`<style>${opts.styles}</style>`);
  if (opts.background) {
    parts.push(`<rect class="ud-paper" x="${mm(vb.x)}" y="${mm(vb.y)}" width="${mm(vb.w)}" height="${mm(vb.h)}"/>`);
  }
  parts.push(wallsPath(floor.wallRects));
  for (const o of floor.openings) parts.push(openingMarkup(o, interactive));
  for (const st of floor.stairs) parts.push(stairsMarkup(st, interactive));
  for (const f of floor.fixtures) parts.push(fixtureMarkup(f, interactive));
  for (const room of floor.rooms) parts.push(roomMarkup(room, meta, interactive));
  for (const d of floor.dims) parts.push(dimMarkup(d, meta, interactive));

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
