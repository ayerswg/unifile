/**
 * DSL-specific preview footer — a persistent transport bar for ABC notation.
 *
 * When the active DSL is 'abcjs' the footer is always shown and provides:
 *   • a play / pause button
 *   • a seekable progress bar (scrubber) with current / total time
 *   • a dropdown to route playback to the internal piano or an external MIDI port
 *
 * The structure is rendered once per DSL/MIDI change; high-frequency playback
 * progress updates the scrubber + time labels in place (no re-render) so the bar
 * stays smooth and a drag isn't interrupted.
 */

import { state } from './state.js';

export class DslFooter {
  /** @param {HTMLElement} container  The #uf-preview-footer element */
  constructor(container) {
    this.el = container;
    this._unsub = [];
    this._lastDsl = null;
    this._midiRequested = false; // request Web MIDI access lazily, once
    this._dragging = false;      // true while the user drags the scrubber

    this._unsub.push(state.on('change',                  () => this._maybeRender()));
    this._unsub.push(state.on('abc-midi-outputs-change', () => this.render()));
    this._unsub.push(state.on('abc-play-state', ({ playing }) => this._updatePlayBtn(playing)));
    this._unsub.push(state.on('abc-duration',   ({ total })   => this._updateScale(total)));
    this._unsub.push(state.on('abc-progress',   ({ ms, total }) => this._updateProgress(ms, total)));

    this.render();
  }

  destroy() { this._unsub.forEach(fn => fn()); }

  _maybeRender() {
    const newDsl = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    if (newDsl !== this._lastDsl) this.render();
  }

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  render() {
    const dslType = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    this._lastDsl = dslType;

    if (dslType !== 'abcjs') { this.el.innerHTML = ''; return; }

    const playing = state.abcPlaying;
    const total   = state.abcDurationMs ?? 0;
    const pos     = state.abcPositionMs ?? 0;

    this.el.innerHTML = `
      <div class="pf-transport">
        <button class="pf-btn play-btn has-tune${playing ? ' playing' : ''}" id="pf-play"
          title="${playing ? 'Pause (Space)' : 'Play (Space)'}" aria-label="Play/Pause">
          <span class="pf-icon">${playing ? _iconPause() : _iconPlay()}</span>
        </button>
        <span class="pf-time" id="pf-cur">${_fmt(pos)}</span>
        <input type="range" class="pf-scrub" id="pf-scrub" min="0" max="${Math.max(0, total)}"
          value="${Math.min(pos, total)}" step="50" aria-label="Seek">
        <span class="pf-time pf-time-total" id="pf-total">${_fmt(total)}</span>
        ${this._midiSelectHtml()}
      </div>`;

    this.el.querySelector('#pf-play')
      ?.addEventListener('click', () => state.emit('abc-play'));

    const scrub = this.el.querySelector('#pf-scrub');
    if (scrub) {
      // Live label while dragging; commit the seek on release.
      scrub.addEventListener('pointerdown', () => { this._dragging = true; });
      scrub.addEventListener('input', () => {
        const cur = this.el.querySelector('#pf-cur');
        if (cur) cur.textContent = _fmt(+scrub.value);
      });
      const commit = () => {
        if (!this._dragging) return;
        this._dragging = false;
        state.emit('abc-seek', { ms: +scrub.value });
      };
      scrub.addEventListener('change', commit);
      scrub.addEventListener('pointerup', commit);
    }

    const sel = this.el.querySelector('#pf-midi');
    if (sel) {
      sel.addEventListener('pointerdown', () => {
        if (!this._midiRequested) { this._midiRequested = true; state.emit('abc-midi-refresh'); }
      });
      sel.addEventListener('change', () => state.emit('abc-midi-select', { id: sel.value || null }));
    }
  }

  // ---------------------------------------------------------------------------
  // In-place updates (no re-render)
  // ---------------------------------------------------------------------------

  _updatePlayBtn(playing) {
    const btn = this.el.querySelector('#pf-play');
    if (!btn) return;
    btn.classList.toggle('playing', playing);
    btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
    const icon = btn.querySelector('.pf-icon');
    if (icon) icon.innerHTML = playing ? _iconPause() : _iconPlay();
  }

  _updateScale(total) {
    const scrub = this.el.querySelector('#pf-scrub');
    const tot   = this.el.querySelector('#pf-total');
    if (scrub) scrub.max = Math.max(0, total || 0);
    if (tot)   tot.textContent = _fmt(total || 0);
  }

  _updateProgress(ms, total) {
    if (total != null && total !== +(this.el.querySelector('#pf-scrub')?.max)) this._updateScale(total);
    if (this._dragging) return; // don't fight the user's drag
    const scrub = this.el.querySelector('#pf-scrub');
    const cur   = this.el.querySelector('#pf-cur');
    if (scrub) scrub.value = ms;
    if (cur)   cur.textContent = _fmt(ms);
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

/** ms → m:ss */
function _fmt(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function _iconPlay() {
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <polygon points="3,1 14,8 3,15"/>
  </svg>`;
}

function _iconPause() {
  return `<svg width="10" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="4" height="12" rx="1"/><rect x="10" y="2" width="4" height="12" rx="1"/>
  </svg>`;
}
