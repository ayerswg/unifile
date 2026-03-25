/**
 * DSL-specific preview footer controls
 *
 * Rendered below the preview pane. Currently handles ABC notation
 * play/stop.
 *
 * The play button is shown only when:
 *   1. The active DSL is 'abcjs', AND
 *   2. A note is currently selected (red highlight) OR playback is active.
 *
 * This ties the button to the specific abcjs block the user last interacted
 * with, rather than showing it unconditionally whenever an abcjs section exists.
 */

import { state } from './state.js';

export class DslFooter {
  /** @param {HTMLElement} container  The #uf-preview-footer element */
  constructor(container) {
    this.el = container;
    this._unsub = [];

    // Re-render on any state change that can affect button visibility.
    this._unsub.push(state.on('change',           () => this._maybeRender()));
    this._unsub.push(state.on('abc-note-selected', () => this.render()));
    this._unsub.push(state.on('abc-play-state',    () => this.render()));

    this._lastDsl = null;
    this.render();
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  _maybeRender() {
    const newDsl = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    if (newDsl !== this._lastDsl) this.render();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render() {
    const dslType = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    this._lastDsl = dslType;

    // Show the play/stop button only when there is something to act on.
    const noteSelected = state.abcNoteSelected;
    const playing      = state.abcPlaying;

    if (dslType !== 'abcjs' || (!noteSelected && !playing)) {
      this.el.innerHTML = '';
      return;
    }

    this.el.innerHTML = `
      <button
        class="pf-btn play-btn has-tune${playing ? ' playing' : ''}"
        id="pf-play"
        title="${playing ? 'Stop (Space)' : 'Play from selected note (Space)'}">
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
