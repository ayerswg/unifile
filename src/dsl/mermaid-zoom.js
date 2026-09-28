/**
 * Mermaid zoom & pan.
 *
 * Diagrams outgrow a pane fast, so every rendered diagram sits in a fixed-size
 * "stage" that zooms and pans — BY REWRITING THE SVG VIEWBOX, not a CSS
 * transform (a transform-scaled svg rasterizes at layout size and blurs; a
 * narrowed viewBox stays vector-crisp — the same trick as uDraft's plan).
 *
 *   • opens FITTED to the stage (never enlarged past 1:1 — small diagrams stay
 *     natural size, big ones shrink to fit)
 *   • wheel / trackpad pinch zooms at the cursor, one pointer pans, two pinch,
 *     double-click zooms in, the − ⛶ + buttons cover discoverability
 *   • a "sole" diagram (the document IS the diagram) fills the whole preview
 *     pane and plain wheel zooms; inside prose (a Markdown doc with a #!mermaid
 *     section) the stage is diagram-sized, plain wheel scrolls the page and
 *     only ctrl/⌘+wheel (= trackpad pinch) zooms — sole-ness is CSS
 *     `:only-child` state, re-read live because parts render sequentially
 *   • the view survives re-renders while typing (memo per preview root +
 *     diagram index; the preview replaces the whole svg on every render)
 *   • a drag never counts as a click: the click-back-to-source listener up the
 *     tree only sees real taps (a node tap still jumps to its source line)
 */

const PAD        = 12;    // px of breathing room around a fitted diagram
const MAX_SCALE  = 10;
const MIN_ABS    = 0.02;
const SOLE_SEL   = '.preview-content > .uf-mmd-stage, ' +
  '.uf-webpage > .uf-webpage-section:only-child > .uf-web-part:only-child > .uf-mmd-stage';

/** Preview root → Map<diagram index, {scale,cx,cy}|null>. Keeps the user's
 *  view across the re-render every keystroke triggers. */
const _views = new WeakMap();

/**
 * Wrap `svg` (already a child of `el`) in a zoom/pan stage.
 * @param {HTMLElement} el   The element mermaid rendered into
 * @param {SVGSVGElement} svg
 */
