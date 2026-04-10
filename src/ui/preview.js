/**
 * Preview pane component
 *
 * Renders the current document content live as the user types.
 * Updates are debounced to avoid excessive re-renders.
 *
 * Dispatch order
 * ─────────────
 * 1. primaryModel ≠ 'flow'  →  model renderer  (grid, spatial, timeline, graph)
 * 2. primaryModel = 'flow'  →  layout renderer  (slides, document, webpage)
 * 3. Fallback               →  per-section DSL rendering  (existing behaviour)
 *
 * Each model has its own coordinate syntax and renderer.
 * Layouts are rendering modes within the flow model.
 */

import { state, VIEW_MODES } from './state.js';
import { getDSL } from '../dsl/registry.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';

// Flow model layouts
import { renderSlides,   teardownSlides,  printSlides   } from '../layout/flow-slides.js';
import { renderDocument, teardownDocument, printDocument } from '../layout/flow-document.js';
import { renderWebpage,  teardownWebpage  } from '../layout/flow-webpage.js';

// Primary model renderers
import { renderGrid,     teardownGrid     } from '../layout/grid-table.js';
import { renderSpatial,  teardownSpatial  } from '../layout/spatial-canvas.js';
import { renderTimeline, teardownTimeline } from '../layout/timeline-tracks.js';
import { renderGraph,    teardownGraph    } from '../layout/graph-er.js';

const DEBOUNCE_MS_BASE = 300;
const DEBOUNCE_MS_MAX  = 1500;

/**
 * Scale debounce delay with document size so large scripts don't trigger
 * repeated full re-renders while the user is still typing.
 * Returns DEBOUNCE_MS_BASE for small docs, scaling up to DEBOUNCE_MS_MAX.
 */
function _debounceMs(content) {
  const len = content?.length ?? 0;
  // Start scaling at 20 kB; reach max at 500 kB.
  const t = Math.min(1, Math.max(0, (len - 20_000) / (500_000 - 20_000)));
  return Math.round(DEBOUNCE_MS_BASE + t * (DEBOUNCE_MS_MAX - DEBOUNCE_MS_BASE));
}

export class Preview {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.el = container;
    this._unsub = [];
    this._renderTimer = null;
    this._renderAbort  = null; // AbortController for the in-flight async render
    this._lastContent = null;
    this._lastDsl     = null;
    this._lastModel   = null;
    this._lastRenderer = null; // key into _MODEL_RENDERERS or _FLOW_LAYOUT_RENDERERS
    this._activeSectionVersion = null;
    this._scrollSyncEnabled = true; // user scroll disables sync temporarily
    // Set true by the content-change handler when in layout mode so that the
    // post-render scroll-to-cursor call is suppressed; the incremental render
    // updates pages in-place and the scroll position is preserved naturally.
    this._suppressScrollAfterRender = false;

    this._build();
    this._bindClickBack();
    this._bindScrollSync();

    this._unsub.push(state.on('content-change', ({ content, cursorPos }) => {
      if (cursorPos != null) {
        this._cursorPos = cursorPos;
        if (this._lastRenderer) {
          // Layout mode (document / slides / webpage): do NOT scroll immediately
          // on every keystroke — the page updates in-place after the debounce.
          // Also suppress the scroll call that fires after the render completes
          // so the pane doesn't jump while the user is actively editing.
          this._suppressScrollAfterRender = true;
        } else if (this._scrollSyncEnabled !== false) {
          // Standalone DSL mode: keep the preview pane in sync as the user types.
          this._scrollToOffset(cursorPos);
        }
      }
      this._scheduleRender(content);
    }));
    this._unsub.push(state.on('change', () => {
      this._updateVisibility();
      // In layout/model mode _lastDsl is null; only re-render on model changes.
      // In per-section DSL mode, also re-render on DSL type changes.
      const dslChanged = !this._lastRenderer && state.data?.dslType !== this._lastDsl;
      if (dslChanged || state.primaryModel !== this._lastModel) {
        this._scheduleRender(state.currentContent, true);
      }
    }));
    this._unsub.push(state.on('checkout', ({ content }) => {
      this._suppressScrollAfterRender = false;
      this._scheduleRender(content, true);
    }));
    this._unsub.push(state.on('branch-switch', ({ content }) => {
      this._suppressScrollAfterRender = false;
      this._scheduleRender(content, true);
    }));
    this._unsub.push(state.on('active-section-change', ({ version }) => {
      this._activeSectionVersion = version ?? null;
      // In layout mode (slides / document / webpage) the full document is always
      // rendered — section-cursor changes never need a fresh render.  Only
      // content changes (content-change) and DSL/model changes (change) do.
      // Skipping here also prevents the note-deselection bug where CM6's
      // post-focus DOM-selection reconciliation fires a second
      // active-section-change (without fromDslSelect) and wipes the preview.
      if (this._lastRenderer) return;
      // Standalone mode: render immediately so the section switches without lag.
      this._scheduleRender(state.currentContent, true);
    }));

