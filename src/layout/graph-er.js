/**
 * Graph model renderer — entity-relationship with inline link declarations.
 *
 * The document content declares entities (nodes) and their fields. Links between
 * entities are declared INSIDE the entities themselves — not in front matter.
 * Directional (→) and bidirectional (—) edges are supported.
 *
 * Syntax
 * ──────
 *   entity EntityName [options]
 *     field: type [constraints]    — field declaration
 *     -> OtherEntity [cardinality] [label]   — directed edge to OtherEntity
 *     -- OtherEntity [label]                 — undirected edge
 *     <- OtherEntity [label]                 — edge from OtherEntity (incoming)
 *
 * Field constraints (space-separated after type):
 *   pk, fk, unique, not-null, index
 *
 * Cardinality:
 *   1:1, 1:N, N:1, N:N, *, ?   (optional shorthand)
 *
 * Entity options: id=name  x=N  y=N  color=#hex
 *
 * Example:
 *   ---
 *   model: graph
 *   ---
 *   entity User
 *     id: int pk
 *     username: string unique not-null
 *     email: string unique
 *     created_at: datetime
 *     -> Post 1:N "writes"
 *     -> Comment 1:N
 *
 *   entity Post
 *     id: int pk
 *     user_id: int fk
 *     title: string not-null
 *     content: text
 *     published_at: datetime
 *     -> Comment 1:N "has"
 *
 *   entity Comment
 *     id: int pk
 *     user_id: int fk
 *     post_id: int fk
 *     body: text not-null
 *
 * The renderer auto-layouts entities unless x/y are specified.
 *
 * Front matter:
 *   direction — LR (left to right) | TB (top to bottom, default)
 *   spacing   — pixels between auto-laid entities (default: 60)
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';

// Layout constants
const CARD_W   = 220;
const CARD_MIN_H = 28; // header
const ROW_H    = 22;
const COLS     = 3;
const GAP_X    = 60;
const GAP_Y    = 60;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderGraph(content, container) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const body = content.slice(bodyFrom).trim();

  container.innerHTML = '';
  container.classList.add('graph-model-mode');

  if (!body) {
    container.innerHTML = `<p class="preview-empty">Declare entities and links using graph syntax.<br>
      <small>entity User<br>  id: int pk<br>  -> Post 1:N</small></p>`;
    return;
  }

  const entities = _parse(body, bodyFrom);

  if (!entities.length) {
    container.innerHTML = '<p class="preview-empty">No entities found. Use: entity Name</p>';
    return;
  }

  // Auto-assign positions for entities without explicit x/y
  let autoIdx = 0;
  for (const e of entities) {
    if (e.x == null) {
      const col = autoIdx % COLS;
      const row = Math.floor(autoIdx / COLS);
      e.x = col * (CARD_W + GAP_X) + 20;
      e.y = row * (CARD_MIN_H + e.fields.length * ROW_H + GAP_Y) + 20;
      autoIdx++;
    }
  }

  // Scene dimensions
  let maxX = 0, maxY = 0;
  for (const e of entities) {
    const h = CARD_MIN_H + e.fields.length * ROW_H;
    maxX = Math.max(maxX, e.x + CARD_W + 20);
    maxY = Math.max(maxY, e.y + h + 20);
  }

  const scene = document.createElement('div');
  scene.className = 'uf-graph-scene';
  scene.style.width  = `${maxX}px`;
  scene.style.minHeight = `${maxY}px`;
  container.appendChild(scene);

  // Entity name → DOM element centre for edge routing
  const nodeMap = new Map();

  // Render entity cards
  for (const entity of entities) {
    const h   = CARD_MIN_H + entity.fields.length * ROW_H;
    const card = document.createElement('div');
    card.className = 'uf-graph-entity';
    card.style.left   = `${entity.x}px`;
    card.style.top    = `${entity.y}px`;
    card.style.width  = `${CARD_W}px`;
    if (entity.color) card.style.borderTopColor = entity.color;
    card.dataset.docFrom = entity.srcFrom;
    scene.appendChild(card);

    // Entity header
    const hdr = document.createElement('div');
    hdr.className = 'uf-graph-entity-hdr';
    hdr.textContent = entity.name;
    card.appendChild(hdr);

    // Fields
    for (const field of entity.fields) {
      const row = document.createElement('div');
      row.className = 'uf-graph-field';

      const name = document.createElement('span');
      name.className = 'uf-graph-field-name';
      name.textContent = field.name;
      row.appendChild(name);

      const type = document.createElement('span');
      type.className = 'uf-graph-field-type';
      type.textContent = field.type;
      row.appendChild(type);

      if (field.constraints.length) {
        const badges = document.createElement('span');
        badges.className = 'uf-graph-field-badges';
        badges.textContent = field.constraints.join(' ');
        row.appendChild(badges);
      }

      card.appendChild(row);
    }

    nodeMap.set(entity.name.toLowerCase(), {
      x: entity.x, y: entity.y, w: CARD_W, h,
      cx: entity.x + CARD_W / 2,
      cy: entity.y + h / 2,
    });
  }

  // Collect all edges from entity link declarations
  const edges = [];
  for (const entity of entities) {
    for (const link of entity.links) {
      edges.push({
        from:    entity.name,
        to:      link.target,
        dir:     link.dir,      // '->' | '--' | '<-'
        label:   link.label,
        card:    link.cardinality,
      });
    }
  }

  if (!edges.length) return;

  // Draw edges as SVG
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.className = 'uf-graph-edges';
  svg.style.cssText = `position:absolute;inset:0;width:${maxX}px;height:${maxY}px;pointer-events:none;overflow:visible`;
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<defs>
    <marker id="uf-g-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--text-muted,#888)"/>
    </marker>
    <marker id="uf-g-dot" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
      <circle cx="3" cy="3" r="2.5" fill="var(--text-muted,#888)"/>
    </marker>
  </defs>`;

  for (const edge of edges) {
    const fNode = nodeMap.get(edge.from.toLowerCase());
    const tNode = nodeMap.get(edge.to.toLowerCase());
    if (!fNode || !tNode) continue;

    const x1 = fNode.x + fNode.w;
    const y1 = fNode.y + fNode.h / 2;
    const x2 = tNode.x;
    const y2 = tNode.y + tNode.h / 2;

    // Prefer right-to-left or top-to-bottom depending on relative position
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    let d;

    if (dx > 10) {
      // Horizontal bezier
      const cx1 = x1 + dx * 0.4;
      const cx2 = x2 - dx * 0.4;
      d = `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;
    } else {
      // Vertical path: exit bottom of source, enter top of target
      const sy1 = fNode.y + fNode.h;
      const sy2 = tNode.y;
      d = `M${fNode.cx},${sy1} C${fNode.cx},${sy1 + 30} ${tNode.cx},${sy2 - 30} ${tNode.cx},${sy2}`;
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--text-muted, #585b70)');
    path.setAttribute('stroke-width', '1.5');
    if (edge.dir === '->' || edge.dir === '<-')
      path.setAttribute('marker-end', 'url(#uf-g-arrow)');
    else
      path.setAttribute('marker-end', 'url(#uf-g-dot)');
    svg.appendChild(path);

    // Cardinality / label
    if (edge.label || edge.card) {
      const lx = (x1 + x2) / 2;
      const ly = (y1 + y2) / 2 - 8;
      const lt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lt.setAttribute('x', lx);
      lt.setAttribute('y', ly);
      lt.setAttribute('text-anchor', 'middle');
      lt.setAttribute('font-size', '10');
      lt.setAttribute('fill', 'var(--text-muted, #585b70)');
      lt.setAttribute('font-family', 'system-ui, sans-serif');
      lt.textContent = [edge.card, edge.label].filter(Boolean).join(' ');
      svg.appendChild(lt);
    }
  }

  scene.insertBefore(svg, scene.firstChild);
}

export function teardownGraph(container) {
  container.classList.remove('graph-model-mode');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function _parse(body, bodyOffset) {
  const lines    = body.split('\n');
  const entities = [];
  let current    = null;
  let lineOffset = bodyOffset;

  for (const line of lines) {
    const raw     = line.trimEnd();
    const trimmed = raw.trimStart();

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      lineOffset += line.length + 1;
      continue;
    }

    const depth = raw.length - trimmed.length;

    if (depth === 0) {
      // Top-level declaration — must be "entity Name [opts]"
      const m = /^entity\s+(\S+)(.*)?$/i.exec(trimmed);
      if (m) {
        const opts = _parseInlineOpts(m[2] ?? '');
        current = {
          name:    m[1],
          fields:  [],
          links:   [],
          x:       opts.x != null ? parseInt(opts.x, 10) : null,
          y:       opts.y != null ? parseInt(opts.y, 10) : null,
          color:   opts.color ?? null,
          srcFrom: lineOffset,
        };
        entities.push(current);
      }
    } else if (current) {
      // Indented: field or link
      if (trimmed.startsWith('->') || trimmed.startsWith('--') || trimmed.startsWith('<-')) {
        const dir  = trimmed.slice(0, 2);
        const rest = trimmed.slice(2).trim();
        const parts = rest.split(/\s+/);
        const target = parts[0] ?? '';
        let card = null, labelParts = [];
        for (let i = 1; i < parts.length; i++) {
          if (/^[1N\*\?]:?[1N\*\?]$/.test(parts[i]) || /^[1N]:?[1N*]$/.test(parts[i])) {
            card = parts[i];
          } else {
            labelParts.push(parts[i].replace(/^["']|["']$/g, ''));
          }
        }
        current.links.push({ target, dir, cardinality: card, label: labelParts.join(' ') || null });
      } else {
        // Field: name: type [constraints...]
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const fname = trimmed.slice(0, colonIdx).trim();
          const rest  = trimmed.slice(colonIdx + 1).trim();
          const parts = rest.split(/\s+/);
          const ftype = parts[0] ?? '';
          const constraints = parts.slice(1).filter(p =>
            ['pk', 'fk', 'unique', 'not-null', 'index', 'null', 'auto'].includes(p.toLowerCase())
          );
          current.fields.push({ name: fname, type: ftype, constraints });
        }
      }
    }

    lineOffset += line.length + 1;
  }

  return entities;
}

function _parseInlineOpts(str) {
  const opts = {};
  for (const part of str.trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) opts[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return opts;
}
