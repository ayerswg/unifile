/**
 * {notes} — the GRAPH VIEW: the workspace drawn as nodes and links on a canvas
 * in the render pane.  Pages are dots sized by how connected they are, the
 * open page is the accent dot, tags are hollow violet dots, unresolved links
 * hollow dashed ones.  Hover a node to light up its neighbourhood, click to
 * open the page (a tag → search it; a missing page → create it), drag a node
 * to pull the picture around, wheel / pinch to zoom, drag the background to
 * pan, ⛶ to fit.  "Local" shows the open page's neighbourhood (two hops);
 * "All" the whole workspace.  The layout (core/notes/graph.js) is a force
 * simulation animated here; positions are remembered across re-renders so a
 * keystroke never reshuffles the picture.  Colours come from the app's CSS
 * tokens at draw time, so the theme applies live.
 */

import { ForceSim, nodeRadius } from '../core/notes/graph.js';

const PREF_MODE = 'uf_notes_graph_mode';
const PREF_TAGS = 'uf_notes_graph_tags';

// Remembered node positions (by node id) — module-level so they outlive a
// re-render (the preview rebuilds the pane) and a page switch.
const _positions = new Map();

export class NotesGraph {
  /**
   * @param {HTMLElement} host
   * @param {object} h
   * @param {() => import('../core/notes/index.js').Index|null} h.getIndex
   * @param {() => string|null} h.currentId
   * @param {(id: string) => void} h.onOpen
   * @param {(tag: string) => void} h.onTag
   * @param {(title: string) => void} h.onCreate
   */
  constructor(host, h) {
    this.host = host;
    this.h = h;
    this.mode = _pref(PREF_MODE, 'local');
    this.tags = _pref(PREF_TAGS, '1') !== '0';
    this.k = 1; this.tx = 0; this.ty = 0;        // view transform (sim → css px)
    this.hover = null;
    this.sim = null;
    this._raf = 0;
    this._fitPending = true;
    this._build();
  }

