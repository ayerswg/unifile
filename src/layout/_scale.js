/**
 * Print-scale utility for slides and document pages.
 *
 * Elements are rendered at a fixed intrinsic pixel width (the "design size").
 * A ResizeObserver watches the container and applies CSS `zoom` so the element
 * scales as a unit — no text reflow, no dimension changes — just the whole
 * page shrinking or growing like a print-preview thumbnail.
 *
 * Usage:
 *   attachScaleObserver(container, '.uf-slide',    960);
 *   attachScaleObserver(container, '.uf-doc-page', 816);
 *   ...later...
 *   detachScaleObserver(container);
 */

/**
 * @param {HTMLElement} container      The scrollable preview container
 * @param {string}      selector       CSS selector for the scaleable elements
 * @param {number}      intrinsicWidth Design width in CSS pixels at zoom = 1
 */
export function attachScaleObserver(container, selector, intrinsicWidth) {
  function apply(contentW) {
    if (contentW <= 0) return;
    const scale = Math.min(contentW / intrinsicWidth, 1);
    container.querySelectorAll(selector).forEach(el => { el.style.zoom = scale; });
  }

  const ro = new ResizeObserver(([entry]) => {
    apply(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
  });
  ro.observe(container);
  container._ufScaleRO = ro;

  // Fire immediately — the ResizeObserver callback is asynchronous so we
  // seed the initial scale now using the current content-box width.
  requestAnimationFrame(() => {
    const cs = getComputedStyle(container);
    const w  = container.clientWidth
      - parseFloat(cs.paddingLeft  || '0')
      - parseFloat(cs.paddingRight || '0');
    apply(w);
  });
}

export function detachScaleObserver(container) {
  container._ufScaleRO?.disconnect();
  delete container._ufScaleRO;
}