    // Scroll-sync: when the editor cursor moves (without a doc change), scroll
    // the preview pane so the corresponding page is centred on screen.
    this._unsub.push(state.on('editor-select', ({ from }) => {
      if (this._scrollSyncEnabled) this._scrollToOffset(from, 'center');
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
    clearTimeout(this._renderTimer);
    this._renderAbort?.abort();
  }

  // ---------------------------------------------------------------------------
  // Click-back: clicking any rendered element jumps editor cursor to source
  // ---------------------------------------------------------------------------

  _bindClickBack() {
    this.content.addEventListener('click', (e) => {
      let el = e.target;
      while (el && el !== this.content) {
        // If a DSL wrapper is marked as self-handling (e.g. abcjs, which fires
        // its own precise dsl-select via its click listener), bail out here so
        // we don't clobber the fine-grained selection with the block-level one.
        if (el.dataset?.dslHandled) return;
        if (el.dataset?.docFrom != null) {
          const pos = parseInt(el.dataset.docFrom, 10);
          const to  = el.dataset.docTo != null ? parseInt(el.dataset.docTo, 10) : pos;
          state.emit('dsl-select', { from: pos, to });
          return;
        }
        el = el.parentElement;
      }
      const paneFrom = this.content.dataset?.docFrom;
      if (paneFrom != null) {
        const pos = parseInt(paneFrom, 10);
        state.emit('dsl-select', { from: pos, to: pos });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Scroll sync: editor cursor → preview page
  // ---------------------------------------------------------------------------

  /**
   * When the user scrolls the preview manually, disable auto scroll-sync for a
   * short window so we don't fight their scroll intention.  Re-enable once they
   * stop scrolling.
   */
  _bindScrollSync() {
    let resetTimer = null;
    // We can only bind once `this.pane` exists, so call from _build().
    // Stored as a pending bind here; _build calls it after DOM creation.
    this._bindScrollSyncToPane = () => {
      this.pane.addEventListener('scroll', () => {
        this._scrollSyncEnabled = false;
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { this._scrollSyncEnabled = true; }, 2000);
      }, { passive: true });
    };
  }

  /**
   * Scroll the preview pane so the page whose content includes `offset` (a
   * character index into the document) is visible.  Falls back to the nearest
   * page when no stub exactly covers the offset.
   */
  _scrollToOffset(offset, block = 'nearest') {
    // Only makes sense in document layout mode where stubs carry content ranges.
    const stubs = this.content.querySelectorAll('[data-page-content-from]');
    if (!stubs.length) return;

    let best = null;
    let bestDist = Infinity;

    for (const stub of stubs) {
      const from = parseInt(stub.dataset.pageContentFrom, 10);
      const to   = parseInt(stub.dataset.pageContentTo,   10);

      // Exact match — cursor is on this page.
      if (from <= offset && offset <= to) { best = stub; break; }

      // Nearest-page fallback.
      const dist = Math.min(Math.abs(from - offset), Math.abs(to - offset));
      if (dist < bestDist) { bestDist = dist; best = stub; }
    }

    if (best) {
      // Temporarily suppress the scroll handler so scrolling programmatically
      // doesn't disable sync for the next 2 s.
      this._scrollSyncEnabled = false;
      best.scrollIntoView({ behavior: 'smooth', block });
      setTimeout(() => { this._scrollSyncEnabled = true; }, 600);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  _build() {
    this.el.innerHTML = `
      <div class="preview-pane" id="preview-pane">
        <div class="preview-rendering-badge" id="preview-rendering-badge" aria-live="polite" aria-label="Preview updating">
          <span class="preview-rendering-dot"></span>Updating…
        </div>
        <div class="preview-content" id="preview-content" aria-live="polite">
          <p class="preview-empty">Start writing to see a preview.</p>
        </div>
      </div>
    `;

    this.pane    = this.el.querySelector('#preview-pane');
    this.content = this.el.querySelector('#preview-content');
    this._badge  = this.el.querySelector('#preview-rendering-badge');

    // Bind the scroll-sync suppression now that the pane exists.
    this._bindScrollSyncToPane?.();

    this._updateVisibility();
    this._scheduleRender(state.currentContent, true);
  }

  /** Show / hide the "Updating…" badge. */
  _setRendering(active) {
    this._badge?.classList.toggle('preview-rendering-badge--visible', active);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _scheduleRender(content, immediate = false) {
    // Cancel any in-flight async render immediately so large-doc renders
    // don't keep running while the user is actively typing.
    if (this._renderAbort) {
      console.log('[preview] aborting render, immediate=', immediate, 'stack=', new Error().stack.split('\n')[2]?.trim());
    }
    this._renderAbort?.abort();
    this._renderAbort = null;

    clearTimeout(this._renderTimer);
    if (immediate) {
      this._render(content);
    } else {
      const delay = _debounceMs(content);
      this._renderTimer = setTimeout(() => this._render(content), delay);
    }
  }

  async _render(content) {
    // Create a fresh abort controller for this render.  Any concurrent render
    // that started before us has already been aborted by _scheduleRender.
    const ac = new AbortController();
    this._renderAbort = ac;
    this._setRendering(true);

    try {
      await this._renderInner(content, ac);
    } finally {
      // Only clear the badge when this render finishes without being superseded.
      if (this._renderAbort === ac) {
        this._setRendering(false);
        this._renderAbort = null;
      }
    }
  }

  async _renderInner(content, ac) {
    const { meta, bodyFrom } = parseGlobalFrontMatter(content ?? '');
    const model  = meta.model ?? state.primaryModel ?? 'flow';
    // Webpage is the default layout for the flow model — it renders the full
    // document body as a flowing webpage and treats `---` as <hr>.
    // Explicit `layout:` in front matter overrides this default.
    const layout = meta.layout ?? (model === 'flow' ? 'webpage' : null);

    // ── 1. Non-flow primary model → model renderer ─────────────────────────
    if (model !== 'flow') {
      const renderer = _MODEL_RENDERERS[model];
      if (renderer) {
        this._teardownCurrent();
        this._lastContent  = content;
        this._lastModel    = model;
        this._lastRenderer = model;

        const body = (content ?? '').slice(bodyFrom).trim();
        if (!body) {
          this.content.innerHTML = `<p class="preview-empty">Start writing in ${model} syntax to see a preview.</p>`;
          return;
        }

        const spinnerTimer = setTimeout(() => {
          if (this._lastContent === content)
            this.content.innerHTML = '<div class="preview-spinner"></div>';
        }, 300);

        try {
          await renderer.render(content, this.content, { signal: ac.signal });
          if (ac.signal.aborted) return;
        } catch (err) {
          if (ac.signal.aborted) return;
          renderer.teardown(this.content);
          this.content.innerHTML = `<pre class="error">${model} render error:\n${_esc(err.message)}</pre>`;
        } finally {
          clearTimeout(spinnerTimer);
        }
        return;
      }
    }

    // ── 2. Flow model with layout → layout renderer ─────────────────────────
    if (layout) {
      const renderer = _FLOW_LAYOUT_RENDERERS[layout];
      if (renderer) {
        this._teardownCurrent();
        this._lastContent  = content;
        this._lastModel    = model;
        this._lastRenderer = `flow:${layout}`;

        const body = (content ?? '').slice(bodyFrom).trim();
        if (!body) {
          this.content.innerHTML = '<p class="preview-empty">Start writing to see a preview.</p>';
          return;
        }

        const spinnerTimer = setTimeout(() => {
          if (this._lastContent === content) {
            this.content.innerHTML = '<div class="preview-spinner"></div>';
            if (layout === 'slides') this.content.classList.add('slides-mode');
          }
        }, 300);

        try {
          const wasFullRender = await renderer.render(content, this.content, { signal: ac.signal, cursorPos: this._cursorPos, defaultDsl: state.data?.dslType, commitHash: state.shortHeadHash, isDirty: state.isDirty });
          if (ac.signal.aborted) return;
          // Suppress scroll during typing so the view doesn't jump (incremental
          // renders update pages in-place and the scroll position is preserved).
          // But after a full re-render the DOM was replaced, so we must restore
          // the view to the cursor page regardless of _suppressScrollAfterRender.
          if (!this._suppressScrollAfterRender || wasFullRender) {
            this._scrollToOffset(this._cursorPos ?? 0);
          }
          this._suppressScrollAfterRender = false;
        } catch (err) {
          if (ac.signal.aborted) return;
          renderer.teardown(this.content);
          this.content.innerHTML = `<pre class="error">${_esc(layout)} render error:\n${_esc(err.message)}</pre>`;
        } finally {
          clearTimeout(spinnerTimer);
        }
        return;
      }
    }

    // ── 3. Flow default → per-section DSL rendering ─────────────────────────
    this._teardownCurrent();

    const range  = state.activeSectionRange;
    const dslId  = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    const renderContent = range ? content.slice(range.from, range.to) : content;

    let dsl;
    try {
      dsl = getDSL(dslId);
    } catch {
      this.content.innerHTML = `<p class="error">Unknown DSL: ${_esc(dslId)}</p>`;
      return;
    }

    this._lastContent  = content;
    this._lastDsl      = dslId;
    this._lastModel    = model;
    this._lastRenderer = null;

    const sectionFrom = range?.from ?? 0;
    const sectionTo   = range?.to   ?? (content?.length ?? 0);
    this.content.dataset.docFrom = sectionFrom;
    this.content.dataset.docTo   = sectionTo;

    if (!renderContent || !renderContent.trim()) {
      this.content.innerHTML = '<p class="preview-empty">Start writing to see a preview.</p>';
      return;
    }

    const declaredVer   = this._activeSectionVersion;
    const pluginVer     = dsl.version ?? null;
    const versionBanner = (declaredVer && pluginVer && declaredVer !== pluginVer)
      ? `<div class="preview-version-warn">⚠ Document uses ${_esc(dslId)}@${_esc(declaredVer)}, plugin is ${_esc(pluginVer)} — rendering with available version</div>`
      : '';

    const spinnerTimer = setTimeout(() => {
      if (this._lastContent === content)
        this.content.innerHTML = '<div class="preview-spinner"></div>';
    }, 200);

    try {
      await dsl.render(renderContent, this.content, { signal: ac.signal });
      if (ac.signal.aborted) return;
      if (versionBanner) this.content.insertAdjacentHTML('afterbegin', versionBanner);
    } catch (err) {
      if (ac.signal.aborted) return;
      this.content.innerHTML = `${versionBanner}<pre class="error">Render error:\n${_esc(err.message)}</pre>`;
    } finally {
      clearTimeout(spinnerTimer);
    }
  }

  /** Teardown whatever renderer is currently active. */
  _teardownCurrent() {
    if (!this._lastRenderer) return;
    const key = this._lastRenderer;
    if (key.startsWith('flow:')) {
      const layout = key.slice(5);
      _FLOW_LAYOUT_RENDERERS[layout]?.teardown(this.content);
    } else {
      _MODEL_RENDERERS[key]?.teardown(this.content);
    }
    this._lastRenderer = null;
  }

  /**
   * Print the current layout via the browser print dialog.
   * For document layout: force-populates all lazy stubs first so every page
   * appears fully rendered in the printout.
   */
  print() {
    const layout = this._lastRenderer?.startsWith('flow:')
      ? this._lastRenderer.slice(5)
      : null;
    if (layout === 'document') {
      printDocument(this.content);
    } else if (layout === 'slides') {
      printSlides(this.content);
    } else {
      window.print();
    }
  }

  /**
   * Render content to an HTML string (for export).
   */
  async renderToString(content, dslId) {
    try {
      const dsl = getDSL(dslId ?? state.data?.dslType ?? 'markdown');
      if (dsl.renderToString) return await dsl.renderToString(content);
      const tmp = document.createElement('div');
      await dsl.render(content, tmp);
      return tmp.innerHTML;
    } catch {
      return `<pre>${_esc(content)}</pre>`;
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  _updateVisibility() {
    const { viewMode } = state;
    const hidden = viewMode === VIEW_MODES.EDITOR;
    this.el.style.display = hidden ? 'none' : '';
    this.el.style.flex = (!hidden && viewMode === VIEW_MODES.PREVIEW)
      ? '1 1 100%'
      : '1 1 50%';
  }
}

// ---------------------------------------------------------------------------
// Renderer registries
// ---------------------------------------------------------------------------

/** Renderers for non-flow primary models. Key = model id. */
const _MODEL_RENDERERS = {
  grid:     { render: renderGrid,     teardown: teardownGrid     },
  spatial:  { render: renderSpatial,  teardown: teardownSpatial  },
  timeline: { render: renderTimeline, teardown: teardownTimeline },
  graph:    { render: renderGraph,    teardown: teardownGraph    },
};

/** Layout renderers within the flow model. Key = layout value. */
const _FLOW_LAYOUT_RENDERERS = {
  slides:   { render: renderSlides,   teardown: teardownSlides   },
  document: { render: renderDocument, teardown: teardownDocument },
  webpage:  { render: renderWebpage,  teardown: teardownWebpage  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
