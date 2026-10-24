/**
 * {notes} — the graph LAYOUT (pure, `test/notes.test.mjs`).
 *
 * A small force-directed simulation over the index's graph (`Index.graph()`):
 * every node repels every other (O(n²) — a workspace has hundreds of notes,
 * not millions), every edge is a spring, a weak gravity keeps the picture
 * centred, and velocities are damped as the "alpha" cools, so the layout
 * settles instead of jittering.  Deterministic for a given seed: the same
 * workspace draws the same picture twice.  `ForceSim.tick()` advances one
 * step so the UI (src/ui/notes-graph.js) can animate it on a canvas; `layout()`
 * runs it to rest for tests and static exports.
 */

/** Mulberry32 — a small seeded PRNG. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Node radius from its degree (the drawing uses the same rule). */
export function nodeRadius(node) {
  const base = node.kind === 'tag' ? 3.5 : node.kind === 'missing' ? 3 : 4.5;
  return base + Math.min(10, Math.sqrt(node.degree || 0) * 2);
}

export class ForceSim {
  /**
   * @param {{ nodes: Array<{ id, kind, degree }>, edges: Array<{ source, target }> }} graph
   * @param {object} [opts]
   * @param {number} [opts.width=800]  the picture's nominal extent
   * @param {number} [opts.height=600]
   * @param {number} [opts.seed=7]
   * @param {Map<string, {x:number,y:number}>} [opts.positions]  remembered positions to start from
   * @param {string|null} [opts.center]  a node id pinned to the middle at the start
   */
  constructor(graph, { width = 800, height = 600, seed = 7, positions = null, center = null } = {}) {
    this.width = width; this.height = height;
    this.alpha = 1;
    this.alphaMin = 0.003;
    this.alphaDecay = 0.025;
    this.velocityDecay = 0.55;
    this.linkDistance = 60;
    this.linkStrength = 0.6;
    this.charge = -420;
    this.gravity = 0.045;
    const rand = seededRandom(seed);
    this.nodes = graph.nodes.map((n, i) => {
      const remembered = positions?.get(n.id);
      // Start remembered nodes where they were; new ones on a loose spiral so
      // nothing begins stacked on the same point.
      const ang = i * 2.399963, rad = 20 + 9 * Math.sqrt(i);
      const x = remembered ? remembered.x : width / 2 + Math.cos(ang) * rad + (rand() - 0.5) * 4;
      const y = remembered ? remembered.y : height / 2 + Math.sin(ang) * rad + (rand() - 0.5) * 4;
      return { ...n, x, y, vx: 0, vy: 0, r: nodeRadius(n), fixed: false };
    });
    this.byId = new Map(this.nodes.map(n => [n.id, n]));
    this.edges = graph.edges
      .map(e => ({ ...e, a: this.byId.get(e.source), b: this.byId.get(e.target) }))
      .filter(e => e.a && e.b);
    if (center && this.byId.has(center)) {
      const c = this.byId.get(center);
      if (!positions?.has(center)) { c.x = width / 2; c.y = height / 2; }
    }
    // Reheat only a little when most nodes were remembered: the picture
    // should settle, not reshuffle, on an edit.
    if (positions && this.nodes.length && this.nodes.filter(n => positions.has(n.id)).length / this.nodes.length > 0.7) {
      this.alpha = 0.3;
    }
  }

  get settled() { return this.alpha < this.alphaMin; }

  /** One simulation step; returns false once settled. */
  tick() {
    if (this.alpha < this.alphaMin) return false;
    const nodes = this.nodes, n = nodes.length;
    const alpha = this.alpha;
    // Repulsion (Coulomb-like, softened; capped range to keep far nodes calm)
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 0.5; dy = 0.5; d2 = 0.5; }
        if (d2 > 160000) continue;              // > 400px apart: negligible
        const f = (this.charge * alpha) / d2;
        const fx = dx * f, fy = dy * f;
        if (!a.fixed) { a.vx += fx; a.vy += fy; }
        if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
      }
    }
    // Springs along edges
    for (const e of this.edges) {
      const { a, b } = e;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const target = this.linkDistance + a.r + b.r;
      const k = (d - target) / d * this.linkStrength * alpha;
      const fx = dx * k, fy = dy * k;
      // heavier nodes move less
      const wa = b.degree + 1, wb = a.degree + 1, w = wa + wb;
      if (!a.fixed) { a.vx += fx * (wa / w); a.vy += fy * (wa / w); }
      if (!b.fixed) { b.vx -= fx * (wb / w); b.vy -= fy * (wb / w); }
    }
    // Gravity + integrate
    const cx = this.width / 2, cy = this.height / 2;
    for (const p of nodes) {
      if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
      p.vx += (cx - p.x) * this.gravity * alpha;
      p.vy += (cy - p.y) * this.gravity * alpha;
      p.vx *= this.velocityDecay; p.vy *= this.velocityDecay;
      p.x += p.vx; p.y += p.vy;
    }
    this.alpha += (0 - this.alpha) * this.alphaDecay;
    return true;
  }

  /** Warm the simulation back up (a drag, a changed graph). */
  reheat(alpha = 0.5) { this.alpha = Math.max(this.alpha, alpha); }

  /** The bounding box of the nodes (with radii). */
  bounds() {
    if (!this.nodes.length) return { x: 0, y: 0, w: this.width, h: this.height };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of this.nodes) {
      x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r);
      x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Positions by id (to remember across renders). */
  positions() { return new Map(this.nodes.map(p => [p.id, { x: p.x, y: p.y }])); }

  /** The node under (x, y) in simulation space, or null. */
  nodeAt(x, y, slop = 4) {
    let best = null, bestD = Infinity;
    for (const p of this.nodes) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= p.r + slop && d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  /** Ids adjacent to a node. */
  neighbours(id) {
    const out = new Set();
    for (const e of this.edges) {
      if (e.source === id) out.add(e.target);
      else if (e.target === id) out.add(e.source);
    }
    return out;
  }
}

/** Run a simulation to rest (at most `maxTicks` steps) and return it. */
export function layout(graph, opts = {}) {
  const sim = new ForceSim(graph, opts);
  const max = opts.maxTicks ?? 400;
  for (let i = 0; i < max && sim.tick(); i++) { /* settle */ }
  return sim;
}
