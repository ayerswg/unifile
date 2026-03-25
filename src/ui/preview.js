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
import { renderSlides,   teardownSlides   } from '../layout/flow-slides.js';
import { renderDocument, teardownDocument } from '../layout/flow-document.js';
import { renderWebpage,  teardownWebpage  } from '../layout/flow-webpage.js';

// Primary model renderers
import { renderGrid,     teardownGrid     } from '../layout/grid-table.js';
import { renderSpatial,  teardownSpatial  } from '../layout/spatial-canvas.js';
import { renderTimeline, teardownTimeline } from '../layout/timeline-tracks.js';
import { renderGraph,    teardownGraph    } from '../layout/graph-er.js';

const DEBOUNCE_MS = 300;

export class Preview {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.el = container;
    this._unsub = [];
    this._renderTimer = null;
    this._lastContent = null;
    this._lastDsl     = null;
    this._lastModel   = null;
    this._lastRenderer = null; // key into _MODEL_RENDERERS or _FLOW_LAYOUT_RENDERERS
    this._activeSectionVersion = null;

    this._build();
    this._bindClickBack();

    this._unsub.push(state.on('content-change', ({ content }) => {
      this._scheduleRender(content);
    }));
    this._unsub.push(state.on('change', () => {
      this._updateVisibility();
      if (state.data?.dslType !== this._lastDsl || state.primaryModel !== this._lastModel) {
        this._scheduleRender(state.currentContent, true);
      }
    }));
    this._unsub.push(state.on('checkout', ({ content }) => {
      this._scheduleRender(content, true);
    }));
    this._unsub.push(state.on('branch-switch', ({ content }) => {
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
  }

  destroy() {
    this._unsub.forEach(fn => fn());
    clearTimeout(this._renderTimer);
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
  // DOM
  // ---------------------------------------------------------------------------

  _build() {
    this.el.innerHTML = `
      <div class="preview-pane" id="preview-pane">
        <div class="preview-content" id="preview-content" aria-live="polite">
          <p class="preview-empty">Start writing to see a preview.</p>
        </div>
      </div>
    `;

    this.pane    = this.el.querySelector('#preview-pane');
    this.content = this.el.querySelector('#preview-content');

    this._updateVisibility();
    this._scheduleRender(state.currentContent, true);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _scheduleRender(content, immediate = false) {
    clearTimeout(this._renderTimer);
    if (immediate) {
      this._render(content);
    } else {
      this._renderTimer = setTimeout(() => this._render(content), DEBOUNCE_MS);
    }
  }

  async _render(content) {
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
          await renderer.render(content, this.content);
        } catch (err) {
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
          await renderer.render(content, this.content);
        } catch (err) {
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
      await dsl.render(renderContent, this.content);
      if (versionBanner) this.content.insertAdjacentHTML('afterbegin', versionBanner);
    } catch (err) {
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
