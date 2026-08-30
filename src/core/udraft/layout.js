/**
 * uDraft layout — statements → placed geometry (the "scene").
 *
 * Deterministic single pass: rooms place in declaration order, each anchored
 * to a room already placed (forward references are errors, never solved).
 * Everything is integer µm and axis-aligned (v1 is 90°-only), so wall sharing
 * detection is exact equality — no epsilons.
 *
 * Coordinates are SCREEN-style: x grows east, y grows south, north is -y.
 * Room polygons are wound clockwise-on-screen (positive shoelace), so the
 * interior is to the RIGHT of travel and each edge's outward side is the LEFT
 * of travel.
 *
 * Walls are implicit (see plan §2.3): rooms declare interior-clear dimensions;
 * this pass derives wall entities between/around them:
 *   • two interior faces exactly `wallInt` apart with overlapping intervals →
 *     ONE shared wall entity (the band between the faces);
 *   • the uncovered remainder of every face → exterior wall entities
 *     (band of `wallExt` outward from the face);
 *   • plus a corner square per polygon corner (sized by the band widths that
 *     meet there) so the union of all wall rects is gap-free.  Overlapping
 *     rects are harmless — the renderer fills them as ONE nonzero-winding
 *     path (the same union trick as abc2svg's staff veils).
 *
 * Openings resolve onto wall entities and carry everything the renderer needs
 * (band, interval, swing).  All records keep their statement's line/from/to —
 * that is the click-to-source map.
 */

import { FIXTURES, SIDE_NAMES, formatLength } from './parse.js';

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

const opposite = { n: 's', s: 'n', e: 'w', w: 'e' };

/** Interval [lo,hi] minus a list of [lo,hi] intervals → remaining intervals. */
function subtractIntervals(lo, hi, cuts) {
  let rest = [[lo, hi]];
  for (const [clo, chi] of cuts) {
    const next = [];
    for (const [a, b] of rest) {
      if (chi <= a || clo >= b) { next.push([a, b]); continue; }
      if (clo > a) next.push([a, clo]);
      if (chi < b) next.push([chi, b]);
    }
    rest = next;
  }
  return rest.filter(([a, b]) => b > a);
}

function overlap(a0, a1, b0, b1) {
  const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
  return hi > lo ? [lo, hi] : null;
}

/** Signed shoelace sum (positive = clockwise on screen, our normal form). */
function shoelace(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s;
}

function bboxOf(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Decompose an axis-aligned simple polygon (CW-screen) into horizontal band
 * rects.  Used for interior overlap tests and label placement.
 */
export function polyToRects(poly) {
  const ys = [...new Set(poly.map(p => p[1]))].sort((a, b) => a - b);
  const rects = [];
  for (let bi = 0; bi < ys.length - 1; bi++) {
    const y0 = ys[bi], y1 = ys[bi + 1];
    const mid = y0 + (y1 - y0) / 2;
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      if (ax === bx && Math.min(ay, by) <= mid && mid < Math.max(ay, by)) xs.push(ax);
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      rects.push({ x: xs[i], y: y0, w: xs[i + 1] - xs[i], h: y1 - y0 });
    }
  }
  return rects;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Is `rect` fully inside the room's interior?  Exact for L-shapes: the room's
 * decomposed band rects are disjoint, so summed intersection area equalling
 * the rect's own area means full coverage (all integer µm — no epsilons).
 */
function rectInsideRoom(rect, room) {
  let covered = 0;
  for (const r of room.rects) {
    const w = Math.min(rect.x + rect.w, r.x + r.w) - Math.max(rect.x, r.x);
    const h = Math.min(rect.y + rect.h, r.y + r.h) - Math.max(rect.y, r.y);
    if (w > 0 && h > 0) covered += w * h;
  }
  return covered >= rect.w * rect.h;
}

/** Do two axis-aligned closed polylines (as rect lists) overlap with area? */
function roomsOverlap(a, b) {
  if (!rectsOverlap(a.bbox, b.bbox)) return false;
  for (const ra of a.rects) for (const rb of b.rects) {
    if (rectsOverlap(ra, rb)) return true;
  }
  return false;
}

/** Basic self-intersection test for an axis-aligned polygon (segment pairs). */
function selfIntersects(poly) {
  const n = poly.length;
  const segs = poly.map((p, i) => [p, poly[(i + 1) % n]]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;   // adjacent share a vertex
      const [[ax0, ay0], [ax1, ay1]] = segs[i];
      const [[bx0, by0], [bx1, by1]] = segs[j];
      const aH = ay0 === ay1, bH = by0 === by1;
      if (aH === bH) {
        // Parallel: collinear overlap?
        if (aH && ay0 === by0 && overlap(Math.min(ax0, ax1), Math.max(ax0, ax1), Math.min(bx0, bx1), Math.max(bx0, bx1))) return true;
        if (!aH && ax0 === bx0 && overlap(Math.min(ay0, ay1), Math.max(ay0, ay1), Math.min(by0, by1), Math.max(by0, by1))) return true;
        continue;
      }
      const [h, v] = aH ? [segs[i], segs[j]] : [segs[j], segs[i]];
      const hy = h[0][1], vx = v[0][0];
      const hx0 = Math.min(h[0][0], h[1][0]), hx1 = Math.max(h[0][0], h[1][0]);
      const vy0 = Math.min(v[0][1], v[1][1]), vy1 = Math.max(v[0][1], v[1][1]);
      if (hx0 < vx && vx < hx1 && vy0 < hy && hy < vy1) return true;
    }
  }
  return false;
}

