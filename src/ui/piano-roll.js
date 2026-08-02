/**
 * Piano roll — a DAW-style second input surface for ABC documents.
 *
 * Desktop: expands bottom-up from the transport bar's piano-roll button and
 * REPLACES the transport while open (it carries its own play/pause, time
 * display and scrubbing ruler).  Landscape phones get it as a dock button;
 * portrait phones don't get it at all (no vertical room).
 *
 * It is deliberately a *view/editor of the DSL*, not a sequencer of its own:
 * only edits representable in ABC text are offered —
 *   • click a note        → select it (source highlight + audition)
 *   • drag vertically     → transpose (chromatic, key-signature-aware spelling)
 *   • drag the right edge → change its written length (quantized to the L: unit)
 *   • double-click a note → delete it (the token becomes a rest, or leaves a chord)
 *   • double-click space  → add a note: over a rest (splitting it), stacked on a
 *                           note at the same onset (chord), or appended at the
 *                           end of the voice
 * Onsets can't be dragged horizontally — in ABC, time is where a token sits in
 * the measure, so "move right" has no single-token representation.
 *
 * DAW conventions followed: keyboard column on the left, beat/measure ruler on
 * top (click/drag to scrub), one color per voice ("track colors"), non-active
 * voices drawn as ghost notes, per-voice mute/solo on the voice chips, playhead
 * line with auto-follow, Delete/Arrow-key editing, wheel = scroll and
 * ctrl/cmd+wheel = time zoom.
 *
 * All source math happens on the section-relative string from abcRollData
 * (offsets line up with abcjs noteTimings); edits go out as full-document
 * changes via 'dsl-edit' so they land in the editor's undo history.
 */

import { state } from './state.js';
import { resolveVoiceColor, voiceColorVar } from '../core/voice-colors.js';
import {
  parseKeySig, parseUnitLen, midiToAbcPitch, naturalMidi,
  hasEarlierAccidental, accidentalRepairs, pitchTokensIn,
  parseLenSuffix, lenSuffix,
} from '../core/abc-pitch.js';

const KEY_W   = 48;   // keyboard column width (px)
const RULER_H = 22;   // time ruler height (px)
const ROW_H   = 12;   // one semitone row (px)
const EDGE_PX = 5;    // right-edge resize grab zone (px)
const BLACK_PC = new Set([1, 3, 6, 8, 10]);