  _build() {
    const el = this.host;
    el.classList.add('nbg');
    el.dataset.dslHandled = '1';                 // preview.js click-back stays out
    el.innerHTML = `
      <canvas class="nbg-canvas" aria-label="Graph of the workspace"></canvas>
      <div class="nbg-ctl">
        <div class="nbg-seg" role="group" aria-label="Scope">
          <button type="button" data-mode="local" title="The open page and its neighbours (two hops)">Local</button>
          <button type="button" data-mode="all" title="Every page in the workspace">All</button>
        </div>
        <button type="button" class="nbg-tags" data-act="tags" title="Show tags as nodes">#</button>
        <span class="nbg-sp"></span>
        <button type="button" data-act="out" title="Zoom out">−</button>
        <button type="button" data-act="fit" title="Fit">⛶</button>
        <button type="button" data-act="in" title="Zoom in">+</button>
      </div>
      <div class="nbg-legend"><span class="nbg-lg nbg-lg-cur"></span>this page <span class="nbg-lg nbg-lg-page"></span>page <span class="nbg-lg nbg-lg-tag"></span>tag <span class="nbg-lg nbg-lg-missing"></span>not created yet</div>
      <div class="nbg-empty" hidden></div>`;
    this.canvas = el.querySelector('canvas');
    this.ctx2d = this.canvas.getContext('2d');
    el.querySelector('.nbg-ctl').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      e.stopPropagation();
      if (b.dataset.mode) { this.mode = b.dataset.mode; _setPref(PREF_MODE, this.mode); this._fitPending = true; this.update(); }
      else if (b.dataset.act === 'tags') { this.tags = !this.tags; _setPref(PREF_TAGS, this.tags ? '1' : '0'); this._fitPending = true; this.update(); }
      else if (b.dataset.act === 'fit') this.fit();
      else if (b.dataset.act === 'in') this.zoomBy(1.3);
      else if (b.dataset.act === 'out') this.zoomBy(1 / 1.3);
    });
    this._bindPointer();
    this._ro = new ResizeObserver(() => { this._resize(); if (this._fitPending) this.fit(); this.draw(); });
    this._ro.observe(el);
    this._resize();
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.sim = null;
  }

  /** The height the stage wants, so a phone's pane shows a square-ish picture. */
  _resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.hgt = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.hgt * dpr);
    this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.hgt + 'px';
    this.dpr = dpr;
  }

  /** Rebuild the simulation from the index (keeps remembered positions). */
  update() {
    const index = this.h.getIndex();
    const current = this.h.currentId();
    const empty = this.host.querySelector('.nbg-empty');
    this.host.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('is-on', b.dataset.mode === this.mode));
    this.host.querySelector('.nbg-tags')?.classList.toggle('is-on', this.tags);
    if (!index) { this.sim = null; empty.hidden = false; empty.textContent = 'No workspace to draw.'; this.draw(); return; }
    const graph = this.mode === 'local' && current
      ? index.graph({ center: current, depth: 2, tags: this.tags, missing: true })
      : index.graph({ tags: this.tags, missing: true });
    this.current = current;
    const W = 800, H = 600;
    this.sim = new ForceSim(graph, { width: W, height: H, positions: _positions, center: current });
    this.simW = W; this.simH = H;
    const n = graph.nodes.length;
    empty.hidden = n > 1 || (n === 1 && graph.edges.length > 0);
    if (!empty.hidden) {
      empty.textContent = n === 0 ? 'Nothing to draw yet.' : this.mode === 'local'
        ? 'This page links to nothing yet — write [[Another page]] to connect it, or switch to All.'
        : 'One page, no links yet — write [[Another page]] to connect notes.';
    }
    if (this._fitPending) { this._fitPending = false; this._fitAfterSettle = true; }
    this._run();
  }

  _run() {
    cancelAnimationFrame(this._raf);
    const step = () => {
      if (!this.sim) return;
      let moved = false;
      for (let i = 0; i < 3; i++) moved = this.sim.tick() || moved;
      for (const p of this.sim.nodes) _positions.set(p.id, { x: p.x, y: p.y });
      if (this._fitAfterSettle && (!moved || this.sim.alpha < 0.08)) { this._fitAfterSettle = false; this.fit(); }
      this.draw();
      if (moved) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  fit() {
    if (!this.sim || !this.sim.nodes.length) return;
    const b = this.sim.bounds();
    const pad = 36;
    const k = Math.min(3, Math.min((this.w - pad * 2) / Math.max(40, b.w), (this.hgt - pad * 2) / Math.max(40, b.h)));
    this.k = Math.max(0.2, k);
    this.tx = this.w / 2 - (b.x + b.w / 2) * this.k;
    this.ty = this.hgt / 2 - (b.y + b.h / 2) * this.k;
    this.draw();
  }

  zoomBy(f, cx = this.w / 2, cy = this.hgt / 2) {
    const k2 = Math.max(0.15, Math.min(6, this.k * f));
    const r = k2 / this.k;
    this.tx = cx - (cx - this.tx) * r;
    this.ty = cy - (cy - this.ty) * r;
    this.k = k2;
    this.draw();
  }

  /** css px → sim coords */
  _toSim(x, y) { return { x: (x - this.tx) / this.k, y: (y - this.ty) / this.k }; }

  _colors() {
    const cs = getComputedStyle(this.host);
    const v = (n, d) => (cs.getPropertyValue(n) || d).trim() || d;
    return {
      accent: v('--accent', '#3d9bff'), accent2: v('--accent-2', '#b89cf2'), text: v('--text', '#dedede'),
      sub: v('--text-sub', '#a8a8a8'), muted: v('--text-muted', '#707070'), bg: v('--bg', '#181818'), border: v('--border', '#2c2c2c'),
    };
  }

  draw() {
    const g = this.ctx2d;
    if (!g) return;
    const { w, hgt, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    if (!this.sim) return;
    const C = this._colors();
    const sim = this.sim;
    const hover = this.hover;
    const near = hover ? sim.neighbours(hover.id) : null;
    const k = this.k;
    g.save();
    g.translate(this.tx, this.ty);
    g.scale(k, k);

    // edges
    g.lineWidth = 1 / k;
    for (const e of sim.edges) {
      const lit = hover && (e.source === hover.id || e.target === hover.id);
      g.strokeStyle = lit ? C.accent : C.muted;
      g.globalAlpha = hover ? (lit ? 0.9 : 0.12) : (e.kind === 'tag' ? 0.28 : 0.45);
      if (e.kind === 'tag') g.setLineDash([3 / k, 3 / k]); else g.setLineDash([]);
      g.beginPath(); g.moveTo(e.a.x, e.a.y); g.lineTo(e.b.x, e.b.y); g.stroke();
    }
    g.setLineDash([]);

    // nodes
    const labelAll = sim.nodes.length <= 70 || k > 1.6;
    for (const p of sim.nodes) {
      const isCur = p.id === this.current;
      const lit = !hover || p === hover || near.has(p.id);
      g.globalAlpha = lit ? 1 : 0.18;
      const r = p.r;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (p.kind === 'tag') {
        g.fillStyle = C.bg; g.fill();
        g.lineWidth = 1.5 / k; g.strokeStyle = C.accent2; g.stroke();
      } else if (p.kind === 'missing') {
        g.fillStyle = C.bg; g.fill();
        g.lineWidth = 1.2 / k; g.strokeStyle = C.muted; g.setLineDash([2.5 / k, 2.5 / k]); g.stroke(); g.setLineDash([]);
      } else {
        g.fillStyle = isCur ? C.accent : (p === hover ? C.text : C.sub);
        g.fill();
        if (isCur) { g.lineWidth = 2 / k; g.strokeStyle = C.accent; g.globalAlpha = lit ? 0.35 : 0.1; g.beginPath(); g.arc(p.x, p.y, r + 4 / k, 0, Math.PI * 2); g.stroke(); g.globalAlpha = lit ? 1 : 0.18; }
      }
      // label
      const show = labelAll || isCur || p === hover || (near && near.has(p.id)) || p.degree >= 4;
      if (show) {
        const fs = Math.max(9, Math.min(13, 11 / Math.sqrt(k))) / k * Math.min(1.4, Math.max(0.8, k));
        g.font = `${p === hover || isCur ? '600 ' : ''}${fs}px system-ui, -apple-system, sans-serif`;
        g.fillStyle = p.kind === 'tag' ? C.accent2 : p.kind === 'missing' ? C.muted : (isCur ? C.text : C.sub);
        g.textAlign = 'center'; g.textBaseline = 'top';
        const label = p.label.length > 28 ? p.label.slice(0, 27) + '…' : p.label;
        g.fillText(label, p.x, p.y + r + 3 / k);
      }
    }
    g.restore();
  }

  _bindPointer() {
    const c = this.canvas;
    const ptrs = new Map();
    let drag = null;           // { kind: 'node'|'pan', node?, sx, sy, moved }
    let pinch = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener('pointerdown', (e) => {
      ptrs.set(e.pointerId, pos(e));
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.k };
        drag = null;
        return;
      }
      const p = pos(e);
      const s = this._toSim(p.x, p.y);
      const node = this.sim?.nodeAt(s.x, s.y, 6 / this.k);
      drag = { kind: node ? 'node' : 'pan', node, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
      if (node) { node.fixed = true; this.sim.reheat(0.25); this._run(); }
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic ids */ }
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        this.zoomBy((pinch.k * (d / pinch.d)) / this.k, cx, cy);
        return;
      }
      if (drag) {
        const dx = p.x - drag.lx, dy = p.y - drag.ly;
        if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 4) drag.moved = true;
        if (drag.kind === 'node') {
          const s = this._toSim(p.x, p.y);
          drag.node.x = s.x; drag.node.y = s.y;
          this.sim.reheat(0.2); this._run();
        } else if (drag.moved) { this.tx += dx; this.ty += dy; this.draw(); }
        drag.lx = p.x; drag.ly = p.y;
        return;
      }
      // hover
      const s = this._toSim(p.x, p.y);
      const node = this.sim?.nodeAt(s.x, s.y, 6 / this.k) ?? null;
      if (node !== this.hover) { this.hover = node; c.style.cursor = node ? 'pointer' : ''; c.title = node ? node.label : ''; this.draw(); }
    });
    const end = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!drag) return;
      const d = drag; drag = null;
      if (d.kind === 'node') {
        d.node.fixed = false;
        if (!d.moved) this._activate(d.node);
        else { this.sim.reheat(0.15); this._run(); }
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!drag && this.hover) { this.hover = null; this.draw(); } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomBy(f, p.x, p.y);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => { const p = pos(e); this.zoomBy(1.6, p.x, p.y); });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _activate(node) {
    if (node.kind === 'page') this.h.onOpen?.(node.id);
    else if (node.kind === 'tag') this.h.onTag?.(node.label.replace(/^#/, ''));
    else if (node.kind === 'missing') this.h.onCreate?.(node.label);
  }
}

function _pref(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function _setPref(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export { nodeRadius };
