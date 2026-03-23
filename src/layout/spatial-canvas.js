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
  if (perspective > 0) svg.style.perspective = `${perspective}px`;
  if (meta.bg) svg.style.background = meta.bg;
  container.appendChild(svg);

  _renderNodes(nodes, svg, { x: 0, y: 0, w: canvasW, h: canvasH });
}

export function teardownSpatial(container) {
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
