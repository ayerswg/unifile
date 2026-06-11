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
    this._unsub.push(state.on('change',            () => this._maybeRender()));
    this._unsub.push(state.on('abc-note-selected', () => this.render()));
    this._unsub.push(state.on('abc-play-state',    () => this.render()));
    this._unsub.push(state.on('abc-midi-outputs-change', () => this.render()));

    this._lastDsl = null;
    this._midiRequested = false; // request Web MIDI access lazily, once
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

    if (dslType !== 'abcjs') {
      this.el.innerHTML = '';
      return;
    }

    // Show the play/stop button only when there is something to act on; the MIDI
    // output picker is always available for abcjs so a port can be chosen first.
    const noteSelected = state.abcNoteSelected;
    const playing      = state.abcPlaying;

    const playBtn = (noteSelected || playing) ? `
      <button
        class="pf-btn play-btn has-tune${playing ? ' playing' : ''}"
        id="pf-play"
        title="${playing ? 'Stop (Space)' : 'Play from selected note (Space)'}">
        <span class="pf-icon">${playing ? _iconStop() : _iconPlay()}</span>
        <span class="pf-label">${playing ? 'Stop' : 'Play'}</span>
      </button>` : '';

    this.el.innerHTML = `<div class="pf-row">${playBtn}${this._midiSelectHtml()}</div>`;

    this.el.querySelector('#pf-play')
      ?.addEventListener('click', () => state.emit('abc-play'));

    const sel = this.el.querySelector('#pf-midi');
    if (sel) {
      // Request Web MIDI access on first interaction so users who never touch the
      // picker are never prompted.
      sel.addEventListener('pointerdown', () => {
        if (!this._midiRequested) {
          this._midiRequested = true;
          state.emit('abc-midi-refresh');
        }
      });
      sel.addEventListener('change', () =>
        state.emit('abc-midi-select', { id: sel.value || null }));
    }
  }

  /** Build the MIDI-output <select> (or a disabled note when unsupported). */
  _midiSelectHtml() {
    if (!state.abcMidiSupported) {
      return `<span class="pf-midi-note" title="Web MIDI is only available in Chromium-based browsers">Internal piano</span>`;
    }
    const outs     = state.abcMidiOutputs ?? [];
    const selected = state.abcMidiOutId ?? '';
    const opts = [`<option value=""${selected ? '' : ' selected'}>🔊 Internal piano</option>`]
      .concat(outs.map(o => {
        const sel = o.id === selected ? ' selected' : '';
        return `<option value="${_esc(o.id)}"${sel}>🎹 ${_esc(o.name)}</option>`;
      }));
    return `<select id="pf-midi" class="pf-midi-select" title="Audio output — route to an external MIDI instrument (e.g. Kontakt) or use the built-in piano">${opts.join('')}</select>`;
  }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