export class PianoRoll {
  /** @param {HTMLElement} container  The #uf-piano-roll element */
  constructor(container) {
    this.el = container;
    this._data = null;         // abcRollData (see abcjs.js _emitRollData)
    this._open = false;
    this._pxPerMs = 0.05;      // time zoom
    this._viewInited = false;  // fit-to-tune happens once per document, not per edit
    this._scrollX = 0;         // px
    this._scrollY = 0;         // px
    this._playMs = 0;
    this._sel = null;          // selected roll note (entry from _data.notes)
    this._selPending = null;   // { char, midi } — re-select after a re-render
    this._drag = null;         // active pointer gesture
    this._drawRaf = 0;
    this._emittingSelect = false;
    this._flashTimer = 0;

    this._build();
    this._bind();

    state.on('piano-roll-change', ({ open }) => this._setOpen(open));
    state.on('abc-roll-data', (d) => this._onData(d));
    state.on('abc-progress', ({ ms }) => this._onProgress(ms));
    state.on('abc-play-state', ({ playing }) => { this._updatePlayBtn(playing); this._scheduleDraw(); });
    state.on('abc-voices-change', () => { this._renderChips(); this._scheduleDraw(); });
    state.on('abc-active-voice', () => { this._renderChips(); this._scheduleDraw(); });
    // Note clicked in the score / editor → mirror the selection here.
    state.on('dsl-select', ({ from }) => {
      if (this._emittingSelect || !this._open || !this._data) return;
      const c = from - this._data.sectionOffset;
      const hit = this._data.notes.find(n => n.startChar <= c && c < n.endChar);
      if (hit) { this._sel = hit; this._scheduleDraw(); }
    });
    // A different document arriving (checkout / branch switch) re-fits the view;
    // ordinary edits must NOT — the user's scroll/zoom position stays put.
    state.on('checkout',      () => { this._viewInited = false; });
    state.on('branch-switch', () => { this._viewInited = false; });

    // Leaving the ABC DSL closes the roll (the toggle only exists for ABC).
    state.on('change', () => {
      const dsl = state.activeDslId ?? state.data?.dslType ?? 'markdown';
      if (dsl !== 'abcjs' && this._open) state.togglePianoRoll(false);
    });

    // Redraw on theme flips (canvas colors are resolved, not live CSS vars).
    try {
      window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => this._scheduleDraw());
      new MutationObserver(() => this._scheduleDraw())
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch { /* old browser — theme flip needs a reopen */ }
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  _build() {
    this.el.innerHTML = `
      <div class="pr-head">
        <button type="button" class="pr-btn pr-play" title="Play (Space)" aria-label="Play/Pause">
          ${_iconPlay()}
        </button>
        <span class="pr-time"><span class="pr-cur">0:00</span> / <span class="pr-total">0:00</span></span>
        <div class="pr-voices" role="tablist" aria-label="Voices"></div>
        <span class="pr-flash" aria-live="polite"></span>
        <span class="pr-hint">2×click add · drag pitch · edge length · ⌫ delete</span>
        <button type="button" class="pr-btn pr-close" title="Close piano roll" aria-label="Close piano roll">
          ${_iconChevronDown()}
        </button>
      </div>
      <div class="pr-body">
        <canvas class="pr-canvas" tabindex="0" aria-label="Piano roll grid"></canvas>
      </div>`;
    this._canvas = this.el.querySelector('.pr-canvas');
    this._ctx = this._canvas.getContext('2d');
    this._body = this.el.querySelector('.pr-body');
  }

  _bind() {
    this.el.querySelector('.pr-play').addEventListener('click', () => state.emit('abc-play'));
    this.el.querySelector('.pr-close').addEventListener('click', () => state.togglePianoRoll(false));

    try {
      new ResizeObserver(() => {
        if (!this._open) return;
        this._sizeCanvas();
        // The pane can open while the tab/pane has no layout (0×0) — the
        // initial fit waits for real geometry.
        this._maybeFit();
        this._scheduleDraw();
      }).observe(this._body);
    } catch { /* no ResizeObserver — sized on open only */ }

    const c = this._canvas;
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerup',   (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', () => { this._drag = null; this._scheduleDraw(); });
    c.addEventListener('dblclick', (e) => this._onDblClick(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('keydown', (e) => this._onKeyDown(e));
    // Hover cursor: resize near note edges, pointer over notes/ruler.
    c.addEventListener('pointerleave', () => { c.style.cursor = ''; });
  }

  // ---------------------------------------------------------------------------
  // Open / close / data
  // ---------------------------------------------------------------------------

  _setOpen(open) {
    this._open = open;
    const root = document.getElementById('unifile-app');
    if (open) root?.setAttribute('data-piano-roll', '');
    else root?.removeAttribute('data-piano-roll');
    if (open) {
      this._data = state.abcRollData;
      this._sizeCanvas();
      this._maybeFit();
      this._renderChips();
      this._updateTime();
      this._updatePlayBtn(state.abcPlaying);
      this._scheduleDraw();
      this._canvas.focus({ preventScroll: true });
    }
  }

  _onData(d) {
    this._data = d;
    if (!this._open) return;
    // Carry the selection across a re-render — either the target of a
    // just-committed edit (_selPending) or whatever was already selected
    // (selection-triggered re-renders must not drop the outline).
    const want = this._selPending
      ?? (this._sel ? { char: this._sel.startChar, midi: this._sel.midi } : null);
    this._sel = null;
    if (want && d) {
      const { char, midi } = want;
      this._sel = d.notes.find(n => n.startChar <= char && char < n.endChar && n.midi === midi)
               ?? d.notes.find(n => n.startChar <= char && char < n.endChar) ?? null;
    }
    this._selPending = null;
    this._maybeFit();
    this._renderChips();
    this._updateTime();
    this._scheduleDraw();
  }

  _onProgress(ms) {
    this._playMs = ms;
    if (!this._open) return;
    this._updateTime();
    // Auto-follow: while playing, keep the playhead inside the visible window.
    if (state.abcPlaying) {
      const w = this._viewW();
      const x = ms * this._pxPerMs - this._scrollX;
      if (x > w * 0.85 || x < 0) {
        this._scrollX = Math.max(0, ms * this._pxPerMs - w * 0.15);
      }
    }
    this._scheduleDraw();
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  _viewW() { return Math.max(1, this._canvas.clientWidth - KEY_W); }
  _viewH() { return Math.max(1, this._canvas.clientHeight - RULER_H); }

  /** Pitch bounds: notes padded, min two octaves, C-aligned edges. */
  _pitchRange() {
    const notes = this._data?.notes ?? [];
    let lo = 128, hi = -1;
    for (const n of notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
    if (hi < 0) { lo = 48; hi = 83; }             // empty tune: C3–B5
    lo -= 5; hi += 5;
    while (hi - lo < 24) { lo--; hi++; }
    return { lo: Math.max(0, lo), hi: Math.min(127, hi) };
  }

  _x(ms)  { return KEY_W + ms * this._pxPerMs - this._scrollX; }
  _msAt(x) { return (x - KEY_W + this._scrollX) / this._pxPerMs; }
  _y(midi) { const { hi } = this._pitchRange(); return RULER_H + (hi - midi) * ROW_H - this._scrollY; }
  _midiAt(y) { const { hi } = this._pitchRange(); return hi - Math.floor((y - RULER_H + this._scrollY) / ROW_H); }

  /** One-time fit per document, deferred until the canvas has real geometry. */
  _maybeFit() {
    if (this._viewInited || !this._data || !this._canvas.clientWidth) return;
    this._fit();
    this._viewInited = true;
  }

  _fit() {
    const total = Math.max(1, this._data?.totalMs ?? 1);
    this._pxPerMs = Math.max(0.001, this._viewW() / total);
    this._scrollX = 0;
    // Center the vertical scroll on the notes.
    const { lo, hi } = this._pitchRange();
    const contentH = (hi - lo + 1) * ROW_H;
    this._scrollY = Math.max(0, (contentH - this._viewH()) / 2);
  }

  _clampScroll() {
    const { lo, hi } = this._pitchRange();
    const contentH = (hi - lo + 1) * ROW_H;
    const total = Math.max(1, this._data?.totalMs ?? 1);
    this._scrollY = Math.max(0, Math.min(this._scrollY, Math.max(0, contentH - this._viewH())));
    this._scrollX = Math.max(0, Math.min(this._scrollX, Math.max(0, total * this._pxPerMs - this._viewW() + 40)));
  }

  _sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = this._body.clientWidth, h = this._body.clientHeight;
    if (!w || !h) return;
    this._canvas.width = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Voices
  // ---------------------------------------------------------------------------

  _voices() { return this._data?.voices?.length ? this._data.voices : []; }

  _activeVoice() {
    const vs = this._voices();
    if (!vs.length) return null;
    return vs.includes(state.abcActiveVoice) ? state.abcActiveVoice : vs[0];
  }

  _voiceIndex(id) {
    const i = this._voices().indexOf(id);
    return i === -1 ? 0 : i;
  }

  _renderChips() {
    const wrap = this.el.querySelector('.pr-voices');
    if (!wrap) return;
    const vs = this._voices();
    if (!vs.length) { wrap.innerHTML = ''; return; }
    const active = this._activeVoice();
    wrap.innerHTML = vs.map((id, i) => {
      const muted = state.abcMutedVoices.has(id);
      const solo  = state.abcSoloVoices.has(id);
      const faded = state.isVoiceMuted(id);
      return `
        <span class="pr-chip${id === active ? ' active' : ''}${faded ? ' faded' : ''}"
          style="--vc:${voiceColorVar(i)}">
          <button type="button" class="pr-chip-name" data-voice="${_esc(id)}" role="tab"
            aria-selected="${id === active}" title="Edit voice ${_esc(id)}">
            <span class="pr-chip-dot" aria-hidden="true"></span>${_esc(id)}
          </button>
          <button type="button" class="pr-chip-m${muted ? ' on' : ''}" data-mute="${_esc(id)}"
            title="Mute voice ${_esc(id)}" aria-pressed="${muted}">M</button>
          <button type="button" class="pr-chip-s${solo ? ' on' : ''}" data-solo="${_esc(id)}"
            title="Solo voice ${_esc(id)}" aria-pressed="${solo}">S</button>
        </span>`;
    }).join('');
    wrap.querySelectorAll('.pr-chip-name').forEach(b =>
      b.addEventListener('click', () => state.setActiveVoice(b.dataset.voice)));
    wrap.querySelectorAll('.pr-chip-m').forEach(b =>
      b.addEventListener('click', () => state.toggleVoiceMute(b.dataset.mute)));
    wrap.querySelectorAll('.pr-chip-s').forEach(b =>
      b.addEventListener('click', () => state.toggleVoiceSolo(b.dataset.solo)));
  }

  // ---------------------------------------------------------------------------
  // Header bits
  // ---------------------------------------------------------------------------

  _updatePlayBtn(playing) {
    const btn = this.el.querySelector('.pr-play');
    if (!btn) return;
    btn.classList.toggle('playing', !!playing);
    btn.innerHTML = playing ? _iconPause() : _iconPlay();
  }

  _updateTime() {
    const cur = this.el.querySelector('.pr-cur');
    const tot = this.el.querySelector('.pr-total');
    if (cur) cur.textContent = _fmt(this._playMs);
    if (tot) tot.textContent = _fmt(this._data?.totalMs ?? 0);
  }

  _flash(msg) {
    const el = this.el.querySelector('.pr-flash');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  _scheduleDraw() {
    if (this._drawRaf || !this._open) return;
    this._drawRaf = requestAnimationFrame(() => { this._drawRaf = 0; this._draw(); });
  }

  _colors() {
    const cs = getComputedStyle(this.el);
    const get = (v, fb) => (cs.getPropertyValue(v) || '').trim() || fb;
    return {
      bg:      get('--bg', '#1e1e2e'),
      bgAlt:   get('--bg-alt', '#181825'),
      surface: get('--bg-surface', '#313244'),
      border:  get('--border', '#313244'),
      text:    get('--text', '#cdd6f4'),
      sub:     get('--text-sub', '#a6adc8'),
      muted:   get('--text-muted', '#6c7086'),
      accent:  get('--accent', '#89b4fa'),
    };
  }

  _draw() {
    const d = this._data;
    const ctx = this._ctx;
    const w = this._canvas.clientWidth, h = this._canvas.clientHeight;
    if (!w || !h) return;
    const col = this._colors();
    this._clampScroll();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, w, h);

    if (!d || !d.notes.length && !d.rests.length) {
      ctx.fillStyle = col.muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No tune to show — write some ABC first.', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }

    const { lo, hi } = this._pitchRange();
    const active = this._activeVoice();

    // ── Grid area ──────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_W, RULER_H, w - KEY_W, h - RULER_H);
    ctx.clip();

    // Pitch rows: shade black-key rows; line at each B/C boundary.
    for (let m = hi; m >= lo; m--) {
      const y = this._y(m);
      if (y > h || y + ROW_H < RULER_H) continue;
      if (BLACK_PC.has(((m % 12) + 12) % 12)) {
        ctx.fillStyle = col.bgAlt;
        ctx.fillRect(KEY_W, y, w - KEY_W, ROW_H);
      }
      if (m % 12 === 0) {                       // line under each C row = octave edge
        ctx.strokeStyle = col.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(KEY_W, y + ROW_H + 0.5);
        ctx.lineTo(w, y + ROW_H + 0.5);
        ctx.stroke();
      }
    }

    // Beat / measure verticals.
    const msPerMeasure = d.msPerMeasure || 1000;
    const beats = Math.max(1, d.meter?.num ?? 4);
    const beatMs = msPerMeasure / beats;
    const msFrom = Math.max(0, this._msAt(KEY_W));
    const msTo = this._msAt(w);
    // Density caps: drop beat lines below 14px, and thin measure lines to
    // every k-th when even they crowd (a long tune fitted to the pane).
    const measurePx = msPerMeasure * this._pxPerMs;
    const mStride = Math.max(1, Math.ceil(24 / Math.max(1e-6, measurePx)));
    ctx.lineWidth = 1;
    for (let ms = Math.floor(msFrom / beatMs) * beatMs; ms <= msTo; ms += beatMs) {
      const x = Math.round(this._x(ms)) + 0.5;
      const beatIdx = Math.round(ms / beatMs);
      const isMeasure = beatIdx % beats === 0;
      if (!isMeasure && beatMs * this._pxPerMs < 14) continue;
      if (isMeasure && (beatIdx / beats) % mStride !== 0) continue;
      ctx.strokeStyle = isMeasure ? col.surface : col.bgAlt;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // ── Notes: ghosts first, active voice on top ───────────────────────────
    // Resolve the voice palette once per frame (getComputedStyle is not cheap).
    const palette = this._voices().map((_, i) => resolveVoiceColor(i, this.el));
    if (!palette.length) palette.push(resolveVoiceColor(0, this.el));
    const drawNote = (n, isActive) => {
      let midi = n.midi, durMs = n.durMs;
      // Live drag previews.
      if (this._drag?.mode === 'move' && this._drag.note === n) midi = this._drag.previewMidi;
      if (this._drag?.mode === 'resize' && this._drag.note === n) durMs = this._drag.previewDurMs;
      const x = this._x(n.ms);
      const y = this._y(midi);
      const nw = Math.max(3, durMs * this._pxPerMs - 1);
      if (x + nw < KEY_W || x > w || y > h || y + ROW_H < RULER_H) return;
      const c = palette[this._voiceIndex(n.voiceId)] ?? palette[0];
      const faded = state.isVoiceMuted(n.voiceId);
      ctx.globalAlpha = faded ? 0.13 : isActive ? 0.95 : 0.3;
      ctx.fillStyle = c;
      _rrect(ctx, x, y + 1.5, nw, ROW_H - 3, 2.5);
      ctx.fill();
      // Sounding now → white flash overlay (DAW playback affordance).
      if (state.abcPlaying && this._playMs >= n.ms && this._playMs < n.ms + n.durMs && !faded) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#ffffff';
        _rrect(ctx, x, y + 1.5, nw, ROW_H - 3, 2.5);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (this._sel === n) {
        ctx.strokeStyle = col.text;
        ctx.lineWidth = 1.5;
        _rrect(ctx, x, y + 1.5, nw, ROW_H - 3, 2.5);
        ctx.stroke();
      }
    };
    for (const n of d.notes) if (n.voiceId !== active) drawNote(n, false);
    for (const n of d.notes) if (n.voiceId === active) drawNote(n, true);

    // Playhead.
    const px = this._x(this._playMs);
    if (px >= KEY_W) {
      ctx.strokeStyle = col.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, RULER_H);
      ctx.lineTo(Math.round(px) + 0.5, h);
      ctx.stroke();
    }
    ctx.restore();

    // ── Ruler ──────────────────────────────────────────────────────────────
    ctx.fillStyle = col.bgAlt;
    ctx.fillRect(KEY_W, 0, w - KEY_W, RULER_H);
    ctx.strokeStyle = col.border;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = col.muted;
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_W, 0, w - KEY_W, RULER_H);
    ctx.clip();
    for (let ms = Math.floor(msFrom / beatMs) * beatMs; ms <= msTo; ms += beatMs) {
      const x = Math.round(this._x(ms)) + 0.5;
      const beatIdx = Math.round(ms / beatMs);
      const isMeasure = beatIdx % beats === 0;
      if (!isMeasure && beatMs * this._pxPerMs < 22) continue;
      if (isMeasure && (beatIdx / beats) % mStride !== 0) continue;
      ctx.strokeStyle = col.surface;
      ctx.beginPath();
      ctx.moveTo(x, isMeasure ? 6 : RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (isMeasure && measurePx * mStride > 34) ctx.fillText(String(beatIdx / beats + 1), x + 3, 12);
    }
    // Playhead marker triangle.
    if (px >= KEY_W) {
      ctx.fillStyle = col.accent;
      ctx.beginPath();
      ctx.moveTo(px - 4, RULER_H - 7);
      ctx.lineTo(px + 4, RULER_H - 7);
      ctx.lineTo(px, RULER_H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // ── Keyboard ───────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, KEY_W, h - RULER_H);
    ctx.clip();
    ctx.fillStyle = col.bgAlt;
    ctx.fillRect(0, RULER_H, KEY_W, h - RULER_H);
    for (let m = hi; m >= lo; m--) {
      const y = this._y(m);
      if (y > h || y + ROW_H < RULER_H) continue;
      const black = BLACK_PC.has(((m % 12) + 12) % 12);
      ctx.fillStyle = black ? col.surface : col.bg;
      ctx.fillRect(0, y + 0.5, black ? KEY_W * 0.62 : KEY_W - 1, ROW_H - 1);
      if (((m % 12) + 12) % 12 === 0) {
        ctx.fillStyle = col.muted;
        ctx.font = '8px system-ui, sans-serif';
        // Octave label in scientific pitch (C4 = middle C = MIDI 60).
        ctx.fillText('C' + (Math.floor(m / 12) - 1), KEY_W - 16, y + ROW_H - 3);
      }
    }
    ctx.strokeStyle = col.border;
    ctx.beginPath();
    ctx.moveTo(KEY_W - 0.5, RULER_H);
    ctx.lineTo(KEY_W - 0.5, h);
    ctx.stroke();
    ctx.restore();

    // Top-left corner blank.
    ctx.fillStyle = col.bgAlt;
    ctx.fillRect(0, 0, KEY_W, RULER_H);
  }

  // ---------------------------------------------------------------------------
  // Hit testing + pointer gestures
  // ---------------------------------------------------------------------------

  _pos(e) {
    const r = this._canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Topmost note under (x, y): active voice wins, later notes win ties. */
  _hitNote(x, y) {
    const d = this._data;
    if (!d) return null;
    const active = this._activeVoice();
    const test = (n) => {
      const nx = this._x(n.ms);
      const nw = Math.max(3, n.durMs * this._pxPerMs - 1);
      const ny = this._y(n.midi);
      return x >= nx - 1 && x <= nx + nw + 1 && y >= ny && y < ny + ROW_H
        ? { note: n, edge: x >= nx + nw - EDGE_PX && nw > EDGE_PX * 2 } : null;
    };
    for (let i = d.notes.length - 1; i >= 0; i--) {
      const n = d.notes[i];
      if (n.voiceId === active) { const hit = test(n); if (hit) return hit; }
    }
    for (let i = d.notes.length - 1; i >= 0; i--) {
      const n = d.notes[i];
      if (n.voiceId !== active) { const hit = test(n); if (hit) return { ...hit, ghost: true }; }
    }
    return null;
  }

  _onPointerDown(e) {
    if (e.button !== 0 || !this._data) return;
    const { x, y } = this._pos(e);
    try { this._canvas.setPointerCapture(e.pointerId); } catch { /* synthetic/stale pointer */ }
    this._canvas.focus({ preventScroll: true });

    if (y < RULER_H && x >= KEY_W) {
      // Ruler → scrub (commit on release, live preview while dragging).
      this._drag = { mode: 'scrub' };
      const ms = Math.max(0, this._msAt(x));
      state.emit('abc-seek-preview', { ms });
      this._playMs = ms;
      this._scheduleDraw();
      return;
    }
    if (x < KEY_W && y >= RULER_H) {
      // Keyboard → audition the pitch (drag to glide).
      const midi = this._midiAt(y);
      this._drag = { mode: 'keys', lastMidi: midi };
      state.emit('abc-audition-pitch', { midi });
      return;
    }

    const hit = this._hitNote(x, y);
    if (!hit) { this._sel = null; this._scheduleDraw(); return; }

    const n = hit.note;
    this._sel = n;
    if (hit.ghost) state.setActiveVoice(n.voiceId);   // clicking a ghost selects its voice

    if (hit.edge && !hit.ghost) {
      this._drag = { mode: 'resize', note: n, startX: x, previewDurMs: n.durMs, moved: false };
    } else {
      this._drag = { mode: 'move', note: n, startY: y, previewMidi: n.midi, moved: false };
    }
    // Source highlight + audition via the standard note-click path.
    this._emitSelect(n);
    this._scheduleDraw();
  }

  _onPointerMove(e) {
    const { x, y } = this._pos(e);
    const drag = this._drag;
    if (!drag) {
      // Hover cursor feedback.
      if (y < RULER_H && x >= KEY_W) this._canvas.style.cursor = 'ew-resize';
      else {
        const hit = this._hitNote(x, y);
        this._canvas.style.cursor = hit ? (hit.edge && !hit.ghost ? 'col-resize' : 'pointer') : '';
      }
      return;
    }
    switch (drag.mode) {
      case 'scrub': {
        const ms = Math.max(0, Math.min(this._msAt(x), this._data?.totalMs ?? 0));
        state.emit('abc-seek-preview', { ms });
        this._playMs = ms;
        this._scheduleDraw();
        break;
      }
      case 'keys': {
        const midi = this._midiAt(y);
        if (midi !== drag.lastMidi) {
          drag.lastMidi = midi;
          state.emit('abc-audition-pitch', { midi });
        }
        break;
      }
      case 'move': {
        const rows = Math.round((drag.startY - y) / ROW_H);
        const midi = Math.max(0, Math.min(127, drag.note.midi + rows));
        if (midi !== drag.previewMidi) {
          drag.previewMidi = midi;
          drag.moved = true;
          state.emit('abc-audition-pitch', { midi, durMs: 220 });
          this._scheduleDraw();
        }
        break;
      }
      case 'resize': {
        const unitMs = this._unitMs();
        const raw = drag.note.durMs + (x - drag.startX) / this._pxPerMs;
        const q = Math.max(unitMs / 4, Math.round(raw / (unitMs / 4)) * (unitMs / 4));
        if (q !== drag.previewDurMs) {
          drag.previewDurMs = q;
          drag.moved = true;
          this._scheduleDraw();
        }
        break;
      }
    }
  }

  _onPointerUp(e) {
    const drag = this._drag;
    this._drag = null;
    if (!drag) return;
    if (drag.mode === 'scrub') {
      const ms = Math.max(0, Math.min(this._msAt(this._pos(e).x), this._data?.totalMs ?? 0));
      state.emit('abc-seek', { ms });
    } else if (drag.mode === 'move' && drag.moved && drag.previewMidi !== drag.note.midi) {
      this._commitTranspose(drag.note, drag.previewMidi);
    } else if (drag.mode === 'resize' && drag.moved && drag.previewDurMs !== drag.note.durMs) {
      this._commitResize(drag.note, drag.previewDurMs);
    }
    this._scheduleDraw();
  }

  _onDblClick(e) {
    if (!this._data) return;
    const { x, y } = this._pos(e);
    if (y < RULER_H || x < KEY_W) return;
    const hit = this._hitNote(x, y);
    if (hit && !hit.ghost) this._deleteNote(hit.note);
    else if (!hit) this._addNote(Math.max(0, this._msAt(x)), this._midiAt(y));
  }

  _onWheel(e) {
    if (!this._data) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Time zoom around the cursor (the DAW ctrl+wheel convention).
      const { x } = this._pos(e);
      const msAtCursor = this._msAt(x);
      const factor = Math.exp(-e.deltaY * 0.002);
      const fitZoom = this._viewW() / Math.max(1, this._data.totalMs);
      this._pxPerMs = Math.max(fitZoom * 0.5, Math.min(2, this._pxPerMs * factor));
      this._scrollX = msAtCursor * this._pxPerMs - (x - KEY_W);
    } else {
      this._scrollX += e.deltaX;
      this._scrollY += e.deltaY;
    }
    this._clampScroll();
    this._scheduleDraw();
  }

  _onKeyDown(e) {
    if (e.key === ' ') { e.preventDefault(); state.emit('abc-play'); return; }
    if (e.key === 'Escape') { this._sel = null; this._scheduleDraw(); return; }
    if (!this._sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this._deleteNote(this._sel);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (e.shiftKey ? 12 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const midi = Math.max(0, Math.min(127, this._sel.midi + step));
      if (midi !== this._sel.midi) {
        state.emit('abc-audition-pitch', { midi, durMs: 220 });
        this._commitTranspose(this._sel, midi);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Source write-back
  // ---------------------------------------------------------------------------

  _unitMs() {
    const d = this._data;
    return parseUnitLen(d.source) * (d.msPerWhole || 2000);
  }

  /** Sounding MIDI of an accidental-less pitch token (for accidental repairs):
   *  the roll note covering it; chords pick the pitch nearest the token's
   *  natural reading. */
  _soundingMidiAt(tok) {
    const cands = this._data.notes.filter(n => n.startChar <= tok.from && tok.from < n.endChar);
    if (!cands.length) return null;
    const nat = naturalMidi(tok.letter, tok.octMarks);
    let best = cands[0];
    for (const c of cands) if (Math.abs(c.midi - nat) < Math.abs(best.midi - nat)) best = c;
    return best.midi;
  }

  /**
   * Walk a token span to its payload: the first char matching `stopRe`.
   * Skips `!…!` decorations, `"…"` chord symbols, `{…}` grace groups and
   * inline `[V:…]`-style fields wholesale, and steps over ANY other char —
   * abcjs startChars can include slur opens `(`, ties, broken-rhythm marks,
   * shortcut decorations (`~`, `.`, …) and even a line's leading voice field.
   * (Stopping at the first unknown char was a real bug: a chord under a slur
   * read as a single note, and "delete" wrote `[zd]2` — the lower pitch became
   * a rest and the clicked one halved.)  Returns -1 when nothing matches.
   */
  _walkToken(src, from, to, stopRe) {
    let i = from;
    while (i < to) {
      const ch = src[i];
      if (ch === '!') { const e = src.indexOf('!', i + 1); if (e === -1 || e >= to) return -1; i = e + 1; continue; }
      if (ch === '"') { const e = src.indexOf('"', i + 1); if (e === -1 || e >= to) return -1; i = e + 1; continue; }
      if (ch === '{') { const e = src.indexOf('}', i + 1); if (e === -1 || e >= to) return -1; i = e + 1; continue; }
      if (ch === '[' && /^\[[A-Za-z]:/.test(src.slice(i, i + 3))) {
        const e = src.indexOf(']', i + 1); if (e === -1 || e >= to) return -1; i = e + 1; continue;
      }
      if (stopRe.test(ch)) return i;
      i++;
    }
    return -1;
  }

  /**
   * Locate the rewritable pieces of a roll note's source token.
   * @returns {null | {
   *   chord: null | { from: number, to: number, tokens: any[], lenFrom: number, lenTo: number },
   *   pitch: { from, to, acc, letter, octMarks },   // the one pitch to rewrite
   *   lenFrom: number, lenTo: number,               // this note's length suffix span
   * }}
   */
  _tokenForNote(note) {
    const src = this._data.source;
    // Stop at a chord bracket or the first pitch/accidental char — the walker
    // has already skipped inline fields, so a '[' here IS a chord.
    const i = this._walkToken(src, note.startChar, note.endChar, /[[A-Ga-g_^=]/);
    if (i === -1) return null;
    if (src[i] === '[') {
      const close = src.indexOf(']', i + 1);
      if (close === -1) return null;
      const tokens = pitchTokensIn(src, i + 1, close);
      if (!tokens.length) return null;
      const keysig = parseKeySig(src);
      // The chord pitch nearest the note's sounding MIDI (explicit accidental
      // or key signature applied to the natural reading).
      let best = tokens[0], bestErr = Infinity;
      for (const t of tokens) {
        const alt = t.acc ? _accValue(t.acc) : (keysig.alter[t.letter.toUpperCase()] ?? 0);
        const err = Math.abs(naturalMidi(t.letter, t.octMarks) + alt - note.midi);
        if (err < bestErr) { best = t; bestErr = err; }
      }
      const len = parseLenSuffix(src, close + 1);
      return { chord: { from: i, to: close + 1, tokens, lenFrom: close + 1, lenTo: len.to },
               pitch: best, lenFrom: close + 1, lenTo: len.to };
    }
    const tokens = pitchTokensIn(src, i, note.endChar);
    if (!tokens.length) return null;
    const t = tokens[0];
    const len = parseLenSuffix(src, t.to);
    return { chord: null, pitch: t, lenFrom: t.to, lenTo: len.to };
  }

  /** Spell `midi` at `pos`, forcing an explicit accidental when a bare token
   *  would inherit one from earlier in the measure. */
  _spellAt(src, pos, midi, keysig) {
    const s = midiToAbcPitch(midi, keysig);
    let text = s.text;
    if (!/^[_^=]/.test(text) && hasEarlierAccidental(src, pos, s.caseTok, s.octMarks)) {
      const diff = midi - naturalMidi(s.caseTok, s.octMarks);
      text = (diff === 0 ? '=' : diff > 0 ? '^'.repeat(diff) : '_'.repeat(-diff)) + s.caseTok + s.octMarks;
    }
    return { ...s, text };
  }

  /** True when the roll's source snapshot still matches the live document.
   *  After any edit there is a window (until the debounced re-render emits
   *  fresh abc-roll-data) where the snapshot is stale — an edit computed
   *  against it would splice the wrong characters (e.g. a quick chord-add
   *  then chord-delete turned `[GB]2` into `zGB]2`). All edits funnel through
   *  _emitEdit, so this one guard covers add/delete/transpose/resize. */
  _isFresh() {
    const d = this._data;
    if (!d) return false;
    const live = state.currentContent ?? '';
    return live.slice(d.sectionOffset, d.sectionOffset + d.source.length) === d.source;
  }

  _emitEdit(changes, selection) {
    if (!this._isFresh()) { this._flash('Score updating — try that again'); return; }
    const off = this._data.sectionOffset;
    state.emit('dsl-edit', {
      changes: changes.map(c => ({ from: c.from + off, to: c.to + off, insert: c.insert })),
      selection: selection
        ? { anchor: selection.anchor + off, head: selection.head + off }
        : undefined,
    });
  }

  _emitSelect(note) {
    const off = this._data.sectionOffset;
    this._emittingSelect = true;
    try {
      state.emit('dsl-select', { from: note.startChar + off, to: note.endChar + off });
    } finally {
      this._emittingSelect = false;
    }
  }

  _commitTranspose(note, newMidi) {
    const src = this._data.source;
    const tok = this._tokenForNote(note);
    if (!tok) { this._flash('Can’t edit this note’s source'); return; }
    const keysig = parseKeySig(src);
    const spell = this._spellAt(src, tok.pitch.from, newMidi, keysig);

    const changes = [{ from: tok.pitch.from, to: tok.pitch.to, insert: spell.text }];
    // Pin later same-letter notes in the measure whose accidental inheritance
    // this edit changes — only when it actually changes: the old token carried
    // an explicit accidental (now removed) or the new one introduces one.
    const spellings = [];
    if (tok.pitch.acc) {
      spellings.push({ letter: tok.pitch.letter, caseTok: tok.pitch.letter, octMarks: tok.pitch.octMarks });
    }
    if (/^[_^=]/.test(spell.text)) {
      spellings.push({ letter: spell.letter, caseTok: spell.caseTok, octMarks: spell.octMarks });
    }
    if (spellings.length) {
      changes.push(...accidentalRepairs(
        src, tok.pitch.from, tok.pitch.to, spellings, keysig,
        (t) => this._soundingMidiAt(t)
      ).filter(r => r.from > tok.pitch.to));
    }

    this._selPending = { char: note.startChar, midi: newMidi };
    this._emitEdit(changes, { anchor: tok.pitch.from, head: tok.pitch.from + spell.text.length });
  }

  _commitResize(note, newDurMs) {
    const src = this._data.source;
    const tok = this._tokenForNote(note);
    if (!tok) { this._flash('Can’t edit this note’s source'); return; }
    const unitMs = this._unitMs();
    const units = Math.max(0.25, Math.round((newDurMs / unitMs) * 4) / 4);
    const suffix = lenSuffix(units);
    this._selPending = { char: note.startChar, midi: note.midi };
    this._emitEdit(
      [{ from: tok.lenFrom, to: tok.lenTo, insert: suffix }],
      { anchor: tok.pitch.from, head: tok.pitch.from }
    );
  }

  _deleteNote(note) {
    const src = this._data.source;
    const tok = this._tokenForNote(note);
    if (!tok) { this._flash('Can’t edit this note’s source'); return; }
    let change;
    if (tok.chord && tok.chord.tokens.length > 1) {
      if (tok.chord.tokens.length === 2) {
        // Two pitches → unwrap to the survivor + the chord's length suffix.
        const other = tok.chord.tokens.find(t => t !== tok.pitch);
        const lenText = src.slice(tok.chord.lenFrom, tok.chord.lenTo);
        change = { from: tok.chord.from, to: tok.chord.lenTo,
                   insert: src.slice(other.from, other.to) + lenText };
      } else {
        change = { from: tok.pitch.from, to: tok.pitch.to, insert: '' };
      }
    } else {
      // Whole note/chord → a rest of the same written length.  Belt-and-braces:
      // a single note's span holds exactly one pitch token — if more follow,
      // this is an undetected chord and writing `z` over one pitch would corrupt
      // it (`[zd]2` = rest + halved note). Refuse rather than guess.
      if (!tok.chord && pitchTokensIn(src, tok.pitch.to, note.endChar).length) {
        this._flash('Can’t edit this note’s source');
        return;
      }
      const from = tok.chord ? tok.chord.from : tok.pitch.from;
      change = { from, to: tok.lenFrom, insert: 'z' };
    }
    this._sel = null;
    this._selPending = null;
    this._emitEdit([change]);
  }

  _addNote(msRaw, midi) {
    const d = this._data;
    const src = d.source;
    const voice = this._activeVoice();
    const keysig = parseKeySig(src);
    const unitFrac = parseUnitLen(src);
    const unitMs = this._unitMs();
    const inVoice = (x) => voice == null || x.voiceId === voice;

    // 1. Over a rest → split it: [rest-before] note [rest-after].
    for (const r of d.rests.filter(inVoice)) {
      const i = this._walkToken(src, r.startChar, r.endChar, /[zx]/i);
      if (i === -1) continue;                      // Z (multi-measure) etc. — skip
      const len = parseLenSuffix(src, i + 1);
      const restUnits = len.value;
      const restMs = restUnits * unitMs;
      if (!(msRaw >= r.ms && msRaw < r.ms + restMs)) continue;

      // Snap to the unit-length cell of the rest the click landed in.
      const cell = Math.max(0, Math.min(
        Math.floor((msRaw - r.ms) / unitMs), Math.max(0, Math.ceil(restUnits) - 1)));
      const preU = cell;
      const noteU = Math.min(1, restUnits - preU);
      const postU = Math.round((restUnits - preU - noteU) * 4) / 4;
      if (noteU <= 0) continue;

      const spell = this._spellAt(src, i, midi, keysig);
      const parts = [];
      if (preU > 0) parts.push('z' + lenSuffix(preU));
      parts.push(spell.text + lenSuffix(noteU));
      if (postU > 0) parts.push('z' + lenSuffix(postU));
      const insert = parts.join(' ');

      const selStart = i + (preU > 0 ? ('z' + lenSuffix(preU) + ' ').length : 0);
      this._selPending = { char: selStart, midi };
      this._emitEdit(
        [{ from: i, to: len.to, insert }],
        { anchor: selStart, head: selStart + spell.text.length }
      );
      return;
    }

    // 2. On a sounding note at the same onset cell → stack a chord pitch.
    const onset = d.notes.filter(inVoice).find(n =>
      msRaw >= n.ms && msRaw < n.ms + Math.max(n.durMs, unitMs / 2));
    if (onset) {
      if (onset.midi === midi) return;             // already there
      const tok = this._tokenForNote(onset);
      if (!tok) { this._flash('Can’t edit this note’s source'); return; }
      const spell = this._spellAt(src, tok.pitch.from, midi, keysig);
      this._selPending = { char: onset.startChar, midi };
      if (tok.chord) {
        this._emitEdit([{ from: tok.chord.to - 1, to: tok.chord.to - 1, insert: spell.text }]);
      } else {
        const lenText = src.slice(tok.lenFrom, tok.lenTo);
        const pitchText = src.slice(tok.pitch.from, tok.pitch.to);
        this._emitEdit([{
          from: tok.pitch.from, to: tok.lenTo,
          insert: '[' + pitchText + spell.text + ']' + lenText,
        }]);
      }
      return;
    }

    // 3. Past the end of the voice → append after its last token.
    const all = [...d.notes.filter(inVoice), ...d.rests.filter(inVoice)];
    if (all.length) {
      let last = all[0];
      for (const x of all) if (x.endChar > last.endChar) last = x;
      const lastEndMs = last.ms + (last.durMs ?? 0);
      if (msRaw >= lastEndMs - 1) {
        const pos = last.endChar;
        const spell = this._spellAt(src, pos, midi, keysig);
        this._selPending = { char: pos + 1, midi };
        this._emitEdit(
          [{ from: pos, to: pos, insert: ' ' + spell.text }],
          { anchor: pos + 1, head: pos + 1 + spell.text.length }
        );
        return;
      }
    }

    this._flash(voice ? `No room in voice ${voice} there — add over a rest` : 'No room there — add over a rest');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _accValue(accText) {
  if (accText === '=') return 0;
  let v = 0;
  for (const ch of accText) v += ch === '^' ? 1 : -1;
  return v;
}

function _rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function _fmt(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _iconPlay() {
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <polygon points="3,1 14,8 3,15"/></svg>`;
}
function _iconPause() {
  return `<svg width="10" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="4" height="12" rx="1"/><rect x="10" y="2" width="4" height="12" rx="1"/></svg>`;
}
function _iconChevronDown() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 6l5 5 5-5"/></svg>`;
}

/** The piano-roll glyph used by the transport + dock toggles. */
export function pianoRollIcon() {
  return `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="3"    width="7"   height="2.6" rx="1"/>
    <rect x="6"   y="6.7"  width="8.5" height="2.6" rx="1"/>
    <rect x="3"   y="10.4" width="6"   height="2.6" rx="1"/></svg>`;
}