export function mountZoomStage(el, svg) {
  const vb = _baseBox(svg);
  if (!vb) return;

  const root = el.closest('.preview-content') ?? el;
  const idx  = root.querySelectorAll('.uf-mmd-stage').length;
  if (!_views.has(root)) _views.set(root, new Map());
  const memo = _views.get(root);

  const stage = document.createElement('div');
  stage.className = 'uf-mmd-stage';
  el.insertBefore(stage, svg);
  stage.appendChild(svg);

  // Mermaid emits width="100%" + style="max-width: Npx" — the stage owns size.
  svg.removeAttribute('style');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const ctl = document.createElement('div');
  ctl.className = 'uf-mmd-zoomctl';
  ctl.innerHTML =
    '<button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">−</button>' +
    '<span class="uf-mmd-zoom" aria-live="off"></span>' +
    '<button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button>' +
    '<button type="button" data-z="fit" title="Fit diagram to view" aria-label="Fit diagram to view">⛶</button>';
  stage.appendChild(ctl);
  const pctEl = ctl.querySelector('.uf-mmd-zoom');

  // ── View model ────────────────────────────────────────────────────────────
  let view = memo.get(idx) ?? null;          // {scale, cx, cy} | null = fit
  if (view && !_plausible(view, vb)) view = null;

  const rect = () => stage.getBoundingClientRect();
  const fitScale = (w, h) => Math.max(MIN_ABS,
    Math.min(1, (w - 2 * PAD) / vb.w, (h - 2 * PAD) / vb.h));
  const isSole = () => stage.matches(SOLE_SEL);

  const apply = () => {
    const r = rect();
    if (r.width < 2 || r.height < 2) return;   // hidden pane — wait for resize
    let s, cx, cy;
    if (view) ({ scale: s, cx, cy } = view);
    else { s = fitScale(r.width, r.height); cx = vb.x + vb.w / 2; cy = vb.y + vb.h / 2; }
    const vw = r.width / s, vh = r.height / s;
    svg.setAttribute('viewBox',
      [cx - vw / 2, cy - vh / 2, vw, vh].map(n => Math.round(n * 100) / 100).join(' '));
    pctEl.textContent = Math.round(s * 100) + '%';
    stage.classList.toggle('is-fit', !view);
  };

  const setView = (v) => { view = v; memo.set(idx, v); apply(); };

  const scaleNow = () => {
    if (view) return view.scale;
    const r = rect();
    return fitScale(r.width, r.height);
  };

  /** Zoom by factor f keeping the diagram point under (clientX, clientY) fixed. */
  const zoomAt = (clientX, clientY, f) => {
    const r = rect();
    if (r.width < 2 || r.height < 2) return;
    const s  = scaleNow();
    const lo = Math.max(MIN_ABS, fitScale(r.width, r.height) / 4);
    const s2 = Math.min(MAX_SCALE, Math.max(lo, s * f));
    if (s2 === s) return;
    const cx = view ? view.cx : vb.x + vb.w / 2;
    const cy = view ? view.cy : vb.y + vb.h / 2;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const px = cx + dx / s, py = cy + dy / s;
    setView({ scale: s2, cx: px - dx / s2, cy: py - dy / s2 });
  };

  const panBy = (dxPx, dyPx) => {
    const s = scaleNow();
    const cx = view ? view.cx : vb.x + vb.w / 2;
    const cy = view ? view.cy : vb.y + vb.h / 2;
    setView({ scale: s, cx: cx - dxPx / s, cy: cy - dyPx / s });
  };

  // ── Sizing: sole diagram = the pane (CSS); in prose = diagram-sized ───────
  const sync = () => {
    const sole = isSole();
    stage.classList.toggle('is-sole', sole);
    stage.style.touchAction = sole ? 'none' : 'pan-y';
    if (sole) {
      stage.style.height = '';
    } else {
      const w = stage.clientWidth || vb.w;
      const natural = Math.min(vb.h, w * vb.h / vb.w) + 2 * PAD;
      const cap = Math.max(240, Math.round((window.innerHeight || 800) * 0.7));
      stage.style.height = Math.round(Math.max(160, Math.min(natural, cap))) + 'px';
    }
    apply();
  };

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => sync()).observe(stage);
  } else {
    window.addEventListener('resize', sync);
  }
  sync();
  setTimeout(sync, 0);   // later sibling parts may have landed since

  // ── Wheel ─────────────────────────────────────────────────────────────────
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) && !isSole()) return;   // prose scrolls
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0018));
  }, { passive: false });

  // ── Pointer pan / pinch ───────────────────────────────────────────────────
  // No capture on pointerdown (it retargets the trailing click away from the
  // diagram nodes) — capture only once a drag latches. setPointerCapture
  // throws for stale ids: wrapped, do not remove.
  const ptrs = new Map();
  let moved = 0, dragged = false;
  const mid = () => {
    const [a, b] = [...ptrs.values()];
    return b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
             : { x: a.x, y: a.y, d: 0 };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.uf-mmd-zoomctl')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) moved = 0;
  });
  stage.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const before = mid();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = mid();
    moved += Math.hypot(after.x - before.x, after.y - before.y);
    if (moved <= 3 && ptrs.size === 1) return;          // jitter — not a pan yet
    try { stage.setPointerCapture(e.pointerId); } catch { /* stale id */ }
    stage.classList.add('is-dragging');
    if (ptrs.size === 2 && before.d > 0 && after.d > 0) zoomAt(after.x, after.y, after.d / before.d);
    panBy(after.x - before.x, after.y - before.y);
    e.preventDefault();
  });
  const up = (e) => {
    if (!ptrs.delete(e.pointerId)) return;
    if (ptrs.size) return;
    stage.classList.remove('is-dragging');
    if (moved > 6) {
      dragged = true;                                    // swallow the tail click
      setTimeout(() => { dragged = false; }, 0);
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('click', (e) => {
    if (dragged) { e.stopPropagation(); e.preventDefault(); }
  });
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.uf-mmd-zoomctl')) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, 2);
  });

  // ── Buttons ───────────────────────────────────────────────────────────────
  ctl.addEventListener('click', (e) => {
    e.stopPropagation();                                 // not a click-back
    const z = e.target.closest('button')?.dataset.z;
    if (!z) return;
    if (z === 'fit') { setView(null); return; }
    const r = rect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, z === 'in' ? 1.4 : 1 / 1.4);
  });
  ctl.addEventListener('dblclick', (e) => e.stopPropagation());

  // ── External control (the phone action bubble: actions.js `zoomStages`) ──
  stage.addEventListener('uf-mmd-zoom', (e) => {
    const z = e.detail;
    if (z === 'fit') { setView(null); return; }
    const r = rect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, z === 'in' ? 1.4 : 1 / 1.4);
  });
}

/**
 * Zoom every mounted stage under `root` ('fit' | 'in' | 'out') — for callers
 * that don't hold a stage (the phone action bubble).
 * @returns {number} stages reached
 */
export function zoomStages(z, root = document) {
  const stages = root.querySelectorAll('.uf-mmd-stage');
  stages.forEach(s => s.dispatchEvent(new CustomEvent('uf-mmd-zoom', { detail: z })));
  return stages.length;
}

/** The diagram's own box from its viewBox (mermaid always sets one). */
function _baseBox(svg) {
  const parts = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
  if (w > 0 && h > 0) { svg.setAttribute('viewBox', `0 0 ${w} ${h}`); return { x: 0, y: 0, w, h }; }
  return null;
}

/** A remembered view still makes sense for this diagram (centre near it). */
function _plausible(v, vb) {
  return Number.isFinite(v.scale) && v.scale > 0 &&
    v.cx > vb.x - vb.w && v.cx < vb.x + 2 * vb.w &&
    v.cy > vb.y - vb.h && v.cy < vb.y + 2 * vb.h;
}
