/**
 * DSL-specific preview footer controls
 *
 * Rendered below the preview pane. Currently handles ABC notation
 * play/stop. Future: piano keyboard entry, slide controls, etc.
 *
 * The component re-renders only when the DSL type changes.
 * Incremental play-state/tune-state updates patch the existing DOM.
 */

import { state } from './state.js';

export class DslFooter {
  /** @param {HTMLElement} container  The #uf-preview-footer element */
  constructor(container) {
    this.el = container;
    this._unsub = [];

    // Full re-render when the effective DSL changes (either file-level or
    // per-section via activeDslId).  Both trigger 'change' via state.update().
    this._unsub.push(state.on('change', () => {
      const newDsl = state.activeDslId ?? state.data?.dslType ?? 'markdown';
      if (newDsl !== this._lastDsl) this.render();
    }));

    // Incremental: update play button icon/class without full re-render
    this._unsub.push(state.on('abc-play-state', ({ playing }) => {
      const btn = this.el.querySelector('#pf-play');
      if (!btn) return;
      btn.classList.toggle('playing', playing);
      btn.title = playing ? 'Stop (Space)' : 'Play (Space)';
      btn.querySelector('.pf-icon').innerHTML = playing ? _iconStop() : _iconPlay();
      btn.querySelector('.pf-label').textContent = playing ? 'Stop' : 'Play';
    }));

    // Incremental: update has-tune class
    this._unsub.push(state.on('abc-tune-state', ({ hasTune }) => {
      const btn = this.el.querySelector('#pf-play');
      if (!btn) return;
      btn.classList.toggle('has-tune', hasTune);
    }));

    this._lastDsl = null;
    this.render();
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render() {
    const dslType = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    this._lastDsl = dslType;

    if (dslType !== 'abcjs') {
      this.el.innerHTML = '';
      return;
    }

    const playing = state.abcPlaying;
    const hasTune = state.abcHasTune;

    this.el.innerHTML = `
      <button
        class="pf-btn play-btn${playing ? ' playing' : ''}${hasTune ? ' has-tune' : ''}"
        id="pf-play"
        title="${playing ? 'Stop (Space)' : 'Play (Space)'}">
        <span class="pf-icon">${playing ? _iconStop() : _iconPlay()}</span>
        <span class="pf-label">${playing ? 'Stop' : 'Play'}</span>
      </button>
    `;

    this.el.querySelector('#pf-play')
      ?.addEventListener('click', () => state.emit('abc-play'));
  }
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function _iconPlay() {
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <polygon points="3,1 14,8 3,15"/>
  </svg>`;
}

function _iconStop() {
  return `<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="12" height="12" rx="2"/>
  </svg>`;
}
