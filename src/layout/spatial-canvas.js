/**
 * Spatial model renderer — hierarchical x,y,z coordinate space.
 *
 * The document content declares shapes in a global coordinate system.
 * Indentation creates parent-child containment: children use coordinates
 * local to their parent, so scaling/moving the parent moves children too.
 *
 * Syntax (one declaration per line)
 * ──────────────────────────────────
 *   shape [args] [options]
 *
 * Shapes:
 *   rect x y w h              — rectangle at (x,y) size w×h
 *   circle cx cy r            — circle at centre (cx,cy) radius r
 *   ellipse cx cy rx ry       — ellipse
 *   line x1 y1 x2 y2          — line segment
 *   text "content" x y        — text label
 *   image "url" x y w h       — image placeholder
 *   group x y                 — invisible container (for grouping children)
 *
 * Options (key=value after shape args):
 *   id=name           — identifier for click-back and references
 *   label="text"      — display label inside shape
 *   fill=#hex         — fill colour
 *   stroke=#hex       — stroke colour
 *   stroke-width=N    — stroke width
 *   opacity=0..1      — opacity
 *   z=N               — z-index / z depth (for 3D perspective)
 *   rx=N              — border radius (rect)
 *
 * Coordinate values can be:
 *   42          — pixels
 *   50%         — percentage of parent's width or height
 *   center      — shorthand for 50%
 *
 * Indentation (2 spaces per level) declares parent-child containment.
 * Children are clipped to parent by default and use the parent's local
 * coordinate system.
 *
 * Example:
 *   ---
 *   model: spatial
 *   ---
 *   rect 0 0 800 500 id=root fill=#1e1e2e
 *     rect 20 20 360 200 id=panel-a fill=#313244 rx=8 label="Panel A"
 *       circle center center 60 fill=#89b4fa label="Logo"
 *     rect 420 20 360 200 id=panel-b fill=#313244 rx=8 label="Panel B"
 *       text "Hello world" center center fill=#cdd6f4
 *
 * Front matter:
 *   width, height — canvas size (default: 800×600)
 *   bg            — canvas background
 *   perspective   — CSS perspective px (0 = flat, default: 0)
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderSpatial(content, container) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const body = content.slice(bodyFrom).trim();

  container.innerHTML = '';
  container.classList.add('spatial-model-mode');
  container.style.position = 'relative'; // needed for absolute-positioned fit button

  if (!body) {
    container.innerHTML = '<p class="preview-empty">Declare shapes using spatial coordinate syntax.</p>';
    return;
  }

  const canvasW     = parseInt(meta.width  ?? '800', 10);
  const canvasH     = parseInt(meta.height ?? '600', 10);
  const perspective = parseInt(meta.perspective ?? '0', 10);

  const nodes = _parseTree(body, bodyFrom);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.className = 'uf-spatial-svg';
  svg.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);
  svg.setAttribute('width',  '100%');
  svg.setAttribute('height', '100%');
  svg.style.maxWidth = `${canvasW}px`;
  svg.style.cursor = 'grab';
  if (perspective > 0) svg.style.perspective = `${perspective}px`;
  if (meta.bg) svg.style.background = meta.bg;
  container.appendChild(svg);

  _renderNodes(nodes, svg, { x: 0, y: 0, w: canvasW, h: canvasH });

  // Fit-extents button
  const fitBtn = document.createElement('button');
  fitBtn.className = 'uf-spatial-fit-btn';
  fitBtn.title = 'Fit all content (or double-click canvas)';
  fitBtn.textContent = '⊞';
  fitBtn.style.cssText = [
    'position:absolute',
    'top:8px',
    'right:8px',
    'width:28px',
    'height:28px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-size:16px',
    'line-height:1',
    'padding:0',
    'border:1px solid rgba(128,128,128,0.4)',
    'border-radius:4px',
    'background:rgba(30,30,30,0.7)',
    'color:#cdd6f4',
    'cursor:pointer',
    'z-index:10',
    'backdrop-filter:blur(4px)',
  ].join(';');
  container.appendChild(fitBtn);

  // -------------------------------------------------------------------------
  // ViewBox state
  // -------------------------------------------------------------------------
  const _vbInitial = { x: 0, y: 0, w: canvasW, h: canvasH };
  let _vb = { ..._vbInitial };

  function _applyVb() {
    svg.setAttribute('viewBox', `${_vb.x} ${_vb.y} ${_vb.w} ${_vb.h}`);
  }

  function _fitExtents() {
    _vb = { ..._vbInitial };
    _applyVb();
  }

  // -------------------------------------------------------------------------
  // Screen → SVG coordinate conversion
  // -------------------------------------------------------------------------
  function _screenToSvg(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  // -------------------------------------------------------------------------
  // Pan state
  // -------------------------------------------------------------------------
  let _dragging  = false;
  let _dragStart = null; // { clientX, clientY } screen coords at mousedown
  let _vbStart   = null; // viewBox snapshot at mousedown

  function _startDrag(clientX, clientY) {
    _dragging  = true;
    _dragStart = { clientX, clientY };
    _vbStart   = { ..._vb };
    svg.style.cursor = 'grabbing';
  }

  function _applyDrag(clientX, clientY) {
    if (!_dragging) return;
    // Compute delta in screen pixels, then scale to SVG coordinate space
    // using the viewBox dimensions captured at drag start.
    const rect = svg.getBoundingClientRect();
    const scaleX = _vbStart.w / rect.width;
    const scaleY = _vbStart.h / rect.height;
    const screenDx = clientX - _dragStart.clientX;
    const screenDy = clientY - _dragStart.clientY;
    _vb = {
      x: _vbStart.x - screenDx * scaleX,
      y: _vbStart.y - screenDy * scaleY,
      w: _vbStart.w,
      h: _vbStart.h,
    };
    _applyVb();
  }

  function _endDrag() {
    if (!_dragging) return;
    _dragging = false;
    svg.style.cursor = 'grab';
  }

  // -------------------------------------------------------------------------
  // Mouse event handlers
  // -------------------------------------------------------------------------
  function onMouseMove(e) {
    _applyDrag(e.clientX, e.clientY);
  }

  function onMouseUp() {
    _endDrag();
  }

  // -------------------------------------------------------------------------
  // Zoom (wheel)
  // -------------------------------------------------------------------------
  const ZOOM_FACTOR = 1.1;

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    const svgPt = _screenToSvg(e.clientX, e.clientY);

    // Zoom around the cursor position: keep svgPt fixed in the new viewBox
    _vb = {
      x: svgPt.x - (svgPt.x - _vb.x) * factor,
      y: svgPt.y - (svgPt.y - _vb.y) * factor,
      w: _vb.w * factor,
      h: _vb.h * factor,
    };
    _applyVb();
  }

  // -------------------------------------------------------------------------
  // Double-click → fit extents
  // -------------------------------------------------------------------------
  function onDblClick(e) {
    // Only react to background double-clicks (not on a shape)
    if (e.target.closest('[data-doc-from]')) return;
    _fitExtents();
  }

  // -------------------------------------------------------------------------
  // Touch events (pan + pinch-zoom)
  // -------------------------------------------------------------------------
  let _touches = null; // { id0, id1, svgPt0, svgPt1, vbSnap }

  function _touchById(list, id) {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      _startDrag(t.clientX, t.clientY);
      _touches = null;
    } else if (e.touches.length === 2) {
      _dragging = false;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      _touches = {
        id0: t0.identifier,
        id1: t1.identifier,
        svgPt0: _screenToSvg(t0.clientX, t0.clientY),
        svgPt1: _screenToSvg(t1.clientX, t1.clientY),
        vbSnap: { ..._vb },
      };
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && _dragging) {
      const t = e.touches[0];
      _applyDrag(t.clientX, t.clientY);
    } else if (e.touches.length === 2 && _touches) {
      const t0 = _touchById(e.touches, _touches.id0);
      const t1 = _touchById(e.touches, _touches.id1);
      if (!t0 || !t1) return;

      // Initial distance between the two touch points in screen pixels
      const dx0 = _touches.svgPt1.x - _touches.svgPt0.x;
      const dy0 = _touches.svgPt1.y - _touches.svgPt0.y;
      const dist0 = Math.hypot(dx0, dy0) || 1;

      // Current touch midpoint in screen space, then in SVG initial vb space
      const midClientX = (t0.clientX + t1.clientX) / 2;
      const midClientY = (t0.clientY + t1.clientY) / 2;
      const rect = svg.getBoundingClientRect();
      // Map to _touches.vbSnap coordinate space
      const scaleX = _touches.vbSnap.w / rect.width;
      const scaleY = _touches.vbSnap.h / rect.height;
      const midSvgX = _touches.vbSnap.x + (midClientX - rect.left) * scaleX;
      const midSvgY = _touches.vbSnap.y + (midClientY - rect.top)  * scaleY;

      // Initial midpoint
      const initMidX = (_touches.svgPt0.x + _touches.svgPt1.x) / 2;
      const initMidY = (_touches.svgPt0.y + _touches.svgPt1.y) / 2;

      // Current distance in screen pixels
      const curDx = t1.clientX - t0.clientX;
      const curDy = t1.clientY - t0.clientY;
      const distCur = Math.hypot(
        curDx / rect.width  * _touches.vbSnap.w,
        curDy / rect.height * _touches.vbSnap.h,
      ) || 1;
      const scale = dist0 / distCur; // >1 = zoom out, <1 = zoom in

      // Pan: current mid minus initial mid (in vbSnap space)
      const panX = initMidX - midSvgX;
      const panY = initMidY - midSvgY;

      _vb = {
        x: initMidX + (_touches.vbSnap.x - initMidX) * scale + panX,
        y: initMidY + (_touches.vbSnap.y - initMidY) * scale + panY,
        w: _touches.vbSnap.w * scale,
        h: _touches.vbSnap.h * scale,
      };
      _applyVb();
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      _dragging = false;
      _touches  = null;
    } else if (e.touches.length === 1 && _touches) {
      // Dropped one finger — restart single-touch pan from current state
      _touches = null;
      const t = e.touches[0];
      _startDrag(t.clientX, t.clientY);
    }
  }

  // -------------------------------------------------------------------------
  // Mouse down handler
  // -------------------------------------------------------------------------
  function _onMouseDownFull(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    _startDrag(e.clientX, e.clientY);
  }

  // -------------------------------------------------------------------------
  // Register event listeners
  // -------------------------------------------------------------------------
  svg.addEventListener('mousedown',  _onMouseDownFull, { passive: false });
  svg.addEventListener('dblclick',   onDblClick);
  svg.addEventListener('wheel',      onWheel,          { passive: false });
  svg.addEventListener('touchstart', onTouchStart,     { passive: false });
  svg.addEventListener('touchmove',  onTouchMove,      { passive: false });
  svg.addEventListener('touchend',   onTouchEnd,       { passive: false });
  // mousemove / mouseup on window so dragging outside svg still works
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup',   onMouseUp);

  fitBtn.addEventListener('click', _fitExtents);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  container._ufSpatialCleanup = () => {
    svg.removeEventListener('mousedown',  _onMouseDownFull);
    svg.removeEventListener('dblclick',   onDblClick);
    svg.removeEventListener('wheel',      onWheel);
    svg.removeEventListener('touchstart', onTouchStart);
    svg.removeEventListener('touchmove',  onTouchMove);
    svg.removeEventListener('touchend',   onTouchEnd);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup',   onMouseUp);
    fitBtn.removeEventListener('click', _fitExtents);
  };
}

export function teardownSpatial(container) {
  if (typeof container._ufSpatialCleanup === 'function') {
    container._ufSpatialCleanup();
    delete container._ufSpatialCleanup;
  }
  container.classList.remove('spatial-model-mode');
}

// ---------------------------------------------------------------------------
// Tree parsing
// ---------------------------------------------------------------------------

function _parseTree(body, bodyOffset) {
  const lines   = body.split('\n');
  const root    = { children: [], depth: -1 };
  const stack   = [root];
  let lineOffset = bodyOffset;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('//') || trimmed.trimStart().startsWith('#')) {
      lineOffset += line.length + 1;
      continue;
    }

    const depth = _indent(trimmed);
    const text  = trimmed.trimStart();
    const node  = _parseLine(text, lineOffset);
    node.depth  = depth;
    node.children = [];

    // Pop stack until parent depth < this depth
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);

    lineOffset += line.length + 1;
  }

  return root.children;
}

function _indent(line) {
  let n = 0;
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++;
  return n;
}

function _parseLine(text, srcFrom) {
  // Tokenize the line
  const tokens = _tokenizeLine(text);
  if (!tokens.length) return { type: 'unknown', attrs: {}, srcFrom };

  const type = tokens[0].toLowerCase();
  const opts = {};

  // Extract key=value options
  const positional = [];
  for (let i = 1; i < tokens.length; i++) {
    const eq = tokens[i].indexOf('=');
    if (eq > 0) {
      const k = tokens[i].slice(0, eq).toLowerCase();
      const v = tokens[i].slice(eq + 1).replace(/^["']|["']$/g, '');
      opts[k] = v;
    } else {
      positional.push(tokens[i]);
    }
  }

  return { type, positional, opts, srcFrom };
}

function _tokenizeLine(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== q) j++;
      tokens.push(text.slice(i, j + 1)); // keep quotes for identification
      i = j + 1; continue;
    }
    let j = i;
    while (j < text.length && !/\s/.test(text[j])) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

function _renderNodes(nodes, svgParent, parentBox) {
  for (const node of nodes) {
    _renderNode(node, svgParent, parentBox);
  }
}

function _renderNode(node, svgParent, parentBox) {
  const { type, positional: pos = [], opts, srcFrom, children } = node;
  const p = parentBox;

  // Resolve coordinate helper
  const rx = (v) => _resolveCoord(v, p.w, p.x);
  const ry = (v) => _resolveCoord(v, p.h, p.y);
  const rw = (v) => _resolveSize(v, p.w);
  const rh = (v) => _resolveSize(v, p.h);

  const fill        = opts.fill   ?? 'none';
  const stroke      = opts.stroke ?? '#89b4fa';
  const strokeW     = opts['stroke-width'] ?? '1';
  const opacity     = opts.opacity ?? '1';
  const label       = opts.label ? opts.label.replace(/^["']|["']$/g, '') : null;
  const borderRadius = opts.rx ?? '0';

  let childBox = p;
  let el = null;

  switch (type) {
    case 'rect': {
      const x = rx(pos[0] ?? '0');
      const y = ry(pos[1] ?? '0');
      const w = rw(pos[2] ?? '100');
      const h = rh(pos[3] ?? '100');
      el = _svgEl('rect', { x, y, width: w, height: h, fill, stroke,
        'stroke-width': strokeW, opacity, rx: borderRadius });
      childBox = { x, y, w, h };
      break;
    }
    case 'circle': {
      const cx = rx(pos[0] ?? 'center');
      const cy = ry(pos[1] ?? 'center');
      const r  = rw(pos[2] ?? '50');
      el = _svgEl('circle', { cx, cy, r, fill, stroke, 'stroke-width': strokeW, opacity });
      childBox = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
      break;
    }
    case 'ellipse': {
      const cx = rx(pos[0] ?? 'center');
      const cy = ry(pos[1] ?? 'center');
      const rx2 = rw(pos[2] ?? '80');
      const ry2 = rh(pos[3] ?? '50');
      el = _svgEl('ellipse', { cx, cy, rx: rx2, ry: ry2, fill, stroke, 'stroke-width': strokeW, opacity });
      childBox = { x: cx - rx2, y: cy - ry2, w: rx2 * 2, h: ry2 * 2 };
      break;
    }
    case 'line': {
      const x1 = rx(pos[0] ?? '0');
      const y1 = ry(pos[1] ?? '0');
      const x2 = rx(pos[2] ?? '100%');
      const y2 = ry(pos[3] ?? '0');
      el = _svgEl('line', { x1, y1, x2, y2, stroke: fill !== 'none' ? fill : stroke, 'stroke-width': strokeW, opacity });
      break;
    }
    case 'text': {
      const rawText = pos[0]?.replace(/^["']|["']$/g, '') ?? '';
      const x = rx(pos[1] ?? 'center');
      const y = ry(pos[2] ?? 'center');
      el = _svgEl('text', {
        x, y,
        fill: fill !== 'none' ? fill : stroke,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-family': 'system-ui, sans-serif',
        'font-size': opts['font-size'] ?? '14',
        opacity,
      });
      el.textContent = rawText;
      break;
    }
    case 'group': {
      const x = rx(pos[0] ?? '0');
      const y = ry(pos[1] ?? '0');
      el = _svgEl('g', { transform: `translate(${x},${y})`, opacity });
      childBox = { x: 0, y: 0, w: p.w - x + p.x, h: p.h - y + p.y };
      break;
    }
    default:
      return;
  }

  if (srcFrom != null) el.dataset.docFrom = srcFrom;
  if (opts.id) el.id = `uf-sp-${opts.id}`;
  svgParent.appendChild(el);

  // Draw label inside shape
  if (label && type !== 'text') {
    const lx = childBox.x + childBox.w / 2;
    const ly = childBox.y + childBox.h / 2;
    const lel = _svgEl('text', {
      x: lx, y: ly,
      fill: opts['label-fill'] ?? '#cdd6f4',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-family': 'system-ui, sans-serif',
      'font-size': opts['font-size'] ?? '13',
      'pointer-events': 'none',
    });
    lel.textContent = label;
    svgParent.appendChild(lel);
  }

  // Recurse into children using the computed child bounding box
  if (children?.length) {
    _renderNodes(children, svgParent, childBox);
  }
}

function _svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---------------------------------------------------------------------------
// Coordinate resolution
// ---------------------------------------------------------------------------

function _resolveCoord(val, parentSize, parentOrigin) {
  if (val == null) return parentOrigin;
  const s = String(val).trim().toLowerCase();
  if (s === 'center') return parentOrigin + parentSize / 2;
  if (s.endsWith('%'))  return parentOrigin + (parseFloat(s) / 100) * parentSize;
  return parentOrigin + parseFloat(s);
}

function _resolveSize(val, parentSize) {
  if (val == null) return parentSize;
  const s = String(val).trim().toLowerCase();
  if (s === 'center') return parentSize / 2;
  if (s.endsWith('%'))  return (parseFloat(s) / 100) * parentSize;
  return parseFloat(s);
}
