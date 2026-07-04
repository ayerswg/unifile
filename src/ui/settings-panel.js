/**
 * Settings panel
 *
 * Opens when the user clicks the ⚙ gear icon.
 * Lets the user update their display name, email, and colour theme.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';
import { applyTheme } from './theme.js';
import { checkForUpdate } from './update-check.js';

// Stamped by esbuild `define` in build.mjs (from the latest git tag); guard for
// any non-built context (e.g. raw ESM in tests).
const APP_VERSION = (typeof UNIFILE_VERSION !== 'undefined') ? UNIFILE_VERSION : '0.0.0';

export class SettingsPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.el = container;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.SETTINGS) this.show();
      else this.hide();
    }));

    // Repopulate the audio-output picker when MIDI ports change (panel open).
    this._unsub.push(state.on('abc-midi-outputs-change', () => {
      const sel = this.el.querySelector('#settings-midi');
      if (sel) sel.innerHTML = this._midiOptions();
    }));
  }

  /** <option>s for the audio-output picker: internal piano + external ports. */
  _midiOptions() {
    if (!state.abcMidiSupported) {
      return '<option value="" selected>Internal piano (Web MIDI unavailable in this browser)</option>';
    }
    const outs = state.abcMidiOutputs ?? [];
    const selected = state.abcMidiOutId ?? '';
    return [`<option value=""${selected ? '' : ' selected'}>🔊 Internal piano</option>`]
      .concat(outs.map(o => `<option value="${escHtml(o.id)}"${o.id === selected ? ' selected' : ''}>🎹 ${escHtml(o.name)}</option>`))
      .join('');
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const prefs = loadUserPrefs();
    const theme = prefs.theme ?? 'auto';
    const isAbc = (state.activeDslId ?? state.data?.dslType) === 'abcjs';

    this.el.innerHTML = `
      <div class="dialog-overlay" id="settings-overlay">
        <div class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="dialog-header">
            <h2 class="dialog-title" id="settings-title">Settings</h2>
            <button class="dialog-close" id="settings-close" aria-label="Close">&times;</button>
          </div>

          <div class="dialog-body">
            <!-- ── Identity ───────────────────────────────────────────── -->
            <p class="settings-intro">
              Your identity is used as the commit author. Cached locally in this
              browser and never shared.
            </p>

            <div class="form-row">
              <label class="form-label" for="settings-name">
                Display name <span class="required">*</span>
              </label>
              <input class="form-input" id="settings-name" type="text"
                value="${escHtml(prefs.name ?? '')}"
                placeholder="Your Name" autocomplete="name">
            </div>

            <div class="form-row">
              <label class="form-label" for="settings-email">
                Email <span class="required">*</span>
              </label>
              <input class="form-input" id="settings-email" type="email"
                value="${escHtml(prefs.email ?? '')}"
                placeholder="you@example.com" autocomplete="email">
            </div>

            <!-- ── Appearance ─────────────────────────────────────────── -->
            <div class="settings-section-label">Appearance</div>

            <div class="form-row">
              <label class="form-label">Colour theme</label>
              <div class="theme-toggle-group" role="group" aria-label="Colour theme">
                <button class="theme-toggle-btn${theme === 'dark'  ? ' active' : ''}"
                  data-theme-pref="dark"  title="Always dark (Catppuccin Mocha)">
                  🌙 Dark
                </button>
                <button class="theme-toggle-btn${theme === 'auto'  ? ' active' : ''}"
                  data-theme-pref="auto"  title="Follow operating system setting">
                  🖥 Auto
                </button>
                <button class="theme-toggle-btn${theme === 'light' ? ' active' : ''}"
                  data-theme-pref="light" title="Always light (Catppuccin Latte)">
                  ☀️ Light
                </button>
              </div>
            </div>

            <p id="settings-error" class="form-error" hidden></p>
            <p id="settings-saved" class="form-success" hidden>Settings saved.</p>

            ${isAbc ? `
            <!-- ── Audio output (ABC) ─────────────────────────────────── -->
            <div class="settings-section-label">Audio output</div>
            <p class="settings-intro">
              Play through the built-in piano, or route to an external MIDI
              instrument (e.g. Kontakt). Web MIDI is Chromium-only.
            </p>
            <div class="form-row">
              <select class="form-input" id="settings-midi" aria-label="Audio output">${this._midiOptions()}</select>
            </div>` : ''}

            <!-- ── Updates ────────────────────────────────────────────── -->
            <div class="settings-section-label">Updates</div>
            <div class="settings-update-row">
              <button class="btn btn-ghost" id="settings-check-update" type="button">Check for updates</button>
              <span class="settings-update-status" id="settings-update-status" aria-live="polite"></span>
            </div>

            <!-- ── About ──────────────────────────────────────────────── -->
            <div class="settings-section-label">About</div>
            <p class="settings-about">
              Unifile <span class="settings-version">v${escHtml(APP_VERSION)}</span>
            </p>
          </div>

          <div class="dialog-footer">
            <button class="btn btn-ghost" id="settings-cancel">Cancel</button>
            <button class="btn btn-primary" id="settings-save">Save</button>
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';
    setTimeout(() => this.el.querySelector('#settings-name')?.focus(), 50);
    this._bindEvents();
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  _bindEvents() {
    const overlay   = this.el.querySelector('#settings-overlay');
    const closeBtn  = this.el.querySelector('#settings-close');
    const cancelBtn = this.el.querySelector('#settings-cancel');
    const saveBtn   = this.el.querySelector('#settings-save');

    closeBtn?.addEventListener('click',  () => state.closePanel());
    cancelBtn?.addEventListener('click', () => state.closePanel());
    overlay?.addEventListener('click',   (e) => { if (e.target === overlay) state.closePanel(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') state.closePanel();
    }, { once: true });

    saveBtn?.addEventListener('click', () => this._save());
    this.el.querySelector('#settings-email')
      ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._save(); });

    // Theme toggle — live preview (applies immediately, no Save needed)
    this.el.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pref = btn.dataset.themePref;
        applyTheme(pref);
        this.el.querySelectorAll('.theme-toggle-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.themePref === pref);
        });
      });
    });

    // Manual "Check for updates" — forces a cache-busting check.
    this.el.querySelector('#settings-check-update')
      ?.addEventListener('click', () => this._checkUpdate());

    // Audio output (ABC): request MIDI access lazily on first interaction.
    const midi = this.el.querySelector('#settings-midi');
    if (midi) {
      let requested = false;
      midi.addEventListener('pointerdown', () => { if (!requested) { requested = true; state.emit('abc-midi-refresh'); } });
      midi.addEventListener('focus',       () => { if (!requested) { requested = true; state.emit('abc-midi-refresh'); } });
      midi.addEventListener('change',      () => state.emit('abc-midi-select', { id: midi.value || null }));
    }
  }

  async _checkUpdate() {
    const statusEl = this.el.querySelector('#settings-update-status');
    const btn = this.el.querySelector('#settings-check-update');
    if (!statusEl) return;
    statusEl.textContent = 'Checking…';
    statusEl.className = 'settings-update-status';
    if (btn) btn.disabled = true;
    try {
      const r = await checkForUpdate({ force: true });
      switch (r.status) {
        case 'update':
          statusEl.textContent = `Update available: v${r.remote} — see the banner to apply.`;
          statusEl.classList.add('is-update');
          break;
        case 'current':
          statusEl.textContent = `You're on the latest (v${r.current}).`;
          break;
        case 'file':
          statusEl.textContent = "Can't check from a downloaded file — open the hosted app or PWA.";
          break;
        default:
          statusEl.textContent = "Couldn't reach the update server. Try again later.";
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  _save() {
    const name  = this.el.querySelector('#settings-name')?.value.trim();
    const email = this.el.querySelector('#settings-email')?.value.trim();
    const errEl   = this.el.querySelector('#settings-error');
    const savedEl = this.el.querySelector('#settings-saved');

    errEl.hidden   = true;
    savedEl.hidden = true;

    if (!name) {
      errEl.textContent = 'Display name is required.';
      errEl.hidden = false; return;
    }
    if (!email || !email.includes('@')) {
      errEl.textContent = 'A valid email is required.';
      errEl.hidden = false; return;
    }

    saveUserPrefs({ name, email });
    state.update({ user: { name, email } });

    savedEl.hidden = false;
    setTimeout(() => state.closePanel(), 800);
  }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

