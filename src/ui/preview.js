/**
 * Preview pane component
 *
 * Renders the current DSL content live as the user types.
 * Updates are debounced to avoid excessive re-renders.
 */

import { state, VIEW_MODES, PANELS } from './state.js';
import { getDSL } from '../dsl/registry.js';

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
    this._lastDsl = null;
    this._activeSectionVersion = null; // declared version from #! line

    this._build();

    this._unsub.push(state.on('content-change', ({ content }) => {
      this._scheduleRender(content);
    }));
    this._unsub.push(state.on('change', () => {
      this._updateVisibility();
      // Re-render if DSL changed
      if (state.data?.dslType !== this._lastDsl) {
        this._scheduleRender(state.currentContent, true);
      }
    }));
    this._unsub.push(state.on('checkout', ({ content }) => {
      this._scheduleRender(content, true);
    }));
    this._unsub.push(state.on('branch-switch', ({ content }) => {
      this._scheduleRender(content, true);
    }));
    // Active section changed (cursor moved to a different #! section) →
    // re-render immediately with the new DSL / slice.
    this._unsub.push(state.on('active-section-change', ({ version }) => {
      this._activeSectionVersion = version ?? null;
      this._scheduleRender(state.currentContent, true);
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
    clearTimeout(this._renderTimer);
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

    this.pane = this.el.querySelector('#preview-pane');
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
    // Active section overrides: use section slice and section DSL if available.
    const range  = state.activeSectionRange;
    const dslId  = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    const renderContent = range
      ? content.slice(range.from, range.to)
      : content;

    let dsl;
    try {
      dsl = getDSL(dslId);
    } catch {
      this.content.innerHTML = `<p class="error">Unknown DSL: ${dslId}</p>`;
      return;
    }

    this._lastContent = content;
    this._lastDsl = dslId;

    if (!renderContent || !renderContent.trim()) {
      this.content.innerHTML = '<p class="preview-empty">Start writing to see a preview.</p>';
      return;
    }

    // Version mismatch warning: document declares a version the plugin doesn't match
    const declaredVer = this._activeSectionVersion;
    const pluginVer   = dsl.version ?? null;
    const versionBanner = (declaredVer && pluginVer && declaredVer !== pluginVer)
      ? `<div class="preview-version-warn">⚠ Document uses ${dslId}@${declaredVer}, plugin is ${pluginVer} — rendering with available version</div>`
      : '';

    // Show spinner for slow renders
    const spinnerTimer = setTimeout(() => {
      if (this._lastContent === content) {
        this.content.innerHTML = '<div class="preview-spinner"></div>';
      }
    }, 200);

    try {
      await dsl.render(renderContent, this.content);
      // Prepend version warning banner if needed (after render clears the element)
      if (versionBanner) {
        this.content.insertAdjacentHTML('afterbegin', versionBanner);
      }
    } catch (err) {
      this.content.innerHTML = `${versionBanner}<pre class="error">Render error:\n${escHtml(err.message)}</pre>`;
    } finally {
      clearTimeout(spinnerTimer);
    }
  }

  /**
   * Render content to an HTML string (for noscript / export).
   * @param {string} content
   * @param {string} dslId
   * @returns {Promise<string>}
   */
  async renderToString(content, dslId) {
    try {
      const dsl = getDSL(dslId ?? state.data?.dslType ?? 'markdown');
      if (dsl.renderToString) return await dsl.renderToString(content);

      // Fallback: render into a temp element
      const tmp = document.createElement('div');
      await dsl.render(content, tmp);
      return tmp.innerHTML;
    } catch {
      return `<pre>${escHtml(content)}</pre>`;
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  _updateVisibility() {
    const { viewMode } = state;
    const hidden = viewMode === VIEW_MODES.EDITOR;
    // Operate on the WRAPPER element so the outer flex layout responds correctly.
    // The inner .preview-pane always fills 100% of the wrapper.
    this.el.style.display = hidden ? 'none' : '';
    this.el.style.flex = (!hidden && viewMode === VIEW_MODES.PREVIEW)
      ? '1 1 100%'
      : '1 1 50%';
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