/** Default display label from a room id: 'living-room' → 'Living Room'. */
export function defaultLabel(id) {
  return id.split(/[-_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// Room construction
// ---------------------------------------------------------------------------

const LEG_DELTA = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** Build a polygon (at origin) from outline legs; throws message on bad walks. */
function outlinePoly(legs) {
  let x = 0, y = 0;
  const pts = [[0, 0]];
  for (const { dir, len } of legs) {
    const [dx, dy] = LEG_DELTA[dir];
    x += dx * len; y += dy * len;
    pts.push([x, y]);
  }
  // close: back to start along the one remaining axis (or already closed).
  if (x !== 0 && y !== 0) throw new Error('outline does not close onto an axis — add a leg before "close"');
  if (x !== 0 || y !== 0) pts.push([0, 0]);
  pts.pop();                                             // drop duplicate start
  // Merge collinear runs (two same-axis legs in a row).
  const poly = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const p = pts[i];
    const straight = (prev[0] === p[0] && p[0] === next[0]) || (prev[1] === p[1] && p[1] === next[1]);
    if (!straight) poly.push(p);
  }
  if (poly.length < 4) throw new Error('outline needs at least four corners');
  if (selfIntersects(poly)) throw new Error('outline crosses itself');
  if (shoelace(poly) < 0) poly.reverse();                // normalize CW-on-screen
  return poly;
}

/** Edges of a CW-screen polygon: {dir (outward), face, lo, hi}. */
function polyEdges(poly) {
  const edges = [];
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    if (y0 === y1) {
      // Horizontal travel; outward is left of travel (CW-screen → interior right).
      edges.push({
        dir: x1 > x0 ? 'n' : 's', face: y0,
        lo: Math.min(x0, x1), hi: Math.max(x0, x1),
      });
    } else {
      edges.push({
        dir: y1 > y0 ? 'e' : 'w', face: x0,
        lo: Math.min(y0, y1), hi: Math.max(y0, y1),
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Lay out a parsed document.
 * @param {ReturnType<import('./parse.js').parseDocument>} parsed
 * @returns {{ meta, floors, issues }} the scene (see module docs).
 */
export function layoutDocument(parsed) {
  const { meta } = parsed;
  const issues = [...parsed.issues];
  const defines = parsed.defines ?? new Map();
  const floors = parsed.floors.map(f => layoutFloor(f, meta, issues, defines));
  crossFloorStairsCheck(floors, issues);
  return { meta, floors, issues, defines };
}

/**
 * Stairs must land somewhere: an `up` flight on a numbered floor should have
 * stairs at an overlapping footprint on the next floor up (any direction —
 * a stacked shaft's DN flight, or the arriving UP), and `down` likewise on
 * the next floor below.  Floors share the origin, so "overlapping footprint"
 * is a plain rect intersection.  Warnings, not errors — a single-floor
 * document's `up` to an undrawn storey is fine.
 */
function crossFloorStairsCheck(floors, issues) {
  const byNum = floors.filter(f => f.num != null).sort((a, b) => a.num - b.num);
  if (byNum.length < 2) return;
  for (let i = 0; i < byNum.length; i++) {
    for (const st of byNum[i].stairs) {
      const neighbor = st.dir === 'up' ? byNum[i + 1] : byNum[i - 1];
      if (!neighbor) continue;
      const hit = neighbor.stairs.some(o => rectsOverlap(st.rect, o.rect));
      if (!hit) {
        const name = neighbor.title || `floor ${neighbor.num}`;
        issues.push({ line: st.line, col: 0, from: st.from, to: st.to, severity: 'warning',
          message: `stairs go ${st.dir} but ${name} has no stairs over this spot — flights in one shaft should stack` });
      }
    }
  }
}

function err(issues, stmt, message, severity = 'error') {
  issues.push({ line: stmt.line, col: 0, from: stmt.from, to: stmt.to, severity, message });
}

function layoutFloor(floorStmts, meta, issues, defines = new Map()) {
  const tInt = meta.wallInt;
  const tExt = meta.wallExt;
  const rooms = [];
  const byId = new Map();

  // ── 1. Place rooms ───────────────────────────────────────────────────────
  for (const stmt of floorStmts.statements) {
    if (stmt.kind !== 'room') continue;
    let poly;
    try {
      poly = stmt.outline
        ? outlinePoly(stmt.outline)
        : [[0, 0], [stmt.w, 0], [stmt.w, stmt.h], [0, stmt.h]];
    } catch (e) {
      err(issues, stmt, `room "${stmt.id}": ${e.message}`);
      continue;
    }
    const bb = bboxOf(poly);
    let x, y;
    if (stmt.at) {
      x = stmt.at.x; y = stmt.at.y;
    } else if (stmt.rel) {
      const ref = byId.get(stmt.rel.ref);
      if (!ref) {
        err(issues, stmt, `room "${stmt.id}": "${stmt.rel.ref}" is not declared above this line`
          + (parsed_has(floorStmts, stmt.rel.ref) ? ' (rooms must be declared before they are referenced)' : ''));
        continue;
      }
      const r = ref.bbox;
      const d = stmt.rel.dir;
      const align = stmt.rel.align ?? null;
      const off = stmt.rel.offset ?? 0;
      if ((d === 'e' || d === 'w') && (align === 'e' || align === 'w')) {
        err(issues, stmt, `room "${stmt.id}": "${SIDE_NAMES[d]} of" takes "align north" or "align south"`);
        continue;
      }
      if ((d === 'n' || d === 's') && (align === 'n' || align === 's')) {
        err(issues, stmt, `room "${stmt.id}": "${SIDE_NAMES[d]} of" takes "align east" or "align west"`);
        continue;
      }
      if (d === 'e') { x = r.x + r.w + tInt; y = (align === 's') ? r.y + r.h - bb.h : r.y; y += off; }
      else if (d === 'w') { x = r.x - tInt - bb.w; y = (align === 's') ? r.y + r.h - bb.h : r.y; y += off; }
      else if (d === 's') { y = r.y + r.h + tInt; x = (align === 'e') ? r.x + r.w - bb.w : r.x; x += off; }
      else { y = r.y - tInt - bb.h; x = (align === 'e') ? r.x + r.w - bb.w : r.x; x += off; }
    } else if (!rooms.length) {
      x = 0; y = 0;                                       // first room = origin
    } else {
      err(issues, stmt, `room "${stmt.id}" needs a placement (e.g. "east of ${rooms[rooms.length - 1].id}", or "at 0', 0'")`);
      continue;
    }
    const placed = poly.map(([px, py]) => [px - bb.x + x, py - bb.y + y]);
    const room = {
      id: stmt.id,
      label: defaultLabel(stmt.id),
      labelStmt: null,
      note: null,
      poly: placed,
      bbox: bboxOf(placed),
      rects: polyToRects(placed),
      areaUm2: Math.abs(shoelace(placed)) / 2,
      edges: polyEdges(placed),
      line: stmt.line, from: stmt.from, to: stmt.to,
    };
    for (const other of rooms) {
      if (roomsOverlap(room, other)) {
        err(issues, stmt, `room "${room.id}" overlaps "${other.id}"`);
      }
    }
    rooms.push(room);
    byId.set(room.id, room);
  }

  // ── 2. Wall graph: pair faces exactly tInt apart ─────────────────────────
  // Faces flattened with a per-face list of shared cuts.
  const faces = [];
  for (const room of rooms) {
    for (const e of room.edges) faces.push({ room, ...e, cuts: [] });
  }
  const walls = [];
  const facesByDir = (d) => faces.filter(f => f.dir === d);

  for (const fe of facesByDir('e')) {
    for (const fw of facesByDir('w')) {
      if (fw.face - fe.face !== tInt) continue;
      const ov = overlap(fe.lo, fe.hi, fw.lo, fw.hi);
      if (!ov) continue;
      fe.cuts.push(ov); fw.cuts.push(ov);
      walls.push({ shared: true, axis: 'v', band: [fe.face, fw.face], lo: ov[0], hi: ov[1],
        loSideRoom: fe.room.id, hiSideRoom: fw.room.id });   // loSide = west of band
    }
  }
  for (const fs of facesByDir('s')) {
    for (const fn of facesByDir('n')) {
      if (fn.face - fs.face !== tInt) continue;
      const ov = overlap(fs.lo, fs.hi, fn.lo, fn.hi);
      if (!ov) continue;
      fs.cuts.push(ov); fn.cuts.push(ov);
      walls.push({ shared: true, axis: 'h', band: [fs.face, fn.face], lo: ov[0], hi: ov[1],
        loSideRoom: fs.room.id, hiSideRoom: fn.room.id });   // loSide = north of band
    }
  }
  // Too-close warning: facing rooms with a gap that an exterior band would
  // overpaint (0 ≤ gap < tExt, and not the exact shared distance).
  for (const fe of facesByDir('e')) {
    for (const fw of facesByDir('w')) {
      const gap = fw.face - fe.face;
      if (gap >= 0 && gap < tExt && gap !== tInt && overlap(fe.lo, fe.hi, fw.lo, fw.hi)) {
        issues.push({ line: fe.room.line, col: 0, from: fe.room.from, to: fe.room.to, severity: 'warning',
          message: `rooms "${fe.room.id}" and "${fw.room.id}" are ${formatLength(gap, 'imperial')} apart — a shared wall needs exactly the interior thickness` });
      }
    }
  }
  for (const fs of facesByDir('s')) {
    for (const fn of facesByDir('n')) {
      const gap = fn.face - fs.face;
      if (gap >= 0 && gap < tExt && gap !== tInt && overlap(fs.lo, fs.hi, fn.lo, fn.hi)) {
        issues.push({ line: fs.room.line, col: 0, from: fs.room.from, to: fs.room.to, severity: 'warning',
          message: `rooms "${fs.room.id}" and "${fn.room.id}" are ${formatLength(gap, 'imperial')} apart — a shared wall needs exactly the interior thickness` });
      }
    }
  }

  // Exterior walls: the uncovered remainder of every face, band tExt OUTWARD.
  for (const f of faces) {
    for (const [lo, hi] of subtractIntervals(f.lo, f.hi, f.cuts)) {
      const w = { shared: false, axis: (f.dir === 'e' || f.dir === 'w') ? 'v' : 'h',
        lo, hi, roomId: f.room.id, side: f.dir };
      if (f.dir === 'e') w.band = [f.face, f.face + tExt];
      else if (f.dir === 'w') w.band = [f.face - tExt, f.face];
      else if (f.dir === 's') w.band = [f.face, f.face + tExt];
      else w.band = [f.face - tExt, f.face];
      walls.push(w);
    }
  }

  // ── 3. Wall rects (bands + corner squares) for the union path ────────────
  // Each rect carries the room(s) it belongs to so the isolation view can
  // render just one room's walls.
  const wallRects = walls.map(w => ({
    ...(w.axis === 'v'
      ? { x: w.band[0], y: w.lo, w: w.band[1] - w.band[0], h: w.hi - w.lo }
      : { x: w.lo, y: w.band[0], w: w.hi - w.lo, h: w.band[1] - w.band[0] }),
    rooms: w.shared ? [w.loSideRoom, w.hiSideRoom] : [w.roomId],
  }));

  // Band width covering face f at along-axis position u (clamped just inside).
  const widthAt = (f, u) => {
    const p = Math.min(Math.max(u, f.lo), f.hi - 1);
    for (const [clo, chi] of f.cuts) if (clo <= p && p < chi) return tInt;
    return tExt;
  };
  for (const room of rooms) {
    const n = room.poly.length;
    for (let i = 0; i < n; i++) {
      const [cx, cy] = room.poly[i];
      const eIn = room.edges[(i - 1 + n) % n];            // edge ending at corner i
      const eOut = room.edges[i];                          // edge starting at corner i
      const fIn = faces.find(f => f.room === room && f.dir === eIn.dir && f.face === eIn.face && f.lo === eIn.lo && f.hi === eIn.hi);
      const fOut = faces.find(f => f.room === room && f.dir === eOut.dir && f.face === eOut.face && f.lo === eOut.lo && f.hi === eOut.hi);
      const horiz = (e, f) => (e.dir === 'n' || e.dir === 's') ? { dir: e.dir, w: widthAt(f, cx) } : null;
      const vert = (e, f) => (e.dir === 'e' || e.dir === 'w') ? { dir: e.dir, w: widthAt(f, cy) } : null;
      const h = horiz(eIn, fIn) || horiz(eOut, fOut);
      const v = vert(eIn, fIn) || vert(eOut, fOut);
      if (!h || !v) continue;
      const x = v.dir === 'e' ? cx : cx - v.w;
      const y = h.dir === 's' ? cy : cy - h.w;
      wallRects.push({ x, y, w: v.w, h: h.w, rooms: [room.id] });
    }
  }

  // ── 4. Openings ──────────────────────────────────────────────────────────
  const openings = [];
  for (const stmt of floorStmts.statements) {
    if (stmt.kind !== 'door' && stmt.kind !== 'window' && stmt.kind !== 'opening') continue;
    const o = resolveOpening(stmt, { rooms, byId, walls, faces, issues, meta });
    if (o) openings.push(o);
  }

  // ── 5. Stairs / fixtures / labels / notes / dims ─────────────────────────
  const stairs = [];
  const fixtures = [];
  const dims = [];
  for (const stmt of floorStmts.statements) {
    const room = stmt.room ? byId.get(stmt.room) : null;
    if (stmt.room && !room) {
      if (stmt.kind !== 'door' && stmt.kind !== 'window' && stmt.kind !== 'opening') {
        err(issues, stmt, `${stmt.kind}: room "${stmt.room}" is not declared above this line`);
      }
      continue;
    }
    switch (stmt.kind) {
      case 'stairs': {
        const bb = room.bbox;
        const along = stmt.along ?? 'w';
        const vertical = along === 'e' || along === 'w';
        const rw = vertical ? stmt.w : stmt.h;
        const rh = vertical ? stmt.h : stmt.w;
        if (rw > bb.w || rh > bb.h) { err(issues, stmt, `stairs do not fit inside "${room.id}"`); break; }
        const x = along === 'e' ? bb.x + bb.w - rw : along === 'w' ? bb.x : bb.x + (bb.w - rw) / 2;
        const y = along === 's' ? bb.y + bb.h - rh : along === 'n' ? bb.y : bb.y + (bb.h - rh) / 2;
        stairs.push({ rect: { x: Math.round(x), y: Math.round(y), w: rw, h: rh },
          runAxis: vertical ? 'v' : 'h', dir: stmt.dir, roomId: room.id,
          width: stmt.w, run: stmt.h,
          line: stmt.line, from: stmt.from, to: stmt.to });
        break;
      }
      case 'fixture': {
        const def = FIXTURES[stmt.type] ? null : defines.get(stmt.type);
        const spec = FIXTURES[stmt.type] ?? def;
        const w = stmt.w ?? spec.w;
        const d = stmt.d ?? spec.d;
        const bb = room.bbox;
        const defRec = def ? { label: def.label ?? defaultLabel(stmt.type) } : null;
        if (stmt.place) {
          // Free-standing: the object's front faces `facing` (default south);
          // its back is the opposite side, which is also the renderer's
          // rotation key (a wall fixture's back sits on its wall).
          const facing = stmt.facing ?? 's';
          const back = opposite[facing];
          const turned = facing === 'e' || facing === 'w';
          const rw = turned ? d : w;
          const rh = turned ? w : d;
          let x, y;
          if (stmt.place === 'centered') { x = bb.x + (bb.w - rw) / 2; y = bb.y + (bb.h - rh) / 2; }
          else { x = bb.x + stmt.place.x; y = bb.y + stmt.place.y; }
          const rect = { x: Math.round(x), y: Math.round(y), w: Math.round(rw), h: Math.round(rh) };
          if (!rectInsideRoom(rect, room)) {
            err(issues, stmt, `${stmt.type} does not fit inside "${room.id}" there`); break;
          }
          fixtures.push({ type: stmt.type, rect, side: back, facing, free: true, def: defRec,
            roomId: room.id, line: stmt.line, from: stmt.from, to: stmt.to });
          break;
        }
        const horiz = stmt.side === 'n' || stmt.side === 's';
        const runLo = horiz ? bb.x : bb.y;
        const runHi = horiz ? bb.x + bb.w : bb.y + bb.h;
        if (w > runHi - runLo || d > (horiz ? bb.h : bb.w)) {
          err(issues, stmt, `${stmt.type} does not fit in "${room.id}"`); break;
        }
        const near = stmt.at != null ? runLo + stmt.at : runLo + (runHi - runLo - w) / 2;
        if (near < runLo || near + w > runHi) { err(issues, stmt, `${stmt.type} lands outside "${room.id}"'s ${SIDE_NAMES[stmt.side]} wall`); break; }
        let rect;
        if (stmt.side === 'n') rect = { x: near, y: bb.y, w, h: d };
        else if (stmt.side === 's') rect = { x: near, y: bb.y + bb.h - d, w, h: d };
        else if (stmt.side === 'w') rect = { x: bb.x, y: near, w: d, h: w };
        else rect = { x: bb.x + bb.w - d, y: near, w: d, h: w };
        rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
        fixtures.push({ type: stmt.type, rect, side: stmt.side, facing: stmt.facing, def: defRec,
          roomId: room.id, line: stmt.line, from: stmt.from, to: stmt.to });
        break;
      }
      case 'label':
        room.label = stmt.text;
        room.labelStmt = { line: stmt.line, from: stmt.from, to: stmt.to };
        break;
      case 'note':
        room.note = stmt.text;
        break;
      case 'dim': {
        const bb = room.bbox;
        const off = tExt + 500000;                        // 0.5 m past the wall band
        if (stmt.side === 'n' || stmt.side === 's') {
          dims.push({ axis: 'h', u0: bb.x, u1: bb.x + bb.w,
            pos: stmt.side === 'n' ? bb.y - off : bb.y + bb.h + off,
            um: bb.w, line: stmt.line, from: stmt.from, to: stmt.to });
        } else {
          dims.push({ axis: 'v', u0: bb.y, u1: bb.y + bb.h,
            pos: stmt.side === 'w' ? bb.x - off : bb.x + bb.w + off,
            um: bb.h, line: stmt.line, from: stmt.from, to: stmt.to });
        }
        break;
      }
      default: break;
    }
  }

  // ── 6. Outer bbox + auto dimension strings ───────────────────────────────
  let outer = null;
  for (const r of wallRects) {
    if (!outer) outer = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
    else {
      outer.x0 = Math.min(outer.x0, r.x); outer.y0 = Math.min(outer.y0, r.y);
      outer.x1 = Math.max(outer.x1, r.x + r.w); outer.y1 = Math.max(outer.y1, r.y + r.h);
    }
  }
  const outerBbox = outer
    ? { x: outer.x0, y: outer.y0, w: outer.x1 - outer.x0, h: outer.y1 - outer.y0 }
    : { x: 0, y: 0, w: 0, h: 0 };

  if (meta.dims === 'auto' && rooms.length) {
    const off = 900000;                                   // 0.9 m out from the walls
    dims.push({ axis: 'h', u0: outerBbox.x, u1: outerBbox.x + outerBbox.w,
      pos: outerBbox.y + outerBbox.h + off, um: outerBbox.w, auto: true });
    dims.push({ axis: 'v', u0: outerBbox.y, u1: outerBbox.y + outerBbox.h,
      pos: outerBbox.x + outerBbox.w + off, um: outerBbox.h, auto: true });
  }

  return {
    num: floorStmts.num, title: floorStmts.title,
    line: floorStmts.line,
    rooms, walls, wallRects, openings, stairs, fixtures, dims, outerBbox,
  };
}

// `parsed_has` — is the id declared anywhere in this floor (i.e. a forward ref)?
function parsed_has(floorStmts, id) {
  return floorStmts.statements.some(s => s.kind === 'room' && s.id === id);
}

// ---------------------------------------------------------------------------
// Opening resolution
// ---------------------------------------------------------------------------

function resolveOpening(stmt, ctx) {
  const { byId, walls, issues, meta } = ctx;
  const kindName = stmt.kind;

  let segs = [];        // candidate wall segments (same axis/band)
  let measureLo, measureHi;   // interval the position spec is measured along
  let exteriorSide = null;
  let roomA = null, roomB = null;

  if (stmt.wall.a) {
    roomA = byId.get(stmt.wall.a); roomB = byId.get(stmt.wall.b);
    if (!roomA || !roomB) {
      err(issues, stmt, `${kindName}: room "${!roomA ? stmt.wall.a : stmt.wall.b}" is not declared above this line`);
      return null;
    }
    segs = walls.filter(w => w.shared
      && ((w.loSideRoom === roomA.id && w.hiSideRoom === roomB.id)
        || (w.loSideRoom === roomB.id && w.hiSideRoom === roomA.id)));
    if (!segs.length) {
      err(issues, stmt, `${kindName}: "${roomA.id}" and "${roomB.id}" share no wall`);
      return null;
    }
    segs.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));   // longest first
    measureLo = segs[0].lo; measureHi = segs[0].hi;
    segs = [segs[0]];
  } else {
    roomA = byId.get(stmt.wall.room);
    if (!roomA) {
      err(issues, stmt, `${kindName}: room "${stmt.wall.room}" is not declared above this line`);
      return null;
    }
    exteriorSide = stmt.wall.side;
    segs = walls.filter(w => !w.shared && w.roomId === roomA.id && w.side === exteriorSide);
    if (!segs.length) {
      err(issues, stmt, `${kindName}: "${roomA.id}" has no exterior ${SIDE_NAMES[exteriorSide]} wall`);
      return null;
    }
    // Positions are measured along the room's whole side (bbox interval).
    const bb = roomA.bbox;
    if (exteriorSide === 'n' || exteriorSide === 's') { measureLo = bb.x; measureHi = bb.x + bb.w; }
    else { measureLo = bb.y; measureHi = bb.y + bb.h; }
  }

  // Position → opening interval [lo, lo+width].
  const width = stmt.width;
  let lo;
  if (stmt.pos.type === 'centered') {
    lo = measureLo + (measureHi - measureLo - width) / 2;
  } else {
    const fromHi = stmt.pos.from === 's' || stmt.pos.from === 'e';
    // Validate the `from` side matches the wall axis if given.
    const axis = segs[0].axis;
    if (stmt.pos.from && ((axis === 'v' && (stmt.pos.from === 'e' || stmt.pos.from === 'w'))
      || (axis === 'h' && (stmt.pos.from === 'n' || stmt.pos.from === 's')))) {
      err(issues, stmt, `${kindName}: "from ${SIDE_NAMES[stmt.pos.from]}" does not apply to a ${axis === 'v' ? 'north–south' : 'east–west'} wall`);
      return null;
    }
    lo = fromHi ? measureHi - stmt.pos.dist - width : measureLo + stmt.pos.dist;
  }
  lo = Math.round(lo);
  const hi = lo + width;

  const seg = segs.find(w => lo >= w.lo && hi <= w.hi);
  if (!seg) {
    err(issues, stmt, `${kindName}: does not fit the wall (${formatLength(width, meta.units)} at ${formatLength(lo - measureLo, meta.units)} from the ${segs[0].axis === 'v' ? 'north' : 'west'} end)`);
    return null;
  }

  // Swing (doors only; defaults applied here so the renderer never guesses).
  let into = null, hingeEnd = 'lo';
  if (stmt.kind === 'door') {
    const sw = stmt.swing;
    if (seg.shared) {
      into = roomB.id;
      if (sw) {
        if (sw.into === 'in' || sw.into === 'out') {
          err(issues, stmt, `door: between two rooms, name the room it swings into (swing ${roomA.id} … / swing ${roomB.id} …)`);
          return null;
        }
        if (sw.into !== roomA.id && sw.into !== roomB.id) {
          err(issues, stmt, `door: "${sw.into}" is not on either side of this wall`);
          return null;
        }
        into = sw.into;
      }
    } else {
      into = roomA.id;
      if (sw) {
        if (sw.into === 'out') into = null;
        else if (sw.into !== 'in' && sw.into !== roomA.id) {
          err(issues, stmt, `door: an exterior door swings "in" or "out" (or names ${roomA.id})`);
          return null;
        }
      }
    }
    if (sw) {
      const axis = seg.axis;
      const ok = axis === 'v' ? (sw.hinge === 'n' || sw.hinge === 's') : (sw.hinge === 'e' || sw.hinge === 'w');
      if (!ok) {
        err(issues, stmt, `door: the hinge side of a ${axis === 'v' ? 'north–south' : 'east–west'} wall is ${axis === 'v' ? 'north or south' : 'east or west'}`);
        return null;
      }
      hingeEnd = (sw.hinge === 's' || sw.hinge === 'e') ? 'hi' : 'lo';
    }
  }

  // Which side of the band the leaf opens toward.
  let openDir = null;
  if (stmt.kind === 'door') {
    if (seg.shared) {
      const intoLo = seg.loSideRoom === into;
      openDir = seg.axis === 'v' ? (intoLo ? 'w' : 'e') : (intoLo ? 'n' : 's');
    } else {
      const inward = opposite[seg.side];
      openDir = into ? inward : seg.side;                 // out = away from the room
    }
  }

  return {
    kind: stmt.kind,
    axis: seg.axis, band: seg.band, lo, hi,
    shared: !!seg.shared,
    rooms: seg.shared ? [seg.loSideRoom, seg.hiSideRoom] : [roomA.id],
    wallSide: exteriorSide,                               // exterior openings only
    width, offsetFromLo: lo - measureLo,                  // for the inspector
    into, hingeEnd, openDir,
    line: stmt.line, from: stmt.from, to: stmt.to,
  };
}
